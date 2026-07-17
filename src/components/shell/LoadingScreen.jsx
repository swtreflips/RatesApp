import React from 'react'
import { Anchor } from 'lucide-react'

export default function LoadingScreen() {
  return (
    <div className="grain relative flex h-screen items-center justify-center overflow-hidden bg-harbor-mesh text-white">
      {/* Faint nautical grid */}
      <div className="pointer-events-none absolute inset-0 bg-chart-grid bg-[size:28px_28px] opacity-50" />

      <div className="relative flex flex-col items-center gap-6">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-signal-500 text-harbor-950 shadow-signal animate-pulse-soft">
            <Anchor size={24} strokeWidth={2.25} />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-display text-3xl font-extrabold tracking-tightest text-white">
              Rates<span className="text-signal-400">App</span>
            </span>
            <span className="mt-1 font-mono text-[10px] uppercase tracking-[0.28em] text-harbor-300">
              Freight Rate Platform
            </span>
          </span>
        </div>

        {/* Sweeping progress rail */}
        <div className="relative h-1 w-56 overflow-hidden rounded-full bg-white/10">
          <div className="absolute h-full w-1/4 rounded-full bg-signal-400 animate-sweep" />
        </div>

        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-harbor-300">
          Establishing session…
        </p>
      </div>
    </div>
  )
}
