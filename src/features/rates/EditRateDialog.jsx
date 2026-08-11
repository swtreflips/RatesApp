import React, { useState, useMemo } from 'react'
import { X, Loader2, AlertTriangle, History } from 'lucide-react'
import {
  fieldsFor, toInput, diffRate, saveRateEdit, isRoutingChange, fetchRateEdits,
} from './rateEditService'

/*
  Correct one rate. Shared by all four rate views — internal and forwarder, ocean and drayage —
  because the only thing that differs between them is the field list, and that comes from
  `fieldsFor(table)`.

  THE CONFIRMATION IS THE DIFF, not a second modal. A "are you sure?" box asks you to approve
  something you can no longer see; this shows exactly what will change, in before → after form, and
  the button commits that list. Nothing is written until it says so.

  Access is not checked here. RLS decides whether the update lands, so a forwarder opening this on
  someone else's rate simply gets a failed write — the rule lives in one place, in the database.
*/

const GROUP_LABELS = {
  routing: 'Routing',
  identity: 'Identity',
  money: 'Rate',
  fees: 'Accessorials',
  chassis: 'Chassis & storage',
  validity: 'Validity',
  notes: 'Notes',
}

/** null renders as an em dash — "" would read as a value the user typed. */
const show = (v) => (v === null || v === undefined || v === '' ? '—' : String(v))

export default function EditRateDialog({ table, rate, label, onClose, onSaved }) {
  const fields = useMemo(() => fieldsFor(table), [table])

  const [draft, setDraft] = useState(() => {
    const d = {}
    for (const f of fields) d[f.name] = toInput(rate[f.name], f.kind)
    return d
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [history, setHistory] = useState(null)   // null = not loaded, [] = loaded and empty

  const changes = useMemo(() => diffRate(rate, draft, fields), [rate, draft, fields])
  const routingChanged = isRoutingChange(changes)

  const groups = useMemo(() => {
    const out = []
    for (const f of fields) {
      const g = out.find((x) => x.id === f.group)
      if (g) g.fields.push(f)
      else out.push({ id: f.group, label: GROUP_LABELS[f.group] ?? f.group, fields: [f] })
    }
    return out
  }, [fields])

  const set = (name, value) => setDraft((d) => ({ ...d, [name]: value }))

  const loadHistory = async () => {
    const { edits } = await fetchRateEdits(rate.id)
    setHistory(edits)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!changes.length) return
    setSaving(true)
    setError(null)
    const { error, auditError } = await saveRateEdit({ table, rateId: rate.id, changes })
    setSaving(false)
    if (error) return setError(error.message)
    // The edit landed; only the log did not. Say so rather than reporting a clean success —
    // a silent gap in an audit trail is worse than a noisy one.
    onSaved?.(changes, auditError ? 'Saved, but the edit history could not be recorded.' : null)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-harbor-950/40 p-4 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="my-8 w-full max-w-2xl overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card-hover"
      >
        {/* header */}
        <div className="flex items-start justify-between gap-4 border-b border-fog-100 px-5 py-3.5">
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-fog-400">
              Edit rate
            </p>
            <p className="mt-0.5 truncate text-sm font-semibold text-harbor-900">{label}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-fog-400 transition-colors hover:bg-fog-100 hover:text-harbor-700"
          >
            <X size={16} />
          </button>
        </div>

        {/* fields */}
        <div className="max-h-[46vh] overflow-y-auto scrollbar-rail px-5 py-4">
          {groups.map((g) => (
            <div key={g.id} className="mb-4 last:mb-0">
              <p className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-fog-400">
                {g.label}
              </p>
              <div className="grid grid-cols-2 gap-2.5">
                {g.fields.map((f) => (
                  <label key={f.name} className={f.name === 'notes' ? 'col-span-2' : ''}>
                    <span className="mb-0.5 block text-[11px] font-medium text-harbor-700">{f.label}</span>
                    <input
                      type={f.kind === 'date' ? 'date' : f.kind === 'text' ? 'text' : 'number'}
                      step={f.kind === 'number' ? 'any' : undefined}
                      value={draft[f.name]}
                      onChange={(e) => set(f.name, e.target.value)}
                      className="w-full rounded-lg border border-fog-300 px-2.5 py-1.5 font-mono text-xs text-harbor-900 outline-none transition-colors focus:border-harbor-400"
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* the confirmation: exactly what will change */}
        <div className="border-t border-fog-100 bg-fog-50/60 px-5 py-3">
          {changes.length === 0 ? (
            <p className="text-xs text-fog-500">No changes yet — edit a field to see what will be saved.</p>
          ) : (
            <>
              <p className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-fog-500">
                {changes.length} change{changes.length === 1 ? '' : 's'} to save
              </p>
              <ul className="space-y-0.5">
                {changes.map((c) => (
                  <li key={c.field} className="flex flex-wrap items-baseline gap-1.5 font-mono text-[11px]">
                    <span className="text-fog-500">{c.label}</span>
                    <span className="text-fog-400 line-through">{show(c.before)}</span>
                    <span className="text-fog-400">→</span>
                    <span className="font-semibold text-harbor-900">{show(c.after)}</span>
                  </li>
                ))}
              </ul>

              {/* Routing is not a cosmetic field: it is what makes this rate the rate FOR a lane,
                  and on drayage it is covered by a unique index on the current rate per lane. */}
              {routingChanged && (
                <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-signal-50 px-2 py-1.5 text-[11px] leading-snug text-signal-900 ring-1 ring-inset ring-signal-200">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-signal-600" />
                  You are changing the routing, which changes which lane this rate belongs to. If
                  another current rate already covers the new lane, the save will be rejected.
                </p>
              )}
            </>
          )}

          {error && (
            <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] leading-snug text-red-700 ring-1 ring-inset ring-red-200">
              {error}
            </p>
          )}
        </div>

        {/* actions */}
        <div className="flex items-center justify-between gap-3 border-t border-fog-100 px-5 py-3">
          <button
            type="button"
            onClick={loadHistory}
            className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-fog-500 transition-colors hover:text-harbor-800"
          >
            <History size={12} />
            {history === null ? 'edit history' : `${history.length} past edit${history.length === 1 ? '' : 's'}`}
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-fog-300 px-3 py-1.5 text-sm text-fog-700 transition-colors hover:bg-fog-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || changes.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-signal-500 px-4 py-1.5 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {changes.length ? `Save ${changes.length} change${changes.length === 1 ? '' : 's'}` : 'Save'}
            </button>
          </div>
        </div>

        {/* history, only once asked for */}
        {history !== null && (
          <div className="max-h-40 overflow-y-auto scrollbar-rail border-t border-fog-100 px-5 py-3">
            {history.length === 0 ? (
              <p className="text-[11px] text-fog-500">This rate has never been edited.</p>
            ) : (
              <ul className="space-y-1">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-baseline gap-1.5 font-mono text-[10px]">
                    <span className="text-fog-400">{new Date(h.edited_at).toLocaleDateString()}</span>
                    <span className="text-fog-500">{h.field}</span>
                    <span className="text-fog-400 line-through">{show(h.old_value)}</span>
                    <span className="text-fog-400">→</span>
                    <span className="text-harbor-900">{show(h.new_value)}</span>
                    {h.profiles?.full_name && <span className="text-fog-400">· {h.profiles.full_name}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </form>
    </div>
  )
}
