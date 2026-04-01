import React from 'react'
import { Construction } from 'lucide-react'

/**
 * Generic placeholder for pages not yet implemented.
 * Used throughout Phase 1 to fill route slots cleanly.
 */
export default function PlaceholderPage({ title, description, phase, compact }) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-12' : 'min-h-[60vh]'}`}>
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
        <Construction size={28} strokeWidth={1.5} className="text-slate-400" />
      </div>
      <h2 className="mb-1 text-lg font-semibold text-slate-700">{title}</h2>
      {description && (
        <p className="max-w-sm text-sm text-slate-400">{description}</p>
      )}
      {phase && (
        <span className="mt-4 rounded-full border border-dashed border-slate-300 px-3 py-1 text-xs text-slate-400">
          Coming in {phase}
        </span>
      )}
    </div>
  )
}
