import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { ROLES, normalizeRole } from '../../lib/roles'

const AuthContext = createContext(null)

/**
 * Provides session, user, role, and loading state to the entire app.
 * Role is derived from user_metadata.role — seeded during sign-up or set via admin.
 * In Phase 1 this also supports a dev-mode mock role toggle.
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  // Dev-mode mock: allows toggling role without a real auth session.
  // normalizeRole maps any legacy 'requester'/'provider' value left in localStorage.
  const [devRole, setDevRole] = useState(
    () => normalizeRole(localStorage.getItem('dev_role') ?? ROLES.INTERNAL)
  )

  // The signed-in user's forwarder company name (providers only; null for requesters)
  const [forwarderName, setForwarderName] = useState(null)

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

  // Load the user's forwarder name from their profile (for the workspace label)
  useEffect(() => {
    const uid = session?.user?.id
    if (!uid) {
      setForwarderName(null)
      return
    }
    let active = true
    supabase
      .from('profiles')
      .select('company, forwarders(name)')
      .eq('id', uid)
      .single()
      .then(({ data }) => {
        if (active) setForwarderName(data?.forwarders?.name ?? data?.company ?? null)
      })
      .catch(() => {
        // profile/forwarder unreachable — leave null, label falls back
      })
    return () => { active = false }
  }, [session?.user?.id])

  const user = session?.user ?? null
  // normalizeRole keeps pre-rename codes (requester/provider) working from cached metadata.
  const role = normalizeRole(user?.user_metadata?.role ?? devRole)

  function toggleDevRole() {
    const next = devRole === ROLES.INTERNAL ? ROLES.FORWARDER : ROLES.INTERNAL
    setDevRole(next)
    localStorage.setItem('dev_role', next)
  }

  return (
    <AuthContext.Provider value={{ session, user, role, loading, devRole, toggleDevRole, forwarderName }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
