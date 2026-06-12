import React, { useState } from 'react'
import { Anchor, LogIn } from 'lucide-react'
import { supabase } from '../lib/supabase'

/**
 * Minimal email/password login (STEP 0 / S0.3).
 *
 * Deliberately bare: a real Supabase session is all this slice needs so that
 * auth.uid() becomes real and RLS engages. Password sign-in is intentional for
 * fast local loop testing (logging in/out across accounts to prove isolation);
 * production swaps to magic link later (NEXTSTEPS A1) — a small, localized change.
 *
 * No success handling needed: AuthProvider subscribes to onAuthStateChange, so a
 * successful sign-in updates `session` and App's gate re-renders into the Shell.
 */
export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setSubmitting(false)
  }

  return (
    <div className="grain relative flex h-screen items-center justify-center overflow-hidden bg-harbor-mesh px-4 text-white">
      {/* Faint nautical grid */}
      <div className="pointer-events-none absolute inset-0 bg-chart-grid bg-[size:28px_28px] opacity-50" />

      <div className="relative w-full max-w-sm">
        {/* Brand lockup */}
        <div className="mb-8 flex items-center justify-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-signal-500 text-harbor-950 shadow-signal">
            <Anchor size={24} strokeWidth={2.25} />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-display text-3xl font-extrabold tracking-tightest text-white">
              Rates<span className="text-signal-400">App</span>
            </span>
            <span className="mt-1 font-mono text-[10px] uppercase tracking-[0.28em] text-harbor-300">
              Ocean Freight Platform
            </span>
          </span>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-card backdrop-blur-md"
        >
          <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-harbor-300">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            className="mb-4 w-full rounded-lg border border-white/10 bg-harbor-950/40 px-3 py-2.5 text-sm text-white placeholder-harbor-400 outline-none transition-colors focus:border-signal-500/60 focus:ring-2 focus:ring-signal-500/30"
            placeholder="you@company.com"
          />

          <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-harbor-300">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="w-full rounded-lg border border-white/10 bg-harbor-950/40 px-3 py-2.5 text-sm text-white placeholder-harbor-400 outline-none transition-colors focus:border-signal-500/60 focus:ring-2 focus:ring-signal-500/30"
            placeholder="••••••••"
          />

          {error && (
            <p className="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="group mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-signal-500 px-4 py-2.5 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          >
            <LogIn size={16} className="transition-transform group-hover:translate-x-0.5" />
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
