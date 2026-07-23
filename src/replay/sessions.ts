// Sessions indicator (port of the "COMPLETE Sessions" Pine study + Karim's custom
// Dubai-time killzones). All session times are stored internally as GMT minutes-of-day
// (the dataset is GMT, no DST); the editor converts to/from a display timezone.

export interface SessionDef {
  id: string
  name: string
  startMin: number // GMT minutes of day, 0..1439
  endMin: number   // exclusive; start > end means the session crosses midnight
  color: string
  enabled: boolean
}

export interface SessionsConfig {
  enabled: boolean
  mode: 'bg' | 'hl' // background shading, or running high/low bands (Pine "High/Low View")
  displayTzMin: number // timezone offset (minutes) used by the editor UI only
  sessions: SessionDef[]
}

export const SESSION_COLORS = ['#0ca30c', '#d03b3b', '#eda100', '#1c5cab', '#3987e5', '#eb6834', '#9085e9', '#898781']

export const TZ_CHOICES = [
  { label: 'GMT (chart time)', offset: 0 },
  { label: 'Dubai (GMT+4)', offset: 240 },
  { label: 'New York winter (GMT-5)', offset: -300 },
  { label: 'New York summer (GMT-4)', offset: -240 },
]

// Killzones given in Dubai time (GMT+4), stored here converted to GMT.
export const KILLZONE_SESSIONS: SessionDef[] = [
  { id: 'kz-asia1', name: 'Asia 1', startMin: 60, endMin: 120, color: '#eda100', enabled: true },     // 05:00-06:00 Dubai
  { id: 'kz-asia2', name: 'Asia 2', startMin: 180, endMin: 240, color: '#eb6834', enabled: true },    // 07:00-08:00 Dubai
  { id: 'kz-london1', name: 'London 1', startMin: 360, endMin: 480, color: '#0ca30c', enabled: true },// 10:00-12:00 Dubai
  { id: 'kz-ny1', name: 'NY 1', startMin: 720, endMin: 780, color: '#d03b3b', enabled: true },        // 16:00-17:00 Dubai
  { id: 'kz-ny2', name: 'NY 2', startMin: 840, endMin: 900, color: '#9085e9', enabled: true },        // 18:00-19:00 Dubai
]

// Classic sessions from the Pine defaults (given there in New York winter time), in GMT.
export const CLASSIC_SESSIONS: SessionDef[] = [
  { id: 'cl-london', name: 'London', startMin: 480, endMin: 1020, color: '#0ca30c', enabled: true },  // 08:00-17:00 GMT
  { id: 'cl-ny', name: 'New York', startMin: 780, endMin: 1320, color: '#d03b3b', enabled: true },    // 13:00-22:00 GMT
  { id: 'cl-tokyo', name: 'Tokyo', startMin: 0, endMin: 540, color: '#eda100', enabled: true },       // 00:00-09:00 GMT
  { id: 'cl-sydney', name: 'Sydney', startMin: 1320, endMin: 420, color: '#1c5cab', enabled: false }, // 22:00-07:00 GMT
]

const clone = (s: SessionDef[]) => s.map(x => ({ ...x }))

export function defaultSessionsConfig(): SessionsConfig {
  return { enabled: true, mode: 'bg', displayTzMin: 240, sessions: clone(KILLZONE_SESSIONS) }
}

export function presetSessions(which: 'killzones' | 'classic'): SessionDef[] {
  return clone(which === 'killzones' ? KILLZONE_SESSIONS : CLASSIC_SESSIONS)
}

export function inSession(tsSec: number, s: SessionDef): boolean {
  const m = Math.floor(tsSec / 60) % 1440
  return s.startMin <= s.endMin ? m >= s.startMin && m < s.endMin : m >= s.startMin || m < s.endMin
}

export const minToStr = (m: number) => {
  const mm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`
}

export const strToMin = (s: string) => {
  const [h, m] = s.split(':').map(Number)
  return (((h || 0) * 60 + (m || 0)) % 1440 + 1440) % 1440
}
