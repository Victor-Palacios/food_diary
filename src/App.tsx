import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { AuthGate } from './components/AuthGate'
import { UpdateBanner } from './components/UpdateBanner'
import { AppDataProvider, useAppData } from './lib/AppData'
import { TodayPage } from './pages/TodayPage'
import { FoodsPage } from './pages/FoodsPage'
import { DashboardPage } from './pages/DashboardPage'
import { SettingsPage } from './pages/SettingsPage'
import { IconFoods, IconSettings, IconStats, IconToday } from './components/Icons'
import { CONFIG_ERROR } from './lib/config'

function ConfigError({ message }: { message: string }) {
  return (
    <div className="center-screen">
      <div className="auth-card">
        <div className="auth-title">Food Log</div>
        <div className="card">
          <div className="notice error">{message}</div>
          <div className="sub">
            Copy <code>.env.example</code> to <code>.env.local</code> and fill in the
            Supabase project URL and anon key, then rebuild. On Cloudflare these are set
            as build variables on the Worker.
          </div>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  if (CONFIG_ERROR) return <ConfigError message={CONFIG_ERROR} />

  return (
    <>
      <UpdateBanner />
      <AuthGate>
        <AppDataProvider>
          <BrowserRouter>
            <Shell />
          </BrowserRouter>
        </AppDataProvider>
      </AuthGate>
    </>
  )
}

function Shell() {
  const { loading, error } = useAppData()

  return (
    <div className="app">
      <main className="main">
        {error ? <div className="notice error">{error}</div> : null}
        {loading ? (
          <div className="spinner" />
        ) : (
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/foods" element={<FoodsPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>

      {/* Bottom bar: every destination sits inside thumb reach. */}
      <nav className="nav">
        <NavLink to="/" end>
          <IconToday />
          Today
        </NavLink>
        <NavLink to="/foods">
          <IconFoods />
          Foods
        </NavLink>
        <NavLink to="/dashboard">
          <IconStats />
          Stats
        </NavLink>
        <NavLink to="/settings">
          <IconSettings />
          Settings
        </NavLink>
      </nav>
    </div>
  )
}
