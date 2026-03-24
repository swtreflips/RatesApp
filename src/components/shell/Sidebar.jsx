import React from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  Anchor,
  LayoutDashboard,
  FilePlus,
  ClipboardList,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Ship,
  FileText,
} from 'lucide-react'
import { useAuth } from '../../app/providers/AuthProvider'

/* ─── Nav item definitions per role ──────────────────────────────────── */

const REQUESTER_NAV = [
  {
    label: 'Dashboard',
    icon: LayoutDashboard,
    to: '/requester',
    end: true,
  },
  {
    label: 'New Rate Request',
    icon: FilePlus,
    to: '/requester/new',
  },
  {
    label: 'My Requests',
    icon: ClipboardList,
    to: '/requester/requests',
  },
  {
    label: 'Received Rates',
    icon: CheckSquare,
    to: '/requester/rates',
  },
]

const PROVIDER_NAV = [
  {
    label: 'Dashboard',
    icon: LayoutDashboard,
    to: '/provider',
    end: true,
  },
  {
    label: 'Open Lanes',
    icon: Ship,
    to: '/provider/lanes',
  },
  {
    label: 'My Submissions',
    icon: FileText,
    to: '/provider/submissions',
  },
]

/* ─── Shared nav item component ──────────────────────────────────────── */

function NavItem({ to, icon: Icon, label, collapsed, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-brand-50 text-brand-700'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-800',
        ].join(' ')
      }
    >
      <Icon size={18} strokeWidth={1.75} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  )
}

/* ─── Sidebar ─────────────────────────────────────────────────────────── */

export default function Sidebar({ open, onToggle }) {
  const { role } = useAuth()
  const navItems = role === 'provider' ? PROVIDER_NAV : REQUESTER_NAV

  return (
    <aside
      className={[
        'relative flex h-full shrink-0 flex-col border-r border-slate-200 bg-white transition-all duration-200',
        open ? 'w-56' : 'w-14',
      ].join(' ')}
    >
      {/* Logo area */}
      <div className="flex h-14 items-center border-b border-slate-200 px-3">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Anchor size={16} strokeWidth={2} />
          </span>
          {open && (
            <span className="truncate text-sm font-bold tracking-tight text-slate-800">
              RatesApp
            </span>
          )}
        </div>
      </div>

      {/* Role badge */}
      {open && (
        <div className="px-3 pt-4 pb-1">
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 uppercase tracking-wide">
            {role === 'provider' ? 'Freight Forwarder' : 'Requester'}
          </span>
        </div>
      )}

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto scrollbar-thin px-2 py-3 space-y-0.5">
        {navItems.map(item => (
          <NavItem key={item.to} collapsed={!open} {...item} />
        ))}
      </nav>

      {/* Collapse toggle button */}
      <button
        onClick={onToggle}
        className="absolute -right-3 top-16 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 shadow-sm hover:text-slate-600 transition-colors"
        aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
      >
        {open ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
      </button>

      {/* Bottom spacer / footer */}
      <div className="border-t border-slate-100 p-3">
        {open ? (
          <p className="text-[10px] text-slate-300 text-center">
            Ocean Rate Platform
          </p>
        ) : (
          <div className="h-3" />
        )}
      </div>
    </aside>
  )
}
