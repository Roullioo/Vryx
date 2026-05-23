import { useEffect, useState } from 'react'
import { AdminShell } from '../components/admin/AdminShell'
import { apiJson } from '../lib/api'

type EnterpriseQuote = {
  id: string
  company: string
  email: string
  offer: string
  monthlyTokens: number
  latencyTargetMs: number
  privacyLevel: string
  fineTuning: boolean
  dedicatedWorkers: number
  monthlyEstimateEur: number
  setupEstimateEur: number
  status: string
  commercialStage: string
  pilotAmountEur: number | null
  expectedCloseDate: string | null
  nextStep: string
  signedDocumentUrl: string
  notes: string
  createdAt: string | null
  updatedAt?: string | null
  updatedByEmail?: string | null
  updatedByUserId?: string | number | null
  quote?: {
    input?: {
      projectName?: string
      modelChoice?: string
      slaTier?: string
      datasetGb?: number
    }
  }
}

type EnterpriseProject = {
  id: string
  quoteId: string | null
  company: string
  email: string
  name: string
  offer: string
  modelChoice: string
  slaTier: string
  privacyLevel: string
  datasetGb: number
  fineTuning: boolean
  dedicatedWorkers: number
  monthlyEstimateEur: number
  setupEstimateEur: number
  status: string
  updatedAt: string | null
}

const statusLabels: Record<string, string> = {
  new: 'Nouveau',
  contacted: 'Contacté',
  loi_requested: 'LOI demandée',
  loi_received: 'LOI reçue',
  paid_pilot: 'Pilote payant',
  won: 'Gagné',
  lost: 'Perdu',
}

const stageLabels: Record<string, string> = {
  prospect: 'Prospect',
  letter_of_interest: "Lettre d'intérêt",
  paid_pilot: 'Pilote payant',
  pilot_running: 'Pilote en cours',
  customer: 'Client',
  lost: 'Perdu',
}

function money(value: number) {
  return Number(value || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

function compact(value: number) {
  return Number(value || 0).toLocaleString('fr-FR', { notation: Math.abs(value) >= 100_000 ? 'compact' : 'standard' })
}

function dateTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

export function AdminEnterpriseQuotesPage() {
  const [quotes, setQuotes] = useState<EnterpriseQuote[]>([])
  const [projects, setProjects] = useState<EnterpriseProject[]>([])
  const [editing, setEditing] = useState<EnterpriseQuote | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [r, p] = await Promise.all([
        apiJson<{ ok: true; quotes: EnterpriseQuote[] }>('/api/admin/enterprise/quotes'),
        apiJson<{ ok: true; projects: EnterpriseProject[] }>('/api/admin/enterprise/projects'),
      ])
      if (cancelled) return
      if (r.ok) {
        setQuotes(r.data.quotes)
        setError('')
      } else {
        setError(r.error)
      }
      if (p.ok) setProjects(p.data.projects)
    }
    void load()
    const id = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const pipelineValue = quotes.reduce((sum, quote) => sum + quote.monthlyEstimateEur, 0)
  const newQuotes = quotes.filter((quote) => quote.status === 'new').length
  const interestCount = quotes.filter((quote) => quote.commercialStage === 'letter_of_interest' || quote.status === 'loi_received').length
  const paidPilots = quotes.filter((quote) => quote.commercialStage === 'paid_pilot' || quote.commercialStage === 'pilot_running' || quote.status === 'paid_pilot')
  const paidPilotValue = paidPilots.reduce((sum, quote) => sum + Number(quote.pilotAmountEur || 0), 0)

  async function saveQuote() {
    if (!editing) return
    setSaving(true)
    setError('')
    const r = await apiJson<{ ok: true }>(`/api/admin/enterprise/quotes/${encodeURIComponent(editing.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: editing.status,
        commercialStage: editing.commercialStage,
        pilotAmountEur: editing.pilotAmountEur,
        expectedCloseDate: editing.expectedCloseDate,
        nextStep: editing.nextStep,
        signedDocumentUrl: editing.signedDocumentUrl,
        notes: editing.notes,
      }),
    })
    setSaving(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setQuotes((rows) => rows.map((row) => (row.id === editing.id ? editing : row)))
    setEditing(null)
  }

  async function createProject(quote: EnterpriseQuote) {
    setSaving(true)
    setError('')
    const r = await apiJson<{ ok: true; projectId: string }>(`/api/admin/enterprise/quotes/${encodeURIComponent(quote.id)}/project`, {
      method: 'POST',
      body: JSON.stringify({
        name: quote.quote?.input?.projectName || `${quote.company} ${quote.offer}`,
        status: quote.pilotAmountEur ? 'build' : 'scoping',
      }),
    })
    setSaving(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    const p = await apiJson<{ ok: true; projects: EnterpriseProject[] }>('/api/admin/enterprise/projects')
    if (p.ok) setProjects(p.data.projects)
    setQuotes((rows) => rows.map((row) => (row.id === quote.id ? { ...row, commercialStage: 'pilot_running' } : row)))
  }

  return (
    <AdminShell title="Enterprise" subtitle="Demandes commerciales B2B et pipeline estimé">
      {error ? <div className="mb-5 rounded-xl border border-alert/40 bg-alert/8 px-4 py-3 text-sm text-alert">{error}</div> : null}
      <div className="space-y-5">
        <section className="grid gap-3 sm:grid-cols-5">
          <div className="panel p-5"><p className="text-xs uppercase tracking-wide text-muted">Demandes</p><p className="mt-1 font-display text-2xl font-bold text-fg">{quotes.length}</p></div>
          <div className="panel p-5"><p className="text-xs uppercase tracking-wide text-muted">Nouvelles</p><p className="mt-1 font-display text-2xl font-bold text-electric">{newQuotes}</p></div>
          <div className="panel p-5"><p className="text-xs uppercase tracking-wide text-muted">Lettres d'intérêt</p><p className="mt-1 font-display text-2xl font-bold text-accent">{interestCount}</p></div>
          <div className="panel p-5"><p className="text-xs uppercase tracking-wide text-muted">Pilotes payants</p><p className="mt-1 font-display text-2xl font-bold text-success">{paidPilots.length}</p></div>
          <div className="panel p-5"><p className="text-xs uppercase tracking-wide text-muted">Pipeline mensuel</p><p className="mt-1 font-display text-2xl font-bold text-success">{money(pipelineValue)}</p></div>
        </section>
        <section className="grid gap-3 lg:grid-cols-3">
          <div className="panel p-5">
            <p className="text-xs uppercase tracking-wide text-muted">Projets clients</p>
            <p className="mt-1 font-display text-2xl font-bold text-fg">{projects.length}</p>
          </div>
          {projects.slice(0, 2).map((project) => (
            <div key={project.id} className="panel p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-fg">{project.name}</p>
                  <p className="mt-1 text-xs text-muted">{project.company} · {project.modelChoice || 'modèle à préciser'}</p>
                </div>
                <span className="rounded-md bg-success/10 px-2 py-1 text-xs font-semibold text-success">{project.status}</span>
              </div>
              <p className="mt-3 font-mono text-sm text-fg">{money(project.monthlyEstimateEur)} / mois · setup {money(project.setupEstimateEur)}</p>
            </div>
          ))}
        </section>
        <section className="panel p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-fg">Preuves commerciales investisseur</p>
              <p className="mt-1 text-xs text-muted">Objectif court terme : 2-3 lettres d'intérêt signées ou au moins un pilote payant traçable.</p>
            </div>
            <p className="font-mono text-sm font-semibold text-success">{money(paidPilotValue)} de pilotes</p>
          </div>
        </section>

        <section className="overflow-x-auto panel">
          <table className="w-full min-w-[64rem] text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Compte</th>
                <th className="px-4 py-3">Offre</th>
                <th className="px-4 py-3">Volume</th>
                <th className="px-4 py-3">Confidentialité</th>
                <th className="px-4 py-3">Preuve</th>
                <th className="px-4 py-3 text-right">Estimation</th>
                <th className="px-4 py-3">Créée</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {quotes.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-muted">Aucune demande Enterprise.</td></tr>
              ) : quotes.map((quote) => (
                <tr key={quote.id} className="border-b border-border/70 align-top hover:bg-surface/40">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-fg">{quote.company}</p>
                    <p className="text-xs text-muted">{quote.email}</p>
                    {quote.notes ? <p className="mt-2 max-w-md text-xs text-muted">{quote.notes}</p> : null}
                    {quote.quote?.input?.projectName ? <p className="mt-2 text-xs font-semibold text-fg">{quote.quote.input.projectName}</p> : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-accent/10 px-2 py-1 text-xs font-semibold text-accent">{quote.offer}</span>
                    <p className="mt-2 text-xs text-muted">{quote.dedicatedWorkers} worker(s) dédié(s) · {quote.fineTuning ? 'fine-tuning' : 'sans fine-tuning'}</p>
                    <p className="mt-1 max-w-48 truncate text-xs text-muted">{quote.quote?.input?.modelChoice || 'modèle à préciser'} · {quote.quote?.input?.slaTier || 'SLA standard'}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-fg">{compact(quote.monthlyTokens)} tokens/mois<br />{quote.latencyTargetMs} ms cible</td>
                  <td className="px-4 py-3 text-xs text-muted">{quote.privacyLevel}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-accent/10 px-2 py-1 text-xs font-semibold text-accent">{stageLabels[quote.commercialStage] || quote.commercialStage}</span>
                    <p className="mt-2 text-xs text-muted">{statusLabels[quote.status] || quote.status}</p>
                    {quote.pilotAmountEur ? <p className="mt-1 font-mono text-xs text-success">{money(quote.pilotAmountEur)} pilote</p> : null}
                    {quote.nextStep ? <p className="mt-1 max-w-xs text-xs text-muted">{quote.nextStep}</p> : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <p className="font-mono font-semibold text-fg">{money(quote.monthlyEstimateEur)} / mois</p>
                    <p className="text-xs text-muted">setup {money(quote.setupEstimateEur)}</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{dateTime(quote.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex flex-col items-end gap-2">
                      <button type="button" onClick={() => setEditing(quote)} className="rounded-xl border border-border px-3 py-2 text-xs font-semibold text-fg hover:bg-surface">
                        Qualifier
                      </button>
                      <button type="button" disabled={saving || projects.some((project) => project.quoteId === quote.id)} onClick={() => void createProject(quote)} className="rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-on-accent disabled:cursor-not-allowed disabled:opacity-45">
                        Créer projet
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      {editing ? (
        <div className="fixed inset-0 z-150 flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center">
          <div className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-border bg-card p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-fg">{editing.company}</h2>
                <p className="text-xs text-muted">{editing.email}</p>
              </div>
              <button type="button" onClick={() => setEditing(null)} className="rounded-xl border border-border px-3 py-2 text-sm text-fg">Fermer</button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-muted">Statut</span>
                <select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent">
                  {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Étape commerciale</span>
                <select value={editing.commercialStage} onChange={(e) => setEditing({ ...editing, commercialStage: e.target.value })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent">
                  {Object.entries(stageLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Montant pilote payant (€)</span>
                <input type="number" min="0" value={editing.pilotAmountEur ?? ''} onChange={(e) => setEditing({ ...editing, pilotAmountEur: e.target.value === '' ? null : Number(e.target.value) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Date cible</span>
                <input type="date" value={editing.expectedCloseDate ?? ''} onChange={(e) => setEditing({ ...editing, expectedCloseDate: e.target.value || null })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm sm:col-span-2">
                <span className="text-muted">Lien document signé</span>
                <input value={editing.signedDocumentUrl} onChange={(e) => setEditing({ ...editing, signedDocumentUrl: e.target.value })} placeholder="URL Drive/DocuSign/PDF signé" className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm sm:col-span-2">
                <span className="text-muted">Prochaine action</span>
                <input value={editing.nextStep} onChange={(e) => setEditing({ ...editing, nextStep: e.target.value })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm sm:col-span-2">
                <span className="text-muted">Notes</span>
                <textarea value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} rows={4} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(null)} className="rounded-xl border border-border px-4 py-2 text-sm text-fg">Annuler</button>
              <button type="button" disabled={saving} onClick={() => void saveQuote()} className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-50">
                {saving ? 'Sauvegarde…' : 'Sauvegarder'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AdminShell>
  )
}
