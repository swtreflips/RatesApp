import React, { useEffect, useState } from 'react'
import { Loader2, FileText, RefreshCw, BadgeCheck } from 'lucide-react'
import { PageHeader, ScrollTable } from '../../../components/ui/DashboardPrimitives'
import { Toast } from '../../rates/rateGrid'
import { fetchMyDrayageRates, confirmDrayageRate, stalenessOf } from '../services/drayageService'
import { StalenessBadge } from '../drayageGrid'

/*
  Forwarder "Active Drayage Rates" — the company's CURRENT rates (§6b: open-ended, no
  validity clock). They stay here indefinitely; Provided/Confirmed dates + the staleness
  badge show their age. "Confirm" = re-validate the price (bumps confirmed_at). Submitting
  a new rate for the same lane (on Open Requests) supersedes the row here.
*/

const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const pct = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(2)}%`)
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')

export default function DrayageActiveRates() {
  const [rates, setRates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [confirming, setConfirming] = useState(null)
  const [toast, setToast] = useState(null)

  const showToast = (severity, message) => {
    setToast({ severity, message })
    setTimeout(() => setToast(null), 4000)
  }

  async function load() {
    setLoading(true)
    setError(null)
    const { rates, error } = await fetchMyDrayageRates()
    if (error) setError(error.message)
    else setRates(rates)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleConfirm(rate) {
    setConfirming(rate.id)
    const { error } = await confirmDrayageRate(rate.id)
    setConfirming(null)
    if (error) showToast('error', `Couldn’t confirm: ${error.message}`)
    else {
      showToast('success', 'Rate confirmed as still valid')
      load()
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Freight Forwarder · Drayage"
        title="Active Drayage Rates"
        subtitle="Your company’s current drayage rates. They don’t expire — the badge shows their age; hit Confirm to re-validate a price that still stands."
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
          <FileText size={28} className="text-fog-300" />
          <p className="text-sm font-medium text-harbor-800">No drayage rates yet</p>
          <p className="max-w-xs text-xs text-fog-500">
            Rates you submit on the Open Requests page show up here and stay current until you replace them.
          </p>
        </div>
      ) : (
        <ScrollTable minWidth="980px">
          <thead>
            <tr className="border-b border-fog-200 font-mono text-[10px] uppercase tracking-[0.06em] text-fog-500">
              <th className="px-3 py-2.5 font-semibold">Drayage Lane</th>
              <th className="px-3 py-2.5 font-semibold">Zip</th>
              <th className="px-3 py-2.5 text-right font-semibold">Rate</th>
              <th className="px-3 py-2.5 text-right font-semibold">Fuel</th>
              <th className="px-3 py-2.5 text-right font-semibold">Fuel %</th>
              <th className="px-3 py-2.5 text-right font-semibold">Total</th>
              <th className="px-3 py-2.5 text-right font-semibold">Storage/Day</th>
              <th className="px-3 py-2.5 font-semibold">Provided</th>
              <th className="px-3 py-2.5 font-semibold">Confirmed</th>
              <th className="px-3 py-2.5 font-semibold">Age</th>
              <th className="px-3 py-2.5 font-semibold" />
            </tr>
          </thead>
          <tbody>
            {rates.map((r) => (
              <tr key={r.id} className="border-b border-fog-100 last:border-0 hover:bg-fog-50/60">
                <td className="px-3 py-2.5 font-medium text-harbor-900">{r.drayage_lane}</td>
                <td className="px-3 py-2.5 font-mono text-harbor-700">{r.dest_zip ?? '—'}</td>
                <td className="px-3 py-2.5 text-right font-mono text-harbor-700">{money(r.rate)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-harbor-700">{money(r.fuel_surcharge_amount)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-harbor-700">{pct(r.fuel_surcharge_pct_eff)}</td>
                <td className="px-3 py-2.5 text-right font-mono font-semibold text-harbor-900">{money(r.total_rate)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-harbor-700">{money(r.storage_fee_per_day)}</td>
                <td className="px-3 py-2.5 font-mono text-harbor-700">{fmtDate(r.provided_at)}</td>
                <td className="px-3 py-2.5 font-mono text-harbor-700">{fmtDate(r.confirmed_at)}</td>
                <td className="px-3 py-2.5"><StalenessBadge level={stalenessOf(r.confirmed_at)} /></td>
                <td className="px-3 py-2.5">
                  <button
                    onClick={() => handleConfirm(r)}
                    disabled={confirming === r.id}
                    title="This price still stands — reset its age"
                    className="inline-flex items-center gap-1 rounded-md border border-fog-200 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-fog-500 transition-colors hover:border-sea-300 hover:text-sea-700 disabled:opacity-50"
                  >
                    {confirming === r.id ? <Loader2 size={11} className="animate-spin" /> : <BadgeCheck size={11} />}
                    Confirm
                  </button>
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
