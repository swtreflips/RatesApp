/*
  Role constants + display labels for the two user roles.

  The stored role code (profiles.role / user_metadata.role) is the canonical value;
  the label is what users see. `normalizeRole` maps the pre-rename codes
  (requester/provider) onto the current ones so stale sessions, cached
  user_metadata, and old localStorage values keep routing correctly after the
  internal/forwarder migration.
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
