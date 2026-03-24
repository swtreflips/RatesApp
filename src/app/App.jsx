import React from 'react'
import { AuthProvider, useAuth } from './providers/AuthProvider'
import Shell from './Shell'
import LoadingScreen from '../components/shell/LoadingScreen'

function AppInner() {
  const { loading } = useAuth()

  if (loading) return <LoadingScreen />

  return <Shell />
}

/**
 * Root application component.
 * Wraps everything in AuthProvider so session/role are available app-wide.
 */
export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  )
}
