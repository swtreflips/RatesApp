import React, { lazy, Suspense } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { Ship, FileText, Loader2 } from 'lucide-react'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'

// Rate-entry grid pulls in MUI X DataGrid — load it only when the route opens.
const SubmitRates = lazy(() => import('./SubmitRates'))
const ActiveRates = lazy(() => import('./ActiveRates'))

/* ─── Dashboard ───────────────────────────────────────────────────────── */

function ProviderDashboard() {
  const navigate = useNavigate()

  const stats = [
    { label: 'Open Requests', value: '—', icon: Ship,     accent: 'harbor', hint: 'Active demand you haven’t acted on' },
    { label: 'Active Rates',  value: '—', icon: FileText, accent: 'sea',    hint: 'Your rates still within their validity' },
  ]

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7">
      <PageHeader
        kicker="Freight Forwarder · Overview"
        title="Dashboard"
        subtitle="Demand that needs your attention and the rates you currently have live."
        actions={
          <button
            onClick={() => navigate('/provider/lanes')}
            className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover"
          >
            <Ship size={16} className="transition-transform group-hover:scale-110" />
            Go to Open Requests
          </button>
        }
      />

      {/* Stat cards */}
      <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2">
        {stats.map(({ label, value, icon: Icon, accent, hint }, i) => (
          <StatCard key={label} label={label} value={value} icon={Icon} accent={accent} hint={hint} index={i} />
        ))}
      </div>
    </div>
  )
}

/* ─── Route mount ─────────────────────────────────────────────────────── */

export default function ProviderRoot() {
  return (
    <Routes>
      <Route index element={<ProviderDashboard />} />
      <Route
        path="lanes"
        element={
          <Suspense fallback={
            <div className="flex min-h-[55vh] items-center justify-center">
              <Loader2 size={26} className="animate-spin text-fog-400" />
            </div>
          }>
            <SubmitRates />
          </Suspense>
        }
      />
      <Route
        path="submissions"
        element={
          <Suspense fallback={
            <div className="flex min-h-[55vh] items-center justify-center">
              <Loader2 size={26} className="animate-spin text-fog-400" />
            </div>
          }>
            <ActiveRates />
          </Suspense>
        }
      />
    </Routes>
  )
}
