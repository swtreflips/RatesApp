import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

const AuthContext = createContext(null)

/**
 * Provides session, user, role, and loading state to the entire app.
 * Role is derived from user_metadata.role — seeded during sign-up or set via admin.
 * In Phase 1 this also supports a dev-mode mock role toggle.
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  // Dev-mode mock: allows toggling role without a real auth session
  const [devRole, setDevRole] = useState(
    () => localStorage.getItem('dev_role') ?? 'requester'
  )

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        setSession(session)
      })
      .catch(() => {
        // Supabase unreachable (e.g. placeholder URL in dev) — treat as logged out
      })
      .finally(() => {
        setLoading(false)
      })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => subscription.unsubscribe()
  }, [])

  const user = session?.user ?? null
  const role = user?.user_metadata?.role ?? devRole

  function toggleDevRole() {
    const next = devRole === 'requester' ? 'provider' : 'requester'
    setDevRole(next)
    localStorage.setItem('dev_role', next)
  }

  return (
    <AuthContext.Provider value={{ session, user, role, loading, devRole, toggleDevRole }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
