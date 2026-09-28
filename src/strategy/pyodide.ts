// Lazy Pyodide loader. First Run click on the Strategies page pulls the
// runtime + Python stdlib from Cloudflare CDN (~10 MB) and caches it in the
// browser's HTTP cache; subsequent runs boot in ~1-2 seconds. The loader is
// deliberately kept small — the strategy runner and page only see a plain
// {runPython, callFunction, isReady} surface.

// Pyodide version pinned so we don't get surprise breaking changes on cdnjs.
// NB: cdnjs mirrors pyodide with a FLAT layout (no `/full/` subdirectory) —
// files like pyodide.js and pyodide.asm.wasm sit directly under the version
// directory. jsdelivr uses `/full/` but cdnjs doesn't.
const PYODIDE_VERSION = '0.28.3'
const PYODIDE_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pyodide/${PYODIDE_VERSION}/`
const PYODIDE_JS = `${PYODIDE_BASE}pyodide.js`

// Pyodide attaches loadPyodide to window; we don't want to fight the global.
declare global {
  interface Window {
    loadPyodide?: (opts: { indexURL: string; stdout?: (s: string) => void; stderr?: (s: string) => void }) => Promise<PyodideRuntime>
  }
}

export interface PyodideRuntime {
  runPython: (code: string) => unknown
  runPythonAsync: (code: string) => Promise<unknown>
  globals: {
    get: (name: string) => any
    set: (name: string, value: unknown) => void
  }
  toPy: (obj: unknown) => any
  registerJsModule: (name: string, module: object) => void
}

export type LoadPhase = 'idle' | 'downloading-loader' | 'booting-runtime' | 'ready' | 'error'
export interface LoadStatus { phase: LoadPhase; message: string; error?: string }

let runtimePromise: Promise<PyodideRuntime> | null = null
let statusListeners = new Set<(s: LoadStatus) => void>()
let lastStatus: LoadStatus = { phase: 'idle', message: 'Python runtime not loaded yet' }

function setStatus(s: LoadStatus) {
  lastStatus = s
  for (const fn of statusListeners) fn(s)
}

export function onPyodideStatus(fn: (s: LoadStatus) => void): () => void {
  statusListeners.add(fn)
  fn(lastStatus)
  return () => { statusListeners.delete(fn) }
}

export function pyodideStatus(): LoadStatus { return lastStatus }

/** Get (loading if needed) the shared Pyodide runtime. Safe to call many times. */
export function loadPyodideRuntime(): Promise<PyodideRuntime> {
  if (runtimePromise) return runtimePromise
  runtimePromise = (async () => {
    try {
      if (!window.loadPyodide) {
        setStatus({ phase: 'downloading-loader', message: `Downloading Python runtime (${PYODIDE_VERSION})…` })
        await injectScript(PYODIDE_JS)
      }
      if (!window.loadPyodide) throw new Error('Pyodide script loaded but loadPyodide is undefined')
      setStatus({ phase: 'booting-runtime', message: 'Starting Python interpreter…' })
      const py = await window.loadPyodide({
        indexURL: PYODIDE_BASE,
        stdout: (s: string) => { console.log('[py]', s) },
        stderr: (s: string) => { console.warn('[py]', s) },
      })
      setStatus({ phase: 'ready', message: `Python ${PYODIDE_VERSION} ready` })
      return py
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      setStatus({ phase: 'error', message: 'Failed to load Python runtime', error: msg })
      // Clear so a retry can happen on next call.
      runtimePromise = null
      throw e
    }
  })()
  return runtimePromise
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true })
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(s)
  })
}
