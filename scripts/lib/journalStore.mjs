// Atomic journal.json persistence: shared by the Vite dev-server /api/journal middleware
// (vite.config.ts) and Electron's main-process IPC handlers (electron/main.cts), so both
// runtimes keep identical write/rotate/prune behavior instead of two hand-maintained copies.
import fs from 'node:fs'
import path from 'node:path'

/** @returns {Buffer|null} null if no journal has been written yet */
export function readJournal(journalDir) {
  const file = path.join(journalDir, 'journal.json')
  return fs.existsSync(file) ? fs.readFileSync(file) : null
}

/** @returns {Buffer|null} */
export function readJournalMeta(journalDir) {
  const file = path.join(journalDir, 'meta.json')
  return fs.existsSync(file) ? fs.readFileSync(file) : null
}

/**
 * Atomic write (tmp file + rename, so a crash mid-write never leaves a half-written
 * journal.json) plus a dated copy (last 14 kept) and an optional meta.json.
 * @param {string} journalDir
 * @param {Buffer} buf        the journal.json contents
 * @param {string} [metaJson] raw JSON string for meta.json
 */
export function writeJournal(journalDir, buf, metaJson) {
  fs.mkdirSync(journalDir, { recursive: true })
  const file = path.join(journalDir, 'journal.json')
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, file)
  const day = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(path.join(journalDir, `journal-${day}.json`), buf)
  const dailies = fs.readdirSync(journalDir).filter(f => /^journal-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
  for (const old of dailies.slice(0, -14)) fs.unlinkSync(path.join(journalDir, old))
  if (metaJson) fs.writeFileSync(path.join(journalDir, 'meta.json'), metaJson)
}
