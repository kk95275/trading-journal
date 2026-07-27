import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readJournal, readJournalMeta, writeJournal } from './scripts/lib/journalStore.mjs'
import { listInstruments, deleteInstrument, isValidSymbol } from './scripts/lib/instrumentsRepo.mjs'
import { convertInstrument } from './scripts/lib/convertInstrument.mjs'

// Persists the journal to disk: the app mirrors its database to
// data-journal/journal.json (plus daily copies) through these endpoints,
// and restores from it when the browser's storage is empty.
function journalStorage(): Plugin {
  const dir = path.resolve(process.cwd(), 'data-journal')

  return {
    name: 'journal-storage',
    configureServer(server) {
      server.middlewares.use('/api/journal-meta', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        const meta = readJournalMeta(dir)
        if (req.method === 'GET' && meta) res.end(meta)
        else { res.statusCode = 404; res.end('{}') }
      })
      server.middlewares.use('/api/journal', (req, res, next) => {
        try {
          if (req.method === 'GET') {
            const buf = readJournal(dir)
            if (!buf) { res.statusCode = 404; res.end('{}'); return }
            res.setHeader('Content-Type', 'application/json')
            res.end(buf)
          } else if (req.method === 'PUT') {
            const chunks: Buffer[] = []
            req.on('data', c => chunks.push(c))
            req.on('end', () => {
              const buf = Buffer.concat(chunks)
              const meta = req.headers['x-journal-meta']
              writeJournal(dir, buf, typeof meta === 'string' ? meta : undefined)
              res.end('ok')
            })
          } else {
            next()
          }
        } catch (e) {
          res.statusCode = 500
          res.end(String(e))
        }
      })
    },
  }
}

// Lets the in-app Instruments UI (Settings page) list/import/delete OHLCV chart data
// during `npm run dev`, mirroring what npm run convert-data does from the CLI — same
// shared scripts/lib/convertInstrument.mjs, so behavior/output format is identical.
function instrumentsApi(): Plugin {
  const dataDir = path.resolve(process.cwd(), 'public', 'data')

  return {
    name: 'instruments-api',
    configureServer(server) {
      server.middlewares.use('/api/instruments', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://internal')
        try {
          if (req.method === 'GET' && url.pathname === '/') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(listInstruments(dataDir)))
          } else if (req.method === 'DELETE' && url.pathname.length > 1) {
            const symbol = decodeURIComponent(url.pathname.slice(1)).toUpperCase()
            if (!isValidSymbol(symbol)) { res.statusCode = 400; res.end('bad symbol'); return }
            deleteInstrument(dataDir, symbol)
            res.end('ok')
          } else if (req.method === 'POST' && url.pathname === '/import') {
            const symbol = (url.searchParams.get('symbol') || '').toUpperCase()
            if (!isValidSymbol(symbol)) { res.statusCode = 400; res.end('bad symbol'); return }
            const specHeader = req.headers['x-instrument-spec']
            const spec = typeof specHeader === 'string' ? JSON.parse(specHeader) : undefined
            res.setHeader('Content-Type', 'application/x-ndjson')
            // Stream the raw uploaded .txt body straight into the converter — do NOT
            // buffer it first (unlike journalStorage's PUT handler above), a source
            // file can be hundreds of MB.
            convertInstrument({
              symbol,
              source: req,
              outDir: path.join(dataDir, symbol),
              spec,
              onProgress: (rows: number, monthKey: string) => res.write(JSON.stringify({ rows, monthKey }) + '\n'),
            })
              .then(r => { res.write(JSON.stringify({ done: true, ...r }) + '\n'); res.end() })
              .catch(e => { res.write(JSON.stringify({ error: String(e?.message ?? e) }) + '\n'); res.end() })
          } else {
            res.statusCode = 404
            res.end()
          }
        } catch (e) {
          res.statusCode = 500
          res.end(String(e))
        }
      })
    },
  }
}

export default defineConfig({
  // Relative asset paths — required for the packaged Electron app, which loads
  // dist/index.html via file:// (absolute paths like "/assets/x.js" would resolve to
  // the filesystem root, not the app bundle, and silently fail to load). Harmless for
  // the dev server and any static web host too.
  base: './',
  plugins: [react(), journalStorage(), instrumentsApi()],
  server: { port: 5173 },
})
