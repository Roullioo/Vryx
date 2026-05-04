import { NavLink, Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../../context/AuthContext'

const tabs = [
  { to: '/admin', label: "Vue d'ensemble", end: true },
  { to: '/admin/utilisateurs', label: 'Utilisateurs', end: false },
  { to: '/admin/noeud', label: 'Nœud Vryx', end: false },
] as const

type AdminShellProps = {
  children: ReactNode
  /** Barre latérale gauche (ex. workers live). Mobile : au-dessus du contenu. */
  aside?: ReactNode
}

export function AdminShell({ children, aside }: AdminShellProps) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="bg-bg min-h-[calc(100svh-4.25rem)] px-4 py-12">
        <div className="mx-auto max-w-6xl animate-pulse space-y-4">
          <div className="h-10 w-1/3 rounded-lg border border-border bg-card" />
          <div className="h-40 panel" />
        </div>
      </div>
    )
  }
  if (!user) return <Navigate to="/connexion" replace state={{ from: '/admin' }} />
  if (!user.isAdmin) {
    return (
      <div className="bg-bg min-h-[calc(100svh-4.25rem)] px-4 py-16">
        <div className="mx-auto max-w-xl panel p-8 text-center">
          <h1 className="font-display text-2xl font-bold text-fg">Accès refusé</h1>
          <p className="mt-3 text-sm text-muted">
            Cette zone est réservée aux administrateurs Vryx. Connectez-vous avec un compte disposant des droits
            requis.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-bg min-h-[calc(100svh-4.25rem)] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className={aside ? 'mx-auto max-w-[100rem]' : 'mx-auto max-w-6xl'}>
        <header className="border-b border-border pb-6">
          <p className="text-xs font-medium uppercase tracking-wider text-accent">Console interne Vryx</p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            Panel administrateur
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted sm:text-base">
            Pilotage du site, gestion des utilisateurs et supervision en temps réel du nœud d'inférence distribuée.
          </p>
          <p className="mt-2 font-mono text-xs text-muted">Connecté en tant que {user.email}</p>
        </header>

        <nav
          className="scrollbar-thin sticky top-[4.25rem] z-30 -mx-4 mt-4 flex gap-2 overflow-x-auto border-b border-border bg-bg/95 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6 lg:top-[4.5rem]"
          aria-label="Sections admin"
        >
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `shrink-0 rounded-full border px-4 py-2 text-xs font-medium transition-colors sm:text-sm ${
                  isActive
                    ? 'border-accent bg-accent text-white'
                    : 'border-border bg-surface text-fg hover:border-accent/40 hover:text-accent'
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>

        {aside ? (
          <div className="mt-8 flex flex-col gap-6 lg:flex-row lg:items-start">
            <aside className="w-full shrink-0 border border-border bg-surface/80 lg:sticky lg:top-28 lg:max-h-[calc(100svh-8rem)] lg:w-64 lg:overflow-y-auto lg:rounded-xl lg:p-4">
              {aside}
            </aside>
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        ) : (
          <div className="mt-8">{children}</div>
        )}
      </div>
    </div>
  )
}
