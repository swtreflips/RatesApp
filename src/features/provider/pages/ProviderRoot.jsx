import React from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { Ship, FileText } from 'lucide-react'
import PlaceholderPage from '../../../components/shell/PlaceholderPage'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'

/* ─── Dashboard ───────────────────────────────────────────────────────── */

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
            title="Pending Lanes"
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
