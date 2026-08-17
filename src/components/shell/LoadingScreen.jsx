import React from 'react'
import { BrandMark } from './BrandMark'

export default function LoadingScreen() {
  return (
    <div className="grain relative flex h-screen items-center justify-center overflow-hidden bg-harbor-mesh text-white">
      {/* Faint nautical grid */}
      <div className="pointer-events-none absolute inset-0 bg-chart-grid bg-[size:28px_28px] opacity-50" />

      <div className="relative flex flex-col items-center gap-6">
        <div className="flex items-center">
          <BrandMark size="lg" />
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
