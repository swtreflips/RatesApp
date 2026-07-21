import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Upload, Search, Ship, Truck, Container, ArrowRight, Loader2, Award,
  PackageX, FileSpreadsheet, AlertTriangle,
} from 'lucide-react'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'
import { parseRateFile, Toast } from '../../rates/rateGrid'
import { money } from '../../drayage/drayageGrid'
import { fetchDrayageRates } from '../../drayage/services/drayageService'
import { buildBookingsHeaderIndex, groupByOfqWithOptions } from '../bookings/inputCsv'
import { laneKey, toNum, indexDrayageByLane, grandTotal } from '../bookings/matching'

/*
  Internal "Bookings" — landed-cost scenario planner (BOOKINGS.md). Cross-service, so it lives
  outside the ocean/drayage sidebar groups. Upload the OFQ file → pick an OFQ → its already-applied
  ocean options are cards → selecting one reveals the REAL drayage rates on file for that Last CY →
  the OFQ's Final Destination, ranked cheapest-first by grand total (ocean rate + drayage total_rate).

  v1: no persistence, no geo hint (deferred), internal-only. Drayage coverage is fetched ONCE and
  indexed by normalized lane key, so selecting an ocean option is instant + normalization is fully
  under our control (matching.js).
*/

const ACCEPTED_EXTS = ['csv', 'xlsx', 'xls']

/* ── ocean option card (routing chain, à la Apply Rates' RouteCell) ──────── */

function OceanOptionCard({ option, hasDrayage, selected, onSelect }) {
  const rate = toNum(option.rate)
  return (
    <button
      onClick={onSelect}
      className={[
        'group relative flex w-full flex-col gap-1.5 rounded-xl border bg-white px-3.5 py-3 text-left transition-all',
        selected
          ? 'border-signal-400 shadow-signal ring-1 ring-signal-300'
          : 'border-fog-200 shadow-card hover:border-harbor-300 hover:shadow-card-hover',
      ].join(' ')}
    >
      <div className="flex items-center gap-1.5">
        <Ship size={14} className={selected ? 'text-sea-600' : 'text-sea-500'} />
        <span className="flex flex-wrap items-center gap-x-1 text-xs font-semibold text-harbor-900">
          <span className="truncate">{option.pol || '—'}</span>
          <ArrowRight size={11} className="text-fog-400" />
          <span className="truncate">{option.pod || '—'}</span>
          <ArrowRight size={11} className="text-fog-400" />
          <span className="truncate text-sea-700">{option.lastCy || '—'}</span>
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-fog-500">
          {option.carrier || 'no carrier'}
        </span>
        <span className="shrink-0 font-mono text-sm font-bold text-harbor-900">
          {rate == null ? '—' : money(rate)}
        </span>
      </div>
      {!hasDrayage && (
        <span className="inline-flex w-max items-center gap-1 rounded bg-fog-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-fog-500">
          <PackageX size={10} /> no drayage on file
        </span>
      )}
    </button>
  )
}

/* ── drayage option row (grand total = the hero numeral) ─────────────────── */

function DrayageOptionRow({ d, oceanRate, best }) {
  const gt = grandTotal(oceanRate, d)
  const dTotal = toNum(d.total_rate)
  const oceanMissing = toNum(oceanRate) == null
  return (
    <div
      className={[
        'flex items-center gap-3 rounded-xl border bg-white px-4 py-3 transition-all',
        best ? 'border-sea-300 ring-1 ring-sea-200' : 'border-fog-200',
      ].join(' ')}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${best ? 'bg-sea-50 text-sea-600' : 'bg-signal-50 text-signal-600'}`}>
        <Truck size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-harbor-900">{d.forwarder?.name ?? '—'}</span>
          {best && (
            <span className="inline-flex items-center gap-1 rounded bg-sea-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-sea-700 ring-1 ring-inset ring-sea-200">
              <Award size={10} /> best total
            </span>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-fog-500">
          {money(d.rate)} rate + {money(d.fuel_surcharge_amount)} fuel = {money(dTotal)} drayage
          {toNum(d.storage_fee_per_day) != null && ` · ${money(d.storage_fee_per_day)}/day storage`}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-2xl font-extrabold leading-none text-harbor-950">
          {gt != null ? money(gt) : money(dTotal)}
        </div>
        <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-fog-400">
          {oceanMissing ? 'drayage only' : 'grand total'}
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
  const [selectedOfqId, setSelectedOfqId] = useState(null)
  const [selectedOfrId, setSelectedOfrId] = useState(null)

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

  /* ── load the current drayage coverage once, index by lane ─────────────── */

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
        setSelectedOfqId(parsed[0].ofqId)
        setSelectedOfrId(null)
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

  const selectedOfq = useMemo(
    () => ofqs.find((o) => o.ofqId === selectedOfqId) ?? null,
    [ofqs, selectedOfqId],
  )
  const selectedOption = useMemo(
    () => selectedOfq?.oceanOptions.find((o) => o.ofrId === selectedOfrId) ?? null,
    [selectedOfq, selectedOfrId],
  )

  const hasDrayageFor = useCallback(
    (option) => drayByLane.has(laneKey(option.lastCy, selectedOfq?.fd)),
    [drayByLane, selectedOfq],
  )

  // Drayage rows for the selected ocean option, ranked cheapest-first by grand total.
  const rankedDrayage = useMemo(() => {
    if (!selectedOption || !selectedOfq) return []
    const rows = drayByLane.get(laneKey(selectedOption.lastCy, selectedOfq.fd)) ?? []
    const keyOf = (d) => grandTotal(selectedOption.rate, d) ?? toNum(d.total_rate) ?? Infinity
    return [...rows].sort((a, b) => keyOf(a) - keyOf(b))
  }, [selectedOption, selectedOfq, drayByLane])

  const bestGrand = rankedDrayage.length ? grandTotal(selectedOption?.rate, rankedDrayage[0]) : null

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
        subtitle="Explore the landed cost of each open quote: pick an OFQ, choose an applied ocean rate, and compare the real drayage rates that complete the door delivery."
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

      {/* idle — drop CTA */}
      {!hasFile ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex min-h-[46vh] w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-fog-300 bg-white text-center shadow-card transition-colors hover:border-signal-400 hover:bg-signal-50/40"
        >
          <Container size={30} className="text-fog-300" />
          <div className="max-w-sm text-sm text-fog-500">
            Drag & drop the OFQ export (.csv or .xlsx) here — or click to browse.<br />
            Each quote’s applied ocean rates open up their matching drayage options and the combined landed cost.
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
            <StatCard label="Ocean options" value={selectedOfq ? String(selectedOfq.oceanOptions.length) : '—'} icon={Ship} accent="sea" index={1} hint={selectedOfq ? `for ${selectedOfq.ofqId}` : undefined} />
            <StatCard label="Best landed total" value={bestGrand != null ? money(bestGrand) : '—'} icon={Award} accent="signal" index={2} hint={selectedOption ? 'cheapest drayage on this route' : 'select an ocean option'} />
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr]">
            {/* OFQ list (master) */}
            <div className="flex flex-col overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card">
              <div className="border-b border-fog-100 p-2.5">
                <div className="flex items-center gap-2 rounded-lg border border-fog-200 bg-fog-50 px-2.5 py-1.5">
                  <Search size={14} className="text-fog-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search OFQs…"
                    className="w-full bg-transparent text-sm text-harbor-900 outline-none placeholder:text-fog-400"
                  />
                </div>
              </div>
              <ul className="max-h-[60vh] overflow-y-auto scrollbar-rail p-1.5">
                {filteredOfqs.map((o) => {
                  const active = o.ofqId === selectedOfqId
                  return (
                    <li key={o.ofqId}>
                      <button
                        onClick={() => { setSelectedOfqId(o.ofqId); setSelectedOfrId(null) }}
                        className={[
                          'w-full rounded-lg px-3 py-2 text-left transition-colors',
                          active ? 'bg-harbor-50 ring-1 ring-inset ring-harbor-200' : 'hover:bg-fog-50',
                        ].join(' ')}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-xs font-semibold text-harbor-900">{o.ofqId}</span>
                          <span className="shrink-0 font-mono text-[10px] text-fog-400">
                            {o.oceanOptions.length} opt{o.oceanOptions.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-fog-500">
                          {o.pol || '—'} <ArrowRight size={9} className="inline text-fog-400" /> {o.fd || '—'}
                        </div>
                      </button>
                    </li>
                  )
                })}
                {filteredOfqs.length === 0 && (
                  <li className="px-3 py-6 text-center text-xs text-fog-400">No OFQs match “{query}”.</li>
                )}
              </ul>
            </div>

            {/* detail */}
            <div className="min-w-0 space-y-5">
              {!selectedOfq ? (
                <div className="flex min-h-[30vh] items-center justify-center rounded-2xl border border-fog-200 bg-white text-sm text-fog-500 shadow-card">
                  Select an OFQ to explore its options.
                </div>
              ) : selectedOfq.oceanOptions.length === 0 ? (
                <div className="flex min-h-[30vh] flex-col items-center justify-center gap-2 rounded-2xl border border-fog-200 bg-white text-center shadow-card">
                  <Ship size={26} className="text-fog-300" />
                  <p className="text-sm font-medium text-harbor-800">No ocean rate applied to {selectedOfq.ofqId} yet</p>
                  <p className="max-w-xs text-xs text-fog-500">Apply an ocean rate to this OFQ first — then its drayage options show up here.</p>
                </div>
              ) : (
                <>
                  {/* OFQ header line */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-mono text-xs font-semibold text-harbor-500">{selectedOfq.ofqId}</span>
                    <span className="font-semibold text-harbor-900">{selectedOfq.pol || '—'}</span>
                    <ArrowRight size={13} className="text-fog-400" />
                    <span className="font-semibold text-harbor-900">{selectedOfq.fd || '—'}</span>
                    {(selectedOfq.containerType || selectedOfq.containerCount) && (
                      <span className="ml-1 inline-flex items-center gap-1 rounded bg-fog-100 px-1.5 py-0.5 font-mono text-[10px] text-fog-500">
                        <Container size={11} />
                        {selectedOfq.containerCount && `${selectedOfq.containerCount}× `}{selectedOfq.containerType || 'container'}
                      </span>
                    )}
                  </div>

                  {/* ocean options */}
                  <div>
                    <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-fog-400">
                      Ocean options — pick one to complete
                    </p>
                    <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {selectedOfq.oceanOptions.map((opt) => (
                        <OceanOptionCard
                          key={opt.ofrId}
                          option={opt}
                          hasDrayage={hasDrayageFor(opt)}
                          selected={opt.ofrId === selectedOfrId}
                          onSelect={() => setSelectedOfrId(opt.ofrId)}
                        />
                      ))}
                    </div>
                  </div>

                  {/* drayage panel */}
                  {selectedOption && (
                    <div>
                      <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-fog-400">
                        Drayage options · {selectedOption.lastCy || '—'} <ArrowRight size={10} className="inline" /> {selectedOfq.fd || '—'}
                      </p>

                      {toNum(selectedOption.rate) == null && (
                        <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-signal-200 bg-signal-50 px-3 py-2 text-xs text-signal-800">
                          <AlertTriangle size={13} /> This ocean option has no rate in the file — showing drayage totals only.
                        </div>
                      )}

                      {drayLoading ? (
                        <div className="flex min-h-[20vh] items-center justify-center rounded-2xl border border-fog-200 bg-white shadow-card">
                          <Loader2 size={22} className="animate-spin text-fog-400" />
                        </div>
                      ) : rankedDrayage.length === 0 ? (
                        <div className="flex min-h-[22vh] flex-col items-center justify-center gap-2 rounded-2xl border border-fog-200 bg-white text-center shadow-card">
                          <PackageX size={26} className="text-fog-300" />
                          <p className="text-sm font-medium text-harbor-800">No drayage rate on file</p>
                          <p className="max-w-sm text-xs text-fog-500">
                            Nothing quoted yet for {selectedOption.lastCy || '—'} → {selectedOfq.fd || '—'}. Request a drayage rate for this lane to fill the gap.
                          </p>
                        </div>
                      ) : (
                        <div className="stagger space-y-2">
                          {rankedDrayage.map((d, i) => (
                            <DrayageOptionRow key={d.id} d={d} oceanRate={selectedOption.rate} best={i === 0} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {!selectedOption && (
                    <div className="rounded-2xl border border-dashed border-fog-300 bg-fog-50/50 px-4 py-6 text-center text-sm text-fog-500">
                      Pick an ocean option above to see its drayage rates and the landed cost.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
