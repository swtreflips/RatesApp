import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, ClipboardList, RefreshCw, FilePlus, Send, BellRing } from 'lucide-react'
import { PageHeader, ScrollTable } from '../../../components/ui/DashboardPrimitives'
import { Toast } from '../../rates/rateGrid'
import { fetchDrayageOpenRequests } from '../services/drayageService'
import SendModal from '../../internal/components/SendModal'
import { fmtDate } from '../../../lib/dates'

/*
  Internal "Open Drayage Requests" — active drayage lanes still within their request TTL,
  with a count of rates received on each. Hosts the drayage Send/Reminder buttons — the
  same SendModal, scoped service='drayage' (its own directory, memory, and template).
*/

function daysLeft(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / 86_400_000))
}

const rateCount = (lane) => lane.drayage_rates?.[0]?.count ?? 0

export default function DrayageOpenRequests() {
  const navigate = useNavigate()
  const [lanes, setLanes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sendMode, setSendMode] = useState(null) // 'request' | 'reminder' | null
  const [toast, setToast] = useState(null)

  function showToast(severity, message) {
    setToast({ severity, message })
    setTimeout(() => setToast(null), 5000)
  }

  async function load() {
    setLoading(true)
    setError(null)
    const { lanes, error } = await fetchDrayageOpenRequests()
    if (error) setError(error.message)
    else setLanes(lanes)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Internal · Drayage"
        title="Open Drayage Requests"
        subtitle="Active drayage lanes you've posted — still within their request window."
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
              onClick={() => setSendMode('reminder')}
              disabled={lanes.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <BellRing size={15} />
              Send Reminder
            </button>
            <button
              onClick={() => setSendMode('request')}
              disabled={lanes.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send size={15} />
              Send Rate Request
            </button>
            <button
              onClick={() => navigate('/internal/drayage/new')}
              className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover"
            >
              <FilePlus size={16} className="transition-transform group-hover:scale-110" />
              New Drayage Request
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
          <p className="text-sm font-medium text-harbor-800">No open drayage requests</p>
          <p className="max-w-xs text-xs text-fog-500">
            Lanes you post stay here for their request window. Create one from New Drayage Request.
          </p>
        </div>
      ) : (
        <ScrollTable minWidth="860px">
          <thead>
            <tr className="border-b border-fog-200 font-mono text-[10px] uppercase tracking-[0.06em] text-fog-500">
              <th className="px-3 py-2.5 font-semibold">Last CY/CFS</th>
              <th className="px-3 py-2.5 font-semibold">Final Destination</th>
              <th className="px-3 py-2.5 font-semibold">Zip</th>
              <th className="px-3 py-2.5 font-semibold">Kind</th>
              <th className="px-3 py-2.5 font-semibold">Notes</th>
              <th className="px-3 py-2.5 font-semibold">Posted</th>
              <th className="px-3 py-2.5 text-right font-semibold">Days Left</th>
              <th className="px-3 py-2.5 text-right font-semibold">Rates</th>
            </tr>
          </thead>
          <tbody>
            {lanes.map((l) => {
              const left = daysLeft(l.expires_at)
              return (
                <tr key={l.id} className="border-b border-fog-100 last:border-0 hover:bg-fog-50/60">
                  <td className="px-3 py-2.5 font-medium text-harbor-900">{l.last_cy_cfs}</td>
                  <td className="px-3 py-2.5 text-harbor-700">{l.final_destination}</td>
                  <td className="px-3 py-2.5 font-mono text-harbor-700">{l.dest_zip ?? '—'}</td>
                  <td className="px-3 py-2.5">
                    {l.kind === 'refresh' ? (
                      <span className="inline-flex items-center rounded bg-signal-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-signal-700 ring-1 ring-inset ring-signal-200">
                        Refresh
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-fog-400">new</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-fog-500">{l.notes ?? '—'}</td>
                  <td className="px-3 py-2.5 font-mono text-harbor-700">{fmtDate(l.posted_at)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <span className={`font-mono font-semibold ${left <= 2 ? 'text-signal-700' : 'text-harbor-800'}`}>
                      {left}d
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono font-semibold text-harbor-900">{rateCount(l)}</td>
                </tr>
              )
            })}
          </tbody>
        </ScrollTable>
      )}

      {sendMode && (
        <SendModal
          mode={sendMode}
          service="drayage"
          onClose={() => setSendMode(null)}
          onResult={showToast}
        />
      )}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
