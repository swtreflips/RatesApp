import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Upload, Search, Ship, Truck, Container, ArrowRight, ChevronRight, Loader2, Award,
  PackageX, FileSpreadsheet, AlertTriangle, CalendarDays,
} from 'lucide-react'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'
import { parseRateFile, Toast } from '../../rates/rateGrid'
import { money } from '../../drayage/drayageGrid'
import { fetchDrayageRates } from '../../drayage/services/drayageService'
import { buildBookingsHeaderIndex, groupByOfqWithOptions } from '../bookings/inputCsv'
import { laneKey, toNum, indexDrayageByLane, grandTotal } from '../bookings/matching'

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
  OFR click is an O(1) lookup — no round-trip. v1 decisions unchanged: no persistence, no geo
  hint yet, internal-only.
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

function CoverageChip({ count }) {
  if (count > 0) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-sea-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-sea-700 ring-1 ring-inset ring-sea-200">
        <Truck size={10} /> {count} drayage
      </span>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-fog-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-fog-500">
      <PackageX size={10} /> no drayage on file
    </span>
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

/* ── booking itinerary panel (right) ─────────────────────────────────────── */

function ItineraryPanel({ ofq, ofr, ranked, selectedDrayageId, onSelectDrayage }) {
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
  const [ofqs, setOfqs] = useState([])
  const [fileName, setFileName] = useState(null)
  const [query, setQuery] = useState('')
  const [expandedOfqId, setExpandedOfqId] = useState(null)
  const [selectedOfrId, setSelectedOfrId] = useState(null)
  const [selectedDrayageId, setSelectedDrayageId] = useState(null)

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

  /* ── upload + parse (browse or drop) ───────────────────────────────────── */

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
        setOfqs(parsed)
        setFileName(file.name)
        setExpandedOfqId(null)
        setSelectedOfrId(null)
        setSelectedDrayageId(null)
        setQuery('')
      },
      error() { showToast('error', 'Failed to read file') },
    })
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

  const filteredOfqs = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ofqs
    return ofqs.filter((o) =>
      [o.ofqId, o.pol, o.fd].some((v) => String(v ?? '').toLowerCase().includes(q)))
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

  /** Drayage options for (ofq, ofr), cheapest grand total first. */
  const rankFor = useCallback((ofq, ofr) => {
    const rows = drayageFor(ofq, ofr)
    const keyOf = (d) => grandTotal(ofr.rate, d) ?? toNum(d.total_rate) ?? Infinity
    return [...rows].sort((a, b) => keyOf(a) - keyOf(b))
  }, [drayageFor])

  const ranked = useMemo(
    () => (expandedOfq && selectedOfr ? rankFor(expandedOfq, selectedOfr) : []),
    [expandedOfq, selectedOfr, rankFor],
  )

  const bestGrand = ranked.length ? grandTotal(selectedOfr?.rate, ranked[0]) : null
  const totalOfrs = useMemo(() => ofqs.reduce((n, o) => n + o.oceanOptions.length, 0), [ofqs])

  /* ── interactions ──────────────────────────────────────────────────────── */

  const toggleOfq = (ofqId) => {
    setSelectedOfrId(null)
    setSelectedDrayageId(null)
    setExpandedOfqId((prev) => (prev === ofqId ? null : ofqId))
  }

  const selectOfr = (ofq, ofr) => {
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
            Drop the OFQ file to {hasFile ? 'replace the current file' : 'upload'}
          </div>
        </div>
      )}

      <PageHeader
        kicker="Internal · Planning"
        title="Bookings"
        subtitle="Open a quote to see its applied ocean rates, pick one, and assemble the door delivery from the drayage rates on file."
        actions={
          <div className="flex items-center gap-2">
            {fileName && (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-fog-200 bg-white px-3 py-1.5 shadow-card">
                <FileSpreadsheet size={13} className="text-fog-400" />
                <span className="font-mono text-xs text-harbor-900">{fileName}</span>
              </span>
            )}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
            >
              <Upload size={15} />
              {hasFile ? 'Different File' : 'Upload OFQ File'}
            </button>
            <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" hidden onChange={onFileInput} />
          </div>
        }
      />

      {drayError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-card">
          Couldn’t load drayage rates: {drayError}
        </div>
      )}

      {!hasFile ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex min-h-[46vh] w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-fog-300 bg-white text-center shadow-card transition-colors hover:border-signal-400 hover:bg-signal-50/40"
        >
          <Container size={30} className="text-fog-300" />
          <div className="max-w-sm text-sm text-fog-500">
            Drag & drop the OFQ export (.csv or .xlsx) here — or click to browse.<br />
            Each quote opens into its applied ocean rates and the drayage options that complete the delivery.
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
            <StatCard label="Ocean rates in file" value={String(totalOfrs)} icon={Ship} accent="sea" index={1} />
            <StatCard label="Best landed total" value={bestGrand != null ? money(bestGrand) : '—'} icon={Award} accent="signal" index={2} hint={selectedOfr ? 'cheapest drayage on this routing' : 'pick an ocean rate'} />
          </div>

          <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            {/* ── OFQ grid ── */}
            <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card">
              {/* toolbar */}
              <div className="border-b border-fog-100 p-2.5">
                <div className="flex max-w-xs items-center gap-2 rounded-lg border border-fog-200 bg-fog-50 px-2.5 py-1.5">
                  <Search size={14} className="text-fog-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search OFQID, POL, destination…"
                    className="w-full bg-transparent text-sm text-harbor-900 outline-none placeholder:text-fog-400"
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <div className="min-w-[720px]">
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
                          <span className="truncate text-right font-mono text-[11px] text-fog-500">
                            {ofq.oceanOptions.length === 0
                              ? 'none applied'
                              : `${ofq.oceanOptions.length} rate${ofq.oceanOptions.length === 1 ? '' : 's'} · ${covered} covered`}
                          </span>
                        </button>

                        {/* expanded: OFR sub-rows */}
                        {isOpen && (
                          <div className="stagger space-y-1 border-t border-fog-100 bg-fog-50/60 px-3 py-2.5 pl-10">
                            {ofq.oceanOptions.length === 0 ? (
                              <p className="flex items-center gap-1.5 py-1.5 text-xs text-fog-500">
                                <Ship size={13} className="text-fog-400" />
                                No ocean rate applied to this OFQ yet — apply one first, then plan the delivery here.
                              </p>
                            ) : (
                              ofq.oceanOptions.map((ofr) => {
                                const active = ofr.ofrId === selectedOfrId
                                const drayCount = drayageFor(ofq, ofr).length
                                return (
                                  <button
                                    key={ofr.ofrId}
                                    onClick={() => selectOfr(ofq, ofr)}
                                    className={[
                                      'flex w-full items-center gap-3 rounded-lg border bg-white px-3 py-2 text-left transition-all',
                                      active
                                        ? 'border-signal-400 shadow-signal ring-1 ring-signal-300'
                                        : 'border-fog-200 hover:border-harbor-300 hover:shadow-card',
                                    ].join(' ')}
                                  >
                                    <Ship size={14} className={`shrink-0 ${active ? 'text-sea-600' : 'text-sea-500'}`} />
                                    <span className="flex min-w-0 flex-1 flex-col">
                                      <span className="flex flex-wrap items-center gap-x-1 text-xs font-semibold text-harbor-900">
                                        <span className="truncate">{ofr.pol || ofq.pol || '—'}</span>
                                        <ArrowRight size={10} className="text-fog-400" />
                                        <span className="truncate">{ofr.pod || '—'}</span>
                                        <ArrowRight size={10} className="text-fog-400" />
                                        <span className="truncate text-sea-700">{ofr.lastCy || '—'}</span>
                                      </span>
                                      <span className="mt-0.5 truncate font-mono text-[10px] text-fog-500">
                                        {ofr.forwarder || '—'}{ofr.validUntil ? ` · until ${ofr.validUntil}` : ''}
                                      </span>
                                    </span>
                                    <CarrierChip code={ofr.carrier} />
                                    <CoverageChip count={drayCount} />
                                    <span className="w-20 shrink-0 text-right font-mono text-sm font-bold text-harbor-900">
                                      {toNum(ofr.rate) == null ? '—' : money(toNum(ofr.rate))}
                                    </span>
                                  </button>
                                )
                              })
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
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
        </>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
