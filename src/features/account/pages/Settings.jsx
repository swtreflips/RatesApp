import React from 'react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'
import PasswordPanel from '../PasswordPanel'
import { useAuth } from '../../../app/providers/AuthProvider'
import { ROLES } from '../../../lib/roles'

/*
  Account settings — the one page in this app that BOTH roles reach.

  Every other route in RoleRouter is mounted for exactly one role, because every other route is a
  feature domain: internal plans, forwarders quote. This is neither. It is your own account, and
  the identical thing whoever you are — which is why it sits outside `/internal` and `/forwarder`
  rather than being built twice.

  Currently one section. It stays a page rather than a modal because more will land here
  (notification preferences, the profile placeholder in TopNav), and because "Settings" opening a
  dialog and "Settings" opening a page in the sibling app would be the kind of small
  inconsistency that makes two tools feel like two products.
*/
export default function Settings() {
  const { role, forwarderName } = useAuth()

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={role === ROLES.FORWARDER ? (forwarderName ?? 'Forwarder') : 'Internal'}
        title="Settings"
        subtitle="Your account."
      />

      <section className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card">
        <div className="border-b border-fog-100 px-5 py-4">
          <h2 className="text-base font-semibold text-harbor-900">Password</h2>
          <p className="mt-0.5 text-xs text-fog-500">
            Replace the password you were given with one only you know.
          </p>
        </div>
        <PasswordPanel />
      </section>
    </div>
  )
}
