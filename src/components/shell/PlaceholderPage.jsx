import React from 'react'
import { Compass } from 'lucide-react'

/**
 * Generic placeholder for pages not yet implemented.
 * Used throughout Phase 1 to fill route slots cleanly.
 */
export default function PlaceholderPage({ title, description, phase, compact }) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-12' : 'min-h-[55vh]'}`}>
      <div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-harbor-50 ring-1 ring-inset ring-harbor-100">
        <span className="absolute inset-0 rounded-2xl bg-chart-grid bg-[size:12px_12px] opacity-[0.08]" />
        <Compass size={30} strokeWidth={1.5} className="text-harbor-400" />
      </div>
      <h2 className="mb-1.5 text-lg font-bold text-harbor-900">{title}</h2>
      {description && (
        <p className="max-w-sm text-sm leading-relaxed text-fog-500">{description}</p>
      )}
      {phase && (
        <span className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-fog-300 px-3 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-fog-500">
          <span className="h-1.5 w-1.5 rounded-full bg-signal-400" />
          Coming in {phase}
        </span>
      )}
    </div>
  )
}
