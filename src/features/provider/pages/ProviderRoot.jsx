import React from 'react'
import { Routes, Route } from 'react-router-dom'
import { Ship, FileText, CheckCircle } from 'lucide-react'
import PlaceholderPage from '../../../components/shell/PlaceholderPage'
import { PageHeader, StatCard, SectionCard } from '../../../components/ui/DashboardPrimitives'

/* ─── Dashboard ───────────────────────────────────────────────────────── */

function ProviderDashboard() {
  const stats = [
    { label: 'Open Lanes',      value: '—', icon: Ship,        accent: 'harbor' },
    { label: 'My Submissions',  value: '—', icon: FileText,    accent: 'signal' },
    { label: 'Accepted Quotes', value: '—', icon: CheckCircle, accent: 'sea' },
  ]

  return (
    <div className="space-y-7">
      <PageHeader
        kicker="Freight Forwarder · Overview"
        title="Dashboard"
        subtitle="Overview of open lanes available to quote and your past submissions."
      />

      {/* Stat cards */}
      <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map(({ label, value, icon: Icon, accent }, i) => (
          <StatCard key={label} label={label} value={value} icon={Icon} accent={accent} index={i} />
        ))}
      </div>

      {/* Open lanes */}
      <SectionCard title="Open Lanes">
        <PlaceholderPage
          compact
          title="No open lanes yet"
          description="When requesters post rate inquiries, matching lanes will appear here for you to quote."
          phase="Phase 3"
        />
      </SectionCard>
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
            title="Open Lanes"
            description="Browse and filter open rate request lanes available to quote."
            phase="Phase 3"
          />
        }
      />
      <Route
        path="submissions"
        element={
          <PlaceholderPage
            title="My Submissions"
            description="Review all rate quotes you have submitted across all lanes."
            phase="Phase 3"
          />
        }
      />
    </Routes>
  )
}
