/*
  Role constants + display labels.

  THE CANONICAL VALUE IS `organizations.type`, resolved in AuthProvider and reaching
  every policy through my_org_type(). `profiles.role` is a fallback kept only until
  HUB2's contract phase drops it.

  user_metadata.role is NOT a source of identity and must never become one again — it is
  user-writable, so reading it let a forwarder mount the internal domain. Any residual
  values on existing auth users are decorative.

  normalizeRole maps pre-rename codes (requester/provider) onto the current ones so stale
  sessions keep routing correctly. It deliberately does NOT supply a default: an unknown
  role stays unknown, matches no ROLES constant, and mounts no domain.
*/

export const ROLES = {
  INTERNAL: 'internal',
  FORWARDER: 'forwarder',
}

export const ROLE_LABELS = {
  internal: 'Internal',
  forwarder: 'Forwarder',
}

// Back-compat: legacy role codes → current codes.
const LEGACY = {
  requester: ROLES.INTERNAL,
  provider: ROLES.FORWARDER,
}

/** Map any role string (legacy or current) to its canonical current code. */
export const normalizeRole = (role) => LEGACY[role] ?? role

/** Human-readable label for a role code (accepts legacy codes too). */
export const roleLabel = (role) => ROLE_LABELS[normalizeRole(role)] ?? role
