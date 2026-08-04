import React, { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from './providers/AuthProvider'
import { ROLES } from '../lib/roles'

// Feature domains are code-split so the heavy internal grid (MUI X DataGrid)
// is only fetched when that domain is actually visited — keeps the initial
// bundle small (Vercel react-best-practices: bundle-dynamic-imports).
const InternalRoot = lazy(() => import('../features/internal/pages/InternalRoot'))
const ForwarderRoot = lazy(() => import('../features/forwarder/pages/ForwarderRoot'))

// Reachable by BOTH roles — see the route below.
const Settings = lazy(() => import('../features/account/pages/Settings'))

/** Lightweight fallback shown while a lazy domain chunk loads. */
function RouteFallback() {
  return (
    <div className="flex min-h-[55vh] items-center justify-center">
      <Loader2 size={26} className="animate-spin text-fog-400" />
    </div>
  )
}

/**
 * Mounts the correct feature domain based on the authenticated user's role.
 * All role routing is centralised here — Shell remains role-agnostic.
 */
export default function RoleRouter() {
  const { role } = useAuth()

  return (
    <Suspense fallback={<RouteFallback />}>
    <Routes>
      {/* Default redirect based on role */}
      <Route
        path="/"
        element={<Navigate to={role === ROLES.FORWARDER ? '/forwarder' : '/internal'} replace />}
      />

      {/* Internal feature domain — only mounted for internal users */}
      {role === ROLES.INTERNAL && <Route path="/internal/*" element={<InternalRoot />} />}

      {/* Forwarder feature domain — only mounted for forwarders */}
      {role === ROLES.FORWARDER && <Route path="/forwarder/*" element={<ForwarderRoot />} />}

      {/*
        Account settings — the ONE route not gated on role, and deliberately so.

        Every other route here is a feature domain: internal plans, forwarders quote, and mounting
        the wrong one would show somebody a workspace that is not theirs. This is your own
        account. Changing your password is the same act whoever you are, so it lives outside both
        domains rather than being built twice and drifting.
      */}
      <Route path="/settings" element={<Settings />} />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  )
}
