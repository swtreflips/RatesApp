import React, { useState, useRef, useCallback, useEffect } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Trash2, Upload, Plus, Send, X } from 'lucide-react'
import Papa from 'papaparse'
import { useAuth } from '../../../app/providers/AuthProvider'
import { postRateRequestBatch } from '../services/rateRequestService'

/* ── helpers ──────────────────────────────────────────────────────────── */

let nextId = 1
const makeEmptyRow = () => ({ id: nextId++, pol: '', fd: '' })

const TOAST_COLORS = {
  success: 'bg-green-600',
  warning: 'bg-amber-500',
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
      width: 60,
      sortable: false,
      filterable: false,
      renderCell: (params) => {
        const index = rows.findIndex(r => r.id === params.row.id)
        return index + 1
      },
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
      field: 'actions',
      headerName: '',
      width: 50,
      sortable: false,
      filterable: false,
      renderCell: (params) => (
        <button
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          onClick={() => handleDeleteRow(params.row.id)}
          tabIndex={-1}
        >
          <Trash2 size={16} />
        </button>
      ),
    },
  ]

  /* ── row editing ─────────────────────────────────────────────────────── */

  const processRowUpdate = useCallback((newRow) => {
    setRows(prev => prev.map(r => (r.id === newRow.id ? newRow : r)))
    return newRow
  }, [])

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
            return { id: nextId++, pol: pol.trim(), fd: fd.trim() }
          })
          .filter(r => r.pol || r.fd) // drop fully empty rows

        if (parsed.length > 0) {
          setRows(parsed)
          showToast('success', `Loaded ${parsed.length} lane(s) from CSV`)
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

    setPosting(true)
    const { batch, error } = await postRateRequestBatch(
      valid.map(({ pol, fd }) => ({ pol, fd })),
      user?.id ?? 'dev-user'
    )
    setPosting(false)

    if (error) {
      showToast('error', `Post failed: ${error.message}`)
    } else {
      showToast('success', `Batch ${batch?.id ?? ''} posted — ${valid.length} lane(s)`)
      setRows([makeEmptyRow()])
    }
  }

  /* ── render ──────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-slate-800">New Rate Request</h1>
        <p className="mt-0.5 text-sm text-slate-400">
          Add origin / destination lanes, then post to create a request batch.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          onClick={handleAddRow}
        >
          <Plus size={16} />
          Add Row
        </button>
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
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
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
          onClick={handlePost}
          disabled={posting}
        >
          <Send size={16} />
          {posting ? 'Posting…' : 'Post Batch'}
        </button>
      </div>

      {/* DataGrid */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm" style={{ width: '100%' }}>
        <DataGrid
          rows={rows}
          columns={columns}
          processRowUpdate={processRowUpdate}
          disableRowSelectionOnClick
          hideFooter
          autoHeight
          sx={{
            border: 'none',
            '& .MuiDataGrid-cell': { fontSize: '0.875rem' },
            '& .MuiDataGrid-columnHeader': { fontSize: '0.875rem', fontWeight: 600 },
          }}
        />
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-lg ${TOAST_COLORS[toast.severity]}`}>
          <span>{toast.message}</span>
          <button
            className="rounded p-0.5 hover:bg-white/20 transition-colors"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
