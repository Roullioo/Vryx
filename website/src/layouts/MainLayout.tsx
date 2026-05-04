import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Navbar } from '../components/layout/Navbar'
import { Footer } from '../components/layout/Footer'

/** Remonte en haut à chaque changement de chemin (sans data router, pas de ScrollRestoration). */
function ScrollToTopOnPathname() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [pathname])
  return null
}

export function MainLayout() {
  const { pathname } = useLocation()
  const topDarkHero =
    pathname === '/' ||
    pathname === '/clients' ||
    pathname === '/race-pool' ||
    pathname === '/simulateur' ||
    pathname === '/comparatif' ||
    pathname === '/workers' ||
    pathname === '/panel/modeles'

  return (
    <div className={`min-h-svh text-fg ${topDarkHero ? 'bg-slate-950' : 'bg-bg'}`}>
      <ScrollToTopOnPathname />
      <Navbar />
      <main className="relative z-0">
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}
