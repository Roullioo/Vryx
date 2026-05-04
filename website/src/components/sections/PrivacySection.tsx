import { type ComponentType } from 'react'
import { motion } from 'framer-motion'
import { STORYTELLING } from '../../data/storytelling'
import { IconLayoutGrid, IconLock, IconShield, IconTerminal } from '../icons/Icons'

const cards: {
  title: string
  body: string
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
}[] = [
  {
    title: 'Illisibilité côté GPU',
    body:
      'Le processeur graphique manipule des tenseurs et des flottants sans clé de décodage exploitable : pas de texte ni de poids du modèle en clair sur la puce.',
    Icon: IconLock,
  },
  {
    title: 'Fragmentation du graphe',
    body:
      'Chaque worker ne voit qu’une fraction du calcul : impossible de reconstituer seul la donnée ou l’ensemble du modèle.',
    Icon: IconLayoutGrid,
  },
  {
    title: 'Exécution isolée',
    body:
      'Conteneur dédié, accès GPU strictement borné, politique de ressources appliquée à chaque tâche.',
    Icon: IconTerminal,
  },
]

function PrivacyFlowDiagram() {
  return (
    <div
      className="panel overflow-hidden p-5 sm:p-6"
      aria-label="Schéma : le modèle reste côté serveur, seuls des tenseurs partent vers les GPU."
    >
      <ol className="space-y-0">
        <li className="flex gap-4 border-b border-border pb-5">
          <span className="font-mono text-xs font-semibold tabular-nums text-muted">01</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">Orchestration centralisée</p>
            <p className="mt-1 text-xs leading-relaxed text-muted sm:text-sm">
              Modèle et contexte sensibles restent sous contrôle Vryx.
            </p>
          </div>
        </li>
        <li className="flex gap-4 border-b border-border py-5">
          <span className="font-mono text-xs font-semibold tabular-nums text-muted">02</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">Opérations dérivées</p>
            <p className="mt-1 text-xs leading-relaxed text-muted sm:text-sm">
              Seuls des blocs mathématiques autorisés sont distribués sur le réseau.
            </p>
          </div>
        </li>
        <li className="flex gap-4 pt-5">
          <span className="font-mono text-xs font-semibold tabular-nums text-muted">03</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">GPU communautaire</p>
            <p className="mt-1 text-xs leading-relaxed text-muted sm:text-sm">
              Calcul éphémère, sans persistance des entrées utilisateur sur le poste du worker.
            </p>
          </div>
        </li>
      </ol>
    </div>
  )
}

export function PrivacySection() {
  const copy = STORYTELLING.privacySection

  return (
    <section
      id="privacy"
      className="border-t border-border bg-surface py-20 sm:py-28"
      aria-labelledby="privacy-heading"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{copy.eyebrow}</p>
          <h2
            id="privacy-heading"
            className="font-display mt-4 text-3xl font-bold tracking-tight text-fg sm:text-4xl lg:text-[2.75rem] lg:leading-tight"
          >
            {copy.title}
          </h2>
          <p className="mt-2 font-mono text-[11px] font-medium uppercase tracking-wider text-muted sm:text-xs">
            {copy.titleEn}
          </p>
          <p className="mt-6 text-base leading-relaxed text-muted sm:text-lg">{copy.intro}</p>
        </div>

        <div className="mt-14 grid gap-8 lg:mt-16 lg:grid-cols-12 lg:gap-10 lg:items-start">
          <motion.div
            className="lg:col-span-5"
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            <PrivacyFlowDiagram />
            <div className="mt-6 flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3.5 sm:px-5">
              <IconShield className="mt-0.5 h-5 w-5 shrink-0 text-electric" aria-hidden />
              <p className="text-sm leading-relaxed text-muted">{copy.footnote}</p>
            </div>
          </motion.div>

          <div className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2 lg:col-span-7">
            {cards.map((c, i) => (
              <motion.article
                key={c.title}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-40px' }}
                transition={{ delay: i * 0.05, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className={`bg-card p-6 sm:p-7 ${i === 2 ? 'md:col-span-2' : ''}`}
              >
                <div className="flex gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-bg text-fg">
                    <c.Icon className="h-5 w-5" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-display text-base font-semibold text-fg sm:text-lg">{c.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted sm:text-[15px]">{c.body}</p>
                  </div>
                </div>
              </motion.article>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
