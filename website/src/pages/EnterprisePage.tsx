import { type FormEvent, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiJson } from '../lib/api'

type Offer = 'api' | 'private_pool' | 'knowledge_ai' | 'custom_ai'
type Privacy = 'standard' | 'eu_only' | 'private_pool' | 'no_retention'

type QuoteResult = {
  ok: true
  id: string
  status: string
  estimate: {
    monthlyEstimateEur: number
    setupEstimateEur: number
    unitTokenCostEurPerMillion: number
  }
}

const offerLabels: Record<Offer, string> = {
  api: 'Vryx API',
  private_pool: 'Private Pool',
  knowledge_ai: 'Knowledge AI',
  custom_ai: 'Custom AI',
}

const privacyLabels: Record<Privacy, string> = {
  standard: 'Standard',
  eu_only: 'Europe uniquement',
  private_pool: 'Pool privé',
  no_retention: 'Sans rétention',
}

const offerCopy: Record<Offer, string> = {
  api: 'Crédits API, clés, usage et facturation en euros.',
  private_pool: 'Capacité réservée, modèle choisi, SLA et traces dédiées.',
  knowledge_ai: 'RAG sécurisé sur base documentaire, avec mode sans rétention possible.',
  custom_ai: 'Dataset, LoRA/fine-tuning, évaluation et déploiement inference.',
}

function money(value: number, digits = 0) {
  return Number(value || 0).toLocaleString('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })
}

function estimateLocal({
  offer,
  monthlyTokens,
  privacyLevel,
  dedicatedWorkers,
  fineTuning,
}: {
  offer: Offer
  monthlyTokens: number
  privacyLevel: Privacy
  dedicatedWorkers: number
  fineTuning: boolean
}) {
  const usageBase = (Math.max(1_000_000, monthlyTokens) / 1_000_000) * 0.3
  const offerMultiplier = offer === 'private_pool' ? 5 : offer === 'knowledge_ai' ? 3.5 : offer === 'custom_ai' ? 7 : 1.8
  const privacyMultiplier = privacyLevel === 'no_retention' ? 1.45 : privacyLevel === 'private_pool' ? 1.65 : privacyLevel === 'eu_only' ? 1.2 : 1
  const monthlyMin = offer === 'api' ? 250 : offer === 'knowledge_ai' ? 1500 : offer === 'private_pool' ? 3500 : 6000
  const monthly = Math.max(monthlyMin, usageBase * offerMultiplier * privacyMultiplier + dedicatedWorkers * 950)
  const setup = offer === 'api' ? 0 : 2500 + (fineTuning ? 4500 : 0)
  return { monthly, setup }
}

export function EnterprisePage() {
  const [company, setCompany] = useState('')
  const [email, setEmail] = useState('')
  const [offer, setOffer] = useState<Offer>('private_pool')
  const [monthlyTokens, setMonthlyTokens] = useState(250_000_000)
  const [latencyTargetMs, setLatencyTargetMs] = useState(2500)
  const [privacyLevel, setPrivacyLevel] = useState<Privacy>('eu_only')
  const [fineTuning, setFineTuning] = useState(false)
  const [dedicatedWorkers, setDedicatedWorkers] = useState(2)
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<QuoteResult | null>(null)

  const estimate = useMemo(
    () => estimateLocal({ offer, monthlyTokens, privacyLevel, dedicatedWorkers, fineTuning }),
    [dedicatedWorkers, fineTuning, monthlyTokens, offer, privacyLevel],
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    setResult(null)
    const response = await apiJson<QuoteResult>('/api/enterprise/quote', {
      method: 'POST',
      body: JSON.stringify({
        company,
        email,
        offer,
        monthlyTokens,
        latencyTargetMs,
        privacyLevel,
        fineTuning,
        dedicatedWorkers,
        notes,
      }),
    })
    setLoading(false)
    if (!response.ok) {
      setError(response.error)
      return
    }
    setResult(response.data)
  }

  return (
    <main className="bg-bg text-fg">
      <section className="page-hero bg-[#08111f] text-white">
        <img
          src="/assets/vryx-enterprise-hero.webp"
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-center opacity-82"
          decoding="async"
          fetchPriority="high"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(3,7,18,.96),rgba(3,7,18,.80)_44%,rgba(3,7,18,.32))]" aria-hidden />
        <div className="relative mx-auto grid min-h-[inherit] max-w-6xl items-center px-4 py-16 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase text-emerald-100/75">Enterprise AI infrastructure</p>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.02] text-white sm:text-5xl lg:text-6xl">
              Vryx Enterprise
            </h1>
            <p className="mt-5 text-base leading-8 text-white/74 sm:text-lg">
              API, pool privé, Knowledge AI et projets custom sur une infrastructure IA distribuée, mesurée et
              facturable en euros. Le réseau est prêt pour les pilotes B2B: sécurité, traces, credits, webhooks et
              readiness score.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#quote" className="rounded-lg bg-white px-5 py-3 text-sm font-semibold text-slate-950 hover:bg-white/90">
                Configurer une offre
              </a>
              <Link to="/network" className="rounded-lg border border-white/25 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/15">
                Voir les preuves live
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-border bg-card py-10">
        <div className="mx-auto grid max-w-6xl gap-3 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-8">
          {[
            ['Readiness', 'Candidat production'],
            ['Facturation', 'Crédits et ledger vérifiés'],
            ['Sécurité', 'Routes séparées'],
            ['Réseau', 'Bench multi-worker'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-bg p-4">
              <p className="text-xs font-semibold uppercase text-muted">{label}</p>
              <p className="mt-2 text-lg font-semibold">{value}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="quote" className="mx-auto grid max-w-6xl gap-6 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:px-8">
        <form onSubmit={submit} className="rounded-lg border border-border bg-card p-5 shadow-sm">
          <div className="mb-6">
            <p className="text-xs font-semibold uppercase text-accent">Configurateur B2B</p>
            <h2 className="mt-2 font-display text-3xl font-semibold">Transformer un besoin en devis.</h2>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Entreprise</span>
              <input value={company} onChange={(event) => setCompany(event.target.value)} className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent" required />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Email</span>
              <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent" required />
            </label>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {(Object.keys(offerLabels) as Offer[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setOffer(item)}
                className={`rounded-lg border p-4 text-left transition ${offer === item ? 'border-accent bg-accent/10' : 'border-border bg-surface hover:border-accent/40'}`}
              >
                <span className="block font-semibold text-fg">{offerLabels[item]}</span>
                <span className="mt-1 block text-xs leading-5 text-muted">{offerCopy[item]}</span>
              </button>
            ))}
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Tokens/mois</span>
              <input value={monthlyTokens} onChange={(event) => setMonthlyTokens(Number(event.target.value))} type="number" min={1_000_000} step={1_000_000} className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Latence cible ms</span>
              <input value={latencyTargetMs} onChange={(event) => setLatencyTargetMs(Number(event.target.value))} type="number" min={250} step={250} className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Workers dédiés</span>
              <input value={dedicatedWorkers} onChange={(event) => setDedicatedWorkers(Number(event.target.value))} type="number" min={0} max={128} className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent" />
            </label>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Confidentialité</span>
              <select value={privacyLevel} onChange={(event) => setPrivacyLevel(event.target.value as Privacy)} className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent">
                {(Object.keys(privacyLabels) as Privacy[]).map((item) => <option key={item} value={item}>{privacyLabels[item]}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm font-semibold text-fg">
              <input type="checkbox" checked={fineTuning} onChange={(event) => setFineTuning(event.target.checked)} className="h-4 w-4 accent-current" />
              LoRA / fine-tuning
            </label>
          </div>

          <label className="mt-5 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Contexte</span>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={5} className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent" placeholder="Cas d’usage, contraintes, modèle souhaité, données, calendrier." />
          </label>

          {error ? <p className="mt-4 rounded-lg border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">{error}</p> : null}
          {result ? (
            <p className="mt-4 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
              Demande #{result.id} enregistrée. Estimation serveur: {money(result.estimate.monthlyEstimateEur)} / mois.
            </p>
          ) : null}

          <button type="submit" disabled={loading} className="mt-5 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-on-accent hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50">
            {loading ? 'Enregistrement...' : 'Demander une offre'}
          </button>
        </form>

        <aside className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Estimation</p>
            <p className="mt-3 font-display text-4xl font-semibold text-fg">{money(estimate.monthly)}</p>
            <p className="mt-1 text-sm text-muted">par mois, setup {money(estimate.setup)}</p>
            <div className="mt-5 space-y-2 text-sm">
              <div className="flex justify-between gap-4"><span className="text-muted">Offre</span><span className="font-semibold text-fg">{offerLabels[offer]}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Confidentialité</span><span className="font-semibold text-fg">{privacyLabels[privacyLevel]}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Tokens</span><span className="font-mono text-fg">{monthlyTokens.toLocaleString('fr-FR')}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Workers</span><span className="font-mono text-fg">{dedicatedWorkers}</span></div>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
            <p className="font-semibold text-fg">Inclut</p>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-muted">
              <li>SLA et capacité réservée selon offre.</li>
              <li>Logs, usage, coûts et facturation API.</li>
              <li>Mode no-retention possible.</li>
              <li>Support architecture et sécurité.</li>
            </ul>
          </div>
        </aside>
      </section>
    </main>
  )
}
