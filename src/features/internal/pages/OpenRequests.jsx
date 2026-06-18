import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, ClipboardList, RefreshCw, FilePlus } from 'lucide-react'
import { PageHeader, ScrollTable } from '../../../components/ui/DashboardPrimitives'
import { fetchOpenRequests } from '../services/rateRequestService'

/*
  Requester "Open Requests" — active rate-request lanes still within their 10-day
  window, with a count of rates received on each. Shared across the requester team
  (RLS scopes lanes to current_role_is('internal')). Minimal: a flat table, soonest
  to expire first. Deferred: per-lane response roster (submitted / skipped / no-response).
*/

function daysLeft(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / 86_400_000))
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString() : '—'
}

function rateCount(lane) {
  return lane.rates?.[0]?.count ?? 0
}

export default function OpenRequests() {
  const navigate = useNavigate()
  const [lanes, setLanes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    const { lanes, error } = await fetchOpenRequests()
    if (error) setError(error.message)
    else setLanes(lanes)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Ocean Freight Rates"
        title="Open Requests"
        subtitle="Active lanes you've posted — still within their 10-day window."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
            >
              <RefreshCw size={15} />
              Refresh
            </button>
            <button
              onClick={() => navigate('/internal/new')}
              className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover"
            >
              <FilePlus size={16} className="transition-transform group-hover:scale-110" />
              New Rate Request
            </button>
          </div>
        }
      />

      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center rounded-2xl border border-fog-200 bg-white shadow-card">
          <Loader2 size={24} className="animate-spin text-fog-400" />
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700 shadow-card">
          Couldn’t load requests: {error}
        </div>
      ) : lanes.length === 0 ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-2xl border border-fog-200 bg-white text-center shadow-card">
          <ClipboardList size={28} className="text-fog-300" />
          <p className="text-sm font-medium text-harbor-800">No open requests</p>
          <p className="max-w-xs text-xs text-fog-500">
            Lanes you post stay here for 10 days. Create one from New Rate Request.
          </p>
        </div>
      ) : (
        <ScrollTable minWidth="920px">
            <thead>
              <tr className="border-b border-fog-200 font-mono text-[10px] uppercase tracking-[0.06em] text-fog-500">
                <th className="px-3 py-2.5 font-semibold">Port of Loading</th>
                <th className="px-3 py-2.5 font-semibold">Port of Discharge</th>
                <th className="px-3 py-2.5 font-semibold">Last CY</th>
                <th className="px-3 py-2.5 font-semibold">Final Destination</th>
                <th className="px-3 py-2.5 font-semibold">Cont. Type</th>
                <th className="px-3 py-2.5 text-right font-semibold"># Cont.</th>
                <th className="px-3 py-2.5 font-semibold">Posted</th>
                <th className="px-3 py-2.5 text-right font-semibold">Days Left</th>
                <th className="px-3 py-2.5 text-right font-semibold">Rates</th>
              </tr>
            </thead>
            <tbody>
              {lanes.map((l) => {
                const left = daysLeft(l.expires_at)
                const rates = rateCount(l)
                return (
                  <tr key={l.id} className="border-b border-fog-100 last:border-0 hover:bg-fog-50/60">
                    <td className="px-3 py-2.5 font-medium text-harbor-900">{l.pol ?? '—'}</td>
                    <td className="px-3 py-2.5 text-harbor-700">{l.pod ?? '—'}</td>
                    <td className="px-3 py-2.5 text-harbor-700">{l.last_cy ?? '—'}</td>
                    <td className="px-3 py-2.5 text-harbor-700">{l.fd ?? '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-harbor-700">{l.container_type ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-harbor-700">{l.container_count ?? '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-harbor-700">{fmtDate(l.posted_at)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <span className={`font-mono font-semibold ${left <= 2 ? 'text-signal-700' : 'text-harbor-800'}`}>
                        {left}d
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold text-harbor-900">{rates}</td>
                  </tr>
                )
              })}
            </tbody>
        </ScrollTable>
      )}
    </div>
  )
}
