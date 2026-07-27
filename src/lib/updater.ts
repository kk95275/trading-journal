// Auto-update, Electron-only. No-ops entirely in a plain browser tab (npm run dev) — an
// installer-based update concept doesn't exist there. See electron/main.cts for the
// autoUpdater wiring this talks to over IPC.
import { useEffect, useState } from 'react'
import { isElectron, type UpdaterStatus } from './platform'

export type { UpdaterStatus }

export function getAppVersion(): Promise<string | null> {
  return isElectron ? window.electronAPI!.getAppVersion() : Promise.resolve(null)
}

export function checkForUpdates(): Promise<void> {
  return isElectron ? window.electronAPI!.checkForUpdates() : Promise.resolve()
}

export function installUpdate(): Promise<void> {
  return isElectron ? window.electronAPI!.installUpdate() : Promise.resolve()
}

export function useUpdaterStatus(): UpdaterStatus {
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' })
  useEffect(() => {
    if (!isElectron) return
    return window.electronAPI!.onUpdaterStatus(setStatus)
  }, [])
  return status
}
