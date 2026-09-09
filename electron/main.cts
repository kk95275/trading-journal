// Electron main process. Wraps the same UI the browser dev workflow uses, but replaces
// vite.config.ts's fetch-based /api/journal and /api/instruments endpoints with IPC
// handlers backed by the same shared scripts/lib/*.mjs modules (Phase 1), so behavior/
// output format is identical between `npm run dev` and the packaged app.
//
// .cts (not .ts) forces CommonJS output regardless of the root package.json's
// "type":"module", since Electron's main entry point must be CJS (or a real .mjs, but
// CJS keeps require()-based Electron APIs simple). The shared *.mjs libs are pure ESM,
// loaded here via dynamic import() — a .cjs file can't require() an ESM module.
import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron'
import { autoUpdater } from 'electron-updater'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'

type UpdaterStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'not-available' }
  | { state: 'error'; message: string }

// In dev (unpackaged), read/write the same repo-relative data-journal/ and public/data/
// the plain browser dev workflow already uses — so testing via `npm run electron:dev`
// and a normal browser tab share the same files. Once packaged, the app's own directory
// is typically read-only and cwd is meaningless, so switch to the OS user-data dir.
const storageRoot = app.isPackaged ? app.getPath('userData') : path.resolve(__dirname, '..')
const journalDir = path.join(storageRoot, 'data-journal')
const instrumentsDir = app.isPackaged ? path.join(storageRoot, 'instruments') : path.join(storageRoot, 'public', 'data')
// AI keys live in userData either way (never checked into the repo, even in dev).
const aiKeysFile = path.join(app.getPath('userData'), 'ai-keys.json')

const SYMBOL_RE = /^[A-Z0-9_.-]+$/i
const AI_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'ollama'])

// Loaded via dynamic import() (a .cjs file can't require() these ESM modules) from
// their original location in the repo — not recompiled/copied, so there's exactly one
// copy of this logic shared with the CLI and the Vite dev middleware (Phase 1). Typed
// `any` here since these are plain .mjs files with no .d.ts — see their JSDoc for shapes.
async function loadLibs(): Promise<any> {
  const [journalStore, convertMod, instrumentsRepo] = await Promise.all([
    import('../scripts/lib/journalStore.mjs'),
    import('../scripts/lib/convertInstrument.mjs'),
    import('../scripts/lib/instrumentsRepo.mjs'),
  ])
  return { journalStore, convertInstrument: convertMod.convertInstrument, instrumentsRepo }
}

async function registerIpc() {
  const { journalStore, convertInstrument, instrumentsRepo } = await loadLibs()
  fs.mkdirSync(journalDir, { recursive: true })

  ipcMain.handle('journal:get', () => {
    const buf = journalStore.readJournal(journalDir)
    return buf ? JSON.parse(buf.toString('utf8')) : null
  })
  ipcMain.handle('journal:put', (_e, snapshot: unknown, meta: unknown) => {
    journalStore.writeJournal(journalDir, Buffer.from(JSON.stringify(snapshot)), JSON.stringify(meta ?? {}))
  })
  ipcMain.handle('journal:meta', () => {
    const buf = journalStore.readJournalMeta(journalDir)
    return buf ? JSON.parse(buf.toString('utf8')) : {}
  })

  ipcMain.handle('data:manifest', (_e, symbol: string) => {
    const p = path.join(instrumentsDir, symbol, 'manifest.json')
    if (!fs.existsSync(p)) throw new Error(`No data for ${symbol} — add it in Settings → Instruments`)
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  })
  ipcMain.handle('data:chunk', (_e, symbol: string, file: string) => {
    const buf = fs.readFileSync(path.join(instrumentsDir, symbol, file))
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) // plain ArrayBuffer, matches dataService's parseChunk(buf: ArrayBuffer)
  })

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('instruments:list', () => instrumentsRepo.listInstruments(instrumentsDir))
  ipcMain.handle('instruments:delete', (_e, symbol: string) => {
    if (!SYMBOL_RE.test(symbol)) throw new Error('bad symbol')
    instrumentsRepo.deleteInstrument(instrumentsDir, symbol)
  })
  ipcMain.handle('instruments:pickFile', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Instrument data', extensions: ['txt'] }] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.on('instruments:import', (event, args: { symbol: string; filePath: string; spec: unknown; channel: string }) => {
    const { symbol, filePath, spec, channel } = args
    void (async () => {
      try {
        if (!SYMBOL_RE.test(symbol)) throw new Error('bad symbol')
        const result = await convertInstrument({
          symbol,
          source: fs.createReadStream(filePath),
          outDir: path.join(instrumentsDir, symbol),
          spec,
          onProgress: (rows: number, monthKey: string) => event.sender.send(`${channel}:progress`, { rows, monthKey }),
        })
        event.sender.send(`${channel}:done`, result)
      } catch (e: any) {
        event.sender.send(`${channel}:error`, String(e?.message ?? e))
      }
    })()
  })

  registerAiIpc()
}

// ─── AI: encrypted key storage + streaming HTTP proxy ────────────────────────
// Keys are encrypted at rest with the OS keychain (Keychain / DPAPI / libsecret)
// via safeStorage. The renderer only ever sees "has a key" bits — never the
// plaintext — and all provider HTTPS calls go out from here so we bypass browser
// CORS entirely.

type StoredKeys = Record<string, string> // provider -> base64(encrypted)

function readKeys(): StoredKeys {
  try { return JSON.parse(fs.readFileSync(aiKeysFile, 'utf8')) } catch { return {} }
}
function writeKeys(k: StoredKeys) {
  fs.writeFileSync(aiKeysFile, JSON.stringify(k), { mode: 0o600 })
}

function decryptKey(provider: string): string | null {
  const store = readKeys()
  const b64 = store[provider]
  if (!b64) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try { return safeStorage.decryptString(Buffer.from(b64, 'base64')) } catch { return null }
}

function registerAiIpc() {
  ipcMain.handle('ai:hasKey', (_e, provider: string) => {
    if (!AI_PROVIDERS.has(provider)) return false
    const store = readKeys()
    return !!store[provider]
  })
  ipcMain.handle('ai:setKey', (_e, provider: string, key: string) => {
    if (!AI_PROVIDERS.has(provider)) throw new Error('bad provider')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain not available on this system')
    const store = readKeys()
    if (!key) { delete store[provider] }
    else { store[provider] = safeStorage.encryptString(key).toString('base64') }
    writeKeys(store)
  })
  // Deliberately never exposed to the renderer: ai:getKey is called only from
  // inside the main process (chat handlers below).
  ipcMain.handle('ai:deleteKey', (_e, provider: string) => {
    if (!AI_PROVIDERS.has(provider)) return
    const store = readKeys()
    delete store[provider]
    writeKeys(store)
  })

  ipcMain.handle('ai:chat', async (_e, req: AiChatRequest) => {
    const chunks: string[] = []
    await runProviderStream(req, d => chunks.push(d))
    return chunks.join('')
  })

  ipcMain.on('ai:chatStream', (event, args: { req: AiChatRequest; channel: string }) => {
    const { req, channel } = args
    void (async () => {
      try {
        const abort = new AbortController()
        const cancelListener = () => abort.abort()
        ipcMain.once(`${channel}:cancel`, cancelListener)
        try {
          await runProviderStream(req, d => event.sender.send(`${channel}:delta`, d), abort.signal)
          event.sender.send(`${channel}:done`)
        } finally {
          ipcMain.removeListener(`${channel}:cancel`, cancelListener)
        }
      } catch (e: any) {
        event.sender.send(`${channel}:error`, String(e?.message ?? e))
      }
    })()
  })
}

// Shape mirrors src/lib/ai.ts ChatRequest. Kept in sync manually — the two
// codepaths (renderer fallback + main-process proxy) build the same wire request.
interface AiChatRequest {
  provider: 'openai' | 'anthropic' | 'gemini' | 'ollama'
  model: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  temperature?: number
  maxTokens?: number
  ollamaBaseUrl?: string
}

interface BuiltAiRequest { url: string; headers: Record<string, string>; body: string }

function buildAiRequest(req: AiChatRequest, key: string): BuiltAiRequest {
  const { provider, model, messages, temperature, maxTokens } = req
  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
    }
  }
  if (provider === 'anthropic') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const rest = messages.filter(m => m.role !== 'system')
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system: system || undefined,
        messages: rest.map(m => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens ?? 4096,
        temperature,
        stream: true,
      }),
    }
  }
  if (provider === 'gemini') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    }
  }
  const base = (req.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  return {
    url: `${base}/api/chat`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { temperature, num_predict: maxTokens } }),
  }
}

function parseAiLine(provider: AiChatRequest['provider'], raw: string): string | null {
  const line = raw.trim()
  if (!line) return null
  if (provider === 'ollama') {
    try { const j = JSON.parse(line); return j.message?.content ?? null } catch { return null }
  }
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    const j = JSON.parse(payload)
    if (provider === 'openai') return j.choices?.[0]?.delta?.content ?? null
    if (provider === 'anthropic') return j.type === 'content_block_delta' ? (j.delta?.text ?? null) : null
    if (provider === 'gemini') {
      const parts = j.candidates?.[0]?.content?.parts
      if (Array.isArray(parts)) return parts.map((p: any) => p.text ?? '').join('')
      return null
    }
  } catch { /* partial */ }
  return null
}

async function runProviderStream(req: AiChatRequest, onDelta: (d: string) => void, signal?: AbortSignal): Promise<void> {
  const key = req.provider === 'ollama' ? '' : (decryptKey(req.provider) ?? '')
  if (req.provider !== 'ollama' && !key) throw new Error(`No ${req.provider} key set`)
  const built = buildAiRequest(req, key)
  const u = new URL(built.url)
  const isHttps = u.protocol === 'https:'
  const lib = isHttps ? https : http

  await new Promise<void>((resolve, reject) => {
    const request = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: { ...built.headers, 'content-length': Buffer.byteLength(built.body).toString() },
    }, res => {
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => reject(new Error(`${req.provider} ${status}: ${Buffer.concat(chunks).toString('utf8').slice(0, 400)}`)))
        return
      }
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buf += chunk
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          const delta = parseAiLine(req.provider, line)
          if (delta) onDelta(delta)
        }
      })
      res.on('end', () => {
        const tail = parseAiLine(req.provider, buf)
        if (tail) onDelta(tail)
        resolve()
      })
      res.on('error', reject)
    })
    request.on('error', reject)
    if (signal) {
      if (signal.aborted) { request.destroy(new Error('aborted')); return }
      signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true })
    }
    request.write(built.body)
    request.end()
  })
}

// Auto-update: checks GitHub Releases (via the app-update.yml electron-builder generates
// at package time from package.json's `build.publish` config — no separate config needed
// here). Downloads in the background automatically, but never force-installs: the user
// must click "Restart to install" in Settings, so a download completing mid-backtest
// never yanks the app out from under them. Only wired when packaged — an unpackaged dev
// run has no app-update.yml and checkForUpdates() would just error.
function registerUpdater(win: BrowserWindow) {
  if (!app.isPackaged) return

  const send = (status: UpdaterStatus) => { if (!win.isDestroyed()) win.webContents.send('updater:status', status) }

  autoUpdater.autoDownload = true
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }))
  autoUpdater.on('update-available', info => send({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => send({ state: 'not-available' }))
  autoUpdater.on('download-progress', p => send({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', info => send({ state: 'downloaded', version: info.version }))
  // Failures here are expected/routine (private repo, offline, etc.) — never let one
  // crash the app or surface as anything more than a status line in Settings.
  autoUpdater.on('error', err => {
    console.error('autoUpdater error:', err) // full detail in the main-process log, not the UI
    send({ state: 'error', message: String(err?.message ?? err).split('\n')[0].slice(0, 200) })
  })

  ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates().catch(() => {}))
  ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall())

  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}) }, 5000)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (app.isPackaged) void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  else void win.loadURL('http://localhost:5173')
  registerUpdater(win)
}

void app.whenReady().then(async () => {
  await registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
