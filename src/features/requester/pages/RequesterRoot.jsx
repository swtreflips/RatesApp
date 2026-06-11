import React, { lazy, Suspense } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { FilePlus, ClipboardList, CheckSquare, Upload, ListChecks, Loader2 } from 'lucide-react'
import PlaceholderPage from '../../../components/shell/PlaceholderPage'
import { PageHeader, StatCard, SectionCard, QuickActions } from '../../../components/ui/DashboardPrimitives'

// The lane-entry grid pulls in MUI X DataGrid (the bulk of the bundle), so it
// is loaded on demand only when the New Rate Request route is opened.
const NewRateRequest = lazy(() => import('./NewRateRequest'))

/* ─── Dashboard ───────────────────────────────────────────────────────── */

const REQUESTER_QUICK_ACTIONS = [
  { label: 'New Rate Request', to: '/requester/new',      icon: FilePlus },
  { label: 'Upload lanes (CSV)', to: '/requester/new',    icon: Upload },
  { label: 'View received rates', to: '/requester/rates', icon: ListChecks },
]

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

      {/* Attention panel + side column */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionCard title="Lanes Expiring Soon">
            <PlaceholderPage
              compact
              title="No active lanes yet"
              description="Create a rate request to get started. Lanes nearing the end of their 10-day window will surface here so you can extend or chase them."
              phase="Phase 2"
            />
          </SectionCard>
        </div>

        <div className="space-y-6 lg:col-span-1">
          <SectionCard title="Recent Rates">
            <PlaceholderPage
              compact
              title="No rates received yet"
              description="Quotes from forwarders will appear here as they come in."
              phase="Phase 2"
            />
          </SectionCard>
          <QuickActions items={REQUESTER_QUICK_ACTIONS} />
        </div>
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
            title="My Requests"
            description="View and manage all your open and historical rate requests."
            phase="Phase 2"
          />
        }
      />
      <Route
        path="rates"
        element={
          <PlaceholderPage
            title="Received Rates"
            description="Review and compare quotes submitted by freight forwarders."
            phase="Phase 2"
          />
        }
      />
    </Routes>
  )
}
