import React, { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from './providers/AuthProvider'

// Feature domains are code-split so the heavy requester grid (MUI X DataGrid)
// is only fetched when that domain is actually visited — keeps the initial
// bundle small (Vercel react-best-practices: bundle-dynamic-imports).
const RequesterRoot = lazy(() => import('../features/requester/pages/RequesterRoot'))
const ProviderRoot = lazy(() => import('../features/provider/pages/ProviderRoot'))

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
        element={<Navigate to={role === 'provider' ? '/provider' : '/requester'} replace />}
      />

      {/* Requester feature domain — only mounted for requesters */}
      {role === 'requester' && <Route path="/requester/*" element={<RequesterRoot />} />}

      {/* Provider feature domain — only mounted for providers */}
      {role === 'provider' && <Route path="/provider/*" element={<ProviderRoot />} />}

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  )
}
