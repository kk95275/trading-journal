import { useEffect } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { initSync } from './lib/sync'
import { refreshInstruments } from './lib/instruments'
import { isElectron } from './lib/platform'
import Analytics from './pages/Analytics'
import Backtest from './pages/Backtest'
import CalendarPage from './pages/CalendarPage'
import Dashboard from './pages/Dashboard'
import Journal from './pages/Journal'
import Playbook from './pages/Playbook'
import Settings from './pages/Settings'
import Trades from './pages/Trades'

type NavItem =
  | { kind: 'link'; to: string; label: string; icon: string }
  | { kind: 'section'; label: string }

const NAV: NavItem[] = [
  { kind: 'section', label: 'Live Journal' },
  { kind: 'link', to: '/dashboard', label: 'Dashboard',  icon: '📊' },
  { kind: 'link', to: '/trades',    label: 'Trades',     icon: '📋' },
  { kind: 'link', to: '/analytics', label: 'Analytics',  icon: '📈' },
  { kind: 'link', to: '/calendar',  label: 'Calendar',   icon: '🗓️' },
  { kind: 'link', to: '/journal',   label: 'Journal',    icon: '📝' },
  { kind: 'link', to: '/playbook',  label: 'Playbook',   icon: '📖' },
  { kind: 'section', label: 'Backtesting' },
  { kind: 'link', to: '/backtest',  label: 'Backtest',   icon: '📉' },
]

export default function App() {
  useEffect(() => { void initSync(); void refreshInstruments() }, [])

  return (
    <div className="flex h-full">
      <aside className="w-52 shrink-0 border-r border-hairline bg-surface flex flex-col">
        {/* Brand */}
        <div className="px-4 py-4 border-b border-hairline">
          <div className="text-ink font-semibold leading-tight">Trading Journal</div>
          <div className="text-[11px] text-muted mt-0.5">Professional trade journaling</div>
        </div>

        {/* Navigation */}
        <nav className="p-2 flex-1 space-y-0.5 overflow-y-auto">
          {NAV.map((item, i) =>
            item.kind === 'section' ? (
              <div key={i} className="px-3 pt-3 pb-1 text-[10px] font-semibold text-muted uppercase tracking-widest">
                {item.label}
              </div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive ? 'bg-accent/15 text-ink font-medium' : 'text-ink2 hover:bg-white/5'
                  }`
                }
              >
                <span className="text-base leading-none">{item.icon}</span>
                {item.label}
              </NavLink>
            ),
          )}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-hairline">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive ? 'bg-accent/15 text-ink font-medium' : 'text-ink2 hover:bg-white/5'
              }`
            }
          >
            <span className="text-base leading-none">⚙️</span>
            Settings
          </NavLink>
          <div className="text-[11px] text-muted mt-2 px-3">
            {isElectron
              ? 'Local only · auto-saved to your app data'
              : 'Local only · auto-saved to data-journal folder'}
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard"  element={<Dashboard />} />
          <Route path="/trades"     element={<Trades />} />
          <Route path="/analytics"  element={<Analytics />} />
          <Route path="/calendar"   element={<CalendarPage />} />
          <Route path="/journal"    element={<Journal />} />
          <Route path="/playbook"   element={<Playbook />} />
          <Route path="/backtest"   element={<Backtest />} />
          <Route path="/settings"   element={<Settings />} />
        </Routes>
      </main>
    </div>
  )
}
