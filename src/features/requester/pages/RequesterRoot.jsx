import React from 'react'
import { Routes, Route } from 'react-router-dom'
import { FilePlus, ClipboardList, CheckSquare, TrendingUp } from 'lucide-react'
import PlaceholderPage from '../../../components/shell/PlaceholderPage'
import NewRateRequest from './NewRateRequest'

/* ─── Dashboard ───────────────────────────────────────────────────────── */

function RequesterDashboard() {
  const stats = [
    { label: 'Open Requests',    value: '—', icon: ClipboardList, color: 'text-blue-600',   bg: 'bg-blue-50' },
    { label: 'Pending Rates',    value: '—', icon: FilePlus,      color: 'text-amber-600',  bg: 'bg-amber-50' },
    { label: 'Rates Received',   value: '—', icon: CheckSquare,   color: 'text-green-600',  bg: 'bg-green-50' },
    { label: 'Active Lanes',     value: '—', icon: TrendingUp,    color: 'text-purple-600', bg: 'bg-purple-50' },
  ]

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold text-slate-800">Dashboard</h1>
        <p className="mt-0.5 text-sm text-slate-400">
          Overview of your rate requests and incoming quotes.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${bg}`}>
                <Icon size={18} strokeWidth={1.75} className={color} />
              </span>
              <div>
                <p className="text-xs font-medium text-slate-400">{label}</p>
                <p className="text-2xl font-bold text-slate-700">{value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Recent activity placeholder */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-slate-600">Recent Requests</h2>
        <PlaceholderPage
          title="No requests yet"
          description="Create your first rate request to get started. Providers will be notified and can submit quotes."
          phase="Phase 2"
        />
      </div>
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
