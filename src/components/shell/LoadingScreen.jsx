import React from 'react'
import { Anchor } from 'lucide-react'

export default function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-2 text-brand-600">
          <Anchor size={32} strokeWidth={1.5} className="animate-pulse" />
          <span className="text-2xl font-semibold tracking-tight text-slate-800">
            RatesApp
          </span>
        </div>
        <div className="h-1 w-48 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full w-1/3 animate-[loading_1.2s_ease-in-out_infinite] rounded-full bg-brand-500" />
        </div>
        <p className="text-sm text-slate-400">Loading session…</p>
      </div>

      <style>{`
        @keyframes loading {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  )
}
