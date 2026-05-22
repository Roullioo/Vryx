import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconChevronDown } from '../icons/Icons'
import { VryxLogo } from '../brand/VryxLogo'
import { useAuth } from '../../context/AuthContext'
import { useTheme } from '../../context/ThemeContext'
import { ThemeToggle } from './ThemeToggle'
import { fetchAccountOverview, type AccountOverview } from '../../lib/account'

const routeLinks = [
  { to: '/clients', labelKey: 'nav.clients' },
  { to: '/enterprise', labelKey: 'nav.enterprise' },
  { to: '/race-pool', labelKey: 'nav.racePool' },
  { to: '/simulateur', labelKey: 'nav.simulator' },
  { to: '/comparatif', labelKey: 'nav.comparison' },
  { to: '/workers', labelKey: 'nav.workers' },
  { to: '/network', labelKey: 'nav.network' },
]

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [accountOverview, setAccountOverview] = useState<AccountOverview | null>(null)
  const [accountOverviewLoading, setAccountOverviewLoading] = useState(false)
  const [accountOverviewError, setAccountOverviewError] = useState('')
  const { pathname } = useLocation()
  const { t } = useTranslation()
  const { user, loading, logout } = useAuth()
  const { resolvedTheme } = useTheme()
  const accountDetailsRef = useRef<HTMLDetailsElement>(null)

  const lightNav =
    pathname === '/' ||
    pathname === '/clients' ||
    pathname === '/enterprise' ||
    pathname === '/race-pool' ||
    pathname === '/simulateur' ||
    pathname === '/comparatif' ||
    pathname === '/workers' ||
    pathname === '/status' ||
    pathname === '/network' ||
    pathname === '/panel/modeles'

  const heroLightChrome = lightNav && resolvedTheme === 'light'
  const heroDarkChrome = lightNav && resolvedTheme !== 'light'

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 12)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const navRouteClass = ({ isActive }: { isActive: boolean }) =>
    [
      'text-sm font-medium transition-colors',
      lightNav
        ? heroLightChrome
          ? isActive
            ? 'text-slate-950'
            : 'text-slate-700 hover:text-slate-950'
          : isActive
            ? 'text-white'
            : 'text-white/75 hover:text-white'
        : isActive
          ? 'text-accent'
          : 'text-muted hover:text-fg',
    ].join(' ')

  const navShellClass = lightNav
    ? `site-nav-shell ${heroLightChrome ? 'site-nav-shell--hero-light' : 'site-nav-shell--hero-dark'} ${scrolled ? 'is-scrolled' : ''}`
    : ''

  const chromePrimaryClass = heroLightChrome
    ? 'bg-slate-950 text-white hover:bg-slate-900'
    : heroDarkChrome
      ? 'bg-white text-slate-950 hover:bg-white/90'
      : 'btn-primary'

  const chromeSecondaryClass = heroLightChrome
    ? 'border border-slate-300/90 bg-white/68 text-slate-900 hover:bg-white/92'
    : heroDarkChrome
      ? 'border border-white/30 bg-white/10 text-white hover:bg-white/18'
      : 'btn-secondary'

  const mobileToneClass = heroLightChrome
    ? 'border-slate-300/90 text-slate-900 hover:bg-slate-950/5'
    : lightNav
      ? 'border-white/30 text-white hover:bg-white/10'
      : 'border-border text-muted hover:bg-surface'

  const handleLogout = useCallback(async () => {
    await logout()
    setMenuOpen(false)
  }, [logout])

  /* eslint-disable react-hooks/set-state-in-effect -- reset compte au logout */
  useEffect(() => {
    let cancelled = false
    if (!user) {
      setAccountOverview(null)
      setAccountOverviewError('')
      setAccountOverviewLoading(false)
      return () => {
        cancelled = true
      }
    }
    setAccountOverviewLoading(true)
    setAccountOverviewError('')
    fetchAccountOverview().then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setAccountOverviewError(result.error)
        setAccountOverview(null)
        setAccountOverviewLoading(false)
        return
      }
      setAccountOverview(result.data)
      setAccountOverviewLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [user])
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <header className="fixed inset-x-0 top-0 z-40 w-full bg-transparent pt-[env(safe-area-inset-top)]">
      <div className="mx-auto max-w-6xl px-4 py-3.5 sm:px-6 lg:px-8">
        <div className={`flex items-center justify-between gap-4 px-4 py-3 sm:px-5 ${navShellClass}`}>
          <div onClick={() => setMenuOpen(false)}>
            <VryxLogo
              to="/"
              tone={heroLightChrome ? 'dark' : lightNav ? 'light' : 'dark'}
              markSize="sm"
              className="py-0.5"
            />
          </div>

        <nav className="hidden items-center gap-4 xl:gap-5 lg:flex" aria-label="Navigation principale">
          {routeLinks.map((l) => (
            <NavLink key={l.to} to={l.to} className={navRouteClass}>
              {t(l.labelKey)}
            </NavLink>
          ))}
          {!loading && user && (
            <NavLink to="/panel/modeles" className={navRouteClass}>
              {t('nav.models')}
            </NavLink>
          )}
          {!loading && user?.isAdmin && (
            <NavLink to="/admin" className={navRouteClass}>
              {t('nav.admin')}
            </NavLink>
          )}
        </nav>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <ThemeToggle navOnDarkHero={heroDarkChrome} />
          {!loading && user ? (
            <>
              <details ref={accountDetailsRef} className="relative hidden lg:block">
                <summary
                  className={`flex cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold [&::-webkit-details-marker]:hidden ${chromePrimaryClass}`}
                >
                  {t('nav.account')}
                  <IconChevronDown className="h-4 w-4 opacity-90" aria-hidden />
                </summary>
                <div className="absolute right-0 z-50 mt-2 w-[min(calc(100vw-2rem),22rem)] rounded-xl border border-border bg-card p-5 shadow-lg">
                  <p className="truncate text-xs font-medium text-muted" title={user.email}>
                    {user.email}
                  </p>
                  <p className="mt-1 text-[0.65rem] uppercase tracking-wide text-muted">
                    Forfait {accountOverview?.plan ?? '—'}
                  </p>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div className="rounded-lg border border-border bg-surface p-3">
                      <dt className="text-muted">Solde</dt>
                      <dd className="mt-0.5 font-mono font-semibold text-success">
                        {accountOverview?.balanceCredits.toLocaleString('fr-FR', {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 0,
                        })}{' '}
                        € TTC
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border bg-surface p-3">
                      <dt className="text-muted">Usage mois</dt>
                      <dd className="mt-0.5 font-mono font-semibold text-electric">
                        {accountOverviewLoading ? '...' : `${accountOverview?.usagePercent ?? 0} %`}
                      </dd>
                    </div>
                    <div className="col-span-2 rounded-lg bg-surface/80 p-2.5">
                      <dt className="text-muted">Clés API actives</dt>
                      <dd className="mt-0.5 font-mono font-semibold text-fg">
                        {accountOverviewLoading ? '...' : accountOverview?.activeApiKeys ?? 0}
                      </dd>
                    </div>
                  </dl>
                  {accountOverviewError ? (
                    <p className="mt-3 rounded-md border border-alert/40 bg-alert/10 p-2 text-[11px] text-alert">
                      {accountOverviewError}
                    </p>
                  ) : null}
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
                className={`hidden rounded-lg px-4 py-2 text-sm lg:inline-flex ${chromeSecondaryClass}`}
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
                className={`hidden rounded-lg px-4 py-2 text-sm font-semibold lg:inline-flex ${chromePrimaryClass}`}
                onClick={() => setMenuOpen(false)}
              >
                  {t('nav.account')}
              </Link>
              <Link
                to="/inscription"
                className={`hidden rounded-lg px-4 py-2 text-sm lg:inline-flex ${chromeSecondaryClass}`}
                onClick={() => setMenuOpen(false)}
              >
                Inscription
              </Link>
            </>
          ) : null}
          {!loading && user ? (
            <Link
              to="/compte"
              className={`inline-flex rounded-lg px-4 py-2 text-sm font-semibold lg:hidden ${chromePrimaryClass}`}
              onClick={() => setMenuOpen(false)}
            >
              {t('nav.account')}
            </Link>
          ) : !loading ? (
            <Link
              to="/connexion"
              state={{ from: '/compte' }}
              className={`inline-flex rounded-lg px-4 py-2 text-sm font-semibold lg:hidden ${chromePrimaryClass}`}
              onClick={() => setMenuOpen(false)}
            >
              {t('nav.account')}
            </Link>
          ) : (
            <span
              className="inline-flex h-10 w-24 shrink-0 animate-pulse rounded-lg bg-card lg:hidden"
              aria-hidden
            />
          )}

          <button
            type="button"
            className={`flex h-10 w-10 items-center justify-center rounded-lg border lg:hidden ${mobileToneClass}`}
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
      </div>

      {menuOpen && (
        <div
          id="mobile-nav"
          className={`mx-4 rounded-2xl border px-4 py-4 backdrop-blur-md sm:mx-6 lg:hidden lg:mx-8 ${
            lightNav
              ? heroLightChrome
                ? 'border-slate-900/10 bg-white/92 text-slate-950'
                : 'border-white/10 bg-page-hero/95 text-white'
              : 'border-border bg-bg/95'
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
                      ? heroLightChrome
                        ? isActive
                          ? 'bg-slate-950/8 text-slate-950'
                          : 'text-slate-700'
                        : isActive
                          ? 'bg-white/15 text-white'
                          : 'text-white/80'
                      : isActive
                        ? 'bg-accent/15 text-accent'
                        : 'text-muted'
                  }`
                }
                onClick={() => setMenuOpen(false)}
              >
                {t(l.labelKey)}
              </NavLink>
            ))}
            {!loading && user && (
              <Link
                to="/compte"
                className={`rounded-lg px-3 py-2.5 text-base font-semibold ${
                  lightNav
                    ? heroLightChrome
                      ? 'bg-slate-950/8 text-slate-950'
                      : 'bg-white/15 text-white'
                    : 'bg-accent/10 text-accent'
                }`}
                onClick={() => setMenuOpen(false)}
              >
                {t('nav.account')}, tableau de bord
              </Link>
            )}
            {!loading && user?.isAdmin && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2.5 text-base font-semibold ${
                    lightNav
                      ? heroLightChrome
                        ? isActive
                          ? 'bg-slate-950/8 text-slate-950'
                          : 'text-slate-700'
                        : isActive
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
                      ? heroLightChrome
                        ? isActive
                          ? 'bg-slate-950/8 text-slate-950'
                          : 'text-slate-700'
                        : isActive
                          ? 'bg-white/15 text-white'
                          : 'text-white/80'
                      : isActive
                        ? 'bg-accent/15 text-accent'
                        : 'text-muted'
                  }`
                }
                onClick={() => setMenuOpen(false)}
              >
                {t('nav.models')}
              </NavLink>
            )}
            {!loading && user ? (
              <>
                <p
                  className={`mt-2 truncate px-3 text-sm ${
                    heroLightChrome ? 'text-slate-600' : lightNav ? 'text-white/70' : 'text-muted'
                  }`}
                  title={user.email}
                >
                  {user.email}
                </p>
                <button
                  type="button"
                  className={`mt-2 w-full rounded-lg px-3 py-2.5 text-center text-sm ${
                    heroLightChrome
                      ? 'border border-slate-300/90 text-slate-900'
                      : lightNav
                        ? 'border border-white/25 text-white'
                        : 'border border-border text-fg'
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
                    heroLightChrome
                      ? 'border border-slate-300/90 text-slate-900'
                      : lightNav
                        ? 'border border-white/25 text-white'
                        : 'border border-border text-fg'
                  }`}
                  onClick={() => setMenuOpen(false)}
                >
                  Connexion
                </Link>
                <Link
                  to="/inscription"
                  className={`mt-1 rounded-lg px-3 py-2.5 text-center text-sm font-medium ${
                    heroLightChrome
                      ? 'bg-slate-950/8 text-slate-950'
                      : lightNav
                        ? 'bg-white/15 text-white'
                        : 'bg-accent/10 text-accent'
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
