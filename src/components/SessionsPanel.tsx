// Editor for the Sessions indicator. Times are typed/displayed in the chosen timezone
// but stored in GMT (dataset time).
import { minToStr, presetSessions, SESSION_COLORS, strToMin, TZ_CHOICES, type SessionsConfig } from '../replay/sessions'

interface Props {
  config: SessionsConfig
  onChange: (c: SessionsConfig) => void
  onClose: () => void
}

export default function SessionsPanel({ config, onChange, onClose }: Props) {
  const tz = config.displayTzMin
  const upd = (patch: Partial<SessionsConfig>) => onChange({ ...config, ...patch })
  const updSession = (id: string, patch: object) =>
    upd({ sessions: config.sessions.map(s => (s.id === id ? { ...s, ...patch } : s)) })

  return (
    <div className="absolute left-4 top-full mt-1 z-30 w-[560px] card shadow-2xl border-white/20 max-h-[70vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink">Sessions indicator</h3>
        <button className="text-muted hover:text-ink text-lg leading-none" onClick={onClose}>×</button>
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="flex items-center gap-1.5 text-xs text-ink2 cursor-pointer">
          <input type="checkbox" className="accent-[#3987e5]" checked={config.enabled} onChange={e => upd({ enabled: e.target.checked })} />
          Show sessions
        </label>
        <div className="flex gap-1 ml-2">
          <button className={`tab ${config.mode === 'bg' ? 'tab-on' : 'tab-off'}`} onClick={() => upd({ mode: 'bg' })}>Background</button>
          <button className={`tab ${config.mode === 'hl' ? 'tab-on' : 'tab-off'}`} onClick={() => upd({ mode: 'hl' })}>High/Low bands</button>
        </div>
        <select
          className="input !w-auto !py-1 text-xs ml-auto"
          value={tz}
          onChange={e => upd({ displayTzMin: +e.target.value })}
          title="Timezone used for typing/displaying the times below (stored internally in GMT)"
        >
          {TZ_CHOICES.map(t => <option key={t.offset} value={t.offset}>{t.label}</option>)}
        </select>
      </div>

      <div className="space-y-1.5 mb-3">
        {config.sessions.map(s => (
          <div key={s.id} className="flex items-center gap-2">
            <input type="checkbox" className="accent-[#3987e5]" checked={s.enabled} onChange={e => updSession(s.id, { enabled: e.target.checked })} />
            <input className="input !w-28 !py-1 text-xs" value={s.name} onChange={e => updSession(s.id, { name: e.target.value })} />
            <input
              type="time" className="input !w-auto !py-1 text-xs"
              value={minToStr(s.startMin + tz)}
              onChange={e => e.target.value && updSession(s.id, { startMin: (strToMin(e.target.value) - tz + 1440) % 1440 })}
            />
            <span className="text-muted text-xs">→</span>
            <input
              type="time" className="input !w-auto !py-1 text-xs"
              value={minToStr(s.endMin + tz)}
              onChange={e => e.target.value && updSession(s.id, { endMin: (strToMin(e.target.value) - tz + 1440) % 1440 })}
            />
            <div className="flex gap-0.5">
              {SESSION_COLORS.map(c => (
                <button
                  key={c}
                  className={`w-4 h-4 rounded-full border ${s.color === c ? 'border-white' : 'border-transparent'}`}
                  style={{ background: c }}
                  onClick={() => updSession(s.id, { color: c })}
                />
              ))}
            </div>
            <button className="text-muted hover:text-down text-sm ml-auto" title="Remove" onClick={() => upd({ sessions: config.sessions.filter(x => x.id !== s.id) })}>✕</button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 items-center border-t border-hairline pt-3">
        <button
          className="btn-ghost text-xs"
          onClick={() => upd({
            sessions: [...config.sessions, {
              id: `s${Date.now() % 1e7}`, name: 'Session', startMin: (600 - tz + 1440) % 1440,
              endMin: (660 - tz + 1440) % 1440, color: SESSION_COLORS[config.sessions.length % SESSION_COLORS.length], enabled: true,
            }],
          })}
        >
          + Add session
        </button>
        <div className="flex-1" />
        <button className="btn-ghost text-xs" onClick={() => upd({ sessions: presetSessions('killzones'), displayTzMin: 240 })}>Load my killzones (Dubai)</button>
        <button className="btn-ghost text-xs" onClick={() => upd({ sessions: presetSessions('classic'), displayTzMin: 0 })}>Load classic sessions</button>
      </div>
      <p className="text-[11px] text-muted mt-2">Killzones preset (Dubai time): Asia 05–06 & 07–08 · London 10–12 · NY 16–17 & 18–19. Chart itself stays in GMT.</p>
    </div>
  )
}
