import React from 'react'
import { AuthProvider, useAuth } from './providers/AuthProvider'
import Shell from './Shell'
import LoginPage from './LoginPage'
import LoadingScreen from '../components/shell/LoadingScreen'

function AppInner() {
  const { session, loading } = useAuth()

  if (loading) return <LoadingScreen />
  if (!session) return <LoginPage />

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
