import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { ROLES, normalizeRole } from '../../lib/roles'
import { SERVICE_SLUGS, isService } from '../../features/rates/serviceConfig'

const AuthContext = createContext(null)

/**
 * Session, identity and loading state for the whole app.
 *
 * IDENTITY COMES FROM `profiles`, JOINED TO `organizations`. Never from user_metadata.
 *
 * user_metadata is USER-WRITABLE: any signed-in person can run
 *   supabase.auth.updateUser({ data: { role: 'internal' } })
 * from the browser console. Reading role from there let a forwarder mount the internal
 * domain. They never got data — every RLS policy reads profiles.role via current_role_is(),
 * and profiles has no UPDATE policy — but an internal-looking UI invites someone to trust
 * what they see, and it left the door open for a future policy to read the JWT instead.
 *
 * The old fallback was worse than the override: `user_metadata.role ?? devRole`, with
 * devRole defaulting to 'internal'. A brand-new account with no metadata landed on the
 * INTERNAL side by default. That is now impossible.
 *
 *   profile === undefined  still loading — decide nothing, render nothing
 *   profile === null       no row, or the query failed → NO ACCESS
 *
 * A failed query resolves to null rather than guessing. Denying a real user on a network
 * blip is recoverable; admitting an unknown one is not.
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  // undefined = still loading. null = no profile = no access. Never a default.
  const [profile, setProfile] = useState(undefined)

  // The signed-in user's forwarder company name (providers only; null for requesters)
  const [forwarderName, setForwarderName] = useState(null)

  // Services the signed-in forwarder's company offers (forwarder_services rows,
  // scoped by RLS to their own company). Internal users always see every service
  // the app ships. Null while loading → callers can distinguish "not yet known".
  const [forwarderServices, setForwarderServices] = useState(null)

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

  // ONE query for identity: role, organization, and the workspace label together.
  // organizations.type is the authoritative answer to "what kind of party is this";
  // profiles.role is kept only until HUB2's contract phase drops it.
  useEffect(() => {
    const uid = session?.user?.id
    if (!uid) {
      setProfile(null)
      setForwarderName(null)
      return
    }
    let active = true
    setProfile(undefined) // loading — NOT "no access"

    supabase
      .from('profiles')
      .select('id, role, org_role, full_name, company, organization_id, must_change_password, organizations(name, type)')
      .eq('id', uid)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        // No row and a failed query both resolve to null. Fail closed.
        setProfile(error ? null : (data ?? null))
        setForwarderName(data?.organizations?.name ?? data?.company ?? null)
      })
    return () => { active = false }
  }, [session?.user?.id])

  // Load the forwarder company's service capabilities (DRAY.md §2a). RLS on
  // forwarder_services returns only the caller's company rows for forwarders.
  useEffect(() => {
    const uid = session?.user?.id
    if (!uid) {
      setForwarderServices(null)
      return
    }
    let active = true
    supabase
      .from('forwarder_services')
      .select('service')
      .eq('active', true)
      .then(({ data }) => {
        if (!active) return
        // keep only services the app actually ships (serviceConfig keys)
        setForwarderServices((data ?? []).map((r) => r.service).filter(isService))
      })
      .catch(() => {
        // table unreachable (e.g. dev without Supabase) — fall back to all services
        if (active) setForwarderServices(null)
      })
    return () => { active = false }
  }, [session?.user?.id])

  const user = session?.user ?? null

  // organizations.type first — it is the single source of truth. profiles.role is the
  // fallback only while contract has not yet dropped it. NO default: an unknown user is
  // null, and null matches no ROLES constant, so no domain mounts.
  const role = profile
    ? normalizeRole(profile.organizations?.type ?? profile.role)
    : null

  // Internal always sees every shipped service; forwarders see their company's
  // capabilities (falling back to all shipped services while loading / in dev-mock).
  const services = role === ROLES.FORWARDER && forwarderServices !== null
    ? forwarderServices
    : SERVICE_SLUGS

  return (
    <AuthContext.Provider value={{ session, user, profile, role, loading, forwarderName, services }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
