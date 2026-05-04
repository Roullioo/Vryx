import { useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { IconChevronDown } from '../icons/Icons'
import { VryxLogo } from '../brand/VryxLogo'
import { useAuth } from '../../context/AuthContext'
import { MOCK_ACCOUNT } from '../../data/accountMock'

const routeLinks = [
  { to: '/clients', label: 'Clients' },
  { to: '/race-pool', label: 'Race-Pool' },
  { to: '/simulateur', label: 'Simulateur' },
  { to: '/comparatif', label: 'Gains solo / pool' },
  { to: '/workers', label: 'Workers' },
]

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()
  const { user, loading, logout } = useAuth()
  const accountDetailsRef = useRef<HTMLDetailsElement>(null)

  const lightNav =
    pathname === '/' ||
    pathname === '/clients' ||
    pathname === '/race-pool' ||
    pathname === '/simulateur' ||
    pathname === '/comparatif' ||
    pathname === '/workers' ||
    pathname === '/panel/modeles'

  const navRouteClass = ({ isActive }: { isActive: boolean }) =>
    [
      'text-sm font-medium transition-colors',
      lightNav
        ? isActive
          ? 'text-white'
          : 'text-white/75 hover:text-white'
        : isActive
          ? 'text-accent'
          : 'text-muted hover:text-fg',
    ].join(' ')

  async function handleLogout() {
    await logout()
    setMenuOpen(false)
  }

  return (
    <header className="relative z-30 w-full bg-transparent">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6 lg:px-8">
        <div onClick={() => setMenuOpen(false)}>
          <VryxLogo to="/" tone={lightNav ? 'light' : 'dark'} markSize="sm" className="py-0.5" />
        </div>

        <nav className="hidden items-center gap-4 xl:gap-5 lg:flex" aria-label="Navigation principale">
          {routeLinks.map((l) => (
            <NavLink key={l.to} to={l.to} className={navRouteClass}>
              {l.label}
            </NavLink>
          ))}
          {!loading && user && (
            <NavLink to="/panel/modeles" className={navRouteClass}>
              Modèles IA
            </NavLink>
          )}
          {!loading && user?.isAdmin && (
            <NavLink to="/admin" className={navRouteClass}>
              Admin
            </NavLink>
          )}
        </nav>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {!loading && user ? (
            <>
              <details ref={accountDetailsRef} className="relative hidden lg:block">
                <summary
                  className={`flex cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold [&::-webkit-details-marker]:hidden ${
                    lightNav
                      ? 'bg-white text-slate-950 hover:bg-white/90'
                      : 'btn-primary'
                  }`}
                >
                  Mon compte
                  <IconChevronDown className="h-4 w-4 opacity-90" aria-hidden />
                </summary>
                <div className="absolute right-0 z-50 mt-2 w-[min(calc(100vw-2rem),22rem)] rounded-xl border border-border bg-card p-5 shadow-lg">
                  <p className="truncate text-xs font-medium text-muted" title={user.email}>
                    {user.email}
                  </p>
                  <p className="mt-1 text-[0.65rem] uppercase tracking-wide text-muted">Forfait {MOCK_ACCOUNT.plan}</p>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div className="rounded-lg border border-border bg-surface p-3">
                      <dt className="text-muted">Solde</dt>
                      <dd className="mt-0.5 font-mono font-semibold text-success">
                        {MOCK_ACCOUNT.balanceCredits.toLocaleString('fr-FR', {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 0,
                        })}{' '}
                        crédits
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border bg-surface p-3">
                      <dt className="text-muted">Usage mois</dt>
                      <dd className="mt-0.5 font-mono font-semibold text-electric">{MOCK_ACCOUNT.usagePercent} %</dd>
                    </div>
                    <div className="col-span-2 rounded-lg bg-surface/80 p-2.5">
                      <dt className="text-muted">Clés API actives</dt>
                      <dd className="mt-0.5 font-mono font-semibold text-fg">{MOCK_ACCOUNT.activeApiKeys}</dd>
                    </div>
                  </dl>
                  <Link
                    to="/compte"
                    className="btn-secondary mt-4 flex w-full justify-center rounded-lg py-2.5 text-sm font-semibold"
                    onClick={() => accountDetailsRef.current?.removeAttribute('open')}
                  >
                    Ouvrir la gestion du compte
                  </Link>
                </div>
              </details>
              <button
                type="button"
                className={`hidden rounded-lg px-4 py-2 text-sm lg:inline-flex ${
                  lightNav
                    ? 'border border-white/35 bg-white/10 text-white hover:bg-white/20'
                    : 'btn-secondary'
                }`}
                onClick={() => void handleLogout()}
              >
                Déconnexion
              </button>
            </>
          ) : !loading ? (
            <>
              <Link
                to="/connexion"
                state={{ from: '/compte' }}
                className={`hidden rounded-lg px-4 py-2 text-sm font-semibold lg:inline-flex ${
                  lightNav ? 'bg-white text-slate-950 hover:bg-white/90' : 'btn-primary'
                }`}
                onClick={() => setMenuOpen(false)}
              >
                Mon compte
              </Link>
              <Link
                to="/inscription"
                className={`hidden rounded-lg px-4 py-2 text-sm lg:inline-flex ${
                  lightNav
                    ? 'border border-white/35 bg-white/10 text-white hover:bg-white/20'
                    : 'btn-secondary'
                }`}
                onClick={() => setMenuOpen(false)}
              >
                Inscription
              </Link>
            </>
          ) : null}
          {!loading && user ? (
            <Link
              to="/compte"
              className={`inline-flex rounded-lg px-4 py-2 text-sm font-semibold lg:hidden ${
                lightNav ? 'bg-white text-slate-950' : 'btn-primary'
              }`}
              onClick={() => setMenuOpen(false)}
            >
              Mon compte
            </Link>
          ) : !loading ? (
            <Link
              to="/connexion"
              state={{ from: '/compte' }}
              className={`inline-flex rounded-lg px-4 py-2 text-sm font-semibold lg:hidden ${
                lightNav ? 'bg-white text-slate-950' : 'btn-primary'
              }`}
              onClick={() => setMenuOpen(false)}
            >
              Mon compte
            </Link>
          ) : (
            <span
              className="inline-flex h-10 w-24 shrink-0 animate-pulse rounded-lg bg-card lg:hidden"
              aria-hidden
            />
          )}

          <button
            type="button"
            className={`flex h-10 w-10 items-center justify-center rounded-lg lg:hidden ${
              lightNav ? 'border border-white/30 text-white' : 'border border-border text-muted'
            }`}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
            <span className="sr-only">Menu</span>
          </button>
        </div>
      </div>

      {menuOpen && (
        <div
          id="mobile-nav"
          className={`border-t px-4 py-4 lg:hidden ${
            lightNav ? 'border-white/10 bg-slate-950/95 text-white' : 'border-border bg-bg/95'
          }`}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation mobile"
        >
          <nav className="flex flex-col gap-1">
            {routeLinks.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2.5 text-base font-medium ${
                    lightNav
                      ? isActive
                        ? 'bg-white/15 text-white'
                        : 'text-white/80'
                      : isActive
                        ? 'bg-accent/15 text-accent'
                        : 'text-muted'
                  }`
                }
                onClick={() => setMenuOpen(false)}
              >
                {l.label}
              </NavLink>
            ))}
            {!loading && user && (
              <Link
                to="/compte"
                className={`rounded-lg px-3 py-2.5 text-base font-semibold ${
                  lightNav ? 'bg-white/15 text-white' : 'bg-accent/10 text-accent'
                }`}
                onClick={() => setMenuOpen(false)}
              >
                Mon compte, tableau de bord
              </Link>
            )}
            {!loading && user?.isAdmin && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2.5 text-base font-semibold ${
                    lightNav
                      ? isActive
                        ? 'bg-white/15 text-white'
                        : 'text-white/80'
                      : isActive
                        ? 'bg-accent/15 text-accent'
                        : 'text-muted'
                  }`
                }
                onClick={() => setMenuOpen(false)}
              >
                Panel admin
              </NavLink>
            )}
            {!loading && user && (
              <NavLink
                to="/panel/modeles"
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2.5 text-base font-medium ${
                    lightNav
                      ? isActive
                        ? 'bg-white/15 text-white'
                        : 'text-white/80'
                      : isActive
                        ? 'bg-accent/15 text-accent'
                        : 'text-muted'
                  }`
                }
                onClick={() => setMenuOpen(false)}
              >
                Modèles IA
              </NavLink>
            )}
            {!loading && user ? (
              <>
                <p className={`mt-2 truncate px-3 text-sm ${lightNav ? 'text-white/70' : 'text-muted'}`} title={user.email}>
                  {user.email}
                </p>
                <button
                  type="button"
                  className={`mt-2 w-full rounded-lg px-3 py-2.5 text-center text-sm ${
                    lightNav ? 'border border-white/25 text-white' : 'border border-border text-fg'
                  }`}
                  onClick={() => void handleLogout()}
                >
                  Déconnexion
                </button>
              </>
            ) : !loading ? (
              <>
                <Link
                  to="/connexion"
                  className={`mt-2 rounded-lg px-3 py-2.5 text-center text-sm ${
                    lightNav ? 'border border-white/25 text-white' : 'border border-border text-fg'
                  }`}
                  onClick={() => setMenuOpen(false)}
                >
                  Connexion
                </Link>
                <Link
                  to="/inscription"
                  className={`mt-1 rounded-lg px-3 py-2.5 text-center text-sm font-medium ${
                    lightNav ? 'bg-white/15 text-white' : 'bg-accent/10 text-accent'
                  }`}
                  onClick={() => setMenuOpen(false)}
                >
                  Inscription
                </Link>
              </>
            ) : null}
          </nav>
        </div>
      )}
    </header>
  )
}
