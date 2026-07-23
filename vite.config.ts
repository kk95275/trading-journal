import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Persists the journal to disk: the app mirrors its database to
// data-journal/journal.json (plus daily copies) through these endpoints,
// and restores from it when the browser's storage is empty.
function journalStorage(): Plugin {
  const dir = path.resolve(process.cwd(), 'data-journal')
  const file = path.join(dir, 'journal.json')
  const metaFile = path.join(dir, 'meta.json')

  return {
    name: 'journal-storage',
    configureServer(server) {
      server.middlewares.use('/api/journal-meta', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.method === 'GET' && fs.existsSync(metaFile)) res.end(fs.readFileSync(metaFile))
        else { res.statusCode = 404; res.end('{}') }
      })
      server.middlewares.use('/api/journal', (req, res, next) => {
        try {
          if (req.method === 'GET') {
            if (!fs.existsSync(file)) { res.statusCode = 404; res.end('{}'); return }
            res.setHeader('Content-Type', 'application/json')
            fs.createReadStream(file).pipe(res)
          } else if (req.method === 'PUT') {
            fs.mkdirSync(dir, { recursive: true })
            const chunks: Buffer[] = []
            req.on('data', c => chunks.push(c))
            req.on('end', () => {
              const buf = Buffer.concat(chunks)
              const tmp = file + '.tmp'
              fs.writeFileSync(tmp, buf)
              fs.renameSync(tmp, file) // atomic: never a half-written journal.json
              const day = new Date().toISOString().slice(0, 10)
              fs.writeFileSync(path.join(dir, `journal-${day}.json`), buf)
              const dailies = fs.readdirSync(dir).filter(f => /^journal-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
              for (const old of dailies.slice(0, -14)) fs.unlinkSync(path.join(dir, old))
              const meta = req.headers['x-journal-meta']
              if (typeof meta === 'string') fs.writeFileSync(metaFile, meta)
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

export default defineConfig({
  plugins: [react(), journalStorage()],
  server: { port: 5173 },
})
