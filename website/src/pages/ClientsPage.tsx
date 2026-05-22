import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ClientPythonSnippet } from '../components/clients/ClientPythonSnippet'
import { EurSign } from '../components/icons/Icons'
import { CLIENT_ENDPOINTS, CLIENT_FAQ } from '../data/clientsContent'
import { useAuth } from '../context/AuthContext'
import { fetchPublicPricing } from '../lib/pricingModels'

const highlights = [
  {
    title: 'SDK déjà installé',
    text: 'OpenAI, LangChain, LiteLLM : changez uniquement la base URL et la clé.',
  },
  {
    title: 'Paiement en euros',
    text: 'Recharge par carte bancaire, factures en euros, conformes à votre comptabilité.',
  },
  {
    title: 'Sécurité transport',
    text: 'TLS 1.2+, clés révocables par environnement, journaux d’audit exportables.',
  },
]

export function ClientsPage() {
  const { user } = useAuth()
  const [minInput, setMinInput] = useState<number | null>(0.02)
  const [minOutput, setMinOutput] = useState<number | null>(0.06)
  const [pricingPublished, setPricingPublished] = useState(false)
  const [subscriptionPlans, setSubscriptionPlans] = useState<{ name: string; monthlyEur: number }[]>([])
  useEffect(() => {
    let cancelled = false
    fetchPublicPricing().then((r) => {
      if (cancelled) return
      if (r.ok) {
        setMinInput(r.data.pricing.minInputEurPerMillion ?? r.data.pricing.headline?.minInputEurPerMillion ?? null)
        setMinOutput(r.data.pricing.minOutputEurPerMillion ?? r.data.pricing.headline?.minOutputEurPerMillion ?? null)
        setPricingPublished(r.data.pricing.published)
        setSubscriptionPlans(
          (r.data.pricing.subscriptionPlans || [])
            .filter((p) => p.isPublic && p.monthlyEur > 0)
            .map((p) => ({ name: p.name, monthlyEur: p.monthlyEur })),
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="border-b border-border bg-bg">
      <section
        className="relative isolate -mt-[4.25rem] flex min-h-[min(88vh,40rem)] flex-col overflow-hidden border-b border-border pt-[4.25rem] sm:min-h-[min(90vh,44rem)]"
        aria-labelledby="clients-hero-heading"
      >
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))] overflow-hidden"
          aria-hidden
        >
          <div
            className="absolute inset-0 scale-105 bg-cover bg-center bg-no-repeat blur-[3px]"
            style={{ backgroundImage: "url('/ClientsHero.png')" }}
          />
        </div>
        <div
          className="hero-overlay absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))]"
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
              id="clients-hero-heading"
              className="font-display text-balance text-3xl font-semibold leading-tight tracking-tight text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.45)] sm:text-4xl md:text-[2.35rem]"
            >
              Jusqu’à cinq fois moins cher au token
            </h1>
            <p className="mt-4 max-w-xl text-pretty text-base leading-snug text-white/88 sm:mt-5 sm:text-lg">
              Même SDK OpenAI&nbsp;: nouvelle URL, nouvelle clé.
            </p>
            <Link
              to="/simulateur"
              className="mt-8 inline-flex min-h-11 w-full max-w-xs items-center justify-center rounded-xl border border-transparent bg-white px-6 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-white/90 dark:border-white/20 dark:bg-card/95 dark:text-fg dark:backdrop-blur-md dark:hover:bg-card sm:mt-9 sm:w-auto sm:px-8 sm:text-base"
            >
              Simuler vos coûts
            </Link>
          </motion.div>
        </div>
      </section>

      <div className="border-b border-border bg-bg">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8 lg:py-20">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-start lg:gap-14">
            <motion.div
              initial={{ opacity: 0, x: -8 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              className="space-y-5 text-sm text-muted sm:text-base"
            >
              <h2 className="font-display text-xl font-semibold text-fg sm:text-2xl">
                Démarrage en trois minutes
              </h2>
              <div className="panel-inset rounded-2xl p-4 sm:p-5">
                <p className="text-sm leading-relaxed text-muted sm:text-base">
                  Créez une organisation, générez une clé API dans votre espace compte, puis pointez votre SDK
                  vers <span className="font-mono text-fg">https://api.vryx-ai.eu/v1</span>.
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted sm:text-base">
                  Les modèles exposés suivent la convention Vryx (préfixe{' '}
                  <span className="font-mono text-accent">vryx-</span>) ; la liste à jour est disponible depuis
                  l’endpoint <span className="font-mono text-fg">GET /v1/models</span> et dans le panel
                  modèles une fois connecté.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-card px-4 py-3">
                  <p className="font-mono text-[0.68rem] uppercase tracking-wide text-muted">Facturation</p>
                  <p className="mt-1 text-sm text-fg">
                    Recharge minimum 20
                    <EurSign className="inline text-fg" />, usage décrémenté au fil des requêtes.
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card px-4 py-3">
                  <p className="font-mono text-[0.68rem] uppercase tracking-wide text-muted">Clés API</p>
                  <p className="mt-1 text-sm text-fg">Clés séparables prod / préprod ; révocation immédiate.</p>
                </div>
              </div>
            </motion.div>
            <ClientPythonSnippet />
          </div>

          <motion.ul
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mt-14 grid gap-5 sm:grid-cols-3"
          >
            {highlights.map((h) => (
              <li key={h.title} className="panel p-5 sm:p-6">
                <h3 className="font-display text-lg font-semibold text-fg">{h.title}</h3>
                <p className="mt-3 text-sm text-muted">{h.text}</p>
              </li>
            ))}
          </motion.ul>
        </div>
      </div>

      <section
        className="relative isolate overflow-hidden border-b border-border py-14 sm:py-20"
        aria-labelledby="tarifs-clients"
      >
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/mid.png')" }}
          aria-hidden
        />
        <div className="hero-overlay absolute inset-0" aria-hidden />
        <div className="relative z-10 mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 id="tarifs-clients" className="font-display text-2xl font-bold text-white sm:text-3xl">
                {pricingPublished ? 'Tarif public' : 'Tarifs sur devis'}
              </h2>
              <p className="mt-3 text-sm text-white/75 sm:text-base">
                Tarifs à partir de {minInput?.toFixed(2) ?? '0,02'} €/M input et {minOutput?.toFixed(2) ?? '0,06'} €/M output.
                Prix par modèle, selon disponibilité réseau.
              </p>
              {pricingPublished && minInput != null && minOutput != null ? (
                <div className="mt-8 space-y-2">
                  <p className="font-display text-3xl font-bold text-white sm:text-4xl">
                    {minInput.toFixed(2)} €<span className="text-lg font-medium text-white/65"> / M input</span>
                  </p>
                  <p className="font-display text-2xl font-bold text-white sm:text-3xl">
                    {minOutput.toFixed(2)} €<span className="text-lg font-medium text-white/65"> / M output</span>
                  </p>
                  <p className="text-sm text-white/70">Exemple : Qwen3.5 9B — 0,06 €/M input, 0,12 €/M output.</p>
                </div>
              ) : (
                <p className="mt-8 rounded-2xl border border-white/15 bg-black/35 px-5 py-4 text-sm leading-relaxed text-white/80">
                  Les prix publics sont en cours de calibration. L’admin Vryx peut les publier dès que la grille est validée.
                </p>
              )}
              <Link
                to="/simulateur"
                className="mt-8 inline-flex text-sm font-semibold text-sky-300 underline-offset-2 transition-colors hover:text-sky-200 hover:underline"
              >
                Projeter vos millions de tokens dans le simulateur
              </Link>
              {subscriptionPlans.length > 0 ? (
                <div className="mt-8 rounded-2xl border border-white/15 bg-black/35 p-4 sm:p-5">
                  <p className="font-mono text-[0.68rem] uppercase tracking-wide text-white/55">Plans B2B</p>
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {subscriptionPlans.map((plan) => (
                      <li key={plan.name} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85">
                        <span>{plan.name}</span>
                        <span className="font-mono font-semibold">{plan.monthlyEur.toLocaleString('fr-FR')} €/mois</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/15 bg-black/40 backdrop-blur-md shadow-lg">
              <table className="w-full min-w-[20rem] text-left text-sm">
                <caption className="border-b border-white/10 px-4 py-3 text-left text-xs font-medium text-white/55">
                  Endpoints REST courants
                </caption>
                <thead>
                  <tr className="border-b border-white/10 bg-white/[0.06] text-xs font-semibold uppercase tracking-wide text-white/55">
                    <th className="px-4 py-3 pl-5">Méthode</th>
                    <th className="px-4 py-3">Chemin</th>
                    <th className="px-4 py-3 pr-5">Rôle</th>
                  </tr>
                </thead>
                <tbody>
                  {CLIENT_ENDPOINTS.map((row) => (
                    <tr key={row.path} className="border-b border-white/10 last:border-0">
                      <td className="px-4 py-3 pl-5 font-mono text-xs text-sky-300">{row.method}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white">{row.path}</td>
                      <td className="px-4 py-3 pr-5 text-white/65">{row.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-bg py-14 sm:py-20" aria-labelledby="faq-clients">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <h2 id="faq-clients" className="font-display text-2xl font-bold text-fg sm:text-3xl">
            Questions fréquentes
          </h2>
          <div className="mt-8 space-y-3">
            {CLIENT_FAQ.map((item) => (
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

      <section className="border-t border-border bg-surface py-14 sm:py-16" aria-labelledby="cta-clients">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 id="cta-clients" className="font-display text-xl font-bold text-fg sm:text-2xl">
            Prêt à brancher votre produit ?
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-muted">
            {user
              ? 'Ouvrez votre compte pour gérer vos clés API, ou consultez le comparatif workers pour comprendre le pool derrière la latence.'
              : 'Créez un compte pour obtenir des clés API, ou ouvrez le comparatif workers pour comprendre le pool derrière la latence.'}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to={user ? '/compte' : '/inscription'} className="btn-primary rounded-xl px-8 py-3 text-sm font-semibold sm:text-base">
              {user ? 'Mon compte' : 'Créer un compte'}
            </Link>
            <Link to="/comparatif" className="btn-secondary rounded-xl px-8 py-3 text-sm font-semibold sm:text-base">
              Gains solo / pool
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
