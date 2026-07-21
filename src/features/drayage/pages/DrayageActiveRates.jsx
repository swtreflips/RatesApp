import React, { useEffect, useState } from 'react'
import { Loader2, FileText, RefreshCw, BadgeCheck, PencilLine, X } from 'lucide-react'
import { PageHeader, ScrollTable } from '../../../components/ui/DashboardPrimitives'
import { Toast } from '../../rates/rateGrid'
import {
  fetchMyDrayageRates, confirmDrayageRate, updateDrayageRate, stalenessOf, isInQuestion,
} from '../services/drayageService'
import { StalenessBadge, money, pct, fmtDate } from '../drayageGrid'

/*
  Forwarder "Active Drayage Rates" — the company's CURRENT rates (§6b: open-ended, no
  validity clock). They stay here indefinitely; Provided/Confirmed dates + the staleness
  badge show their age.

  A rate only shows actions once it is IN QUESTION — aged past fresh (3 mo) or internal asked
  for a re-quote. A rate provided yesterday stays quiet: asking someone to re-confirm what they
  just asserted is noise, and reflexive clicking would make confirmed_at meaningless.

  Two answers, deliberately paired so "unchanged" and "changed" are both one action:
    Confirm      → price still stands  → bumps confirmed_at (asks for the amount first)
    Update price → price changed       → supersedes with an edited copy (never an in-place edit)
*/

export default function DrayageActiveRates() {
  const [rates, setRates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [confirming, setConfirming] = useState(null)
  const [askConfirm, setAskConfirm] = useState(null) // rate awaiting "is it still $X?"
  const [editing, setEditing] = useState(null)       // rate open in the Update modal
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

  // Confirm asks for the amount first — the attestation only means something if a human actually
  // looked at the number before vouching for it.
  async function handleConfirm(rate) {
    setConfirming(rate.id)
    const { error } = await confirmDrayageRate(rate.id)
    setConfirming(null)
    setAskConfirm(null)
    if (error) showToast('error', `Couldn’t confirm: ${error.message}`)
    else {
      showToast('success', 'Rate confirmed as still valid')
      load()
    }
  }

  async function handleUpdate(rate, changes) {
    const { error } = await updateDrayageRate(rate, changes)
    if (error) return { error }
    showToast('success', 'New rate submitted — the previous one was superseded')
    setEditing(null)
    load()
    return { error: null }
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
                <td className="px-3 py-2.5 font-medium text-harbor-900">
                  {r.drayage_lane}
                  {r.refreshRequested && (
                    <span className="ml-2 inline-flex items-center rounded bg-signal-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-signal-700 ring-1 ring-inset ring-signal-200">
                      re-quote requested
                    </span>
                  )}
                </td>
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
                  {/* Actions appear only once the rate is in question (aged past fresh, or a
                      re-quote was requested) — otherwise the row stays quiet. */}
                  {isInQuestion(r) && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setAskConfirm(r)}
                        disabled={confirming === r.id}
                        title="This price still stands — reset its age"
                        className="inline-flex items-center gap-1 rounded-md border border-fog-200 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-fog-500 transition-colors hover:border-sea-300 hover:text-sea-700 disabled:opacity-50"
                      >
                        {confirming === r.id ? <Loader2 size={11} className="animate-spin" /> : <BadgeCheck size={11} />}
                        Confirm
                      </button>
                      <button
                        onClick={() => setEditing(r)}
                        title="My price changed — submit a new rate (supersedes this one)"
                        className="inline-flex items-center gap-1 rounded-md border border-fog-200 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-fog-500 transition-colors hover:border-signal-300 hover:text-signal-700"
                      >
                        <PencilLine size={11} />
                        Update
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}

      {askConfirm && (
        <ConfirmDialog
          rate={askConfirm}
          busy={confirming === askConfirm.id}
          onCancel={() => setAskConfirm(null)}
          onConfirm={() => handleConfirm(askConfirm)}
        />
      )}

      {editing && (
        <UpdateRateModal
          rate={editing}
          onCancel={() => setEditing(null)}
          onSubmit={(changes) => handleUpdate(editing, changes)}
        />
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}

/* ── Confirm dialog ───────────────────────────────────────────────────────
   Shows the amount before vouching. The friction is the point: a one-click Confirm invites
   reflexive clicking, and a confirmed_at nobody actually thought about is worse than none. */
function ConfirmDialog({ rate, busy, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-harbor-950/40 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-md rounded-2xl border border-fog-200 bg-white p-6 shadow-card-hover" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-extrabold text-harbor-950">Still your price?</h2>
        <p className="mt-2 text-sm text-fog-600">
          Confirm <span className="font-mono font-semibold text-harbor-900">{money(rate.total_rate)}</span>{' '}
          still stands for <span className="font-semibold text-harbor-900">{rate.drayage_lane}</span>.
        </p>
        <p className="mt-1 text-xs text-fog-500">
          This only resets the rate’s age — the price is not changed. If it changed, use Update instead.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 transition-colors hover:bg-fog-50">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-sea-600 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-sea-500 disabled:opacity-50"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <BadgeCheck size={15} />}
            Yes, it still stands
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Update price modal ───────────────────────────────────────────────────
   "My price changed." Prefilled from the current rate; submitting SUPERSEDES it (new row,
   fresh provided_at) — never an in-place edit, so the old price survives as history. Fields not
   shown here (accessorials, chassis days) are carried forward untouched by the service. */
function UpdateRateModal({ rate, onCancel, onSubmit }) {
  const [form, setForm] = useState({
    rate: rate.rate ?? '',
    fuelPct: rate.fuel_surcharge_pct == null ? '' : String(Number(rate.fuel_surcharge_pct) * 100),
    fuelAmount: rate.fuel_surcharge ?? '',
    storagePerDay: rate.storage_fee_per_day ?? '',
    notes: rate.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit() {
    if (form.rate === '' || form.rate == null) return setErr('Rate is required')
    setSaving(true)
    setErr(null)
    const { error } = await onSubmit(form)
    setSaving(false)
    if (error) setErr(error.message)
  }

  const field = 'w-full rounded-lg border border-fog-300 px-2.5 py-1.5 font-mono text-sm text-harbor-900 outline-none focus:border-signal-400'
  const label = 'block font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-fog-500'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-harbor-950/40 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-lg rounded-2xl border border-fog-200 bg-white shadow-card-hover" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-fog-100 px-6 py-4">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-fog-400">My price changed</p>
            <h2 className="mt-0.5 text-lg font-extrabold text-harbor-950">Update rate</h2>
            <p className="mt-1 text-xs text-fog-500">{rate.drayage_lane}</p>
          </div>
          <button onClick={onCancel} className="rounded-lg p-1.5 text-fog-400 transition-colors hover:bg-fog-100 hover:text-harbor-700">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4 px-6 py-4">
          <div>
            <label className={label}>Rate *</label>
            <input className={field} value={form.rate} onChange={set('rate')} inputMode="decimal" autoFocus />
          </div>
          <div>
            <label className={label}>Storage / day</label>
            <input className={field} value={form.storagePerDay} onChange={set('storagePerDay')} inputMode="decimal" />
          </div>
          <div>
            <label className={label}>Fuel surcharge %</label>
            <input className={field} value={form.fuelPct} onChange={set('fuelPct')} inputMode="decimal" placeholder="34" />
          </div>
          <div>
            <label className={label}>Fuel surcharge $</label>
            <input className={field} value={form.fuelAmount} onChange={set('fuelAmount')} inputMode="decimal" />
          </div>
          <div className="col-span-2">
            <label className={label}>Notes</label>
            <input className={field} value={form.notes} onChange={set('notes')} />
          </div>
          <p className="col-span-2 text-xs text-fog-500">
            Submitting replaces the current rate — the old one is kept as history (superseded).
            Accessorials and chassis days carry over unchanged.
          </p>
          {err && <p className="col-span-2 text-xs text-red-600">{err}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-fog-100 px-6 py-3.5">
          <button onClick={onCancel} className="rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 transition-colors hover:bg-fog-50">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 disabled:opacity-50"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <PencilLine size={15} />}
            Submit new rate
          </button>
        </div>
      </div>
    </div>
  )
}
