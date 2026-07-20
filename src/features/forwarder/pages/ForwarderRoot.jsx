import React, { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom'
import { Ship, FileText, Loader2 } from 'lucide-react'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'
import ServiceGuard from '../../../app/ServiceGuard'
import { useAuth } from '../../../app/providers/AuthProvider'
import { serviceConfig } from '../../rates/serviceConfig'

// Rate-entry grid pulls in MUI X DataGrid — load it only when the route opens.
const SubmitRates = lazy(() => import('./SubmitRates'))
const ActiveRates = lazy(() => import('./ActiveRates'))
const DrayageSubmitRates = lazy(() => import('../../drayage/pages/DrayageSubmitRates'))
const DrayageActiveRates = lazy(() => import('../../drayage/pages/DrayageActiveRates'))

/* Per-service page components (DRAY.md §3) — same route shape, service-specific pages. */
const PAGES = {
  ocean: { lanes: SubmitRates, submissions: ActiveRates },
  drayage: { lanes: DrayageSubmitRates, submissions: DrayageActiveRates },
}

function ServicePage({ slot }) {
  const { service } = useParams()
  const Page = PAGES[service]?.[slot]
  return Page ? <Page /> : <Navigate to="/forwarder" replace />
}

/* ─── Dashboard ───────────────────────────────────────────────────────── */

function ForwarderDashboard() {
  const navigate = useNavigate()
  const { services } = useAuth()

  /* The dashboard sits ABOVE the :service route segment, so it has no service
     param to read — it must derive one. Targeting the company's first capability
     (serviceConfig order) instead of assuming ocean: a drayage-only forwarder
     would otherwise be sent to /forwarder/ocean/lanes and silently bounced back
     here by ServiceGuard. */
  const primary = services.find((slug) => serviceConfig[slug])
  const primaryCfg = primary ? serviceConfig[primary] : null
  const PrimaryIcon = primaryCfg?.icon ?? Ship

  const stats = [
    { label: 'Open Requests', value: '—', icon: PrimaryIcon, accent: 'harbor', hint: 'Active demand you haven’t acted on' },
    { label: 'Active Rates',  value: '—', icon: FileText, accent: 'sea',    hint: 'Your rates still within their validity' },
  ]

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7">
      <PageHeader
        kicker="Freight Forwarder · Overview"
        title="Dashboard"
        subtitle="Demand that needs your attention and the rates you currently have live."
        actions={
          primaryCfg && (
            <button
              onClick={() => navigate(`/forwarder/${primary}/lanes`)}
              className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover"
            >
              <PrimaryIcon size={16} className="transition-transform group-hover:scale-110" />
              Go to {primaryCfg.nav?.openRequests ?? 'Open Requests'}
            </button>
          )
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

export default function ForwarderRoot() {
  return (
    <Routes>
      <Route index element={<ForwarderDashboard />} />

      {/* Service-parameterized pages (DRAY.md §3 / Diagram C). The guard also
          enforces the company's forwarder_services capability. */}
      <Route path=":service/lanes" element={<ServiceGuard fallbackTo="/forwarder"><Lazy><ServicePage slot="lanes" /></Lazy></ServiceGuard>} />
      <Route path=":service/submissions" element={<ServiceGuard fallbackTo="/forwarder"><Lazy><ServicePage slot="submissions" /></Lazy></ServiceGuard>} />

      {/* Legacy flat paths → ocean (pre-service bookmarks keep working) */}
      <Route path="lanes" element={<Navigate to="/forwarder/ocean/lanes" replace />} />
      <Route path="submissions" element={<Navigate to="/forwarder/ocean/submissions" replace />} />
    </Routes>
  )
}
