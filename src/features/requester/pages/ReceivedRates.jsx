import React, { useEffect, useState } from 'react'
import { Loader2, Inbox, RefreshCw } from 'lucide-react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'
import { fetchReceivedRates } from '../services/rateRequestService'

/*
  Requester read of forwarder-submitted rates (STEP 0 / S0.6 — the loop's last leg).

  Deliberately minimal: a flat table, newest first, no grouping / cheapest-first /
  skip roster. Those are later slices (NEXTSTEPS §A3). This just proves the rate a
  provider submitted is visible to the requester team.
*/

function fmtMoney(amount, currency) {
  if (amount == null) return '—'
  return `${currency || 'USD'} ${Number(amount).toLocaleString()}`
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString() : '—'
}

export default function ReceivedRates() {
  const [rates, setRates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    const { rates, error } = await fetchReceivedRates()
    if (error) setError(error.message)
    else setRates(rates)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Active Rates"
        actions={
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
          >
            <RefreshCw size={15} />
            Refresh
          </button>
        }
      />

      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center rounded-2xl border border-fog-200 bg-white shadow-card">
          <Loader2 size={24} className="animate-spin text-fog-400" />
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700 shadow-card">
          Couldn’t load rates: {error}
        </div>
      ) : rates.length === 0 ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-2xl border border-fog-200 bg-white text-center shadow-card">
          <Inbox size={28} className="text-fog-300" />
          <p className="text-sm font-medium text-harbor-800">No rates received yet</p>
          <p className="max-w-xs text-xs text-fog-500">
            Once a forwarder submits a rate on one of your lanes, it shows up here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-fog-200 bg-white shadow-card">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-fog-200 bg-fog-50 font-mono text-[10px] uppercase tracking-[0.06em] text-fog-500">
                <th className="px-3 py-2.5 font-semibold">Forwarder</th>
                <th className="px-3 py-2.5 font-semibold">POL</th>
                <th className="px-3 py-2.5 font-semibold">POD</th>
                <th className="px-3 py-2.5 font-semibold">Last CY</th>
                <th className="px-3 py-2.5 font-semibold">Final Destination</th>
                <th className="px-3 py-2.5 font-semibold">Carrier</th>
                <th className="px-3 py-2.5 text-right font-semibold">Rate</th>
                <th className="px-3 py-2.5 text-right font-semibold"># of Free Days</th>
                <th className="px-3 py-2.5 font-semibold">Valid Until</th>
                <th className="px-3 py-2.5 font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id} className="border-b border-fog-100 last:border-0 hover:bg-fog-50/60">
                  <td className="px-3 py-2.5 font-medium text-harbor-900">{r.forwarder?.name ?? '—'}</td>
                  <td className="px-3 py-2.5 text-harbor-700">{r.pol ?? '—'}</td>
                  <td className="px-3 py-2.5 text-harbor-700">{r.pod ?? '—'}</td>
                  <td className="px-3 py-2.5 text-harbor-700">{r.last_cy ?? '—'}</td>
                  <td className="px-3 py-2.5 text-harbor-700">{r.fd ?? '—'}</td>
                  <td className="px-3 py-2.5 font-mono text-harbor-700">{r.carrier ?? '—'}</td>
                  <td className="px-3 py-2.5 text-right font-mono font-semibold text-harbor-900">{fmtMoney(r.rate_amount, r.currency)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-harbor-700">{r.free_days ?? '—'}</td>
                  <td className="px-3 py-2.5 font-mono text-harbor-700">{fmtDate(r.valid_until)}</td>
                  <td className="px-3 py-2.5 text-fog-500">{r.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
