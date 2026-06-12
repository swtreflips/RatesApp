import React, { useState, useRef, useCallback, useEffect } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Trash2, Upload, Plus, Send, X } from 'lucide-react'
import Papa from 'papaparse'
import { useAuth } from '../../../app/providers/AuthProvider'
import { postRateRequestBatch } from '../services/rateRequestService'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'

/* ── helpers ──────────────────────────────────────────────────────────── */

let nextId = 1
const makeEmptyRow = () => ({ id: nextId++, pol: '', fd: '', containerType: '', containerCount: '' })

function laneKey(r) {
  return `${r.pol.trim().toLowerCase()}|${r.fd.trim().toLowerCase()}`
}

function dedup(rows) {
  const seen = new Set()
  const unique = []
  let removed = 0
  for (const r of rows) {
    const key = laneKey(r)
    if (!key || key === '|' || !seen.has(key)) {
      if (key && key !== '|') seen.add(key)
      unique.push(r)
    } else {
      removed++
    }
  }
  return { unique, removed }
}

const TOAST_COLORS = {
  success: 'bg-sea-600',
  warning: 'bg-signal-600',
  error:   'bg-red-600',
}

/* ── component ────────────────────────────────────────────────────────── */

export default function NewRateRequest() {
  const { user } = useAuth()
  const fileInputRef = useRef(null)

  const [rows, setRows] = useState([makeEmptyRow()])
  const [posting, setPosting] = useState(false)
  const [toast, setToast] = useState(null)

  /* ── auto-dismiss toast ──────────────────────────────────────────────── */

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const showToast = (severity, message) => setToast({ severity, message })

  /* ── columns ─────────────────────────────────────────────────────────── */

  const columns = [
    {
      field: 'rowNum',
      headerName: '#',
      width: 56,
      sortable: false,
      filterable: false,
      cellClassName: 'font-mono text-fog-400',
      renderCell: (params) => params.api.getRowIndexRelativeToVisibleRows(params.row.id) + 1,
    },
    {
      field: 'pol',
      headerName: 'Port of Loading',
      flex: 1,
      minWidth: 200,
      editable: true,
    },
    {
      field: 'fd',
      headerName: 'Final Destination',
      flex: 1,
      minWidth: 200,
      editable: true,
    },
    {
      field: 'containerType',
      headerName: 'Container Type',
      width: 150,
      editable: true,
      type: 'singleSelect',
      cellClassName: 'font-mono',
      valueOptions: ['20GP', '40GP', '40HC', '45HC', '20RF', '40RF'],
    },
    {
      field: 'containerCount',
      headerName: '# Containers',
      width: 130,
      editable: true,
      type: 'number',
      cellClassName: 'font-mono',
    },
    {
      field: 'actions',
      headerName: '',
      width: 50,
      sortable: false,
      filterable: false,
      renderCell: (params) => (
        <button
          className="rounded-md p-1 text-fog-400 transition-colors hover:bg-red-50 hover:text-red-600"
          onClick={() => handleDeleteRow(params.row.id)}
          tabIndex={-1}
        >
          <Trash2 size={16} />
        </button>
      ),
    },
  ]

  /* ── row editing ─────────────────────────────────────────────────────── */

  const processRowUpdate = useCallback((newRow, oldRow) => {
    const newKey = laneKey(newRow)
    // Only check for duplicates if both fields are filled
    if (newKey && newKey !== '|') {
      const isDuplicate = rows.some(r => r.id !== newRow.id && laneKey(r) === newKey)
      if (isDuplicate) {
        showToast('warning', 'Duplicate lane — this POL / FD pair already exists')
        return oldRow
      }
    }
    setRows(prev => prev.map(r => (r.id === newRow.id ? newRow : r)))
    return newRow
  }, [rows])

  /* ── add / delete rows ───────────────────────────────────────────────── */

  const handleAddRow = () => {
    setRows(prev => [...prev, makeEmptyRow()])
  }

  const handleDeleteRow = (id) => {
    setRows(prev => {
      const filtered = prev.filter(r => r.id !== id)
      return filtered.length === 0 ? [makeEmptyRow()] : filtered
    })
  }

  /* ── CSV upload ──────────────────────────────────────────────────────── */

  const handleCsvUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete(results) {
        const parsed = results.data
          .map(row => {
            // flexible header matching: accept common variations
            const pol = row.pol ?? row.POL ?? row['Port of Loading'] ?? row['port_of_loading'] ?? ''
            const fd = row.fd ?? row.FD ?? row['Final Destination'] ?? row['final_destination'] ?? ''
            const containerType = row.containerType ?? row.container_type ?? row['Container Type'] ?? ''
            const containerCount = row.containerCount ?? row.container_count ?? row['# of Containers'] ?? row['# Containers'] ?? row['containers'] ?? ''
            return { id: nextId++, pol: pol.trim(), fd: fd.trim(), containerType: containerType.toString().trim(), containerCount: containerCount === '' ? '' : Number(containerCount) || '' }
          })
          .filter(r => r.pol || r.fd) // drop fully empty rows

        if (parsed.length > 0) {
          const { unique, removed } = dedup(parsed)
          setRows(unique)
          const msg = `Loaded ${unique.length} lane(s) from CSV`
          showToast('success', removed > 0 ? `${msg} (${removed} duplicate(s) removed)` : msg)
        } else {
          showToast('warning', 'CSV had no valid rows. Expected columns: pol, fd')
        }
      },
      error() {
        showToast('error', 'Failed to parse CSV file')
      },
    })

    // reset so the same file can be re-selected
    e.target.value = ''
  }

  /* ── post batch ──────────────────────────────────────────────────────── */

  const handlePost = async () => {
    const valid = rows.filter(r => r.pol.trim() && r.fd.trim())
    if (valid.length === 0) {
      showToast('warning', 'Add at least one lane with both POL and Final Destination')
      return
    }

    // Safety dedup before posting
    const { unique: dedupedValid } = dedup(valid)

    if (!user?.id) {
      showToast('error', 'No active session — please sign in again')
      return
    }

    setPosting(true)
    const { batch, error } = await postRateRequestBatch(
      dedupedValid.map(({ pol, fd, containerType, containerCount }) => ({ pol, fd, containerType, containerCount })),
      user.id
    )
    setPosting(false)

    if (error) {
      showToast('error', `Post failed: ${error.message}`)
    } else {
      showToast('success', `Batch ${batch?.id ?? ''} posted — ${dedupedValid.length} lane(s)`)
      setRows([makeEmptyRow()])
    }
  }

  /* ── render ──────────────────────────────────────────────────────────── */

  const laneCount = rows.filter(r => r.pol.trim() && r.fd.trim()).length

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Requester · New Request"
        title="New Rate Request"
        subtitle="Add origin / destination lanes, then post to create a request batch."
        actions={
          <span className="inline-flex items-center gap-2 rounded-lg border border-fog-200 bg-white px-3 py-1.5 shadow-card">
            <span className="font-mono text-lg font-semibold leading-none text-harbor-900">{laneCount}</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fog-400">
              valid {laneCount === 1 ? 'lane' : 'lanes'}
            </span>
          </span>
        }
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
          onClick={handleAddRow}
        >
          <Plus size={16} />
          Add Row
        </button>
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={16} />
          Upload CSV
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          hidden
          onChange={handleCsvUpload}
        />

        <div className="flex-1" />

        <button
          className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          onClick={handlePost}
          disabled={posting}
        >
          <Send size={16} className="transition-transform group-hover:translate-x-0.5" />
          {posting ? 'Sending…' : 'Send Request'}
        </button>
      </div>

      {/* DataGrid */}
      <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card" style={{ width: '100%' }}>
        <DataGrid
          rows={rows}
          columns={columns}
          processRowUpdate={processRowUpdate}
          disableRowSelectionOnClick
          hideFooter
          autoHeight
          sx={{
            border: 'none',
            fontFamily: '"Hanken Grotesk", ui-sans-serif, sans-serif',
            '& .MuiDataGrid-columnHeaders': {
              backgroundColor: '#f7f8fa',
              borderBottom: '1px solid #dfe4ea',
            },
            '& .MuiDataGrid-columnHeader': {
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontSize: '0.7rem',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: '#566270',
            },
            '& .MuiDataGrid-columnSeparator': { color: '#eef1f4' },
            '& .MuiDataGrid-cell': {
              fontSize: '0.875rem',
              color: '#132236',
              borderColor: '#eef1f4',
            },
            '& .MuiDataGrid-row:hover': { backgroundColor: '#f7f8fa' },
            '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': {
              outline: '2px solid rgba(245,165,36,0.5)',
              outlineOffset: '-2px',
            },
            '& .MuiDataGrid-cell--editing': {
              boxShadow: 'inset 0 0 0 2px rgba(245,165,36,0.5)',
            },
          }}
        />
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-card-hover animate-rise-in ${TOAST_COLORS[toast.severity]}`}>
          <span>{toast.message}</span>
          <button
            className="rounded-md p-0.5 transition-colors hover:bg-white/20"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
