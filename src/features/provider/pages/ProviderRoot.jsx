import React from 'react'
import { Routes, Route } from 'react-router-dom'
import { Ship, FileText, CheckCircle } from 'lucide-react'
import PlaceholderPage from '../../../components/shell/PlaceholderPage'

/* ─── Dashboard ───────────────────────────────────────────────────────── */

function ProviderDashboard() {
  const stats = [
    { label: 'Open Lanes',       value: '—', icon: Ship,        color: 'text-blue-600',  bg: 'bg-blue-50' },
    { label: 'My Submissions',   value: '—', icon: FileText,    color: 'text-amber-600', bg: 'bg-amber-50' },
    { label: 'Accepted Quotes',  value: '—', icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' },
  ]

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold text-slate-800">Dashboard</h1>
        <p className="mt-0.5 text-sm text-slate-400">
          Overview of open lanes available to quote and your past submissions.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

      {/* Open lanes placeholder */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-slate-600">Open Lanes</h2>
        <PlaceholderPage
          title="No open lanes yet"
          description="When requesters post rate inquiries, matching lanes will appear here for you to quote."
          phase="Phase 3"
        />
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
