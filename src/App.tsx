import { useEffect } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { initSync } from './lib/sync'
import { refreshInstruments } from './lib/instruments'
import { isElectron } from './lib/platform'
import Backtest from './pages/Backtest'
import Dashboard from './pages/Dashboard'
import Trades from './pages/Trades'
import CalendarPage from './pages/CalendarPage'
import Journal from './pages/Journal'
import Playbook from './pages/Playbook'
import Settings from './pages/Settings'

const NAV = [
  { to: '/backtest', label: 'Backtest', icon: '📉' },
  { to: '/dashboard', label: 'Dashboard', icon: '📊' },
  { to: '/trades', label: 'Trades', icon: '📋' },
  { to: '/calendar', label: 'Calendar', icon: '🗓️' },
  { to: '/journal', label: 'Journal', icon: '📝' },
  { to: '/playbook', label: 'Playbook', icon: '📖' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
]

export default function App() {
  useEffect(() => { void initSync(); void refreshInstruments() }, [])
  return (
    <div className="flex h-full">
      <aside className="w-52 shrink-0 border-r border-hairline bg-surface flex flex-col">
        <div className="px-4 py-4 border-b border-hairline">
          <div className="text-ink font-semibold leading-tight">Trading Journal</div>
          <div className="text-[11px] text-muted mt-0.5">Bar-replay backtester</div>
        </div>
        <nav className="p-2 space-y-0.5 flex-1">
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive ? 'bg-accent/15 text-ink font-medium' : 'text-ink2 hover:bg-white/5'
                }`
              }
            >
              <span className="text-base leading-none">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-3 text-[11px] text-muted border-t border-hairline">
          {isElectron ? 'Local only · auto-saved to your app data folder' : 'Local only · auto-saved to the data-journal folder'}
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/backtest" replace />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/trades" element={<Trades />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/journal" element={<Journal />} />
          <Route path="/playbook" element={<Playbook />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  )
}
