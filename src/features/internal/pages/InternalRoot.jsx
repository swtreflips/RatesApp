import React, { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom'
import { FilePlus, ClipboardList, CheckSquare, Loader2 } from 'lucide-react'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'
import ServiceGuard from '../../../app/ServiceGuard'

// The lane-entry grid pulls in MUI X DataGrid (the bulk of the bundle), so it
// is loaded on demand only when a grid route is opened.
const NewRateRequest = lazy(() => import('./NewRateRequest'))
const OpenRequests = lazy(() => import('./OpenRequests'))
const ReceivedRates = lazy(() => import('./ReceivedRates'))
const UploadRates = lazy(() => import('./UploadRates'))
const ApplyRates = lazy(() => import('./ApplyRates'))
const Bookings = lazy(() => import('./Bookings'))
const AnalyticsHub = lazy(() => import('./AnalyticsHub'))
const DrayageAnalytics = lazy(() => import('./DrayageAnalytics'))
const DrayageNewRequest = lazy(() => import('../../drayage/pages/DrayageNewRequest'))
const DrayageOpenRequests = lazy(() => import('../../drayage/pages/DrayageOpenRequests'))
const DrayageReceivedRates = lazy(() => import('../../drayage/pages/DrayageReceivedRates'))
const DrayageUploadRates = lazy(() => import('../../drayage/pages/DrayageUploadRates'))

/* Per-service page components for each route slot (DRAY.md §3). Ocean and drayage
   pages are separate implementations — their columns and validity models differ
   materially — mounted under the same :service route shape. */
const PAGES = {
  ocean: { new: NewRateRequest, requests: OpenRequests, rates: ReceivedRates, upload: UploadRates },
  drayage: { new: DrayageNewRequest, requests: DrayageOpenRequests, rates: DrayageReceivedRates, upload: DrayageUploadRates },
}

function ServicePage({ slot }) {
  const { service } = useParams()
  const Page = PAGES[service]?.[slot]
  return Page ? <Page /> : <Navigate to="/internal" replace />
}

/* ─── Dashboard ───────────────────────────────────────────────────────── */

function InternalDashboard() {
  const navigate = useNavigate()

  const stats = [
    { label: 'Open Requests',  value: '—', icon: ClipboardList, accent: 'harbor', hint: 'Active lanes within their 10-day window' },
    { label: 'Rates Received', value: '—', icon: CheckSquare,   accent: 'sea',    hint: 'Quotes submitted by forwarders' },
  ]

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7">
      <PageHeader
        kicker="Internal · Overview"
        title="Dashboard"
        subtitle="Overview of your rate requests and incoming quotes."
        actions={
          <button
            onClick={() => navigate('/internal/ocean/new')}
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

/** Suspense wrapper for the lazy page chunks. */
function Lazy({ children }) {
  return (
    <Suspense fallback={
      <div className="flex min-h-[55vh] items-center justify-center">
        <Loader2 size={26} className="animate-spin text-fog-400" />
      </div>
    }>
      {children}
    </Suspense>
  )
}

export default function InternalRoot() {
  return (
    <Routes>
      <Route index element={<InternalDashboard />} />

      {/* Service-parameterized pages (DRAY.md §3 / Diagram C). The guard rejects
          unknown/inaccessible service slugs; ServicePage mounts that service's
          implementation of the slot. */}
      <Route path=":service/new" element={<ServiceGuard fallbackTo="/internal"><Lazy><ServicePage slot="new" /></Lazy></ServiceGuard>} />
      <Route path=":service/requests" element={<ServiceGuard fallbackTo="/internal"><Lazy><ServicePage slot="requests" /></Lazy></ServiceGuard>} />
      <Route path=":service/rates" element={<ServiceGuard fallbackTo="/internal"><Lazy><ServicePage slot="rates" /></Lazy></ServiceGuard>} />
      <Route path=":service/upload" element={<ServiceGuard fallbackTo="/internal"><Lazy><ServicePage slot="upload" /></Lazy></ServiceGuard>} />

      {/* Apply Rates is an ocean-specific tool (DRAY.md §3a) — stays unparameterized */}
      <Route path="apply" element={<Lazy><ApplyRates /></Lazy>} />

      {/* Bookings is cross-service (ocean + drayage), so it sits outside both service groups */}
      <Route path="bookings" element={<Lazy><Bookings /></Lazy>} />

      {/* Analytics hub (cross-service) → per-service pages. Ocean deferred (DRAYAGE_ANALYTICS.md) */}
      <Route path="analytics" element={<Lazy><AnalyticsHub /></Lazy>} />
      <Route path="analytics/drayage" element={<Lazy><DrayageAnalytics /></Lazy>} />

      {/* Legacy flat paths → ocean (pre-service bookmarks keep working) */}
      <Route path="new" element={<Navigate to="/internal/ocean/new" replace />} />
      <Route path="requests" element={<Navigate to="/internal/ocean/requests" replace />} />
      <Route path="rates" element={<Navigate to="/internal/ocean/rates" replace />} />
      <Route path="upload" element={<Navigate to="/internal/ocean/upload" replace />} />
    </Routes>
  )
}
