import React from 'react'
import { AuthProvider, useAuth } from './providers/AuthProvider'
import Shell from './Shell'
import LoginPage from './LoginPage'
import LoadingScreen from '../components/shell/LoadingScreen'
import { supabase } from '../lib/supabase'

function AppInner() {
  const { session, loading, profile, role } = useAuth()

  // Order matters: "still loading" must never fall through to "no access", or a slow
  // network reads as a locked account. profile === undefined means the identity query
  // has not resolved yet.
  if (loading || (session && profile === undefined)) return <LoadingScreen />
  if (!session) return <LoginPage />

  // Authenticated is not authorised. A session with no profile row — or a role that is
  // neither internal nor forwarder — gets an explicit refusal, not an empty Shell.
  // An empty app looks like a bug; a refusal looks like a decision.
  if (!profile || !role) return <NoAccess email={session.user?.email} />

  return <Shell />
}

function NoAccess({ email }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-fog-50 px-6 text-center">
      <h1 className="text-lg font-semibold text-fog-900">No access</h1>
      <p className="max-w-sm text-sm text-fog-600">
        {email ? `${email} is signed in, but has no profile in this workspace.` :
                 'This account has no profile in this workspace.'}
        {' '}Ask an administrator to set one up.
      </p>
      <button
        onClick={() => supabase.auth.signOut()}
        className="rounded-lg border border-fog-300 px-4 py-2 text-sm text-fog-700 hover:bg-fog-100"
      >
        Sign out
      </button>
    </div>
  )
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
