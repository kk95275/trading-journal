// Exposes a narrow, typed window.electronAPI to the renderer via contextBridge — the
// renderer never gets direct Node/ipcRenderer access (contextIsolation: true, sandbox:
// true in main.cts). Shape must match the `electronAPI` interface declared in
// src/lib/platform.ts.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getJournal: () => ipcRenderer.invoke('journal:get'),
  putJournal: (snapshot: unknown, meta: unknown) => ipcRenderer.invoke('journal:put', snapshot, meta),
  getJournalMeta: () => ipcRenderer.invoke('journal:meta'),
  getManifest: (symbol: string) => ipcRenderer.invoke('data:manifest', symbol),
  getChunk: (symbol: string, file: string) => ipcRenderer.invoke('data:chunk', symbol, file),
  listInstruments: () => ipcRenderer.invoke('instruments:list'),
  deleteInstrument: (symbol: string) => ipcRenderer.invoke('instruments:delete', symbol),
  pickInstrumentFile: () => ipcRenderer.invoke('instruments:pickFile'),
  importInstrument: (
    args: { symbol: string; filePath: string; spec: unknown },
    onProgress: (rows: number, monthKey: string) => void,
  ) =>
    new Promise((resolve, reject) => {
      // unique channel per call so overlapping imports (shouldn't normally happen —
      // the UI disables the form while busy — but this avoids any cross-talk if it does)
      const channel = `instruments:import:${Date.now()}:${Math.random().toString(36).slice(2)}`
      const cleanup = () => {
        ipcRenderer.removeAllListeners(`${channel}:progress`)
        ipcRenderer.removeAllListeners(`${channel}:done`)
        ipcRenderer.removeAllListeners(`${channel}:error`)
      }
      ipcRenderer.on(`${channel}:progress`, (_e, p: { rows: number; monthKey: string }) => onProgress(p.rows, p.monthKey))
      ipcRenderer.on(`${channel}:done`, (_e, r: unknown) => { cleanup(); resolve(r) })
      ipcRenderer.on(`${channel}:error`, (_e, err: string) => { cleanup(); reject(new Error(err)) })
      ipcRenderer.send('instruments:import', { ...args, channel })
    }),

  getAppVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (cb: (status: unknown) => void) => {
    const listener = (_e: unknown, status: unknown) => cb(status)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },

  // AI. Keys never leave the main process — the renderer only sees hasKey/set/delete.
  aiHasKey: (provider: string) => ipcRenderer.invoke('ai:hasKey', provider),
  aiSetKey: (provider: string, key: string) => ipcRenderer.invoke('ai:setKey', provider, key),
  aiDeleteKey: (provider: string) => ipcRenderer.invoke('ai:deleteKey', provider),
  aiChat: (req: unknown) => ipcRenderer.invoke('ai:chat', req),
  aiChatStream: (req: unknown, onDelta: (d: string) => void, signal?: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const channel = `ai:chatStream:${Date.now()}:${Math.random().toString(36).slice(2)}`
      let full = ''
      const cleanup = () => {
        ipcRenderer.removeAllListeners(`${channel}:delta`)
        ipcRenderer.removeAllListeners(`${channel}:done`)
        ipcRenderer.removeAllListeners(`${channel}:error`)
      }
      ipcRenderer.on(`${channel}:delta`, (_e, d: string) => { full += d; onDelta(d) })
      ipcRenderer.on(`${channel}:done`, () => { cleanup(); resolve(full) })
      ipcRenderer.on(`${channel}:error`, (_e, err: string) => { cleanup(); reject(new Error(err)) })
      if (signal) {
        signal.addEventListener('abort', () => { ipcRenderer.send(`${channel}:cancel`) }, { once: true })
      }
      ipcRenderer.send('ai:chatStream', { req, channel })
    }),
})
