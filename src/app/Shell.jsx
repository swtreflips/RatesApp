import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from './providers/AuthProvider'
import TopNav from '../components/shell/TopNav'
import Sidebar from '../components/shell/Sidebar'
import RoleRouter from './RoleRouter'

/* ── mobile breakpoint hook ───────────────────────────────────────────── */

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint)
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const handler = (e) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [breakpoint])
  return isMobile
}

/**
 * Still on the password internal read out at onboarding.
 *
 * Left alone, a temporary password becomes a permanent one — nobody remembers months later which
 * accounts were handed over and never changed. Persistent rather than dismissable for that
 * reason, but it never blocks anything: someone mid-task should not be stopped from working to
 * deal with an account chore.
 */
function TempPasswordBanner() {
  const { profile } = useAuth()
  if (!profile?.must_change_password) return null

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-signal-200 bg-signal-50 px-6 py-2">
      <span className="text-xs text-harbor-800">
        You are still using the temporary password you were given. Set one only you know.
      </span>
      <Link
        to="/settings"
        className="rounded-lg border border-fog-200 bg-white px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-harbor-700 transition-colors hover:bg-fog-50"
      >
        Change it
      </Link>
    </div>
  )
}

/**
 * The shared application shell.
 * Composes TopNav + Sidebar + main content area.
 * Mounts RoleRouter in the main content slot.
 * Does not contain any requester or provider business logic.
 */
export default function Shell() {
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile)

  // Auto-close sidebar when switching to mobile
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
    else setSidebarOpen(true)
  }, [isMobile])

  return (
    <div className="flex h-screen overflow-hidden bg-fog-100">
      {/* Mobile backdrop */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-harbor-950/50 backdrop-blur-sm transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(o => !o)}
        isMobile={isMobile}
        onNavClick={() => isMobile && setSidebarOpen(false)}
      />

      {/* Right panel: top nav + page content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopNav onMenuToggle={() => setSidebarOpen(o => !o)} />

        <TempPasswordBanner />

        {/* Main scrollable content area */}
        <main className="relative flex-1 overflow-y-auto scrollbar-thin">
          {/* Subtle top atmosphere fading into the page */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-harbor-100/60 to-transparent" />
          <div className="relative min-h-full w-full px-6 py-7 sm:px-8">
            <RoleRouter />
          </div>
        </main>
      </div>
    </div>
  )
}
