import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconChevronDown } from '../icons/Icons'
import { VryxLogo } from '../brand/VryxLogo'
import { useAuth } from '../../context/AuthContext'
import { useTheme } from '../../context/ThemeContext'
import { ThemeToggle } from './ThemeToggle'
import { fetchAccountOverview, type AccountOverview } from '../../lib/account'

const mainRouteLinks = [
  { to: '/clients', labelKey: 'nav.clients' },
  { to: '/enterprise', labelKey: 'nav.enterprise' },
]

const gpuRouteLinks = [
  { to: '/race-pool', labelKey: 'nav.racePool', desc: 'Pool de calcul partagé pour vos GPU' },
  { to: '/simulateur', labelKey: 'nav.simulator', desc: 'Simulateur de gains en temps réel' },
  { to: '/comparatif', labelKey: 'nav.comparison', desc: 'Comparateur Gains seul vs collectif' },
  { to: '/workers', labelKey: 'nav.workers', desc: 'Gestion de vos nœuds de calcul' },
  { to: '/network', labelKey: 'nav.network', desc: 'Statut et ressources du réseau' },
]

const routeLinks = [...mainRouteLinks, ...gpuRouteLinks]

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
            ? 'text-slate-950 font-semibold'
            : 'text-slate-700 hover:text-slate-950'
          : isActive
            ? 'text-white font-semibold'
            : 'text-white/75 hover:text-white'
        : isActive
          ? 'text-accent font-semibold'
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

        <nav className="hidden items-center gap-6 xl:gap-8 lg:flex" aria-label="Navigation principale">
          {mainRouteLinks.map((l) => (
            <NavLink key={l.to} to={l.to} className={navRouteClass}>
              {t(l.labelKey)}
            </NavLink>
          ))}

          {/* Grouped Dropdown for GPU Network & Calculations */}
          <div className="relative group py-2">
            <button
              type="button"
              className={`flex items-center gap-1 text-sm font-medium transition-colors focus:outline-none ${
                lightNav
                  ? heroLightChrome
                    ? 'text-slate-700 hover:text-slate-950 group-hover:text-slate-950'
                    : 'text-white/75 hover:text-white group-hover:text-white'
                  : 'text-muted hover:text-fg group-hover:text-fg'
              }`}
            >
              Calcul & Réseau
              <IconChevronDown className="h-4 w-4 transition-transform duration-200 group-hover:rotate-180 opacity-70" aria-hidden={true} />
            </button>

            {/* Submenu Dropdown Panel */}
            <div className={`absolute left-1/2 -translate-x-1/2 top-full z-50 w-80 rounded-2xl border p-3 shadow-2xl backdrop-blur-xl opacity-0 scale-95 pointer-events-none transition-all duration-200 origin-top group-hover:opacity-100 group-hover:scale-100 group-hover:pointer-events-auto ${
              lightNav
                ? heroLightChrome
                  ? 'border-slate-900/10 bg-white/95'
                  : 'border-white/10 bg-slate-950/92'
                : 'border-border bg-card/95'
            }`}>
              <div className="grid gap-1">
                {gpuRouteLinks.map((l) => (
                  <NavLink
                    key={l.to}
                    to={l.to}
                    className={`flex flex-col gap-0.5 rounded-xl p-2.5 transition-colors ${
                      lightNav
                        ? heroLightChrome
                          ? 'hover:bg-slate-950/5'
                          : 'hover:bg-white/10'
                        : 'hover:bg-surface'
                    }`}
                  >
                    <span className={`text-sm font-semibold transition-colors ${
                      lightNav
                        ? heroLightChrome
                          ? 'text-slate-950'
                          : 'text-white'
                        : 'text-fg'
                    }`}>
                      {t(l.labelKey)}
                    </span>
                    <span className={`text-xs transition-colors ${
                      lightNav
                        ? heroLightChrome
                          ? 'text-slate-500'
                          : 'text-white/60'
                        : 'text-muted'
                    }`}>
                      {l.desc}
                    </span>
                  </NavLink>
                ))}
              </div>
            </div>
          </div>

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
              className={`hidden rounded-lg px-4 py-2 text-sm font-semibold sm:inline-flex lg:hidden ${chromePrimaryClass}`}
              onClick={() => setMenuOpen(false)}
            >
              {t('nav.account')}
            </Link>
          ) : !loading ? (
            <Link
              to="/connexion"
              state={{ from: '/compte' }}
              className={`hidden rounded-lg px-4 py-2 text-sm font-semibold sm:inline-flex lg:hidden ${chromePrimaryClass}`}
              onClick={() => setMenuOpen(false)}
            >
              {t('nav.account')}
            </Link>
          ) : (
            <span
              className="hidden h-10 w-24 shrink-0 animate-pulse rounded-lg bg-card sm:inline-flex lg:hidden"
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

      {/* Backdrop overlay */}
      <div
        className={`fixed inset-0 z-30 bg-slate-950/40 backdrop-blur-sm lg:hidden transition-opacity duration-300 ${
          menuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => setMenuOpen(false)}
      />

      <div
        id="mobile-nav"
        className={`relative z-40 mx-4 mt-2 rounded-2xl border px-5 py-5 backdrop-blur-xl sm:mx-6 lg:hidden transition-all duration-300 ease-out transform ${
          menuOpen
            ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto shadow-2xl'
            : 'opacity-0 -translate-y-4 scale-95 pointer-events-none absolute'
        } ${
          lightNav
            ? heroLightChrome
              ? 'border-slate-900/10 bg-white/94 text-slate-950'
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
                `rounded-lg px-3 py-2.5 text-base font-medium transition-all duration-200 ${
                  lightNav
                    ? heroLightChrome
                      ? isActive
                        ? 'bg-slate-950/8 text-slate-950 font-semibold'
                        : 'text-slate-700 hover:bg-slate-950/4 hover:text-slate-950'
                      : isActive
                        ? 'bg-white/15 text-white font-semibold'
                        : 'text-white/80 hover:bg-white/5 hover:text-white'
                    : isActive
                      ? 'bg-accent/15 text-accent font-semibold'
                      : 'text-muted hover:bg-surface hover:text-fg'
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
              className={`rounded-lg px-3 py-2.5 text-base font-semibold transition-all duration-200 ${
                lightNav
                  ? heroLightChrome
                    ? 'bg-slate-950/8 text-slate-950 hover:bg-slate-950/12'
                    : 'bg-white/15 text-white hover:bg-white/25'
                  : 'bg-accent/10 text-accent hover:bg-accent/20'
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
                `rounded-lg px-3 py-2.5 text-base font-semibold transition-all duration-200 ${
                  lightNav
                    ? heroLightChrome
                      ? isActive
                        ? 'bg-slate-950/8 text-slate-950'
                        : 'text-slate-700 hover:bg-slate-950/4'
                      : isActive
                        ? 'bg-white/15 text-white'
                        : 'text-white/80 hover:bg-white/5'
                    : isActive
                      ? 'bg-accent/15 text-accent'
                      : 'text-muted hover:bg-surface'
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
                `rounded-lg px-3 py-2.5 text-base font-medium transition-all duration-200 ${
                  lightNav
                    ? heroLightChrome
                      ? isActive
                        ? 'bg-slate-950/8 text-slate-950'
                        : 'text-slate-700 hover:bg-slate-950/4'
                      : isActive
                        ? 'bg-white/15 text-white'
                        : 'text-white/80 hover:bg-white/5'
                    : isActive
                      ? 'bg-accent/15 text-accent'
                      : 'text-muted hover:bg-surface'
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
                className={`mt-2 w-full rounded-lg px-3 py-2.5 text-center text-sm transition-colors duration-200 ${
                  heroLightChrome
                    ? 'border border-slate-300/90 text-slate-900 hover:bg-slate-950/5'
                    : lightNav
                      ? 'border border-white/25 text-white hover:bg-white/10'
                      : 'border border-border text-fg hover:bg-surface'
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
                className={`mt-2 rounded-lg px-3 py-2.5 text-center text-sm transition-colors duration-200 ${
                  heroLightChrome
                    ? 'border border-slate-300/90 text-slate-900 hover:bg-slate-950/5'
                    : lightNav
                      ? 'border border-white/25 text-white hover:bg-white/10'
                      : 'border border-border text-fg hover:bg-surface'
                }`}
                onClick={() => setMenuOpen(false)}
              >
                Connexion
              </Link>
              <Link
                to="/inscription"
                className={`mt-1 rounded-lg px-3 py-2.5 text-center text-sm font-medium transition-all duration-200 ${
                  heroLightChrome
                    ? 'bg-slate-950/8 text-slate-950 hover:bg-slate-950/15'
                    : lightNav
                      ? 'bg-white/15 text-white hover:bg-white/25'
                      : 'bg-accent/10 text-accent hover:bg-accent/20'
                }`}
                onClick={() => setMenuOpen(false)}
              >
                Inscription
              </Link>
            </>
          ) : null}
        </nav>
      </div>
    </header>
  )
}
