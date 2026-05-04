import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { WorkerDashboardPreview } from '../components/workers/WorkerDashboardPreview'
import { WorkerSetupPanel } from '../components/workers/WorkerSetupPanel'
import {
  WORKERS_FAQ,
} from '../data/workersContent'
import { STORYTELLING } from '../data/storytelling'
import { useAuth } from '../context/AuthContext'

const pillars = [
  {
    title: 'Paiements SEPA',
    text: 'Encaissement en euros sur compte bancaire dans la zone SEPA.',
  },
  {
    title: 'Charge utile',
    text: 'Votre GPU exécute des blocs d’inférence ; les données sensibles client ne persistent pas en VRAM.',
  },
  {
    title: 'Course et Relais',
    text: 'Comparatif clair entre file classique et course de latence selon votre profil matériel.',
  },
] as const

export function WorkersPage() {
  const wp = STORYTELLING.workersPage
  const { user } = useAuth()
  const { hash, pathname } = useLocation()

  useEffect(() => {
    if (pathname !== '/workers' || hash !== '#install') return
    window.requestAnimationFrame(() => {
      document.getElementById('install')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [hash, pathname])

  return (
    <div className="border-b border-border bg-bg">
      <section
        className="relative isolate -mt-[4.25rem] flex min-h-[min(84vh,36rem)] flex-col overflow-hidden border-b border-border pt-[4.25rem] sm:min-h-[min(88vh,40rem)]"
        aria-labelledby="workers-hero-heading"
      >
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))] overflow-hidden"
          aria-hidden
        >
          <div
            className="absolute inset-0 scale-105 bg-cover bg-center bg-no-repeat blur-[3px]"
            style={{ backgroundImage: "url('/worker.png')" }}
          />
        </div>
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))] bg-slate-950/60 sm:bg-slate-950/55"
          aria-hidden
        />

        <div className="relative z-10 flex min-h-[inherit] flex-1 flex-col items-center justify-center px-4 pb-14 pt-8 text-center sm:pb-16 sm:pt-10">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="flex max-w-2xl flex-col items-center"
          >
            <h1
              id="workers-hero-heading"
              className="font-display text-balance text-3xl font-semibold leading-tight tracking-tight text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.45)] sm:text-4xl md:text-[2.35rem]"
            >
              {wp.title}
            </h1>
            <p className="mt-4 max-w-xl text-pretty text-base leading-snug text-white/88 sm:mt-5 sm:text-lg">{wp.intro}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:gap-4">
              <Link
                to="/comparatif"
                className="inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-white/90 sm:px-8 sm:text-base"
              >
                Comparatif des modes
              </Link>
              <Link
                to="/workers#install"
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/35 bg-white/5 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/12 sm:px-8 sm:text-base"
              >
                Installer le client
              </Link>
            </div>
          </motion.div>
        </div>
      </section>

      <section className="border-b border-border bg-bg py-14 sm:py-18" aria-labelledby="worker-pilotage-heading">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <h2 id="worker-pilotage-heading" className="font-display text-2xl font-semibold text-fg sm:text-3xl">
              Pilotage worker
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted sm:text-base">
              Vue session, prérequis matériels et installation rapide. Même structure que les autres pages, orientée
              lecture mobile d’abord.
            </p>
          </div>

          <div className="mt-10 grid gap-8 lg:grid-cols-2 lg:items-stretch">
            <WorkerDashboardPreview />
            <WorkerSetupPanel showDownloadCta={false} />
          </div>
        </div>
      </section>

      <section className="border-b border-border bg-surface py-14 sm:py-18" aria-labelledby="workers-pillars-heading">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <h2 id="workers-pillars-heading" className="text-center font-display text-2xl font-semibold text-fg sm:text-3xl">
            Principes clés
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-muted sm:text-base">
            Ce qui définit le cadre worker côté paiements, exécution et mode de traitement.
          </p>

          <motion.ul
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mt-10 grid gap-5 sm:grid-cols-3"
          >
            {pillars.map((p) => (
              <li key={p.title} className="panel p-5 sm:p-6">
                <h2 className="font-display text-lg font-semibold text-fg">{p.title}</h2>
                <p className="mt-3 text-sm text-muted">{p.text}</p>
              </li>
            ))}
          </motion.ul>
        </div>
      </section>

      <section
        className="relative isolate overflow-hidden border-b border-border py-16 sm:py-20 lg:py-24"
        aria-labelledby="workflow-workers"
      >
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/mid.png')" }}
          aria-hidden
        />
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/82 via-slate-950/72 to-slate-950/88" aria-hidden />
        <div className="relative z-10 mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <h2 id="workflow-workers" className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              Parcours type
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-white/72 sm:text-base">
              Cycle d’une requête
              <br />
              Du multi-cast au signal de fin : quatre étapes sur le fil de la requête.
            </p>
          </div>
          <ol className="mx-auto mt-12 grid max-w-4xl list-none gap-5 p-0 sm:grid-cols-2 lg:mt-16 lg:max-w-none lg:grid-cols-4 lg:gap-4">
            {[
              { step: '01', title: 'Compte', body: 'Inscription e-mail et mot de passe.' },
              { step: '02', title: 'Install', body: 'Une commande curl ou PowerShell pour enregistrer le worker.' },
              { step: '03', title: 'Bench', body: 'Test de charge automatique : bande passante, VRAM, stabilité.' },
              { step: '04', title: 'Production', body: 'Vous rejoignez les files ; les gains s’affichent sur le solde.' },
            ].map((row) => (
              <li
                key={row.step}
                className="flex flex-col rounded-2xl border border-white/10 bg-black/50 px-5 pb-5 pt-6 text-center shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] sm:px-6 sm:pb-6 sm:pt-7"
              >
                <div className="mx-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/20 bg-slate-950/80 font-mono text-xs font-semibold tabular-nums text-white">
                  {row.step}
                </div>
                <h3 className="font-display mt-4 text-base font-semibold text-white sm:text-lg">{row.title}</h3>
                <p className="mt-2 grow text-pretty text-sm leading-relaxed text-white/68">{row.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="bg-bg py-14 sm:py-20" aria-labelledby="faq-workers">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <h2 id="faq-workers" className="font-display text-2xl font-semibold text-fg sm:text-3xl">
            Questions fréquentes
          </h2>
          <div className="mt-8 space-y-3">
            {WORKERS_FAQ.map((item) => (
              <details
                key={item.q}
                className="group panel px-4 py-1 open:border-electric/30"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 font-medium text-fg [&::-webkit-details-marker]:hidden">
                  <span>{item.q}</span>
                  <span className="shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden>
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m19 9-7 7-7-7" />
                    </svg>
                  </span>
                </summary>
                <p className="border-t border-border/80 pb-4 text-sm leading-relaxed text-muted">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border bg-surface py-14 sm:py-16" aria-labelledby="cta-workers">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 id="cta-workers" className="font-display text-xl font-semibold text-fg sm:text-2xl">
            Rejoindre le réseau
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-muted">
            {user
              ? 'Installez le client worker, puis laissez la file attribuer les tâches.'
              : 'Créez un compte (côté worker ou compte unique), installez le client, puis laissez la file attribuer les tâches.'}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to={user ? '/compte' : '/inscription'} className="btn-primary rounded-xl px-8 py-3 text-sm font-semibold sm:text-base">
              {user ? 'Mon compte' : 'S’inscrire'}
            </Link>
            <Link to="/clients" className="btn-secondary rounded-xl px-8 py-3 text-sm font-semibold sm:text-base">
              Côté client API
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
