import React, { useState, useCallback } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Trash2, Plus, Send, Loader2 } from 'lucide-react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'
import { AutocompleteEditCell, DATA_GRID_SX, gridScrollHeight, Toast } from '../../rates/rateGrid'
import { LAST_CY_OPTIONS } from '../../rates/locationOptions'
import { postDrayageRequestBatch } from '../services/drayageService'
import { useAuth } from '../../../app/providers/AuthProvider'

/*
  Internal "New Drayage Request" — post demand lanes (origin CY/CFS → delivery city).
  Lean by design: a drayage request is just the routing pair (+ zip / notes); the money
  columns belong to the forwarder's template. Lanes carry the request TTL (10 days) as
  flow control; the rates that come back are open-ended (DRAY.md §6b).
*/

let tmp = 0
const emptyLane = () => ({ id: `lane-${++tmp}`, origin: '', destination: '', zip: '', notes: '' })

export default function DrayageNewRequest() {
  const { user } = useAuth()
  const [rows, setRows] = useState([emptyLane()])
  const [posting, setPosting] = useState(false)
  const [toast, setToast] = useState(null)

  const showToast = (severity, message) => {
    setToast({ severity, message })
    setTimeout(() => setToast(null), 4000)
  }

  const processRowUpdate = useCallback((newRow) => {
    setRows((prev) => prev.map((r) => (r.id === newRow.id ? newRow : r)))
    return newRow
  }, [])

  const handleDelete = (row) => setRows((prev) => {
    const filtered = prev.filter((r) => r.id !== row.id)
    return filtered.length === 0 ? [emptyLane()] : filtered
  })

  const columns = [
    {
      field: 'rowNum', headerName: '#', width: 38, sortable: false, filterable: false,
      cellClassName: 'font-mono text-fog-400',
      renderCell: (params) => params.api.getRowIndexRelativeToVisibleRows(params.row.id) + 1,
    },
    { field: 'origin', headerName: 'Last CY/CFS (origin)', flex: 1.2, minWidth: 150, editable: true,
      renderEditCell: (p) => <AutocompleteEditCell {...p} options={LAST_CY_OPTIONS} /> },
    { field: 'destination', headerName: 'Final Destination', flex: 1.2, minWidth: 150, editable: true },
    { field: 'zip', headerName: 'Zip Code', width: 96, editable: true, cellClassName: 'font-mono' },
    { field: 'notes', headerName: 'Notes', flex: 1.4, minWidth: 140, editable: true },
    {
      field: 'actions', headerName: '', width: 48, sortable: false, filterable: false,
      renderCell: (params) => (
        <button
          className="rounded-md p-1 text-fog-400 transition-colors hover:bg-red-50 hover:text-red-600"
          onClick={() => handleDelete(params.row)}
          tabIndex={-1}
          title="Remove this lane"
        >
          <Trash2 size={15} />
        </button>
      ),
    },
  ]

  const filled = rows.filter((r) => r.origin && r.destination)

  const handlePost = async () => {
    if (filled.length === 0) {
      showToast('warning', 'Fill origin and destination on at least one lane')
      return
    }
    setPosting(true)
    const { error } = await postDrayageRequestBatch(filled, user?.id)
    setPosting(false)
    if (error) {
      showToast('error', `Post failed: ${error.message}`)
    } else {
      showToast('success', `Posted ${filled.length} drayage lane(s)`)
      setRows([emptyLane()])
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Internal · Drayage"
        title="New Drayage Request"
        subtitle="Post the drayage lanes you need rates for — origin CY/CFS to delivery city. Forwarders fill the money side in their template."
        actions={
          <span className="inline-flex items-center gap-2 rounded-lg border border-fog-200 bg-white px-3 py-1.5 shadow-card">
            <span className="font-mono text-lg font-semibold leading-none text-harbor-900">{filled.length}</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fog-400">
              lane{filled.length === 1 ? '' : 's'} ready
            </span>
          </span>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
          onClick={() => setRows((prev) => [...prev, emptyLane()])}
        >
          <Plus size={16} />
          Add Lane
        </button>
        <div className="flex-1" />
        <button
          className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          onClick={handlePost}
          disabled={posting || filled.length === 0}
        >
          {posting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} className="transition-transform group-hover:translate-x-0.5" />}
          {posting ? 'Posting…' : 'Post Request'}
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card" style={{ width: '100%' }}>
        <DataGrid
          rows={rows}
          columns={columns}
          processRowUpdate={processRowUpdate}
          tabNavigation="content"
          disableRowSelectionOnClick
          hideFooter
          sx={{ ...DATA_GRID_SX, height: gridScrollHeight(rows.length) }}
        />
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
