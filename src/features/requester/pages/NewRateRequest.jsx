import React, { useState, useRef, useCallback } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Snackbar from '@mui/material/Snackbar'
import Alert from '@mui/material/Alert'
import IconButton from '@mui/material/IconButton'
import { Trash2, Upload, Plus, Send } from 'lucide-react'
import Papa from 'papaparse'
import { useAuth } from '../../../app/providers/AuthProvider'
import { postRateRequestBatch } from '../services/rateRequestService'

/* ── helpers ──────────────────────────────────────────────────────────── */

let nextId = 1
const makeEmptyRow = () => ({ id: nextId++, pol: '', fd: '' })

/* ── component ────────────────────────────────────────────────────────── */

export default function NewRateRequest() {
  const { user } = useAuth()
  const fileInputRef = useRef(null)

  const [rows, setRows] = useState([makeEmptyRow()])
  const [posting, setPosting] = useState(false)
  const [snack, setSnack] = useState({ open: false, severity: 'success', message: '' })

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
        <IconButton
          size="small"
          onClick={() => handleDeleteRow(params.row.id)}
          tabIndex={-1}
        >
          <Trash2 size={16} />
        </IconButton>
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
          showSnack('success', `Loaded ${parsed.length} lane(s) from CSV`)
        } else {
          showSnack('warning', 'CSV had no valid rows. Expected columns: pol, fd')
        }
      },
      error() {
        showSnack('error', 'Failed to parse CSV file')
      },
    })

    // reset so the same file can be re-selected
    e.target.value = ''
  }

  /* ── post batch ──────────────────────────────────────────────────────── */

  const handlePost = async () => {
    const valid = rows.filter(r => r.pol.trim() && r.fd.trim())
    if (valid.length === 0) {
      showSnack('warning', 'Add at least one lane with both POL and Final Destination')
      return
    }

    setPosting(true)
    const { batch, error } = await postRateRequestBatch(
      valid.map(({ pol, fd }) => ({ pol, fd })),
      user?.id ?? 'dev-user'
    )
    setPosting(false)

    if (error) {
      showSnack('error', `Post failed: ${error.message}`)
    } else {
      showSnack('success', `Batch ${batch?.id ?? ''} posted — ${valid.length} lane(s)`)
      setRows([makeEmptyRow()])
    }
  }

  /* ── snackbar helper ─────────────────────────────────────────────────── */

  const showSnack = (severity, message) => setSnack({ open: true, severity, message })

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
      <Stack direction="row" spacing={1}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<Plus size={16} />}
          onClick={handleAddRow}
        >
          Add Row
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<Upload size={16} />}
          onClick={() => fileInputRef.current?.click()}
        >
          Upload CSV
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          hidden
          onChange={handleCsvUpload}
        />

        <div className="flex-1" />

        <Button
          size="small"
          variant="contained"
          startIcon={<Send size={16} />}
          onClick={handlePost}
          disabled={posting}
        >
          {posting ? 'Posting…' : 'Post Batch'}
        </Button>
      </Stack>

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

      {/* Snackbar */}
      <Snackbar
        open={snack.open}
        autoHideDuration={4000}
        onClose={() => setSnack(s => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={snack.severity}
          variant="filled"
          onClose={() => setSnack(s => ({ ...s, open: false }))}
        >
          {snack.message}
        </Alert>
      </Snackbar>
    </div>
  )
}
