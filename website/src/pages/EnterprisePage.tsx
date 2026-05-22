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
  eu_only: 'EU only',
  private_pool: 'Pool privé',
  no_retention: 'No retention',
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
    <main className="bg-bg">
      <section className="border-b border-border bg-surface/50 px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Enterprise</p>
          <h1 className="mt-2 font-display text-4xl font-bold text-fg sm:text-5xl">Configurer une offre Vryx B2B.</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-muted">
            API self-serve, pool privé, IA documentaire ou projet custom. Le formulaire produit une première estimation exploitable par l’équipe commerciale.
          </p>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:px-8">
        <form onSubmit={submit} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
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
                className={`rounded-xl border p-4 text-left transition ${offer === item ? 'border-accent bg-accent/10' : 'border-border bg-surface hover:border-accent/40'}`}
              >
                <span className="block font-semibold text-fg">{offerLabels[item]}</span>
                <span className="mt-1 block text-xs text-muted">
                  {item === 'api' ? 'Crédits API et usage développeur.' : item === 'private_pool' ? 'Capacité dédiée, SLA, workers réservés.' : item === 'knowledge_ai' ? 'RAG sécurisé sur documents métier.' : 'Accompagnement modèle, dataset, déploiement.'}
                </span>
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
            <label className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm font-semibold text-fg">
              <input type="checkbox" checked={fineTuning} onChange={(event) => setFineTuning(event.target.checked)} className="h-4 w-4 accent-current" />
              Fine-tuning / LoRA
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

          <button type="submit" disabled={loading} className="mt-5 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50">
            {loading ? 'Enregistrement...' : 'Demander une offre'}
          </button>
        </form>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Estimation</p>
            <p className="mt-3 font-display text-4xl font-bold text-fg">{money(estimate.monthly)}</p>
            <p className="mt-1 text-sm text-muted">par mois, setup {money(estimate.setup)}</p>
            <div className="mt-5 space-y-2 text-sm">
              <div className="flex justify-between gap-4"><span className="text-muted">Offre</span><span className="font-semibold text-fg">{offerLabels[offer]}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Confidentialité</span><span className="font-semibold text-fg">{privacyLabels[privacyLevel]}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Tokens</span><span className="font-mono text-fg">{monthlyTokens.toLocaleString('fr-FR')}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Workers</span><span className="font-mono text-fg">{dedicatedWorkers}</span></div>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="font-semibold text-fg">Inclut</p>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li>SLA et capacité réservée selon offre.</li>
              <li>Logs, usage, coûts et facturation API.</li>
              <li>Mode no-retention possible.</li>
              <li>Support architecture et sécurité.</li>
            </ul>
          </div>
          <Link to="/network" className="block rounded-2xl border border-border bg-surface p-5 text-sm font-semibold text-fg hover:border-accent/40">
            Voir le réseau live public
          </Link>
        </aside>
      </section>
    </main>
  )
}
