import React from 'react'
import { NavLink } from 'react-router-dom'
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
  { label: 'Dashboard',        icon: LayoutDashboard, to: '/requester',          end: true },
  { label: 'New Rate Request', icon: FilePlus,        to: '/requester/new' },
  { label: 'Open Requests',    icon: ClipboardList,   to: '/requester/requests' },
  { label: 'Active Rates',     icon: CheckSquare,     to: '/requester/rates' },
]

const PROVIDER_NAV = [
  { label: 'Dashboard',     icon: LayoutDashboard, to: '/provider',             end: true },
  { label: 'Open Requests', icon: Ship,            to: '/provider/lanes' },
  { label: 'Active Rates',  icon: FileText,        to: '/provider/submissions' },
]

/* ─── Shared nav item ────────────────────────────────────────────────── */

function NavItem({ to, icon: Icon, label, collapsed, end, onClick }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        [
          'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
          isActive
            ? 'bg-harbor-800/80 text-white'
            : 'text-harbor-200/80 hover:bg-harbor-800/50 hover:text-white',
        ].join(' ')
      }
    >
      {({ isActive }) => (
        <>
          {/* Active accent rail */}
          <span
            className={[
              'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-signal-500 transition-all duration-200',
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-40',
            ].join(' ')}
          />
          <Icon
            size={18}
            strokeWidth={isActive ? 2.25 : 1.75}
            className={[
              'shrink-0 transition-colors',
              isActive ? 'text-signal-400' : 'text-harbor-300 group-hover:text-signal-300',
            ].join(' ')}
          />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  )
}

/* ─── Sidebar ─────────────────────────────────────────────────────────── */

export default function Sidebar({ open, onToggle, isMobile, onNavClick }) {
  const { role } = useAuth()
  const navItems = role === 'provider' ? PROVIDER_NAV : REQUESTER_NAV
  const roleLabel = role === 'provider' ? 'Freight Forwarder' : 'Requester'

  const desktopClasses = open ? 'w-60' : 'w-16'
  const mobileClasses = open
    ? 'fixed inset-y-0 left-0 z-40 w-60 shadow-2xl'
    : 'fixed inset-y-0 left-0 z-40 w-60 -translate-x-full'

  return (
    <aside
      className={[
        'grain relative flex h-full shrink-0 flex-col overflow-hidden bg-harbor-mesh text-white shadow-rail transition-all duration-200',
        isMobile ? mobileClasses : `relative ${desktopClasses}`,
      ].join(' ')}
    >
      {/* Faint nautical grid wash */}
      <div className="pointer-events-none absolute inset-0 bg-chart-grid bg-[size:22px_22px] opacity-60" />

      {/* Logo area */}
      <div className="relative flex h-16 items-center border-b border-white/5 px-4">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-signal-500 text-harbor-950 shadow-signal">
            <Anchor size={18} strokeWidth={2.25} />
          </span>
          {open && (
            <span className="flex flex-col leading-none">
              <span className="font-display text-base font-extrabold tracking-tightest text-white">
                Rates<span className="text-signal-400">App</span>
              </span>
              <span className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.22em] text-harbor-300">
                Ocean Freight
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Role badge */}
      {open && (
        <div className="relative px-4 pt-4 pb-1">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-harbor-200 ring-1 ring-inset ring-white/10">
            <span className="h-1.5 w-1.5 rounded-full bg-sea-400" />
            {roleLabel}
          </span>
        </div>
      )}

      {/* Nav items */}
      <nav className="relative flex-1 overflow-y-auto scrollbar-rail px-2.5 py-3 space-y-1">
        {navItems.map(item => (
          <NavItem key={item.to} collapsed={!open} onClick={onNavClick} {...item} />
        ))}
      </nav>

      {/* Collapse toggle — desktop only */}
      {!isMobile && (
        <button
          onClick={onToggle}
          className="absolute -right-3 top-20 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-harbor-700 bg-harbor-800 text-harbor-200 shadow-md transition-colors hover:bg-harbor-700 hover:text-signal-300"
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {open ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
        </button>
      )}

      {/* Footer */}
      <div className="relative border-t border-white/5 p-3">
        {open ? (
          <p className="text-center font-mono text-[9px] uppercase tracking-[0.2em] text-harbor-400">
            Ocean Rate Platform
          </p>
        ) : (
          <div className="h-3" />
        )}
      </div>
    </aside>
  )
}
