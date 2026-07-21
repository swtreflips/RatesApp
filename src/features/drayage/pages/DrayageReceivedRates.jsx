import React, { useEffect, useState } from 'react'
import { Loader2, LineChart, RefreshCw, History, RotateCcw } from 'lucide-react'
import { PageHeader, ScrollTable } from '../../../components/ui/DashboardPrimitives'
import { Toast } from '../../rates/rateGrid'
import { fetchDrayageRates, requestDrayageRefresh, stalenessOf } from '../services/drayageService'
import { StalenessBadge, money, pct, fmtDate } from '../drayageGrid'
import { useAuth } from '../../../app/providers/AuthProvider'

/*
  Internal "Drayage Rates" — every forwarder's rates. Default scope: CURRENT (one live rate
  per forwarder+lane, §6b); History shows superseded rows too (the negotiation trail).
  "Refresh" posts a kind='refresh' request lane pointing at the rate (§6b) — the forwarder
  answers by re-confirming or submitting a replacement.
*/

export default function DrayageReceivedRates() {
  const { user } = useAuth()
  const [scope, setScope] = useState('current') // 'current' | 'history'
  const [rates, setRates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(null)
  const [toast, setToast] = useState(null)

  const showToast = (severity, message) => {
    setToast({ severity, message })
    setTimeout(() => setToast(null), 4000)
  }

  async function load(nextScope = scope) {
    setLoading(true)
    setError(null)
    const { rates, error } = await fetchDrayageRates({ scope: nextScope })
    if (error) setError(error.message)
    else setRates(rates)
    setLoading(false)
  }

  useEffect(() => { load() }, [scope]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRefreshRequest(rate) {
    setRefreshing(rate.id)
    const { error } = await requestDrayageRefresh(rate, user?.id)
    setRefreshing(null)
    if (error) showToast('error', `Couldn’t post refresh: ${error.message}`)
    else showToast('success', `Refresh request posted for ${rate.drayage_lane}`)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Internal · Drayage"
        title="Drayage Rates"
        subtitle="Current drayage rates across all forwarders — open-ended, aged by their last confirmation. Request a refresh when a price needs a second look."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setScope(scope === 'current' ? 'history' : 'current')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
            >
              <History size={15} />
              {scope === 'current' ? 'Show History' : 'Show Current'}
            </button>
            <button
              onClick={() => load()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
            >
              <RefreshCw size={15} />
              Refresh
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
          Couldn’t load rates: {error}
        </div>
      ) : rates.length === 0 ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-2xl border border-fog-200 bg-white text-center shadow-card">
          <LineChart size={28} className="text-fog-300" />
          <p className="text-sm font-medium text-harbor-800">No drayage rates yet</p>
          <p className="max-w-xs text-xs text-fog-500">
            Rates submitted by forwarders (or recorded via Upload) appear here.
          </p>
        </div>
      ) : (
        <ScrollTable minWidth="1080px">
          <thead>
            <tr className="border-b border-fog-200 font-mono text-[10px] uppercase tracking-[0.06em] text-fog-500">
              <th className="px-3 py-2.5 font-semibold">Forwarder</th>
              <th className="px-3 py-2.5 font-semibold">Drayage Lane</th>
              <th className="px-3 py-2.5 font-semibold">Zip</th>
              <th className="px-3 py-2.5 text-right font-semibold">Rate</th>
              <th className="px-3 py-2.5 text-right font-semibold">Fuel</th>
              <th className="px-3 py-2.5 text-right font-semibold">Fuel %</th>
              <th className="px-3 py-2.5 text-right font-semibold">Total</th>
              <th className="px-3 py-2.5 font-semibold">Provided</th>
              <th className="px-3 py-2.5 font-semibold">Confirmed</th>
              <th className="px-3 py-2.5 font-semibold">Age</th>
              {scope === 'history' && <th className="px-3 py-2.5 font-semibold">Status</th>}
              <th className="px-3 py-2.5 font-semibold" />
            </tr>
          </thead>
          <tbody>
            {rates.map((r) => (
              <tr key={r.id} className={`border-b border-fog-100 last:border-0 hover:bg-fog-50/60 ${r.status === 'superseded' ? 'opacity-60' : ''}`}>
                <td className="px-3 py-2.5 font-medium text-harbor-900">{r.forwarder?.name ?? '—'}</td>
                <td className="px-3 py-2.5 text-harbor-700">{r.drayage_lane}</td>
                <td className="px-3 py-2.5 font-mono text-harbor-700">{r.dest_zip ?? '—'}</td>
                <td className="px-3 py-2.5 text-right font-mono text-harbor-700">{money(r.rate)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-harbor-700">{money(r.fuel_surcharge_amount)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-harbor-700">{pct(r.fuel_surcharge_pct_eff)}</td>
                <td className="px-3 py-2.5 text-right font-mono font-semibold text-harbor-900">{money(r.total_rate)}</td>
                <td className="px-3 py-2.5 font-mono text-harbor-700">{fmtDate(r.provided_at)}</td>
                <td className="px-3 py-2.5 font-mono text-harbor-700">{fmtDate(r.confirmed_at)}</td>
                <td className="px-3 py-2.5">
                  {r.status === 'current' && <StalenessBadge level={stalenessOf(r.confirmed_at)} />}
                </td>
                {scope === 'history' && (
                  <td className="px-3 py-2.5 font-mono text-xs text-fog-500">{r.status}</td>
                )}
                <td className="px-3 py-2.5">
                  {r.status === 'current' && (
                    <button
                      onClick={() => handleRefreshRequest(r)}
                      disabled={refreshing === r.id}
                      title="Post a refresh request for this lane"
                      className="inline-flex items-center gap-1 rounded-md border border-fog-200 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-fog-500 transition-colors hover:border-signal-300 hover:text-signal-700 disabled:opacity-50"
                    >
                      {refreshing === r.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                      Refresh
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
