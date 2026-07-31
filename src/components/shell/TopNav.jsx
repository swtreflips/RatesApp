import React, { useState, useRef, useEffect } from 'react'
import {
  Menu,
  Bell,
  ChevronDown,
  User,
  LogOut,
  Settings,
} from 'lucide-react'
import { useAuth } from '../../app/providers/AuthProvider'
import { supabase } from '../../lib/supabase'
import { ROLES, ROLE_LABELS } from '../../lib/roles'

export default function TopNav({ onMenuToggle }) {
  const { user, profile, role, forwarderName } = useAuth()

  // Workspace breadcrumb label: internal users are "PTP"; forwarders show their company.
  const workspaceLabel =
    role === ROLES.FORWARDER ? (forwarderName ?? ROLE_LABELS.forwarder) : 'PTP'
  const [accountOpen, setAccountOpen] = useState(false)
  const menuRef = useRef(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setAccountOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const displayName = profile?.full_name ?? user?.email ?? 'Account'
  const initials = displayName
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <header className="relative z-30 flex h-16 shrink-0 items-center justify-between border-b border-fog-200 bg-white/85 px-4 backdrop-blur-md sm:px-6">
      {/* Left: hamburger + wayfinding */}
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuToggle}
          className="rounded-lg p-2 text-fog-500 transition-colors hover:bg-fog-100 hover:text-harbor-800"
          aria-label="Toggle sidebar"
        >
          <Menu size={20} />
        </button>
        <div className="hidden items-center gap-2 sm:flex">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-fog-400">
            Workspace
          </span>
          <span className="text-fog-300">/</span>
          <span className="text-sm font-semibold text-harbor-800">
            {workspaceLabel}
          </span>
        </div>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-1.5">
        {/* Notification bell — placeholder */}
        <button className="relative rounded-lg p-2 text-fog-500 transition-colors hover:bg-fog-100 hover:text-harbor-800">
          <Bell size={18} />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-signal-500 ring-2 ring-white" />
        </button>

        <span className="mx-1 hidden h-6 w-px bg-fog-200 sm:block" />

        {/* Account menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setAccountOpen(o => !o)}
            className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-sm transition-colors hover:bg-fog-100"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-harbor-800 text-xs font-bold text-white ring-2 ring-signal-500/30">
              {initials}
            </span>
            <span className="hidden text-left leading-tight sm:block">
              <span className="block text-sm font-semibold text-harbor-900">{displayName}</span>
              <span className="block font-mono text-[10px] uppercase tracking-wider text-fog-400">
                {ROLE_LABELS[role] ?? role}
              </span>
            </span>
            <ChevronDown size={14} className="text-fog-400" />
          </button>

          {accountOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-fog-200 bg-white py-1 shadow-card">
              <div className="border-b border-fog-100 px-3.5 py-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-fog-400">Signed in as</p>
                <p className="truncate text-sm font-semibold text-harbor-900">{displayName}</p>
                <p className="text-xs text-fog-500">{ROLE_LABELS[role] ?? role}</p>
              </div>

              <button className="flex w-full items-center gap-2.5 px-3.5 py-2 text-sm text-fog-600 transition-colors hover:bg-fog-50 hover:text-harbor-800">
                <User size={15} />
                Profile
              </button>
              <button className="flex w-full items-center gap-2.5 px-3.5 py-2 text-sm text-fog-600 transition-colors hover:bg-fog-50 hover:text-harbor-800">
                <Settings size={15} />
                Settings
              </button>

              <div className="my-1 border-t border-fog-100" />
              <button
                onClick={() => supabase.auth.signOut()}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-sm text-red-600 transition-colors hover:bg-red-50"
              >
                <LogOut size={15} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
