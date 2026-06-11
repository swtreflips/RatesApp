import React, { lazy, Suspense } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { FilePlus, ClipboardList, CheckSquare, Loader2 } from 'lucide-react'
import PlaceholderPage from '../../../components/shell/PlaceholderPage'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'

// The lane-entry grid pulls in MUI X DataGrid (the bulk of the bundle), so it
// is loaded on demand only when the New Rate Request route is opened.
const NewRateRequest = lazy(() => import('./NewRateRequest'))

/* ─── Dashboard ───────────────────────────────────────────────────────── */

function RequesterDashboard() {
  const navigate = useNavigate()

  const stats = [
    { label: 'Open Requests',  value: '—', icon: ClipboardList, accent: 'harbor', hint: 'Active lanes within their 10-day window' },
    { label: 'Rates Received', value: '—', icon: CheckSquare,   accent: 'sea',    hint: 'Quotes submitted by forwarders' },
  ]

  return (
    <div className="space-y-7">
      <PageHeader
        kicker="Requester · Overview"
        title="Dashboard"
        subtitle="Overview of your rate requests and incoming quotes."
        actions={
          <button
            onClick={() => navigate('/requester/new')}
            className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover"
          >
            <FilePlus size={16} className="transition-transform group-hover:scale-110" />
            New Rate Request
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

export default function RequesterRoot() {
  return (
    <Routes>
      <Route index element={<RequesterDashboard />} />
      <Route
        path="new"
        element={
          <Suspense fallback={
            <div className="flex min-h-[55vh] items-center justify-center">
              <Loader2 size={26} className="animate-spin text-fog-400" />
            </div>
          }>
            <NewRateRequest />
          </Suspense>
        }
      />
      <Route
        path="requests"
        element={
          <PlaceholderPage
            title="Open Requests"
            description="Your active rate request lanes — templates still within their 10-day window."
            phase="Phase 2"
          />
        }
      />
      <Route
        path="rates"
        element={
          <PlaceholderPage
            title="Active Rates"
            description="Rates submitted by freight forwarders that are still within their validity period."
            phase="Phase 2"
          />
        }
      />
    </Routes>
  )
}
