import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'

const currentPath = [
  {
    title: 'API et réservation',
    body: 'La requête arrive par l’API Vryx. Le service vérifie le compte, le modèle et les crédits, puis réserve les workers compatibles selon leur disponibilité, leur mémoire et leur état de charge.',
  },
  {
    title: 'Construction du chemin',
    body: 'Le réseau choisit le meilleur chemin d’exécution selon la disponibilité réelle, les liaisons directes possibles et les contraintes du run en cours.',
  },
  {
    title: 'Pipeline distribué',
    body: 'Pour les modèles distribués, le calcul est réparti entre plusieurs workers. Chaque étape exécute sa part puis transmet le résultat au segment suivant.',
  },
  {
    title: 'Mesure et preuve',
    body: 'Chaque run produit une trace : workers utilisés, tokens, latence, débit, erreurs et coût estimé. Ces données alimentent ensuite les métriques publiques et les benchmarks.',
  },
] as const

const truthCards = [
  {
    title: 'Ce qui tourne vraiment aujourd’hui',
    body: 'Le chemin public valide repose sur une orchestration distribuée : les workers sont déclarés, sélectionnés puis coordonnés dans un pipeline mesurable.',
  },
  {
    title: 'Ce qui est optionnel',
    body: 'La course pure, ou duplication d’un même bloc entre plusieurs workers, reste une stratégie possible sur certains cas critiques. Ce n’est pas le chemin unique de production.',
  },
  {
    title: 'Ce qui est mesurable',
    body: 'Les preuves existent : benchmarks, affectation des workers, score de readiness, tokens, latence, débit et stabilité sur une fenêtre propre.',
  },
] as const

const requirements = [
  'Accès internes protégés et séparés des routes publiques',
  'Authentification worker obligatoire en production',
  'Routes publiques expurgées pour masquer les identifiants et détails sensibles',
  'Readiness score calculé sur une fenêtre propre et archivable',
  'Audit de dépendances et contrôles de sécurité suivis dans la durée',
] as const

export function RacePoolPage() {
  return (
    <div className="bg-bg text-fg">
      <section className="page-hero bg-[#07111f] text-white">
        <div
          className="absolute inset-0 opacity-45"
          style={{ backgroundImage: "url('/heroes/race-pool-hero.webp')", backgroundPosition: 'center', backgroundSize: 'cover' }}
          aria-hidden
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(4,12,24,.94),rgba(4,12,24,.78)_42%,rgba(4,12,24,.42))]" aria-hidden />
        <div className="relative mx-auto grid min-h-[inherit] max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.05fr_.95fr] lg:px-8">
          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}>
            <p className="text-xs font-semibold uppercase text-cyan-100/75">Architecture réseau actuelle</p>
            <h1 className="mt-5 max-w-3xl font-display text-4xl font-semibold leading-[1.02] text-white sm:text-5xl lg:text-6xl">
              Comment Vryx orchestre vraiment un pool de workers IA.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-8 text-white/72 sm:text-lg">
              Race Pool n’est pas une promesse abstraite : c’est la couche d’orchestration qui sélectionne, réserve,
              connecte et mesure des workers distribués. Le chemin stable actuel repose sur un pipeline distribué,
              avec adaptation automatique selon la connectivité disponible.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/network" className="rounded-lg bg-white px-5 py-3 text-sm font-semibold text-slate-950 hover:bg-white/90">
                Voir le réseau live
              </Link>
              <Link to="/enterprise" className="rounded-lg border border-white/25 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/15">
                Offres B2B
              </Link>
            </div>
          </motion.div>

            <div className="rounded-lg border border-white/14 bg-white/8 p-4 backdrop-blur-xl">
            <div className="grid gap-3">
              {['Client API', 'Contrôle d’accès', 'Réservation', 'Coordination', 'Workers actifs'].map((label, index) => (
                <div key={label} className="flex items-center gap-3 rounded-lg border border-white/10 bg-black/20 px-4 py-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-200 text-xs font-bold text-slate-950">
                    {index + 1}
                  </span>
                  <span className="text-sm font-semibold text-white">{label}</span>
                  <span className="ml-auto h-2 w-16 rounded-full bg-gradient-to-r from-cyan-200 to-emerald-200" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-border bg-card py-14 sm:py-18">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase text-accent">Mise à jour produit</p>
            <h2 className="mt-3 font-display text-3xl font-semibold sm:text-4xl">Race Pool, sans folklore.</h2>
            <p className="mt-4 text-base leading-8 text-muted">
              La page a été réécrite pour refléter l’infrastructure actuelle : un réseau distribué, des workers
              déclarés, une orchestration de réservation et un pipeline qui produit des preuves exploitables.
            </p>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {truthCards.map((card) => (
              <article key={card.title} className="rounded-lg border border-border bg-bg p-5">
                <h3 className="text-lg font-semibold">{card.title}</h3>
                <p className="mt-3 text-sm leading-7 text-muted">{card.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-border bg-bg py-14 sm:py-18">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[.8fr_1.2fr]">
            <div>
              <p className="text-xs font-semibold uppercase text-accent">Chemin d’une requête</p>
              <h2 className="mt-3 font-display text-3xl font-semibold sm:text-4xl">Du prompt à la preuve.</h2>
              <p className="mt-4 text-sm leading-7 text-muted">
                Le but n’est plus de vendre une fonction spectaculaire : le but est de montrer un chemin stable,
                auditable, facturable et répétable.
              </p>
            </div>
            <ol className="grid list-none gap-4 p-0 md:grid-cols-2">
              {currentPath.map((step, index) => (
                <li key={step.title} className="rounded-lg border border-border bg-card p-5">
                  <p className="font-mono text-xs font-semibold text-accent">{String(index + 1).padStart(2, '0')}</p>
                  <h3 className="mt-3 text-lg font-semibold">{step.title}</h3>
                  <p className="mt-2 text-sm leading-7 text-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="border-b border-border bg-card py-14 sm:py-18">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[1fr_.9fr] lg:items-start">
            <div>
              <p className="text-xs font-semibold uppercase text-accent">Exigences de production</p>
              <h2 className="mt-3 font-display text-3xl font-semibold sm:text-4xl">Ce qui rend le pool défendable.</h2>
              <p className="mt-4 text-base leading-8 text-muted">
                Vryx doit être jugé comme une infrastructure B2B : accès protégés, traces propres, facturation,
                observabilité et contrôles continus. Les briques utiles sont maintenant visibles dans le produit.
              </p>
            </div>
            <ul className="grid gap-3">
              {requirements.map((item) => (
                <li key={item} className="rounded-lg border border-border bg-bg px-4 py-3 text-sm font-medium">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  )
}
