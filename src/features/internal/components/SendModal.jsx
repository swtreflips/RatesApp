import React, { useEffect, useMemo, useState } from 'react'
import { X, Send, Loader2, Clock, Mail, Tags } from 'lucide-react'
import { previewNotification, sendNotification } from '../services/notifyService'

/*
  Recipient-selection modal for the Open Requests Send/Reminder actions — v2, per-analyst
  (ALERTS.md §4/§5 + DRAY.md §7b/§7e). Company rows carry the lane counts; each analyst is a
  checkbox sub-row with a service tag chip (OCEAN / DRAYAGE / ALL — display-only guidance,
  capped by the company's capabilities).

  Prefill = MEMORY ONLY: analysts emailed in the latest send of this service (`lastSelected`
  from the preview). No memory → nothing pre-checked; the sender picks manually (once), and
  that choice becomes next time's prefill. Tags never pre-select anyone.

  `service` is hard-coded 'ocean' by the caller until the :service routes land (§9b step 2).
*/

const COOLDOWN_MS = 12 * 60 * 60 * 1000 // soft re-send warning window (ALERTS.md §9)

/** Chip for an analyst, capped by the company's offered services (DRAY.md §7a). */
function chipFor(analyst, companyServices) {
  const ocean = analyst.tagOcean && companyServices.includes('ocean')
  const drayage = analyst.tagDrayage && companyServices.includes('drayage')
  if (ocean && drayage) return 'ALL'
  if (ocean) return 'OCEAN'
  if (drayage) return 'DRAYAGE'
  return null
}

const CHIP_STYLES = {
  OCEAN:   'bg-sea-50 text-sea-700 ring-sea-200',
  DRAYAGE: 'bg-signal-50 text-signal-700 ring-signal-200',
  ALL:     'bg-fog-50 text-fog-500 ring-fog-300',
}

function TagChip({ label }) {
  if (!label) return null
  return (
    <span className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] ring-1 ring-inset ${CHIP_STYLES[label]}`}>
      {label}
    </span>
  )
}

export default function SendModal({ mode, service = 'ocean', onClose, onResult }) {
  const isReminder = mode === 'reminder'
  const [roster, setRoster] = useState([])
  const [selected, setSelected] = useState(() => new Set()) // analyst ids
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)

  const laneCountFor = (c) => (isReminder ? c.outstandingCount : c.openCount)
  const sendableCompany = (c) => (c.analysts?.length ?? 0) > 0 && laneCountFor(c) > 0
  const taggedFor = (a) => (service === 'drayage' ? a.tagDrayage : a.tagOcean)

  useEffect(() => {
    let active = true
    setLoading(true)
    previewNotification({ service }).then(({ data, error }) => {
      if (!active) return
      if (error) {
        setError(error.message)
      } else {
        const rows = data.roster ?? []
        setRoster(rows)
        // Prefill = memory only (§7e): the analysts emailed in the latest send of this service.
        // First-ever send → nothing lastSelected → blank; the sender picks manually.
        setSelected(new Set(
          rows.flatMap((c) => (c.analysts ?? []).filter((a) => a.lastSelected).map((a) => a.analystId)),
        ))
      }
      setLoading(false)
    })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, service])

  const sendable = useMemo(() => roster.filter(sendableCompany), [roster, isReminder])
  const allAnalystIds = useMemo(
    () => sendable.flatMap((c) => c.analysts.map((a) => a.analystId)),
    [sendable],
  )
  const allSelected = allAnalystIds.length > 0 && allAnalystIds.every((id) => selected.has(id))

  const selectedCompanies = useMemo(
    () => roster.filter((c) => (c.analysts ?? []).some((a) => selected.has(a.analystId))),
    [roster, selected],
  )
  const totalLanes = useMemo(
    () => selectedCompanies.reduce((n, c) => n + laneCountFor(c), 0),
    [selectedCompanies, isReminder],
  )
  const cooldownHit = useMemo(
    () => selectedCompanies.some((c) => c.lastNotifiedAt &&
      Date.now() - new Date(c.lastNotifiedAt).getTime() < COOLDOWN_MS),
    [selectedCompanies],
  )

  function setMany(ids, on) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) on ? next.add(id) : next.delete(id)
      return next
    })
  }
  const toggleAnalyst = (id) => setMany([id], !selected.has(id))
  function toggleCompany(c) {
    const ids = c.analysts.map((a) => a.analystId)
    setMany(ids, !ids.every((id) => selected.has(id)))
  }
  /** "Check all tagged" (§7b) — user-initiated shortcut, never automatic. */
  const checkTagged = (c) => setMany(c.analysts.filter(taggedFor).map((a) => a.analystId), true)
  const toggleAll = () => setMany(allAnalystIds, !allSelected)

  async function handleSend() {
    setSending(true)
    const { data, error } = await sendNotification(mode, [...selected], { service })
    setSending(false)
    if (error) {
      onResult?.('error', error.message)
      return
    }
    const sent = data.sent?.length ?? 0
    const failed = data.failed?.length ?? 0
    onResult?.(
      failed > 0 ? 'warning' : 'success',
      failed > 0
        ? `Sent to ${sent} forwarder(s); ${failed} failed`
        : `Sent to ${sent} forwarder(s)`,
    )
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-harbor-950/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card-hover"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-fog-100 px-6 py-4">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-fog-400">
              {isReminder ? 'Nudge non-responders' : 'Outbound rate request'} · {service}
            </p>
            <h2 className="mt-0.5 text-lg font-extrabold text-harbor-950">
              {isReminder ? 'Send Reminder' : 'Send Rate Request'}
            </h2>
            <p className="mt-1 text-xs text-fog-500">
              {isReminder
                ? 'Each forwarder receives only the lanes they haven’t answered yet.'
                : 'Each selected forwarder receives all open lanes for this period.'}{' '}
              Pick the analysts who should receive it — tags are guidance, your last selection is remembered.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fog-400 transition-colors hover:bg-fog-100 hover:text-harbor-700">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-[200px] flex-1 overflow-auto px-6 py-4">
          {loading ? (
            <div className="flex min-h-[160px] items-center justify-center">
              <Loader2 size={22} className="animate-spin text-fog-400" />
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700">
              Couldn’t load forwarders: {error}
            </div>
          ) : roster.length === 0 ? (
            <div className="py-10 text-center text-sm text-fog-500">No active forwarders offer {service}.</div>
          ) : (
            <>
              <label className="mb-2 flex items-center gap-2 border-b border-fog-100 pb-2 text-xs font-semibold uppercase tracking-wide text-fog-500">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 rounded border-fog-300 text-signal-600 focus:ring-signal-400" />
                All analysts
              </label>

              <ul className="space-y-2">
                {roster.map((c) => {
                  const lanes = laneCountFor(c)
                  const can = sendableCompany(c)
                  const analysts = c.analysts ?? []
                  const companyIds = analysts.map((a) => a.analystId)
                  const companyAllSelected = companyIds.length > 0 && companyIds.every((id) => selected.has(id))
                  const hasTagged = analysts.some(taggedFor)
                  return (
                    <li key={c.forwarderId} className={`rounded-lg border border-fog-100 ${can ? '' : 'opacity-50'}`}>
                      {/* Company row */}
                      <div className="flex items-center gap-3 rounded-t-lg bg-fog-50/60 px-3 py-2">
                        <input
                          type="checkbox"
                          disabled={!can}
                          checked={companyAllSelected}
                          onChange={() => toggleCompany(c)}
                          className="h-4 w-4 rounded border-fog-300 text-signal-600 focus:ring-signal-400 disabled:opacity-50"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-harbor-900">{c.name}</span>
                        {can && hasTagged && (
                          <button
                            onClick={() => checkTagged(c)}
                            title={`Check every analyst tagged for ${service}`}
                            className="inline-flex items-center gap-1 rounded-md border border-fog-200 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-fog-500 transition-colors hover:border-harbor-300 hover:text-harbor-700"
                          >
                            <Tags size={11} />
                            Check tagged
                          </button>
                        )}
                        <span className="shrink-0 font-mono text-xs font-semibold text-harbor-700">
                          {lanes} lane{lanes === 1 ? '' : 's'}
                        </span>
                      </div>
                      {/* Analyst sub-rows */}
                      {analysts.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-red-500">no analysts onboarded for this company</p>
                      ) : (
                        <ul>
                          {analysts.map((a) => (
                            <li key={a.analystId} className={`flex items-center gap-3 px-3 py-1.5 pl-8 ${can ? 'hover:bg-fog-50' : ''}`}>
                              <input
                                type="checkbox"
                                disabled={!can}
                                checked={selected.has(a.analystId)}
                                onChange={() => toggleAnalyst(a.analystId)}
                                className="h-4 w-4 rounded border-fog-300 text-signal-600 focus:ring-signal-400 disabled:opacity-50"
                              />
                              <span className="min-w-0 flex-1 truncate">
                                <span className="text-sm font-medium text-harbor-900">{a.name}</span>
                                <span className="ml-2 truncate text-xs text-fog-500">{a.email}</span>
                              </span>
                              <TagChip label={chipFor(a, c.services ?? [])} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-fog-100 px-6 py-3.5">
          {cooldownHit && (
            <p className="mb-2 flex items-center gap-1.5 text-xs text-signal-700">
              <Clock size={13} /> Some selected forwarders were notified within the last 12h.
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-fog-500">
              <Mail size={13} className="mr-1 inline" />
              {selected.size} analyst{selected.size === 1 ? '' : 's'} · {selectedCompanies.length} forwarder{selectedCompanies.length === 1 ? '' : 's'} · {totalLanes} lane{totalLanes === 1 ? '' : 's'}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 transition-colors hover:bg-fog-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={sending || selected.size === 0 || totalLanes === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {isReminder ? 'Send Reminder' : 'Send Rate Request'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
