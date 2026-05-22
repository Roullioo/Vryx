import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { EurSign } from '../components/icons/Icons'
import { STORYTELLING } from '../data/storytelling'
import { formatEur } from '../lib/simulator'

/** Enveloppe worker illustrative pour une petite mission (ordre de grandeur). */
const EXAMPLE_TASK_EUR = 4.8
/** Nombre de machines en répartition pool illustrative (parts égales). */
const EXAMPLE_POOL_SIZE = 8
const examplePoolShareEur = EXAMPLE_TASK_EUR / EXAMPLE_POOL_SIZE

const rows = [
  {
    label: 'Découpage',
    solo: 'Toujours : fragments calibrés VRAM, graphe réparti sur beaucoup de nœuds.',
    pool: 'Identique côté réseau : une requête volumineuse ne tient pas sur une seule carte.',
  },
  {
    label: 'Gains',
    solo: 'Sur les blocs en course, rémunération du chemin validé en premier ; tentatives redondantes non retenues relâchées.',
    pool: 'Enveloppe souvent partagée selon les règles du pool : part plus faible par machine si répartition large.',
  },
  {
    label: 'Activité',
    solo: 'Variabilité selon les étapes où votre nœud entre en course ou en chaîne.',
    pool: 'Missionnement souvent plus dense au sein du groupe : régularité typique plus forte.',
  },
]

export function ComparePage() {
  const cp = STORYTELLING.comparePage

  return (
    <div className="border-b border-border bg-bg pb-16 sm:pb-24">
      <section
        className="page-hero page-hero--compact"
        aria-labelledby="compare-hero-heading"
      >
        <div className="page-hero-media-shell" aria-hidden>
          <div
            className="page-hero-media"
            style={{ backgroundImage: "url('/heroes/compare-hero.webp')" }}
          />
        </div>
        <div className="page-hero-overlay" aria-hidden />

        <div className="relative z-10 flex min-h-[inherit] flex-1 flex-col items-center justify-center px-4 pb-12 pt-8 text-center sm:pb-14 sm:pt-10">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="mx-auto max-w-2xl"
          >
            <h1
              id="compare-hero-heading"
              className="font-display text-balance text-3xl font-semibold leading-tight tracking-tight text-white drop-shadow-[0_2px_28px_rgba(0,0,0,0.55)] sm:text-4xl md:text-[2.15rem]"
            >
              {cp.title}
            </h1>
            <p className="mx-auto mt-4 max-w-xl whitespace-pre-line text-pretty text-base leading-snug text-white/88 sm:mt-5 sm:text-lg">
              {cp.intro}
            </p>
            <div className="mt-9 flex w-full flex-col gap-3 sm:mx-auto sm:max-w-lg sm:flex-row sm:justify-center sm:gap-4">
              <Link
                to="/simulateur"
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-transparent bg-white px-6 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-white/90 dark:border-white/20 dark:bg-card/95 dark:text-fg dark:backdrop-blur-md dark:hover:bg-card sm:flex-none sm:px-8 sm:text-base"
              >
                Simulateur coûts clients
              </Link>
              <Link
                to="/workers"
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/35 bg-white/5 px-6 py-3 text-sm font-semibold text-white backdrop-blur-[2px] transition-colors hover:bg-white/12 sm:flex-none sm:px-8 sm:text-base"
              >
                Devenir worker
              </Link>
            </div>
          </motion.div>
        </div>
      </section>

      <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.35 }}
          className="rounded-2xl border border-border bg-card p-5 sm:p-7 dark:shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset]"
          aria-labelledby="compare-example-heading"
        >
          <h2 id="compare-example-heading" className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-electric">
            Exemple chiffré
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted sm:text-base">
            Un modèle qui dépasse largement la mémoire d&apos;un GPU (ex. besoin global énorme vs carte 16&nbsp;Go)
            n&apos;est jamais traité comme un bloc unique sur une seule machine : la requête est{' '}
            <strong className="font-semibold text-fg">découpée</strong>, et{' '}
            <strong className="font-semibold text-fg">de nombreux nœuds</strong> enchaînent ou travaillent en parallèle,
            que vous soyez en solo ou en pool. Ce qui diffère, ce sont surtout les règles de rémunération et de groupe.
          </p>
          <ul className="mt-5 space-y-4 text-sm leading-relaxed text-muted sm:text-base">
            <li className="flex gap-3">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
              <span>
                <span className="font-semibold text-fg">Solo / course</span> : sur une étape où la redondance est utile,
                le même sous-bloc peut être confié à plusieurs GPU en parallèle ; celui qui livre le premier résultat
                valide pour ce bloc débloque la suite, les autres tentatives sur ce bloc sont coupées. Le reste du
                graphe continue sur d&apos;autres nœuds avec d&apos;autres fragments :{' '}
                <strong className="font-semibold text-fg">
                  ce n&apos;est pas l&apos;intégralité de l&apos;enveloppe worker sur une seule carte
                </strong>
                .
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
              <span>
                <span className="font-semibold text-fg">Pool (illustration de répartition)</span> : même logique de
                découpage réseau ; pour une enveloppe totale illustrée de{' '}
                <span className="font-mono font-semibold tabular-nums text-fg">
                  {formatEur(EXAMPLE_TASK_EUR)}
                  <EurSign className="inline text-fg" />
                </span>{' '}
                à répartir à parts égales entre {EXAMPLE_POOL_SIZE} machines du pool, cela fait environ{' '}
                <span className="font-mono font-semibold tabular-nums text-accent">
                  {formatEur(examplePoolShareEur)}
                  <EurSign className="inline text-accent" />
                </span>{' '}
                par machine dans cet exemple ({formatEur(EXAMPLE_TASK_EUR)}
                <EurSign className="inline text-muted" /> ÷ {EXAMPLE_POOL_SIZE}). Les montants réels suivent le barème
                et le détail des tâches.
              </span>
            </li>
          </ul>
          <p className="mt-5 border-t border-border/80 pt-4 text-xs leading-relaxed text-muted">
            Chiffres indicatifs pour comparer les logiques économiques ; la ventilation technique exacte dépend du
            modèle, du scheduler et du mode Race-Pool ou Relais.
          </p>
        </motion.section>

        <div className="mt-10 grid gap-5 sm:gap-6 lg:grid-cols-2">
          <motion.article
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.35 }}
            className="rounded-2xl border border-border bg-surface p-6 sm:p-8"
          >
            <h2 className="font-display text-xl font-semibold text-fg">Solo (La Course)</h2>
            <ul className="mt-5 space-y-3 text-sm leading-relaxed text-muted">
              <li className="flex gap-2">
                <span className="text-success" aria-hidden>
                  +
                </span>
                Chaque nœud ne voit qu&apos;une partie de la charge utile ; la course porte sur certains blocs
                redondants, pas sur tout le modèle d&apos;un coup.
              </li>
              <li className="flex gap-2">
                <span className="text-muted" aria-hidden>
                  −
                </span>
                Irrégularité possible selon les étapes où votre GPU entre en compétition ou en chaîne avec les autres.
              </li>
            </ul>
          </motion.article>

          <motion.article
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.35, delay: 0.05 }}
            className="rounded-2xl border border-border bg-surface p-6 sm:p-8"
          >
            <h2 className="font-display text-xl font-semibold text-fg">Pool (Le Relais)</h2>
            <ul className="mt-5 space-y-3 text-sm leading-relaxed text-muted">
              <li className="flex gap-2">
                <span className="text-success" aria-hidden>
                  +
                </span>
                Même pipeline découpé ; le pool organise souvent une charge plus continue et une répartition contractuelle
                de l&apos;enveloppe entre membres.
              </li>
              <li className="flex gap-2">
                <span className="text-muted" aria-hidden>
                  −
                </span>
                Part individuelle plus faible lorsque les gains sont étalés sur plusieurs machines selon les règles du
                groupe.
              </li>
            </ul>
          </motion.article>
        </div>

        <div className="mt-12 overflow-hidden rounded-2xl border border-border shadow-sm">
          <table className="w-full min-w-[min(100%,520px)] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface font-mono text-[0.65rem] uppercase tracking-wider text-muted sm:text-xs">
                <th className="px-4 py-3.5 sm:px-6">Critère</th>
                <th className="px-4 py-3.5 sm:px-6">Solo</th>
                <th className="px-4 py-3.5 sm:px-6">Pool</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.label}
                  className={i % 2 === 0 ? 'bg-bg' : 'bg-card/60'}
                >
                  <th className="border-b border-border px-4 py-3.5 font-display text-sm font-semibold text-fg sm:px-6 sm:text-base">
                    {r.label}
                  </th>
                  <td className="border-b border-border px-4 py-3.5 text-muted sm:px-6">{r.solo}</td>
                  <td className="border-b border-border px-4 py-3.5 text-muted sm:px-6">{r.pool}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mt-10 rounded-2xl border border-electric/25 bg-electric/[0.06] p-5 sm:p-7"
        >
          <h3 className="font-display text-base font-semibold text-electric sm:text-lg">En résumé</h3>
          <p className="mt-3 text-sm leading-relaxed text-muted sm:text-base">
            En résumé : le réseau repose sur{' '}
            <strong className="font-semibold text-fg">beaucoup de nœuds et des morceaux calibrés mémoire</strong>, en
            solo comme en pool. La course optimise certaines étapes par redondance ; le pool change surtout la façon de{' '}
            <strong className="font-semibold text-fg">partager l&apos;enveloppe</strong> entre machines. Les règles
            doivent rester lisibles pour chaque participant.
          </p>
        </motion.div>
      </div>
    </div>
  )
}
