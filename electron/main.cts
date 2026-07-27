// Electron main process. Wraps the same UI the browser dev workflow uses, but replaces
// vite.config.ts's fetch-based /api/journal and /api/instruments endpoints with IPC
// handlers backed by the same shared scripts/lib/*.mjs modules (Phase 1), so behavior/
// output format is identical between `npm run dev` and the packaged app.
//
// .cts (not .ts) forces CommonJS output regardless of the root package.json's
// "type":"module", since Electron's main entry point must be CJS (or a real .mjs, but
// CJS keeps require()-based Electron APIs simple). The shared *.mjs libs are pure ESM,
// loaded here via dynamic import() — a .cjs file can't require() an ESM module.
import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import fs from 'node:fs'
import path from 'node:path'

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

const SYMBOL_RE = /^[A-Z0-9_.-]+$/i

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
