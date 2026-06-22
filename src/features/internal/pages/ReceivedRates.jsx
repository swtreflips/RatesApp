import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, Inbox, RefreshCw, FilterX } from 'lucide-react'
import { PageHeader, ScrollTable } from '../../../components/ui/DashboardPrimitives'
import ColumnFilter from '../../../components/ui/ColumnFilter'
import { fetchReceivedRates } from '../services/rateRequestService'

/*
  Internal "Active Rates" — all rates the team can see (lane-linked AND independent).
  Per-column facet filters (Forwarder / POL / POD / Last CY / Final Destination / Carrier):
  each header opens a checklist of that column's unique values; columns combine with AND.
  Filtering is client-side over the fetched set.
*/

function fmtMoney(amount, currency) {
  if (amount == null) return '—'
  return `${currency || 'USD'} ${Number(amount).toLocaleString()}`
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString() : '—'
}

// Filterable columns — drives the unique-value facets, the headers, and the filter predicate.
const BLANK = '(blank)'
const valOf = (col, r) => {
  const v = col.get(r)
  return v == null || v === '' ? BLANK : String(v)
}
const FILTER_COLS = [
  { id: 'forwarder', label: 'Forwarder',        get: (r) => r.forwarder?.name },
  { id: 'pol',       label: 'POL',               get: (r) => r.pol },
  { id: 'pod',       label: 'POD',               get: (r) => r.pod },
  { id: 'last_cy',   label: 'Last CY',           get: (r) => r.last_cy },
  { id: 'fd',        label: 'Final Destination', get: (r) => r.fd },
  { id: 'carrier',   label: 'Carrier',           get: (r) => r.carrier },
]

export default function ReceivedRates() {
  const [rates, setRates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filters, setFilters] = useState({}) // { [colId]: string[] }

  async function load() {
    setLoading(true)
    setError(null)
    const { rates, error } = await fetchReceivedRates()
    if (error) setError(error.message)
    else setRates(rates)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // unique values per filterable column (from the full fetched set), sorted; (blank) last
  const uniques = useMemo(() => {
    const out = {}
    for (const col of FILTER_COLS) {
      out[col.id] = [...new Set(rates.map((r) => valOf(col, r)))].sort((a, b) =>
        a === BLANK ? 1 : b === BLANK ? -1 : a.localeCompare(b))
    }
    return out
  }, [rates])

  // rows passing EVERY active column filter (AND)
  const filteredRates = useMemo(() => {
    const active = FILTER_COLS
      .map((col) => [col, new Set(filters[col.id] ?? [])])
      .filter(([, sel]) => sel.size > 0)
    if (active.length === 0) return rates
    return rates.filter((r) => active.every(([col, sel]) => sel.has(valOf(col, r))))
  }, [rates, filters])

  const hasFilters = FILTER_COLS.some((col) => (filters[col.id] ?? []).length > 0)
  const clearFilters = () => setFilters({})

  return (
    <div className="space-y-6">
      <PageHeader
        title="Active Rates"
        actions={
          <div className="flex items-center gap-2">
            {hasFilters && (
              <>
                <span className="font-mono text-xs text-fog-500">
                  Showing {filteredRates.length} of {rates.length}
                </span>
                <button
                  onClick={clearFilters}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
                >
                  <FilterX size={15} />
                  Clear filters
                </button>
              </>
            )}
            <button
              onClick={load}
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
          <Inbox size={28} className="text-fog-300" />
          <p className="text-sm font-medium text-harbor-800">No rates received yet</p>
          <p className="max-w-xs text-xs text-fog-500">
            Once a forwarder submits a rate on one of your lanes, it shows up here.
          </p>
        </div>
      ) : (
        <ScrollTable minWidth="820px">
            <thead>
              <tr className="border-b border-fog-200 font-mono text-[10px] uppercase tracking-[0.06em] text-fog-500">
                {FILTER_COLS.map((col) => (
                  <th key={col.id} className="px-3 py-2.5 font-semibold">
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      <ColumnFilter
                        label={col.label}
                        options={uniques[col.id] ?? []}
                        selected={filters[col.id] ?? []}
                        onChange={(next) => setFilters((f) => ({ ...f, [col.id]: next }))}
                      />
                    </span>
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right font-semibold">Rate</th>
                <th className="px-3 py-2.5 text-right font-semibold"># of Free Days</th>
                <th className="px-3 py-2.5 font-semibold">Valid Until</th>
                <th className="px-3 py-2.5 font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody>
              {filteredRates.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-10 text-center text-sm text-fog-500">
                    No rates match your filters.{' '}
                    <button onClick={clearFilters} className="font-medium text-signal-700 underline-offset-2 hover:underline">
                      Clear filters
                    </button>
                  </td>
                </tr>
              ) : (
                filteredRates.map((r) => (
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
                ))
              )}
            </tbody>
        </ScrollTable>
      )}
    </div>
  )
}
