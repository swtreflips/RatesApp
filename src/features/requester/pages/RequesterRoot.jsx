import React from 'react'
import { Routes, Route } from 'react-router-dom'
import { FilePlus, ClipboardList, CheckSquare, TrendingUp } from 'lucide-react'
import PlaceholderPage from '../../../components/shell/PlaceholderPage'
import { PageHeader, StatCard, SectionCard } from '../../../components/ui/DashboardPrimitives'
import NewRateRequest from './NewRateRequest'

/* ─── Dashboard ───────────────────────────────────────────────────────── */

function RequesterDashboard() {
  const stats = [
    { label: 'Open Requests',  value: '—', icon: ClipboardList, accent: 'harbor' },
    { label: 'Pending Rates',  value: '—', icon: FilePlus,      accent: 'signal' },
    { label: 'Rates Received', value: '—', icon: CheckSquare,   accent: 'sea' },
    { label: 'Active Lanes',   value: '—', icon: TrendingUp,    accent: 'harbor' },
  ]

  return (
    <div className="space-y-7">
      <PageHeader
        kicker="Requester · Overview"
        title="Dashboard"
        subtitle="Overview of your rate requests and incoming quotes."
      />

      {/* Stat cards */}
      <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, accent }, i) => (
          <StatCard key={label} label={label} value={value} icon={Icon} accent={accent} index={i} />
        ))}
      </div>

      {/* Recent activity */}
      <SectionCard title="Recent Requests">
        <PlaceholderPage
          compact
          title="No requests yet"
          description="Create your first rate request to get started. Providers will be notified and can submit quotes."
          phase="Phase 2"
        />
      </SectionCard>
    </div>
  )
}

/* ─── Route mount ─────────────────────────────────────────────────────── */

export default function RequesterRoot() {
  return (
    <Routes>
      <Route index element={<RequesterDashboard />} />
      <Route path="new" element={<NewRateRequest />} />
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
