import React from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { Ship, FileText } from 'lucide-react'
import PlaceholderPage from '../../../components/shell/PlaceholderPage'
import { PageHeader, StatCard, SectionCard, QuickActions } from '../../../components/ui/DashboardPrimitives'

/* ─── Dashboard ───────────────────────────────────────────────────────── */

const PROVIDER_QUICK_ACTIONS = [
  { label: 'Go to Lanes to Fill', to: '/provider/lanes',       icon: Ship },
  { label: 'View active rates',   to: '/provider/submissions', icon: FileText },
]

function ProviderDashboard() {
  const navigate = useNavigate()

  const stats = [
    { label: 'Lanes to Fill', value: '—', icon: Ship,     accent: 'harbor', hint: 'Active demand you haven’t acted on' },
    { label: 'Active Rates',  value: '—', icon: FileText, accent: 'sea',    hint: 'Your rates still within their validity' },
  ]

  return (
    <div className="space-y-7">
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
            Go to Lanes to Fill
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
          <SectionCard title="Lanes to Fill — Expiring Soon">
            <PlaceholderPage
              compact
              title="No lanes to fill right now"
              description="When requesters post lanes, the ones nearing the end of their 10-day window appear here first so you can quote before they expire."
              phase="Phase 3"
            />
          </SectionCard>
        </div>

        <div className="space-y-6 lg:col-span-1">
          <SectionCard title="Rates Expiring Soon">
            <PlaceholderPage
              compact
              title="No active rates yet"
              description="Rates you submit will show here, with the ones closest to their validity end surfaced first."
              phase="Phase 3"
            />
          </SectionCard>
          <QuickActions items={PROVIDER_QUICK_ACTIONS} />
        </div>
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
          <PlaceholderPage
            title="Lanes to Fill"
            description="Active lanes you haven’t acted on yet. Quote or skip each to clear it from your list."
            phase="Phase 3"
          />
        }
      />
      <Route
        path="submissions"
        element={
          <PlaceholderPage
            title="Active Rates"
            description="The rates you currently have live — your latest bid per routing while still within its validity."
            phase="Phase 3"
          />
        }
      />
    </Routes>
  )
}
