import React, { useState, useMemo, useRef } from 'react'
import Popover from '@mui/material/Popover'   // direct import (avoid the @mui/material barrel)
import { ListFilter, Search, Check } from 'lucide-react'

/*
  In-header multi-select facet filter (Excel/Linear style). A funnel icon in a table header opens
  a checklist popover of that column's unique values; the parent owns the selected[] + onChange.

  Rendered via MUI Popover so it portals out of the table's overflow-auto scroll container (it
  isn't clipped) and gets outside-click/Escape handling for free.

  Props:
    label     — column name (popover title / aria)
    options   — sorted unique string values for this column
    selected  — string[] currently selected (empty = no filter)
    onChange  — (nextSelected: string[]) => void
*/
export default function ColumnFilter({ label, options, selected, onChange }) {
  const btnRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const active = selected.length > 0
  const selectedSet = useMemo(() => new Set(selected), [selected])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options
  }, [options, query])

  const close = () => { setOpen(false); setQuery('') }

  const toggle = (value) => {
    onChange(selectedSet.has(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        title={active ? `${label}: ${selected.length} selected` : `Filter ${label}`}
        className={[
          'inline-flex h-5 items-center gap-0.5 rounded px-1 transition-colors',
          active
            ? 'bg-signal-100 text-signal-700 ring-1 ring-inset ring-signal-200'
            : 'text-fog-400 hover:bg-fog-100 hover:text-harbor-600',
        ].join(' ')}
      >
        <ListFilter size={13} />
        {active && <span className="font-mono text-[9px] font-bold leading-none">{selected.length}</span>}
      </button>

      <Popover
        open={open}
        anchorEl={btnRef.current}
        onClose={close}
        disableScrollLock
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { className: 'mt-1 rounded-xl border border-fog-200 shadow-card-hover' } }}
      >
        <div className="w-60 font-sans">
          {/* search */}
          <div className="flex items-center gap-2 border-b border-fog-100 px-3 py-2">
            <Search size={14} className="shrink-0 text-fog-400" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${label}…`}
              className="w-full bg-transparent text-sm text-harbor-900 outline-none placeholder:text-fog-400"
            />
          </div>

          {/* select all / clear */}
          <div className="flex items-center justify-between border-b border-fog-100 px-3 py-1.5 text-[11px] font-medium">
            <button
              type="button"
              className="text-harbor-600 hover:text-harbor-900"
              onClick={() => onChange([...new Set([...selected, ...visible])])}
            >
              Select all{query && ' (matches)'}
            </button>
            <button
              type="button"
              className="text-fog-500 hover:text-harbor-800 disabled:opacity-40"
              disabled={!active}
              onClick={() => onChange([])}
            >
              Clear
            </button>
          </div>

          {/* options */}
          <ul className="max-h-64 overflow-auto py-1">
            {visible.length === 0 ? (
              <li className="px-3 py-2 text-xs text-fog-400">No matches</li>
            ) : (
              visible.map((value) => {
                const checked = selectedSet.has(value)
                return (
                  <li key={value}>
                    <button
                      type="button"
                      onClick={() => toggle(value)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-harbor-800 hover:bg-fog-50"
                    >
                      <span
                        className={[
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                          checked ? 'border-signal-500 bg-signal-500 text-harbor-950' : 'border-fog-300 bg-white',
                        ].join(' ')}
                      >
                        {checked && <Check size={12} strokeWidth={3} />}
                      </span>
                      <span className="truncate">{value}</span>
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      </Popover>
    </>
  )
}
