import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { RACE_POOL_FAQ, RACE_POOL_STEPS } from '../data/racePoolContent'

const pillars = [
  {
    title: 'La Course',
    text: 'Sur un bloc mis en course, plusieurs GPU peuvent recevoir le même fragment ; le premier résultat valide fait avancer le graphe, les autres tentatives sur ce bloc sont coupées.',
  },
  {
    title: 'Le Relais',
    text: 'Les très grands modèles se découpent : un groupe enchaîne après l’autre sans saturer une seule machine.',
  },
  {
    title: 'Euros partout',
    text: 'Carte côté client, virement SEPA côté worker, même filet de sécurité qu’ailleurs sur Vryx.',
  },
] as const

export function RacePoolPage() {
  return (
    <div className="border-b border-border bg-bg">
      <section
        className="relative isolate -mt-[4.25rem] flex min-h-[min(86vh,38rem)] flex-col overflow-hidden border-b border-border pt-[4.25rem] sm:min-h-[min(88vh,42rem)]"
        aria-labelledby="race-pool-hero-heading"
      >
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))] overflow-hidden"
          aria-hidden
        >
          <div
            className="absolute inset-0 scale-105 bg-cover bg-center bg-no-repeat blur-[3px]"
            style={{ backgroundImage: "url('/datacenter.png')" }}
          />
        </div>
        <div
          className="hero-overlay pointer-events-none absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))]"
          aria-hidden
        />

        <div className="relative z-10 flex min-h-[inherit] flex-1 flex-col items-center justify-center px-4 pb-14 pt-6 text-center sm:pb-16 sm:pt-8">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="flex max-w-2xl flex-col items-center"
          >
            <h1
              id="race-pool-hero-heading"
              className="font-display text-balance text-3xl font-semibold leading-tight tracking-tight text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.45)] sm:text-4xl md:text-[2.35rem]"
            >
              Course et Relais
            </h1>
            <p className="mt-4 max-w-xl text-pretty text-base leading-snug text-white/88 sm:mt-5 sm:text-lg">
              Parallélisme compétitif, puis enchaînement, pour rester rapide même avec des connexions variables.
            </p>
            <Link
              to="/comparatif"
              className="mt-8 inline-flex min-h-11 w-full max-w-xs items-center justify-center rounded-xl border border-transparent bg-white px-6 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-white/90 dark:border-white/20 dark:bg-card/95 dark:text-fg dark:backdrop-blur-md dark:hover:bg-card sm:mt-9 sm:w-auto sm:px-8 sm:text-base"
            >
              Comparer solo et pool
            </Link>
          </motion.div>
        </div>
      </section>

      <section className="border-b border-border bg-bg py-14 sm:py-18" aria-labelledby="race-architecture">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <h2 id="race-architecture" className="font-display text-center text-2xl font-semibold text-fg sm:text-3xl">
            Deux briques d’architecture
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-sm leading-relaxed text-muted sm:text-base">
            La Race-Pool compense l’irrégularité d’Internet chez les particuliers sans retomber sur un datacenter
            classique.
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 sm:gap-8">
            <article className="panel p-6 sm:p-7">
              <h3 className="font-display text-lg font-semibold text-fg">La Course</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted sm:text-base">
                La requête est d&apos;abord découpée selon la VRAM disponible. Pour une étape mise en course, le même
                bloc utile peut partir vers plusieurs GPU en parallèle : le premier qui livre un résultat valide pour ce
                bloc fait avancer le graphe ; les autres tentatives sur ce bloc sont stoppées. D&apos;autres fragments
                de la même inférence tournent sur d&apos;autres nœuds.
              </p>
            </article>
            <article className="panel p-6 sm:p-7">
              <h3 className="font-display text-lg font-semibold text-fg">Le Relais</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted sm:text-base">
                Quand une étape dépasse ce qu&apos;une carte peut traiter seule, des groupes enchaînent : chaque segment
                reçoit une partie du calcul, puis passe le relais au suivant sans saturer la mémoire d&apos;un seul
                poste.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section
        className="relative isolate overflow-hidden border-b border-border py-16 sm:py-20 lg:py-24"
        aria-labelledby="race-cycle-heading"
      >
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/mid.png')" }}
          aria-hidden
        />
        <div className="hero-overlay absolute inset-0" aria-hidden />
        <div className="relative z-10 mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <p className="font-mono text-[0.7rem] font-medium uppercase tracking-[0.22em] text-white/45">
              Parcours
            </p>
            <h2 id="race-cycle-heading" className="mt-2 font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              Cycle d’une requête
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-white/72 sm:text-base">
              Du multi-cast au signal de fin : quatre étapes sur le fil de la requête.
            </p>
          </div>

          <ol className="mx-auto mt-12 grid max-w-4xl list-none gap-5 p-0 sm:grid-cols-2 lg:mt-16 lg:max-w-none lg:grid-cols-4 lg:gap-4">
            {RACE_POOL_STEPS.map((s, i) => {
              const step = String(i + 1).padStart(2, '0')
              return (
                <li
                  key={s.title}
                  className="flex flex-col rounded-2xl border border-white/10 bg-black/50 px-5 pb-5 pt-6 text-center shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] sm:px-6 sm:pb-6 sm:pt-7"
                >
                  <div className="mx-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/20 bg-page-hero/85 font-mono text-xs font-semibold tabular-nums text-white dark:bg-black/50">
                    {step}
                  </div>
                  <h3 className="font-display mt-4 text-base font-semibold text-white sm:text-lg">{s.title}</h3>
                  <p className="mt-2 grow text-pretty text-sm leading-relaxed text-white/68">{s.body}</p>
                </li>
              )
            })}
          </ol>
        </div>
      </section>

      <section className="border-b border-border bg-surface py-14 sm:py-18" aria-labelledby="race-pillars-heading">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <h2 id="race-pillars-heading" className="text-center font-display text-2xl font-semibold text-fg sm:text-3xl">
            Pourquoi ce modèle
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-muted sm:text-base">
            Parallélisme utile, coût marginal maîtrisé, même devise partout.
          </p>
          <ul className="mt-10 grid gap-5 sm:grid-cols-3">
            {pillars.map((p, i) => (
              <motion.li
                key={p.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                className="panel p-5 sm:p-6"
              >
                <h3 className="font-display text-lg font-semibold text-fg">{p.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted">{p.text}</p>
              </motion.li>
            ))}
          </ul>
        </div>
      </section>

      <section className="bg-bg py-14 sm:py-18" aria-labelledby="faq-rp-heading">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <h2 id="faq-rp-heading" className="text-center font-display text-2xl font-semibold text-fg sm:text-3xl">
            Questions fréquentes
          </h2>
          <div className="mt-8 space-y-3">
            {RACE_POOL_FAQ.map((item) => (
              <details
                key={item.q}
                className="group panel px-4 py-1 open:border-accent/30"
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

      <section className="border-t border-border bg-surface py-12 sm:py-14" aria-labelledby="cta-rp-heading">
        <div className="mx-auto max-w-2xl px-4 text-center sm:px-6 lg:px-8">
          <h2 id="cta-rp-heading" className="font-display text-xl font-semibold text-fg sm:text-2xl">
            Passer au chiffrage
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted sm:text-base">
            Projettez vos volumes et comparez avec votre grille actuelle.
          </p>
          <Link
            to="/simulateur"
            className="btn-primary mx-auto mt-8 inline-flex min-h-11 items-center justify-center rounded-xl px-8 py-3 text-sm font-semibold sm:text-base"
          >
            Ouvrir le simulateur
          </Link>
        </div>
      </section>
    </div>
  )
}
