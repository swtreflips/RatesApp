import React, { useEffect, useMemo, useState } from 'react'
import { X, Send, Loader2, AlertTriangle, Clock, Mail } from 'lucide-react'
import { previewNotification, sendNotification } from '../services/notifyService'

/*
  Shared recipient-selection modal for the Open Requests Send/Reminder actions (ALERTS.md §4 / §5).
  One component, two modes:
    • request  — preselects all active forwarders; lanes per forwarder = ALL open lanes.
    • reminder — preselects forwarders with outstanding lanes; lanes per forwarder = OUTSTANDING only.
  Both share the `notify-forwarders` pipeline; only the lane filter + copy differ (ALERTS.md §14).

  Roster comes from the function's `preview` mode (server-side counts; no emails reach the browser).
*/

const COOLDOWN_MS = 12 * 60 * 60 * 1000 // soft re-send warning window (ALERTS.md §9)

function fmtWhen(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function SendModal({ mode, onClose, onResult }) {
  const isReminder = mode === 'reminder'
  const [roster, setRoster] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)

  const laneCountFor = (r) => (isReminder ? r.outstandingCount : r.openCount)
  const selectable = (r) => r.recipientCount > 0 && laneCountFor(r) > 0

  useEffect(() => {
    let active = true
    setLoading(true)
    previewNotification().then(({ data, error }) => {
      if (!active) return
      if (error) {
        setError(error.message)
      } else {
        const rows = data.roster ?? []
        setRoster(rows)
        // default selection: everything sendable in this mode
        setSelected(new Set(rows.filter(selectable).map((r) => r.forwarderId)))
      }
      setLoading(false)
    })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const sendable = useMemo(() => roster.filter(selectable), [roster, isReminder])
  const allSelected = sendable.length > 0 && sendable.every((r) => selected.has(r.forwarderId))
  const totalLanes = useMemo(
    () => roster.filter((r) => selected.has(r.forwarderId)).reduce((n, r) => n + laneCountFor(r), 0),
    [roster, selected, isReminder],
  )
  const cooldownHit = useMemo(
    () => roster.some((r) => selected.has(r.forwarderId) && r.lastNotifiedAt &&
      Date.now() - new Date(r.lastNotifiedAt).getTime() < COOLDOWN_MS),
    [roster, selected, isReminder],
  )

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(sendable.map((r) => r.forwarderId)))
  }

  async function handleSend() {
    setSending(true)
    const ids = [...selected]
    const { data, error } = await sendNotification(mode, ids)
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
              {isReminder ? 'Nudge non-responders' : 'Outbound rate request'}
            </p>
            <h2 className="mt-0.5 text-lg font-extrabold text-harbor-950">
              {isReminder ? 'Send Reminder' : 'Send Rate Request'}
            </h2>
            <p className="mt-1 text-xs text-fog-500">
              {isReminder
                ? 'Each forwarder receives only the lanes they haven’t answered yet.'
                : 'Each selected forwarder receives all open lanes for this period.'}
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
            <div className="py-10 text-center text-sm text-fog-500">No active forwarders.</div>
          ) : (
            <>
              <label className="mb-2 flex items-center gap-2 border-b border-fog-100 pb-2 text-xs font-semibold uppercase tracking-wide text-fog-500">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 rounded border-fog-300 text-signal-600 focus:ring-signal-400" />
                {isReminder ? 'All pending' : 'All forwarders'}
              </label>

              <ul className="space-y-1">
                {roster.map((r) => {
                  const lanes = laneCountFor(r)
                  const can = selectable(r)
                  const recent = r.lastNotifiedAt && Date.now() - new Date(r.lastNotifiedAt).getTime() < COOLDOWN_MS
                  return (
                    <li
                      key={r.forwarderId}
                      className={`flex items-center gap-3 rounded-lg px-2 py-2 ${can ? 'hover:bg-fog-50' : 'opacity-50'}`}
                    >
                      <input
                        type="checkbox"
                        disabled={!can}
                        checked={selected.has(r.forwarderId)}
                        onChange={() => toggle(r.forwarderId)}
                        className="h-4 w-4 rounded border-fog-300 text-signal-600 focus:ring-signal-400 disabled:opacity-50"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-harbor-900">{r.name}</span>
                          {r.recipientCount === 0 && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 ring-1 ring-red-100">
                              <AlertTriangle size={10} /> no email
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[11px] text-fog-500">
                          <span className="text-sea-700">✓ {r.respondedCount}/{r.openCount}</span>
                          {r.skippedCount > 0 && <span>⤫ {r.skippedCount}</span>}
                          <span className={r.outstandingCount > 0 ? 'text-signal-700' : ''}>— {r.outstandingCount} pending</span>
                          {recent && (
                            <span className="inline-flex items-center gap-1 text-signal-700">
                              <Clock size={10} /> notified {fmtWhen(r.lastNotifiedAt)}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-xs font-semibold text-harbor-700">
                        {lanes} lane{lanes === 1 ? '' : 's'}
                      </span>
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
              {selected.size} forwarder{selected.size === 1 ? '' : 's'} · {totalLanes} lane{totalLanes === 1 ? '' : 's'}
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
