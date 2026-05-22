import { NavLink, Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useEffect, useState, useCallback } from 'react'
import { VryxLogo } from '../brand/VryxLogo'
import { useAuth } from '../../context/AuthContext'

/* ─── Icons ───────────────────────────────────────────────────────────────── */
function IconGrid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}
function IconServer() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="2" y="3" width="20" height="6" rx="1" /><rect x="2" y="15" width="20" height="6" rx="1" />
      <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  )
}
function IconWorkers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <circle cx="9" cy="7" r="3" /><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
      <path d="M16 11a3 3 0 1 1 0-6" /><path d="M21 21v-2a4 4 0 0 0-3-3.87" />
    </svg>
  )
}
function IconSessions() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  )
}
function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}
function IconPulse() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  )
}
function IconChat() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}
function IconMenu() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}
function IconClose() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
function IconLogout() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}

/* ─── Navigation ──────────────────────────────────────────────────────────── */
type NavItem = { to: string; label: string; icon: ReactNode; end?: boolean }
type NavSection = { label: string; items: NavItem[] }

const mainNavItems: NavItem[] = [
  { to: '/admin', label: "Vue d'ensemble", icon: <IconGrid />, end: true },
  { to: '/admin/noeud', label: 'Nœud Vryx', icon: <IconServer /> },
  { to: '/admin/chat-p2p', label: 'Chat P2P', icon: <IconChat /> },
  { to: '/admin/workers', label: 'Workers', icon: <IconWorkers /> },
  { to: '/admin/sessions', label: 'Sessions', icon: <IconSessions /> },
  { to: '/admin/observabilite', label: 'Observabilité', icon: <IconPulse /> },
  { to: '/admin/production-readiness', label: 'Readiness', icon: <IconPulse /> },
  { to: '/admin/enterprise', label: 'Enterprise', icon: <IconGrid /> },
  { to: '/admin/utilisateurs', label: 'Utilisateurs', icon: <IconUsers /> },
]

const pricingNavItems: NavItem[] = [
  { to: '/admin/parametres/pricing', label: 'Paramètres', icon: <IconPulse /> },
  { to: '/admin/modeles', label: 'Modèles', icon: <IconServer /> },
]

const navSections: NavSection[] = [
  { label: 'Navigation', items: mainNavItems },
  { label: 'Pricing', items: pricingNavItems },
]

const SIDEBAR_W = 220 // px

/* ─── Sidebar ─────────────────────────────────────────────────────────────── */
function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, logout } = useAuth() as { user: { email: string } | null; logout?: () => void }
  const loc = useLocation()

  // Fermer sidebar mobile au changement de route
  useEffect(() => { onClose() }, [loc.pathname, onClose])

  return (
    <>
      {/* Overlay mobile */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      {/* Sidebar */}
      <aside
        style={{ width: SIDEBAR_W }}
        className={`admin-sidebar fixed inset-y-0 left-0 z-50 flex flex-col bg-admin-sidebar transition-transform duration-300 lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo + sigle étendu */}
        <div className="flex min-h-14 items-start gap-2.5 border-b border-white/8 px-4 py-3 sm:px-5">
          <VryxLogo variant="mark" tone="light" markSize="sm" to="/" className="shrink-0 self-start pt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="font-display text-[11px] font-semibold leading-snug tracking-tight text-white sm:text-xs">
              Virtualized Remote Yield eXchange
            </p>
          </div>
          <button
            className="ml-auto shrink-0 self-start text-white/40 hover:text-white lg:hidden"
            onClick={onClose}
            aria-label="Fermer"
          >
            <IconClose />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {navSections.map((section) => (
            <div key={section.label} className={section.label === 'Pricing' ? 'mt-5' : ''}>
              <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-widest text-white/25">
                {section.label}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={`${item.to}-${item.label}`}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        `flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                          isActive
                            ? 'bg-white/10 text-white'
                            : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                        }`
                      }
                    >
                      {item.icon}
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-white/8 p-3">
          <div className="flex items-center gap-2 rounded-lg px-2 py-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-bold text-white/80">
              {(user?.email?.[0] ?? 'A').toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-medium text-white/80">{user?.email ?? ''}</p>
              <p className="text-[10px] text-white/30">Administrateur</p>
            </div>
            {logout && (
              <button
                onClick={logout}
                className="text-white/30 hover:text-white/70"
                title="Se déconnecter"
              >
                <IconLogout />
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}

/* ─── AdminShell ─────────────────────────────────────────────────────────── */
type AdminShellProps = {
  children: ReactNode
  title: string
  subtitle?: string
  actions?: ReactNode
  /** `none` : pas de padding sur le contenu principal (vue immersive, ex. chat plein cadre). */
  mainSpacing?: 'default' | 'none'
  /** Masque le bandeau titre / sous-titre sous la barre mobile (grand écran : plus de place au contenu). */
  showDesktopTitleBar?: boolean
}

export function AdminShell({
  children,
  title,
  subtitle,
  actions,
  mainSpacing = 'default',
  showDesktopTitleBar = true,
}: AdminShellProps) {
  const { user, loading } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-admin-canvas">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    )
  }

  if (!user) return <Navigate to="/connexion" replace state={{ from: '/admin' }} />

  if (!user.isAdmin) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-admin-canvas px-4">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-alert/10">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-6 w-6 text-alert">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h1 className="font-display text-xl font-bold text-fg">Accès refusé</h1>
          <p className="mt-2 text-sm text-muted">Zone réservée aux administrateurs Vryx.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="admin-ultimate flex h-dvh max-h-dvh min-h-0 overflow-hidden bg-admin-canvas">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />

      {/* Main */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:pl-[220px]">
        {/* Top bar mobile */}
        <header className="admin-topbar z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-[var(--color-admin-mobile-header)] px-4 backdrop-blur-md lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-fg"
            aria-label="Ouvrir menu"
          >
            <IconMenu />
          </button>
          <span className="font-display text-[15px] font-semibold text-fg">{title}</span>
        </header>

        {showDesktopTitleBar ? (
          <div className="admin-titlebar hidden border-b border-border bg-card px-6 py-4 lg:block lg:px-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="font-display text-xl font-bold text-fg lg:text-2xl">{title}</h1>
                {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
              </div>
              {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
            </div>
          </div>
        ) : null}

        {/* Content */}
        <main
          className={
            mainSpacing === 'none'
              ? 'flex min-h-0 flex-1 flex-col overflow-hidden p-0'
              : 'flex-1 overflow-auto p-4 lg:p-6'
          }
        >
          {children}
        </main>
      </div>
    </div>
  )
}
