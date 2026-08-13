import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Upload, Search, Ship, Truck, Container, ArrowRight, ChevronRight, Loader2, Award,
  PackageX, FileSpreadsheet, AlertTriangle, CalendarDays, CalendarX2, Clock, History, Check,
} from 'lucide-react'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'
import { parseRateFile, Toast } from '../../rates/rateGrid'
import { money } from '../../drayage/drayageGrid'
import { fetchDrayageRates } from '../../drayage/services/drayageService'
import { buildBookingsHeaderIndex, groupByOfqWithOptions } from '../bookings/inputCsv'
import { laneKey, toNum, indexDrayageByLane, grandTotal } from '../bookings/matching'
import { dateVal, startOfToday, applyValidity } from '../bookings/rateValidity'
// Same operational rule as Apply Rates, same default — a rate you cannot book in time
// is noise on a screen whose only job is deciding what to book.
import { DEFAULT_MIN_VALID_DAYS } from '../applyRates/matcher'
import { buildRateTrends, formatPct, isHeld } from '../bookings/rateTrend'
import {
  findSailings, fetchPicks, savePick, clearPick, pickKey, hasSailed, shortDate, tidyPlace,
} from '../bookings/schedulesService'
import {
  fetchLatestSnapshot, fetchSnapshotHistory, saveSnapshot, diffAgainst,
  relativeDay, isStale,
} from '../bookings/snapshotService'

/*
  Internal "Bookings" — landed-cost scenario planner (BOOKINGS.md). Cross-service, so it lives
  outside the ocean/drayage sidebar groups.

  Progressive disclosure, grid-first (the v2 layout — v1's picker+cards read as unintuitive):
    1. a familiar GRID of OFQs (OFQID · POL · FD · Cargo Ready · containers · ocean-rate summary);
    2. clicking an OFQ row EXPANDS it in place → its applied OFRs as indented sub-rows;
    3. clicking an OFR opens the BOOKING ITINERARY panel on the right — a vertical route timeline
       (POL → ocean leg → POD → Last CY → drayage leg → FD) where the drayage leg holds the
       selectable options (cheapest preselected) and the landed total is the pinned hero numeral.

  Drayage coverage is fetched ONCE and indexed by normalized lane key (matching.js), so every
  OFR click is an O(1) lookup — no round-trip.

  THE SHEET IS SHARED; THE EXPLORATION IS NOT.

  §242's "no persistence" had folded two separate things into one decision. Choosing an ocean
  rate and a drayage option is still pure exploration and still saves nothing — one person's
  what-if has no business becoming another's. But the FILE was browser state too, so a reload
  emptied the page and the export one person happened to have was invisible to everyone else.

  The sheet is now a SNAPSHOT: uploaded once, seen by every internal user, stamped with who and
  when. Only the universe is stored — OFQs and the ocean rates applied to them. Drayage is still
  read live on every load, because a two-week-old sheet must not quote two-week-old trucking.
*/

const ACCEPTED_EXTS = ['csv', 'xlsx', 'xls']

/* ── small pieces ────────────────────────────────────────────────────────── */

/** The ocean carrier behind a rate (HPL / CMA / ONE…) — THE differentiator between a
    forwarder's multiple rates on one routing, so it gets a chip, not buried meta text. */
function CarrierChip({ code }) {
  if (!code) return null
  return (
    <span className="inline-flex shrink-0 items-center rounded bg-harbor-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-harbor-700 ring-1 ring-inset ring-harbor-100">
      {code}
    </span>
  )
}

/* CoverageChip lived here and rendered "3 drayage" / "no drayage on file" beside each rate card.
   Drayage coverage is a property of the LANE, so it was identical for every rate sharing a Last CY
   and repeated itself all the way down. It now appears once per OFQ in the summary line ("9 rates
   · 3 covered"), in all three views, and the itinerary panel still lists the actual options. */

/*
  Column track for the rate sub-table, shared by its header and its rows so they cannot drift.
  A single definition is the whole point: the previous cards were a flex row, so the rate column
  only lined up by accident, and stopped lining up the moment a forwarder name got longer.

    marker · routing · forwarder · carrier · vessel · type · ETD · ETA · transit · rate
    └────────────── text, left ──────────────┘  └──── numbers + dates, right ────┘

  Text columns first, then everything right-aligned, so the numeric block runs unbroken to Rate.
  Putting the transport type between Transit and Rate would have split that block with a word.

  THE DRAYAGE COUNT IS GONE from the row. It was answering "can this be trucked at all", which is
  a property of the LANE and therefore identical for every rate sharing a Last CY — so it repeated
  itself down the column while the per-OFQ "3 covered" summary already said the same thing once.
  The itinerary panel is where drayage is actually chosen, and it still lists every option.

  Its width went to the sailing instead: vessel, type, ETD, ETA and transit are properties of THIS
  rate's chosen schedule and differ row to row, which is what a column is for.
*/
const OFR_GRID =
  'grid grid-cols-[14px_minmax(0,1.3fr)_minmax(0,1fr)_52px_minmax(0,1.1fr)_52px_56px_56px_44px_84px] items-center gap-2'

/*
  ── the three views (SKATE.md) ─────────────────────────────────────────────────────────────
  All three show the SAME columns through the same header and row components below, and the same
  `renderOfrRows`. Only the GROUPING differs. That is deliberate: three copies of the row would
  drift, and a rate that reads $3,200 in one view and lines up differently in another is the exact
  problem the table replaced.

    accordion  one OFQ at a time, expanded on click   "this shipment — what came back for it?"
    flat       every rate at once, OFQ as a band      "who is cheapest out of here, on anything?"
    cards      every OFQ as its own block             "walk me through the whole list"

  Labels name the SHAPE rather than the job, because the point of the toggle is to compare shapes.
*/
const VIEWS = [
  { id: 'accordion', label: 'Accordion' },
  { id: 'flat', label: 'Flat' },
  { id: 'cards', label: 'Cards' },
]

/*
  Runway presets, not a number field.

  The field asked you to read a sentence, click into a box and type — three steps for a setting
  with maybe three sensible answers. These are one tap each, and the labels say what they mean
  rather than needing "valid at least … days" wrapped around them.

  The values are not arbitrary. Rates cluster hard at a period boundary — in the current pool 33
  sit at one day and nothing else is under seventeen — so anything between about 2 and 14 selects
  the same set. Presets lose no real precision, and if a number in between ever matters the array
  is one line.
*/
const RUNWAY_PRESETS = [
  { days: 0, label: 'All' },
  { days: 3, label: '3d' },
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
]

/**
 * Why an OFQ is showing fewer rates than the file holds.
 *
 * The two reasons are never merged. "Expired" is a fact about the rate and there is nothing to do
 * about it; "under N days" is a consequence of a control the reader set and can unset. Reporting
 * a single "5 hidden" would tell someone a lane is thin when what is actually true is that they
 * asked not to see part of it — a decision they can only reverse if they know they made it.
 *
 * Returns '' when nothing was hidden, so call sites can append it unconditionally.
 */
function hiddenNote(ofq, minRunwayDays) {
  const parts = []
  if (ofq.expiredCount > 0) parts.push(`${ofq.expiredCount} expired`)
  if (ofq.belowRunwayCount > 0) parts.push(`${ofq.belowRunwayCount} under ${minRunwayDays}d`)
  return parts.length ? ` · ${parts.join(', ')} hidden` : ''
}

/**
 * What to say when an OFQ has been emptied by filtering.
 *
 * Distinguishes the two dead ends, because the response differs. Everything expired means going
 * back out for fresh rates. Everything hidden by the runway control means the rates exist and
 * lowering the threshold brings them back — telling someone to chase new rates in that case sends
 * them to do work they do not need to do.
 */
function emptiedMessage(ofq, minRunwayDays) {
  const { expiredCount = 0, belowRunwayCount = 0 } = ofq
  if (expiredCount > 0 && belowRunwayCount > 0) {
    return `${expiredCount} rate${expiredCount === 1 ? '' : 's'} expired and ${belowRunwayCount} `
      + `have under ${minRunwayDays} days left — lower the threshold to see those, or go back out for fresh rates.`
  }
  if (belowRunwayCount > 0) {
    return `${belowRunwayCount} rate${belowRunwayCount === 1 ? '' : 's'} still live but with under `
      + `${minRunwayDays} days left — lower the threshold to see them.`
  }
  return `All ${expiredCount} rate${expiredCount === 1 ? '' : 's'} expired — go back out for fresh ones.`
}

/** True when an OFQ has nothing left to show but did have rates before filtering. */
const isEmptied = (ofq) =>
  ofq.oceanOptions.length === 0 && (ofq.expiredCount > 0 || ofq.belowRunwayCount > 0)

/** The rate table's header. One definition, so the views cannot disagree about a column. */
function OfrHeader({ className = '' }) {
  return (
    <div className={`${OFR_GRID} border-b border-fog-200/80 px-2 pb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-fog-400 ${className}`}>
      <span />
      <span>Routing</span>
      <span>Forwarder</span>
      <span>Carrier</span>
      <span>Vessel</span>
      <span>Type</span>
      <span className="text-right">ETD</span>
      <span className="text-right">ETA</span>
      <span className="text-right">Transit</span>
      <span className="text-right">Rate</span>
    </div>
  )
}

/**
 * One rate. Rate is the value being compared, so it is right-aligned with tabular figures — in the
 * flex cards this replaced it sat wherever the content before it happened to push it.
 *
 * Routing is POD → Last CY rather than the full chain: a rate's POL is never different from its
 * OFQ's (0 of 128 in the live snapshot), so including it would repeat a value already on screen
 * on every row. What varies between rates is the discharge port and the ramp.
 */
function OfrRow({ ofr, rate, pick, trend, cheapest, active, onSelect }) {
  // A pinned sailing whose ETD has passed cannot carry the booking any more. Same derive-on-render
  // rule as everywhere else (schedulesService.hasSailed) — nothing stored, nothing to go stale.
  const sailed = hasSailed(pick)
  return (
    <button
      onClick={onSelect}
      title={ofr.validUntil ? `valid until ${ofr.validUntil}` : undefined}
      className={[
        OFR_GRID,
        'w-full rounded px-2 py-1.5 text-left transition-colors',
        active ? 'bg-signal-50 ring-1 ring-inset ring-signal-300' : 'hover:bg-white',
      ].join(' ')}
    >
      {/* cheapest, marked rather than merely sorted first — the answer should be readable
          without having to trust the order */}
      <span className="text-center text-[10px] leading-none text-signal-600">{cheapest ? '◆' : ''}</span>

      <span className="flex min-w-0 items-center gap-1 text-xs text-harbor-900">
        <span className="truncate">{ofr.pod || '—'}</span>
        <ArrowRight size={9} className="shrink-0 text-fog-400" />
        <span className="truncate text-sea-700">{ofr.lastCy || '—'}</span>
      </span>

      <span className="truncate text-xs text-harbor-800">{ofr.forwarder || '—'}</span>

      <span className="min-w-0"><CarrierChip code={ofr.carrier} /></span>

      {/* ── the pinned sailing (SAILINGS.md) ──
          All four are empty until someone picks a sailing in the itinerary panel. The dashes mark
          rates whose timing is still unknown, which is a prompt rather than a gap — a rate with no
          schedule is a rate you cannot yet judge on speed. */}
      <span className="truncate font-mono text-[10px] text-fog-600" title={pick?.mother_vessel || undefined}>
        {pick?.mother_vessel || <span className="text-fog-300">—</span>}
      </span>

      {/* Direct vs 1/2/3/4 TS. Coloured because it is a risk read, not just a label — every
          transhipment is another chance to roll, and it is usually what explains a long transit
          sitting next to it. Values come from the feed as free text (it already ships 3 TS and
          4 TS despite the Schedules type declaring only three), so anything unrecognised prints
          as-is rather than being forced into a bucket. */}
      <span className={`truncate font-mono text-[10px] ${
        pick?.transport_type === 'Direct' ? 'font-semibold text-sea-700' : 'text-fog-600'
      }`}>
        {pick?.transport_type || <span className="text-fog-300">—</span>}
      </span>

      {/* A pinned sailing that has already left is worth seeing, not hiding: it is why this
          booking has no live plan. */}
      <span className={`text-right font-mono text-[11px] ${sailed ? 'font-semibold text-signal-600' : 'text-harbor-700'}`}>
        {pick?.etd ? shortDate(pick.etd) : <span className="text-fog-300">—</span>}
      </span>

      <span className="text-right font-mono text-[11px] text-harbor-700">
        {pick?.eta ? shortDate(pick.eta) : <span className="text-fog-300">—</span>}
      </span>

      <span className="text-right font-mono text-[11px] text-harbor-700">
        {pick?.transit_time_days != null ? `${pick.transit_time_days}d` : <span className="text-fog-300">—</span>}
      </span>

      {/* The movement lives WITH the rate rather than in its own column: it is a fact about this
          number, and the table is already ten columns wide. Two lines cost no width.

          Increase reads coral because a buyer's cost went up; a decrease reads sea, the app's
          existing positive tone. `held` is muted but present — a price that did not move across a
          renewal is something you act on, so it is a result rather than a gap. */}
      <span className="flex flex-col items-end leading-tight">
        <span className="font-mono text-sm font-bold tabular-nums text-harbor-900">
          {rate == null ? '—' : money(rate)}
        </span>
        {trend && (
          <span
            title={`was ${money(trend.prevRate)}${trend.prevValidUntil ? `, valid to ${trend.prevValidUntil}` : ''}`}
            className={`font-mono text-[10px] tabular-nums ${
              isHeld(trend.pct) ? 'text-fog-400'
                : trend.pct > 0 ? 'font-semibold text-red-600'
                : 'font-semibold text-sea-700'
            }`}
          >
            {isHeld(trend.pct) ? 'held' : `${trend.pct > 0 ? '▲' : '▼'} ${formatPct(trend.pct).replace(/^[+−]/, '')}`}
          </span>
        )}
      </span>
    </button>
  )
}

/** One stop on the itinerary. `accent` colors the dot; children render the leg BELOW the stop. */
function TimelineStop({ label, place, accent = 'bg-harbor-400', last = false, children }) {
  return (
    <div className="relative pl-6">
      {/* rail segment (skipped after the last stop) */}
      {!last && <span className="absolute left-[5px] top-3 h-full w-px bg-fog-200" />}
      {/* node dot */}
      <span className={`absolute left-0 top-[5px] h-[11px] w-[11px] rounded-full ring-2 ring-white ${accent}`} />
      <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-fog-400">{label}</p>
      <p className="text-sm font-semibold leading-tight text-harbor-900">{place || '—'}</p>
      {children && <div className="py-3">{children}</div>}
      {!children && <div className="pb-4" />}
    </div>
  )
}

/* ── sailings (SAILINGS.md) ──────────────────────────────────────────────── */

/** ETD → POD ETA → ETA, transit, type, vessel. Six facts; the rest lives in the Schedules app. */
function SailingLine({ s }) {
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-x-1.5 text-xs font-semibold text-harbor-900">
          <span>{shortDate(s.etd)}</span>
          <ArrowRight size={10} className="text-fog-400" />
          <span>{shortDate(s.pod_eta)}</span>
          <ArrowRight size={10} className="text-fog-400" />
          <span className="text-sea-700">{shortDate(s.eta)}</span>
        </span>
        <span className="mt-0.5 truncate font-mono text-[10px] text-fog-500">
          {s.mother_vessel || 'vessel n/a'}
        </span>
      </span>
      <span className="shrink-0 text-right font-mono text-[10px] leading-tight text-fog-500">
        <span className="block font-semibold text-harbor-900">
          {s.transit_time_days == null ? '—' : `${s.transit_time_days}d`}
        </span>
        {s.transport_type || '—'}
      </span>
    </>
  )
}

/**
 * The sailings that could carry this booking, and the one chosen.
 *
 * Opens only when asked: the ocean card is a click target, and nothing is fetched until someone
 * wants it. An OFQ list can be long, and a schedule query per visible rate would spend requests
 * on cards nobody looked at.
 */
function SailingsSection({ ofq, ofr, pick, onPick, onClear }) {
  const [open, setOpen] = useState(false)
  const [sailings, setSailings] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const pol = ofr.pol || ofq.pol
  const sailed = hasSailed(pick)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    findSailings({ carrier: ofr.carrier, pol, lastCy: ofr.lastCy, cargoReadyDate: ofq.cargoReadyDate })
      .then(({ sailings, error }) => {
        if (cancelled) return
        if (error) setError(error.message)
        else setSailings(sailings)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, ofr.carrier, pol, ofr.lastCy, ofq.cargoReadyDate])

  // Re-opening after a pick would be busywork; close once the choice is made.
  const choose = async (s) => {
    setSaving(true)
    await onPick(s)
    setSaving(false)
    setOpen(false)
  }

  return (
    <div className="mt-2 border-t border-sea-200/70 pt-2">
      {/* the chosen sailing, or the invitation to choose one */}
      {pick ? (
        <div className={sailed ? 'rounded-lg bg-signal-50 px-2 py-1.5 ring-1 ring-inset ring-signal-200' : ''}>
          {sailed && (
            <p className="mb-1 flex items-center gap-1 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-signal-700">
              <AlertTriangle size={10} className="shrink-0" />
              sailed {shortDate(pick.etd)} — expired
            </p>
          )}
          <div className="flex items-center gap-3">
            <SailingLine s={pick} />
          </div>
          <p className="mt-1 truncate font-mono text-[9px] uppercase tracking-[0.14em] text-fog-400">
            {tidyPlace(pick.port_of_discharge)} discharge
          </p>
        </div>
      ) : null}

      <div className="mt-1.5 flex items-center gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-sea-700 transition-colors hover:text-sea-900"
        >
          <CalendarDays size={11} />
          {pick ? (sailed ? 'pick another sailing' : 'change sailing') : 'find sailings'}
          <ChevronRight size={11} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
        {pick && (
          <button
            onClick={onClear}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-fog-400 transition-colors hover:text-red-600"
          >
            clear
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-1">
          {loading ? (
            <div className="flex items-center gap-1.5 py-2 font-mono text-[10px] text-fog-400">
              <Loader2 size={11} className="animate-spin" /> loading sailings…
            </div>
          ) : error ? (
            <p className="py-1.5 text-[11px] leading-snug text-red-700">{error}</p>
          ) : sailings.length === 0 ? (
            /* Not an error. The feed genuinely does not cover every lane Rates quotes, and it
               only holds the last 5 days of scrapes — so silence here is information, and it
               must not be dressed up as a failure. SAILINGS.md §2c / §3b. */
            <p className="py-1.5 text-[11px] leading-snug text-fog-500">
              No sailings on file for {ofr.carrier || '—'} · {tidyPlace(pol)} → {tidyPlace(ofr.lastCy)}
              {ofq.cargoReadyDate ? ` departing after ${ofq.cargoReadyDate}` : ''}. The schedule feed
              may not cover this lane.
            </p>
          ) : (
            sailings.map((s) => {
              const active = pick?.schedule_hash === s.schedule_hash
              return (
                <button
                  key={s.schedule_hash}
                  onClick={() => choose(s)}
                  disabled={saving}
                  className={[
                    'flex w-full items-center gap-3 rounded-lg border bg-white px-2.5 py-1.5 text-left transition-all disabled:opacity-50',
                    active
                      ? 'border-sea-400 ring-1 ring-sea-300'
                      : 'border-fog-200 hover:border-sea-300 hover:shadow-card',
                  ].join(' ')}
                >
                  <SailingLine s={s} />
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

/* ── booking itinerary panel (right) ─────────────────────────────────────── */

function ItineraryPanel({ ofq, ofr, ranked, selectedDrayageId, onSelectDrayage, pick, onPick, onClearPick }) {
  const selectedDrayage = ranked.find((d) => d.id === selectedDrayageId) ?? null
  const oceanRate = toNum(ofr.rate)
  const total = grandTotal(ofr.rate, selectedDrayage)

  return (
    <div className="stagger flex flex-col overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card">
      {/* header */}
      <div className="border-b border-fog-100 px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-xs font-bold text-harbor-900">{ofq.ofqId}</span>
          {(ofq.containerType || ofq.containerCount) && (
            <span className="inline-flex items-center gap-1 rounded bg-fog-100 px-1.5 py-0.5 font-mono text-[10px] text-fog-500">
              <Container size={11} />
              {ofq.containerCount && `${ofq.containerCount}× `}{ofq.containerType || 'container'}
            </span>
          )}
          {ofq.cargoReadyDate && (
            <span className="inline-flex items-center gap-1 rounded bg-fog-100 px-1.5 py-0.5 font-mono text-[10px] text-fog-500">
              <CalendarDays size={11} /> ready {ofq.cargoReadyDate}
            </span>
          )}
        </div>
        <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-fog-400">Booking itinerary</p>
      </div>

      {/* timeline */}
      <div className="flex-1 overflow-y-auto scrollbar-rail px-5 py-4">
        <TimelineStop label="Port of Loading" place={ofr.pol || ofq.pol}>
          {/* ocean leg */}
          <div className="rounded-xl border border-sea-200 bg-sea-50/50 px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Ship size={14} className="shrink-0 text-sea-600" />
                <span className="truncate text-xs font-semibold text-harbor-900">
                  {ofr.forwarder || 'Ocean'}
                </span>
                <CarrierChip code={ofr.carrier} />
              </span>
              <span className="shrink-0 font-mono text-sm font-bold text-harbor-900">
                {oceanRate == null ? '—' : money(oceanRate)}
              </span>
            </div>
            {ofr.validUntil && (
              <p className="mt-0.5 font-mono text-[10px] text-fog-500">valid until {ofr.validUntil}</p>
            )}
            {/* Sailings hang off the ocean card, inside the same stop — the panel above and the
                drayage below are untouched. SAILINGS.md §5. */}
            <SailingsSection
              ofq={ofq}
              ofr={ofr}
              pick={pick}
              onPick={onPick}
              onClear={onClearPick}
            />
          </div>
        </TimelineStop>

        <TimelineStop label="Port of Discharge" place={ofr.pod} />

        <TimelineStop label="Last CY / ramp" place={ofr.lastCy} accent="bg-sea-500">
          {/* drayage leg — the selectable options */}
          {ranked.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-fog-300 bg-fog-50/60 px-3 py-4 text-center">
              <PackageX size={18} className="text-fog-300" />
              <p className="text-xs font-medium text-harbor-800">No drayage rate on file</p>
              <p className="text-[11px] leading-snug text-fog-500">
                Nothing quoted yet for {ofr.lastCy || '—'} → {ofq.fd || '—'}.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {ranked.map((d, i) => {
                const active = d.id === selectedDrayageId
                return (
                  <button
                    key={d.id}
                    onClick={() => onSelectDrayage(d.id)}
                    className={[
                      'w-full rounded-xl border px-3 py-2 text-left transition-all',
                      active
                        ? 'border-signal-400 bg-signal-50/60 ring-1 ring-signal-300'
                        : 'border-fog-200 bg-white hover:border-signal-200 hover:bg-signal-50/30',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <span className={`h-2 w-2 shrink-0 rounded-full border ${active ? 'border-signal-500 bg-signal-500' : 'border-fog-300'}`} />
                        <Truck size={13} className={`shrink-0 ${active ? 'text-signal-600' : 'text-fog-400'}`} />
                        <span className="truncate text-xs font-semibold text-harbor-900">{d.forwarder?.name ?? '—'}</span>
                        {i === 0 && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-sea-50 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.12em] text-sea-700 ring-1 ring-inset ring-sea-200">
                            <Award size={9} /> best
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 font-mono text-xs font-bold text-harbor-900">{money(toNum(d.total_rate))}</span>
                    </div>
                    <p className="mt-0.5 pl-[22px] font-mono text-[10px] text-fog-500">
                      {money(d.rate)} + {money(d.fuel_surcharge_amount)} fuel
                      {toNum(d.storage_fee_per_day) != null && ` · storage ${money(d.storage_fee_per_day)}/day`}
                    </p>
                  </button>
                )
              })}
            </div>
          )}
        </TimelineStop>

        <TimelineStop label="Final Destination" place={ofq.fd} accent="bg-signal-500" last />
      </div>

      {/* footer — the hero */}
      <div className="border-t border-fog-100 bg-fog-50/50 px-5 py-4">
        {oceanRate == null && (
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-signal-800">
            <AlertTriangle size={12} /> No ocean rate in the file for this option — total is drayage only.
          </p>
        )}
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-fog-400">Landed total</p>
            {selectedDrayage && (
              <p className="mt-0.5 font-mono text-[10px] text-fog-500">
                {oceanRate != null ? `${money(oceanRate)} ocean + ` : ''}{money(toNum(selectedDrayage.total_rate))} drayage
              </p>
            )}
          </div>
          <span className="font-mono text-3xl font-extrabold leading-none text-harbor-950">
            {total != null ? money(total)
              : selectedDrayage ? money(toNum(selectedDrayage.total_rate))
              : oceanRate != null ? money(oceanRate) : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── main page ───────────────────────────────────────────────────────────── */

export default function Bookings() {
  // The shared snapshot: metadata + the parsed universe. `ofqs` is read from it rather than held
  // separately, so there is exactly one answer to "what is on screen" and it always carries its
  // own provenance.
  const [snapshot, setSnapshot] = useState(null)
  const [snapLoading, setSnapLoading] = useState(true)
  const [snapError, setSnapError] = useState(null)
  const [history, setHistory] = useState([])
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState(null)   // parsed file awaiting confirmation

  // Today, fixed once per mount so the memo below has a stable input. Re-reading the clock on
  // every render would make "is this expired" a different question each pass; a session left
  // open across midnight is the acceptable cost, and a reload settles it.
  const [asOf] = useState(() => startOfToday())
  // Minimum days of validity a rate needs to stay on the board. Rates drop off day by day as
  // their runway shrinks, which is the point: the board should show what is bookable now.
  const [minRunwayDays, setMinRunwayDays] = useState(DEFAULT_MIN_VALID_DAYS)

  // What is on screen = the published snapshot MINUS anything past its Valid Until. The raw
  // snapshot is kept intact (`snapshot.ofqs`) — this is a view of it, not a replacement, so the
  // same stored file answers differently tomorrow without being re-uploaded.
  const { ofqs, expiredTotal, belowRunwayTotal } = useMemo(
    () => applyValidity(snapshot?.ofqs ?? [], asOf, minRunwayDays),
    [snapshot, asOf, minRunwayDays],
  )

  /*
    Movement against the rate each one replaced, from the RAW snapshot — deliberately NOT from
    `ofqs` above. The baseline is by definition the older rate, so building this from the filtered
    list would delete exactly what it needs, and silently: the result would just be a smaller Map.
    It also depends only on the snapshot, so changing the runway control does not recompute it.
  */
  const trends = useMemo(
    () => buildRateTrends(snapshot?.ofqs ?? []),
    [snapshot],
  )

  const [query, setQuery] = useState('')
  // 'shipment' — one OFQ at a time, expanded on click.  'flat' — every rate at once.
  // Same columns either way; only the grouping changes.
  const [view, setView] = useState('accordion')
  const [expandedOfqId, setExpandedOfqId] = useState(null)
  const [selectedOfrId, setSelectedOfrId] = useState(null)
  const [selectedDrayageId, setSelectedDrayageId] = useState(null)

  // Chosen sailings, keyed `${ofqId}|${ofrId}`. Loaded once for the whole board — the panel shows
  // one at a time, but a request per expansion would slow down opening quotes for no gain.
  const [picks, setPicks] = useState(() => new Map())

  const [drayByLane, setDrayByLane] = useState(() => new Map())
  const [drayLoading, setDrayLoading] = useState(true)
  const [drayError, setDrayError] = useState(null)

  const [toast, setToast] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const dragDepthRef = useRef(0)
  const fileInputRef = useRef(null)

  const showToast = (severity, message) => setToast({ severity, message })
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])

  /* ── drayage coverage: fetch once, index by lane ───────────────────────── */

  const loadDrayage = useCallback(async () => {
    setDrayLoading(true)
    setDrayError(null)
    const { rates, error } = await fetchDrayageRates({ scope: 'current' })
    if (error) setDrayError(error.message)
    else setDrayByLane(indexDrayageByLane(rates))
    setDrayLoading(false)
  }, [])

  useEffect(() => { loadDrayage() }, [loadDrayage])

  /* ── chosen sailings (SAILINGS.md) ─────────────────────────────────────── */

  // A failed read leaves the map empty and says nothing: sailings are an add-on, and the cost
  // work this page exists for must not be blocked by the schedules feed being unavailable.
  useEffect(() => {
    let cancelled = false
    fetchPicks().then(({ picks }) => { if (!cancelled) setPicks(picks) })
    return () => { cancelled = true }
  }, [])

  const handlePick = useCallback(async (ofqId, ofrId, sailing) => {
    const { pick, error } = await savePick({ ofqId, ofrId, sailing })
    if (error) return showToast('error', `Couldn’t save the sailing: ${error.message}`)
    setPicks((prev) => new Map(prev).set(pickKey(ofqId, ofrId), pick))
  }, [])

  const handleClearPick = useCallback(async (ofqId, ofrId) => {
    const { error } = await clearPick({ ofqId, ofrId })
    if (error) return showToast('error', `Couldn’t clear the sailing: ${error.message}`)
    setPicks((prev) => {
      const next = new Map(prev)
      next.delete(pickKey(ofqId, ofrId))
      return next
    })
  }, [])

  /* ── the shared snapshot ───────────────────────────────────────────────── */

  const loadSnapshot = useCallback(async () => {
    setSnapLoading(true)
    const [{ snapshot: latest, error }, { history: rows }] = await Promise.all([
      fetchLatestSnapshot(),
      fetchSnapshotHistory(8),
    ])
    if (error) setSnapError(error.message)
    else {
      setSnapError(null)
      setSnapshot(latest)
      setHistory(rows)
    }
    setSnapLoading(false)
  }, [])

  useEffect(() => { loadSnapshot() }, [loadSnapshot])

  /* ── upload + parse (browse or drop) ───────────────────────────────────── */

  /*
    Parsing does NOT publish. A file lands in `pending` with a summary of what it would change,
    and is only written when the user confirms — because this upload replaces what every other
    internal user sees, and that deserves more than a drag gesture. The delta is also the honest
    answer to "did I need to re-upload?": age says the sheet is old, the delta says whether
    anything actually moved.
  */
  const handleFile = (file) => {
    if (!file) return
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (!ACCEPTED_EXTS.includes(ext)) {
      return showToast('warning', `Unsupported file type ".${ext}" — expected .csv, .xlsx or .xls`)
    }
    parseRateFile(file, {
      complete(res) {
        const [headerCells, ...dataRows] = res.data
        if (!headerCells) return showToast('warning', 'File had no rows.')
        const { index, missing } = buildBookingsHeaderIndex(headerCells)
        if (missing.length) return showToast('error', `Missing column(s): ${missing.join(', ')}`)
        const parsed = groupByOfqWithOptions(dataRows, index)
        if (!parsed.length) return showToast('warning', 'No OFQ rows found in the file.')
        setPending({ ofqs: parsed, fileName: file.name, diff: diffAgainst(snapshot, parsed) })
      },
      error() { showToast('error', 'Failed to read file') },
    })
  }

  const publishPending = async () => {
    if (!pending) return
    setSaving(true)
    const { snapshot: saved, error } = await saveSnapshot({
      ofqs: pending.ofqs,
      fileName: pending.fileName,
    })
    setSaving(false)
    if (error) return showToast('error', `Couldn’t save the snapshot: ${error.message}`)

    setSnapshot(saved)
    setPending(null)
    setExpandedOfqId(null)
    setSelectedOfrId(null)
    setSelectedDrayageId(null)
    setQuery('')
    fetchSnapshotHistory(8).then(({ history: rows }) => setHistory(rows))
    showToast('success', 'Snapshot published — every internal user sees this now.')
  }

  const onFileInput = (e) => { handleFile(e.target.files?.[0]); e.target.value = '' }

  const handleDragEnter = (e) => { e.preventDefault(); dragDepthRef.current += 1; setDragOver(true) }
  const handleDragOver = (e) => { e.preventDefault() }
  const handleDragLeave = (e) => {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }
  const handleDrop = (e) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    handleFile(e.dataTransfer?.files?.[0])
  }

  /* ── derived ───────────────────────────────────────────────────────────── */

  // Filtered by the search box, then Cargo Ready ASCENDING (soonest first; blanks last) —
  // the working order: quotes that ship soonest need their delivery plan first.
  const filteredOfqs = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = !q ? ofqs : ofqs.filter((o) =>
      [o.ofqId, o.pol, o.fd].some((v) => String(v ?? '').toLowerCase().includes(q)))
    return [...base].sort((a, b) => dateVal(a.cargoReadyDate) - dateVal(b.cargoReadyDate))
  }, [ofqs, query])

  const expandedOfq = useMemo(
    () => ofqs.find((o) => o.ofqId === expandedOfqId) ?? null,
    [ofqs, expandedOfqId],
  )
  const selectedOfr = useMemo(
    () => expandedOfq?.oceanOptions.find((o) => o.ofrId === selectedOfrId) ?? null,
    [expandedOfq, selectedOfrId],
  )

  const drayageFor = useCallback(
    (ofq, ofr) => drayByLane.get(laneKey(ofr.lastCy, ofq.fd)) ?? [],
    [drayByLane],
  )

  /** Drayage options for (ofq, ofr), cheapest first by total_rate (base + fuel — the §6d
      "price"; for a fixed ocean selection this is the same ordering as grand total). */
  const rankFor = useCallback((ofq, ofr) => {
    const rows = drayageFor(ofq, ofr)
    const keyOf = (d) => toNum(d.total_rate) ?? Infinity
    return [...rows].sort((a, b) => keyOf(a) - keyOf(b))
  }, [drayageFor])

  const ranked = useMemo(
    () => (expandedOfq && selectedOfr ? rankFor(expandedOfq, selectedOfr) : []),
    [expandedOfq, selectedOfr, rankFor],
  )

  /**
   * One OFQ's rates, cheapest first, as rows — shared by all three views.
   *
   * Written once because three copies of the same seven props is three chances for one view to
   * mark a different row cheapest, or read transit from somewhere else. The views differ in how
   * they GROUP rates; the rates themselves are the same rates.
   */
  const renderOfrRows = useCallback((ofq) => {
    const sorted = [...ofq.oceanOptions]
      .sort((a, b) => (toNum(a.rate) ?? Infinity) - (toNum(b.rate) ?? Infinity))
    // First row with an actual price — not simply the first row. A rate-less option sorts last,
    // but where every option is rate-less the first row has no price and marking it cheapest
    // would be a claim about nothing.
    const cheapestId = sorted.find((o) => toNum(o.rate) != null)?.ofrId ?? null
    return sorted.map((ofr) => (
      <OfrRow
        key={ofr.ofrId}
        ofr={ofr}
        rate={toNum(ofr.rate)}
        pick={picks.get(pickKey(ofq.ofqId, ofr.ofrId))}
        trend={trends.get(ofr.ofrId)}
        cheapest={ofr.ofrId === cheapestId}
        active={ofr.ofrId === selectedOfrId}
        onSelect={() => selectOfr(ofq, ofr)}
      />
    ))
  }, [drayageFor, picks, trends, selectedOfrId, rankFor]) // eslint-disable-line react-hooks/exhaustive-deps

  const bestGrand = ranked.length ? grandTotal(selectedOfr?.rate, ranked[0]) : null
  const totalOfrs = useMemo(() => ofqs.reduce((n, o) => n + o.oceanOptions.length, 0), [ofqs])

  /* ── interactions ──────────────────────────────────────────────────────── */

  const toggleOfq = (ofqId) => {
    setSelectedOfrId(null)
    setSelectedDrayageId(null)
    setExpandedOfqId((prev) => (prev === ofqId ? null : ofqId))
  }

  const selectOfr = (ofq, ofr) => {
    // Set the OFQ too, not just the rate. The itinerary panel renders from `expandedOfq` and
    // looks the selected rate up INSIDE it, so a rate selected while a different OFQ was expanded
    // resolves to nothing — the row highlights and the panel shows its empty state. That could
    // not happen in the shipment view (you had to expand before you could click), but the flat
    // view makes every rate clickable without expanding anything.
    setExpandedOfqId(ofq.ofqId)
    setSelectedOfrId(ofr.ofrId)
    // cheapest drayage preselected — the user can switch in the panel
    setSelectedDrayageId(rankFor(ofq, ofr)[0]?.id ?? null)
  }

  /* ── render ────────────────────────────────────────────────────────────── */

  const hasFile = ofqs.length > 0

  return (
    <div
      className="relative space-y-6"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-signal-400 bg-signal-50/80">
          <div className="flex items-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-harbor-900 shadow-card-hover">
            <Upload size={18} className="text-signal-600" />
            Drop the OFQ export to {hasFile ? 'stage a new snapshot' : 'upload'}
          </div>
        </div>
      )}

      <PageHeader
        kicker="Internal · Planning"
        title="Bookings"
        subtitle="Open a quote to see its applied ocean rates, pick one, and assemble the door delivery from the drayage rates on file."
        actions={
          <div className="flex items-center gap-2">
            {snapshot && <SnapshotStamp snapshot={snapshot} />}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
            >
              <Upload size={15} />
              {hasFile ? 'New Snapshot' : 'Upload OFQ File'}
            </button>
            <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" hidden onChange={onFileInput} />
          </div>
        }
      />

      {snapError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-card">
          Couldn’t load the current snapshot: {snapError}
        </div>
      )}

      {pending && (
        <PendingSnapshot
          pending={pending}
          current={snapshot}
          saving={saving}
          onPublish={publishPending}
          onDiscard={() => setPending(null)}
        />
      )}

      {drayError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-card">
          Couldn’t load drayage rates: {drayError}
        </div>
      )}

      {snapLoading ? (
        <div className="flex min-h-[46vh] w-full items-center justify-center rounded-2xl border border-fog-200 bg-white shadow-card">
          <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-fog-400">
            <Loader2 size={14} className="animate-spin" /> loading the current snapshot…
          </span>
        </div>
      ) : !hasFile ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex min-h-[46vh] w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-fog-300 bg-white text-center shadow-card transition-colors hover:border-signal-400 hover:bg-signal-50/40"
        >
          <Container size={30} className="text-fog-300" />
          <div className="max-w-sm text-sm text-fog-500">
            No snapshot yet. Drag & drop the OFQ export (.csv or .xlsx) here — or click to browse.<br />
            Whatever you upload becomes the shared view for every internal user.
          </div>
          {drayLoading && (
            <span className="mt-1 inline-flex items-center gap-1.5 font-mono text-[11px] text-fog-400">
              <Loader2 size={12} className="animate-spin" /> loading drayage coverage…
            </span>
          )}
        </button>
      ) : (
        <>
          {/* summary */}
          <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-3">
            <StatCard label="OFQs loaded" value={String(ofqs.length)} icon={FileSpreadsheet} accent="harbor" index={0} />
            {/* Counts what is BOOKABLE, not what the file held — and says so when those differ,
                because "9 rates" quietly becoming "7" overnight needs a reason on screen. */}
            <StatCard
              label="Bookable ocean rates"
              value={String(totalOfrs)}
              icon={Ship}
              accent="sea"
              index={1}
              hint={expiredTotal + belowRunwayTotal > 0
                ? [
                    expiredTotal > 0 ? `${expiredTotal} expired` : null,
                    belowRunwayTotal > 0 ? `${belowRunwayTotal} under ${minRunwayDays}d` : null,
                  ].filter(Boolean).join(' · ') + ' hidden'
                : 'every rate in the file is bookable'}
              /*
                The control lives on the card whose number it changes, rather than in the toolbar
                where it sat between the search box and the view toggle competing with both. Press
                a preset and the figure above moves — cause and effect in one glance, which the
                toolbar could never give because the count was three elements away.
              */
              control={
                <div className="inline-flex rounded-lg bg-fog-100 p-0.5" role="group" aria-label="Minimum days of validity">
                  {RUNWAY_PRESETS.map((p) => (
                    <button
                      key={p.days}
                      onClick={() => setMinRunwayDays(p.days)}
                      title={p.days === 0
                        ? 'Show every unexpired rate'
                        : `Only rates with at least ${p.days} days left`}
                      className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] transition-all ${
                        minRunwayDays === p.days
                          ? 'bg-white text-harbor-900 shadow-sm'
                          : 'text-fog-500 hover:text-harbor-700'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              }
            />
            <StatCard label="Best landed total" value={bestGrand != null ? money(bestGrand) : '—'} icon={Award} accent="signal" index={2} hint={selectedOfr ? 'cheapest drayage on this routing' : 'pick an ocean rate'} />
          </div>

          <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            {/* ── OFQ grid ── */}
            <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card">
              {/* toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-fog-100 p-2.5">
                <div className="flex min-w-[180px] max-w-xs flex-1 items-center gap-2 rounded-lg border border-fog-200 bg-fog-50 px-2.5 py-1.5">
                  <Search size={14} className="text-fog-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search OFQID, POL, destination…"
                    className="w-full bg-transparent text-sm text-harbor-900 outline-none placeholder:text-fog-400"
                  />
                </div>

                {/* Two ways to read the same rates: one shipment at a time, or all of them at
                    once. Neither is right for every question — "what came back for this quote"
                    and "who is cheapest out of here on anything" are different jobs. */}
                <div className="inline-flex shrink-0 rounded-lg bg-fog-100 p-0.5">
                  {VIEWS.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => setView(v.id)}
                      className={`rounded-md px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] transition-all ${
                        view === v.id ? 'bg-white text-harbor-900 shadow-sm' : 'text-fog-500 hover:text-harbor-700'
                      }`}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto">
                {/* Wider than before: the sailing columns earned their space, and this container
                    already scrolls horizontally rather than squeezing the columns. At 1040 the
                    three flexible columns still get 212 / 163 / 179px — enough for
                    "Los Angeles → Los Angeles" and a full vessel name without truncating. */}
                <div className="min-w-[1040px]">
                  {/* ── cards: each OFQ its own block, nothing collapsed ──
                       The OFQ becomes a HEADING rather than a row, which is what it actually is —
                       a shipment, with the offers against it underneath. Costs vertical space,
                       so search carries more weight here than in the other two. */}
                  {view === 'cards' ? (
                    <div className="space-y-2 p-2.5">
                      {filteredOfqs.length === 0 && (
                        <p className="px-4 py-8 text-center text-xs text-fog-400">No OFQs match “{query}”.</p>
                      )}

                      {filteredOfqs.map((ofq) => {
                        const lapsed = isEmptied(ofq)
                        const covered = ofq.oceanOptions.filter((o) => drayageFor(ofq, o).length > 0).length
                        return (
                          <div key={ofq.ofqId} className="overflow-hidden rounded-xl border border-fog-200">
                            <div className="border-b border-fog-100 bg-fog-50/70 px-3 py-2">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="font-mono text-xs font-bold text-harbor-900">{ofq.ofqId}</span>
                                <span className={`ml-auto font-mono text-[10px] ${lapsed ? 'font-semibold text-signal-600' : 'text-fog-500'}`}>
                                  {ofq.oceanOptions.length > 0
                                    ? `${ofq.oceanOptions.length} rate${ofq.oceanOptions.length === 1 ? '' : 's'} · ${covered} covered`
                                    : lapsed ? 'no valid rates' : 'none applied'}
                                </span>
                              </div>
                              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-harbor-900">
                                <span>{ofq.pol || '—'}</span>
                                <ArrowRight size={12} className="shrink-0 text-fog-400" />
                                <span>{ofq.fd || '—'}</span>
                              </p>
                              <p className="mt-0.5 font-mono text-[10px] text-fog-500">
                                {ofq.cargoReadyDate ? `ready ${ofq.cargoReadyDate}` : 'no ready date'}
                                {ofq.containerType || ofq.containerCount
                                  ? ` · ${ofq.containerCount ? `${ofq.containerCount} × ` : ''}${ofq.containerType || 'container'}`
                                  : ''}
                                {hiddenNote(ofq, minRunwayDays)}
                              </p>
                            </div>

                            <div className="px-3 py-2">
                              {ofq.oceanOptions.length === 0 ? (
                                <p className="px-2 py-1 text-[11px] text-fog-500">
                                  {lapsed
                                    ? emptiedMessage(ofq, minRunwayDays)
                                    : 'No ocean rate applied to this OFQ yet.'}
                                </p>
                              ) : (
                                <>
                                  <OfrHeader />
                                  {renderOfrRows(ofq)}
                                </>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : view === 'flat' ? (
                    <>
                      <OfrHeader className="px-3 pt-2.5" />

                      {filteredOfqs.length === 0 && (
                        <p className="px-4 py-8 text-center text-xs text-fog-400">No OFQs match “{query}”.</p>
                      )}

                      {filteredOfqs.map((ofq) => {
                        const lapsed = isEmptied(ofq)
                        // Drayage left the rate rows, so the band carries it here exactly as the
                        // other two views do — coverage is a property of the lane, said once.
                        const covered = ofq.oceanOptions.filter((o) => drayageFor(ofq, o).length > 0).length
                        return (
                          <div key={ofq.ofqId} className="border-b border-fog-100 last:border-0">
                            {/* The band carries everything the OFQ columns carried in the other
                                view — id, lane, readiness, size — so no rate column has to repeat
                                it on every row. */}
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 bg-fog-50/70 px-3 py-1.5">
                              <span className="font-mono text-xs font-bold text-harbor-900">{ofq.ofqId}</span>
                              <span className="text-xs text-harbor-800">
                                {ofq.pol || '—'} <span className="text-fog-400">→</span> {ofq.fd || '—'}
                              </span>
                              <span className="font-mono text-[10px] text-fog-500">
                                {ofq.cargoReadyDate ? `ready ${ofq.cargoReadyDate}` : 'no ready date'}
                                {ofq.containerType || ofq.containerCount
                                  ? ` · ${ofq.containerCount ? `${ofq.containerCount} × ` : ''}${ofq.containerType || 'container'}`
                                  : ''}
                              </span>
                              <span className={`ml-auto font-mono text-[10px] ${lapsed ? 'font-semibold text-signal-600' : 'text-fog-500'}`}>
                                {ofq.oceanOptions.length > 0
                                  ? `${ofq.oceanOptions.length} rate${ofq.oceanOptions.length === 1 ? '' : 's'} · ${covered} covered`
                                  : lapsed ? 'no valid rates' : 'none applied'}
                                {ofq.oceanOptions.length > 0 ? hiddenNote(ofq, minRunwayDays) : ''}
                              </span>
                            </div>

                            <div className="px-3 py-1">
                              {ofq.oceanOptions.length === 0 ? (
                                <p className="px-2 py-1.5 text-[11px] text-fog-500">
                                  {lapsed
                                    ? emptiedMessage(ofq, minRunwayDays)
                                    : 'No ocean rate applied to this OFQ yet.'}
                                </p>
                              ) : renderOfrRows(ofq)}
                            </div>
                          </div>
                        )
                      })}
                    </>
                  ) : (
                  <>
                  {/* header */}
                  <div className="grid grid-cols-[28px_110px_1.1fr_1.1fr_100px_130px] items-center gap-2 border-b border-fog-200 px-3 py-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-fog-500">
                    <span />
                    <span>OFQID</span>
                    <span>Port of Loading</span>
                    <span>Final Destination</span>
                    <span>Cargo Ready</span>
                    <span className="text-right">Ocean rates</span>
                  </div>

                  {filteredOfqs.length === 0 && (
                    <p className="px-4 py-8 text-center text-xs text-fog-400">No OFQs match “{query}”.</p>
                  )}

                  {filteredOfqs.map((ofq) => {
                    const isOpen = ofq.ofqId === expandedOfqId
                    const covered = ofq.oceanOptions.filter((o) => drayageFor(ofq, o).length > 0).length
                    // had rates, all of them expired — real demand with nothing bookable on it
                    const allLapsed = isEmptied(ofq)
                    // sorting + the cheapest marker live in renderOfrRows, so all three views
                    // agree about which row is cheapest
                    return (
                      <div key={ofq.ofqId} className="border-b border-fog-100 last:border-0">
                        {/* OFQ row */}
                        <button
                          onClick={() => toggleOfq(ofq.ofqId)}
                          className={`grid w-full grid-cols-[28px_110px_1.1fr_1.1fr_100px_130px] items-center gap-2 px-3 py-2.5 text-left transition-colors ${isOpen ? 'bg-harbor-50/60' : 'hover:bg-fog-50/70'}`}
                        >
                          <ChevronRight size={15} className={`text-fog-400 transition-transform ${isOpen ? 'rotate-90 text-harbor-600' : ''}`} />
                          <span className="truncate font-mono text-xs font-bold text-harbor-900">{ofq.ofqId}</span>
                          <span className="truncate text-sm text-harbor-800">{ofq.pol || '—'}</span>
                          <span className="truncate text-sm text-harbor-800">{ofq.fd || '—'}</span>
                          <span className="truncate font-mono text-xs text-harbor-700">{ofq.cargoReadyDate || '—'}</span>
                          {/* Three distinct states, not two: a quote nobody has quoted yet and a
                              quote whose rates have all lapsed look identical if both read
                              "none applied", and only the second one needs chasing. */}
                          <span className={`truncate text-right font-mono text-[11px] ${allLapsed ? 'font-semibold text-signal-600' : 'text-fog-500'}`}>
                            {ofq.oceanOptions.length > 0
                              ? `${ofq.oceanOptions.length} rate${ofq.oceanOptions.length === 1 ? '' : 's'} · ${covered} covered`
                              : allLapsed
                                ? 'no valid rates'
                                : 'none applied'}
                          </span>
                        </button>

                        {/* expanded: OFR sub-rows */}
                        {isOpen && (
                          <div className="stagger space-y-1 border-t border-fog-100 bg-fog-50/60 px-3 py-2.5 pl-10">
                            {ofq.oceanOptions.length === 0 ? (
                              <p className="flex items-center gap-1.5 py-1.5 text-xs text-fog-500">
                                <Ship size={13} className="text-fog-400" />
                                {allLapsed
                                  ? emptiedMessage(ofq, minRunwayDays)
                                  : 'No ocean rate applied to this OFQ yet — apply one first, then plan the delivery here.'}
                              </p>
                            ) : (
                              <>
                                <OfrHeader />
                                {renderOfrRows(ofq)}
                              </>
                            )}

                            {/* Says why the list is shorter than the file. Without this, a rate a
                                colleague quoted yesterday simply is not there and nobody can tell
                                whether it lapsed or was never applied. */}
                            {ofq.oceanOptions.length > 0 && hiddenNote(ofq, minRunwayDays) && (
                              <p className="flex items-center gap-1.5 pt-1 font-mono text-[10px] text-fog-400">
                                <CalendarX2 size={11} className="shrink-0" />
                                {hiddenNote(ofq, minRunwayDays).replace(/^ · /, '')}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  </>
                  )}
                </div>
              </div>
            </div>

            {/* ── itinerary panel ── */}
            <div className="xl:sticky xl:top-6">
              {expandedOfq && selectedOfr ? (
                drayLoading ? (
                  <div className="flex min-h-[30vh] items-center justify-center rounded-2xl border border-fog-200 bg-white shadow-card">
                    <Loader2 size={22} className="animate-spin text-fog-400" />
                  </div>
                ) : (
                  <ItineraryPanel
                    ofq={expandedOfq}
                    ofr={selectedOfr}
                    ranked={ranked}
                    selectedDrayageId={selectedDrayageId}
                    onSelectDrayage={setSelectedDrayageId}
                    pick={picks.get(pickKey(expandedOfq.ofqId, selectedOfr.ofrId)) ?? null}
                    onPick={(s) => handlePick(expandedOfq.ofqId, selectedOfr.ofrId, s)}
                    onClearPick={() => handleClearPick(expandedOfq.ofqId, selectedOfr.ofrId)}
                  />
                )
              ) : (
                <div className="flex min-h-[30vh] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-fog-300 bg-fog-50/50 px-6 text-center">
                  <Container size={24} className="text-fog-300" />
                  <p className="text-sm font-medium text-harbor-800">No booking assembled yet</p>
                  <p className="max-w-[220px] text-xs leading-relaxed text-fog-500">
                    Open a quote, then pick one of its ocean rates — the door-to-door itinerary and landed total build here.
                  </p>
                </div>
              )}
            </div>
          </div>

          {history.length > 1 && <SnapshotHistory history={history} currentId={snapshot?.id} />}
        </>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}

/* ── snapshot provenance ─────────────────────────────────────────────────── */

/**
 * Who uploaded the sheet on screen, and when.
 *
 * The stamp turns amber past `STALE_AFTER_DAYS` (snapshotService). It is a cue, never a gate — an old sheet is
 * still the best available answer until someone posts a newer one, and blocking work on it would
 * punish the reader for the uploader's silence. What it CANNOT know is whether new OFQs or newly
 * applied rates exist upstream; age is the only proxy available from here, so the wording says
 * "may be" rather than asserting the sheet is wrong.
 */
function SnapshotStamp({ snapshot }) {
  const stale = isStale(snapshot.uploadedAt)
  return (
    <span
      title={`${snapshot.fileName ?? 'snapshot'} · ${new Date(snapshot.uploadedAt).toLocaleString()}${
        snapshot.uploadedBy ? ` · uploaded by ${snapshot.uploadedBy}` : ''
      }`}
      className={[
        'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 shadow-card',
        stale ? 'border-signal-300 bg-signal-50' : 'border-fog-200 bg-white',
      ].join(' ')}
    >
      <Clock size={13} className={stale ? 'text-signal-600' : 'text-fog-400'} />
      <span className="flex flex-col leading-tight">
        <span className={`font-mono text-xs ${stale ? 'text-signal-900' : 'text-harbor-900'}`}>
          {relativeDay(snapshot.uploadedAt)}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-fog-400">
          {stale ? 'may be out of date' : 'current snapshot'}
        </span>
      </span>
    </span>
  )
}

/**
 * A parsed file, not yet published.
 *
 * Publishing changes what every internal user sees, so it takes a deliberate click rather than
 * following from a drag. The delta is the point of the pause: it answers whether the upload was
 * worth making, and it answers it BEFORE the old snapshot is replaced.
 */
function PendingSnapshot({ pending, current, saving, onPublish, onDiscard }) {
  const { diff, ofqs, fileName } = pending
  const ofrCount = ofqs.reduce((n, o) => n + o.oceanOptions.length, 0)
  const sign = (n) => (n > 0 ? `+${n}` : String(n))

  // Counts against the file as a whole, because that is what is being published — the snapshot
  // stores every rate. Surfacing it HERE is the point: a file that arrives already part-expired
  // means the rates were pulled too long ago, and that is worth knowing before it becomes the
  // shared view rather than after someone wonders where the rows went.
  const { expiredTotal } = applyValidity(ofqs)

  return (
    <div className="stagger rounded-2xl border border-signal-300 bg-signal-50/60 px-5 py-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-signal-700">
            Ready to publish
          </p>
          <p className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-harbor-900">
            <FileSpreadsheet size={14} className="shrink-0 text-fog-400" />
            <span className="font-mono">{fileName}</span>
          </p>
          <p className="mt-1 text-xs text-fog-600">
            {ofqs.length} OFQs · {ofrCount} applied ocean rates
            {diff.isFirst
              ? ' — this becomes the first shared snapshot.'
              : diff.identical
                ? ' — identical to the current snapshot. Nothing has been raised or applied since.'
                : ` — ${sign(diff.ofqDelta)} OFQs, ${sign(diff.ofrDelta)} rates against what is on screen.`}
          </p>
          {expiredTotal > 0 && (
            <p className="mt-1 inline-flex items-center gap-1.5 font-mono text-[11px] text-fog-500">
              <CalendarX2 size={11} className="shrink-0 text-fog-400" />
              {expiredTotal} of {ofrCount} already past their Valid Until — stored, but hidden from the board.
            </p>
          )}
          {!diff.isFirst && diff.newOfqIds.length > 0 && (
            <p className="mt-1 font-mono text-[11px] text-fog-500">
              new: {diff.newOfqIds.slice(0, 6).join(', ')}
              {diff.newOfqIds.length > 6 && ` +${diff.newOfqIds.length - 6} more`}
            </p>
          )}
          {current && (
            <p className="mt-1.5 text-[11px] text-fog-500">
              Replaces the snapshot from {relativeDay(current.uploadedAt)}
              {current.uploadedBy ? ` by ${current.uploadedBy}` : ''} — which stays in history.
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onDiscard}
            disabled={saving}
            className="rounded-lg px-3 py-2 text-sm font-medium text-harbor-700 transition-colors hover:bg-white/70 disabled:opacity-50"
          >
            Discard
          </button>
          <button
            onClick={onPublish}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-harbor-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:bg-harbor-800 disabled:opacity-50"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            Publish snapshot
          </button>
        </div>
      </div>
    </div>
  )
}

/** Earlier uploads. Metadata only — the counts are stored on the row so this costs no payloads. */
function SnapshotHistory({ history, currentId }) {
  return (
    <details className="rounded-2xl border border-fog-200 bg-white shadow-card">
      <summary className="cursor-pointer list-none px-5 py-3">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-fog-500">
          <History size={12} /> Snapshot history · {history.length}
        </span>
      </summary>
      <div className="border-t border-fog-100 px-5 py-3">
        <ul className="space-y-1.5">
          {history.map((s) => {
            const isCurrent = s.id === currentId
            return (
              <li
                key={s.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[11px]"
              >
                <span className={isCurrent ? 'font-bold text-harbor-900' : 'text-fog-500'}>
                  {new Date(s.uploadedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                </span>
                <span className="text-fog-500">
                  {s.ofqCount} OFQs · {s.ofrCount} rates
                </span>
                {s.uploadedBy && <span className="text-fog-400">{s.uploadedBy}</span>}
                {isCurrent && (
                  <span className="rounded bg-sea-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-sea-700 ring-1 ring-inset ring-sea-200">
                    on screen
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        {/* Older snapshots are kept, not shown. Restoring one would mean publishing a stale
            universe as current, which is the opposite of what this page is for — the record is
            here to show how the universe grew, not to be reverted to. */}
        <p className="mt-2.5 text-[11px] leading-snug text-fog-400">
          Kept for reference. To change what is on screen, upload a newer export — snapshots are
          never edited or rolled back.
        </p>
      </div>
    </details>
  )
}
