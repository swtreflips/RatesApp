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

const ROLE_LABELS = {
  requester: 'Requester',
  provider:  'Freight Forwarder',
}

export default function TopNav({ onMenuToggle }) {
  const { user, role, devRole, toggleDevRole } = useAuth()
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

  const displayName = user?.user_metadata?.full_name ?? user?.email ?? 'Dev User'
  const initials = displayName
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 shadow-sm">
      {/* Left: hamburger */}
      <button
        onClick={onMenuToggle}
        className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
        aria-label="Toggle sidebar"
      >
        <Menu size={20} />
      </button>

      {/* Right: actions */}
      <div className="flex items-center gap-2">
        {/* Notification bell — placeholder */}
        <button className="relative rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors">
          <Bell size={18} />
          {/* Unread dot */}
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-white" />
        </button>

        {/* Account menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setAccountOpen(o => !o)}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-slate-100 transition-colors"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
              {initials}
            </span>
            <span className="hidden sm:block text-slate-700 font-medium">
              {displayName}
            </span>
            <span className="hidden sm:block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
              {ROLE_LABELS[role] ?? role}
            </span>
            <ChevronDown size={14} className="text-slate-400" />
          </button>

          {accountOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              <div className="border-b border-slate-100 px-3 py-2">
                <p className="text-xs font-medium text-slate-400">Signed in as</p>
                <p className="truncate text-sm font-semibold text-slate-700">{displayName}</p>
                <p className="text-xs text-slate-400">{ROLE_LABELS[role] ?? role}</p>
              </div>

              <button className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 transition-colors">
                <User size={14} />
                Profile
              </button>
              <button className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 transition-colors">
                <Settings size={14} />
                Settings
              </button>

              {/* Dev-only role toggle — visible when no real session */}
              {!user && (
                <>
                  <div className="my-1 border-t border-dashed border-slate-200" />
                  <button
                    onClick={toggleDevRole}
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs text-amber-600 hover:bg-amber-50 transition-colors"
                  >
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono font-bold">DEV</span>
                    Switch to {devRole === 'requester' ? 'Provider' : 'Requester'}
                  </button>
                </>
              )}

              <div className="my-1 border-t border-slate-100" />
              <button className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors">
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
