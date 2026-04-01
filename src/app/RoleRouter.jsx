import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './providers/AuthProvider'

// Feature domain placeholders — will be replaced with real pages in later phases
import RequesterRoot from '../features/requester/pages/RequesterRoot'
import ProviderRoot from '../features/provider/pages/ProviderRoot'

/**
 * Mounts the correct feature domain based on the authenticated user's role.
 * All role routing is centralised here — Shell remains role-agnostic.
 */
export default function RoleRouter() {
  const { role } = useAuth()

  return (
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
  )
}
