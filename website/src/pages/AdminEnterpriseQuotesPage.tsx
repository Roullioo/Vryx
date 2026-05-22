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
  notes: string
  createdAt: string | null
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
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      const r = await apiJson<{ ok: true; quotes: EnterpriseQuote[] }>('/api/admin/enterprise/quotes')
      if (cancelled) return
      if (r.ok) {
        setQuotes(r.data.quotes)
        setError('')
      } else {
        setError(r.error)
      }
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

  return (
    <AdminShell title="Enterprise" subtitle="Demandes commerciales B2B et pipeline estimé">
      {error ? <div className="mb-5 rounded-xl border border-alert/40 bg-alert/8 px-4 py-3 text-sm text-alert">{error}</div> : null}
      <div className="space-y-5">
        <section className="grid gap-3 sm:grid-cols-3">
          <div className="panel p-5"><p className="text-xs uppercase tracking-wide text-muted">Demandes</p><p className="mt-1 font-display text-2xl font-bold text-fg">{quotes.length}</p></div>
          <div className="panel p-5"><p className="text-xs uppercase tracking-wide text-muted">Nouvelles</p><p className="mt-1 font-display text-2xl font-bold text-electric">{newQuotes}</p></div>
          <div className="panel p-5"><p className="text-xs uppercase tracking-wide text-muted">Pipeline mensuel</p><p className="mt-1 font-display text-2xl font-bold text-success">{money(pipelineValue)}</p></div>
        </section>

        <section className="overflow-x-auto panel">
          <table className="w-full min-w-[64rem] text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Compte</th>
                <th className="px-4 py-3">Offre</th>
                <th className="px-4 py-3">Volume</th>
                <th className="px-4 py-3">Confidentialité</th>
                <th className="px-4 py-3 text-right">Estimation</th>
                <th className="px-4 py-3">Créée</th>
              </tr>
            </thead>
            <tbody>
              {quotes.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-muted">Aucune demande Enterprise.</td></tr>
              ) : quotes.map((quote) => (
                <tr key={quote.id} className="border-b border-border/70 align-top hover:bg-surface/40">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-fg">{quote.company}</p>
                    <p className="text-xs text-muted">{quote.email}</p>
                    {quote.notes ? <p className="mt-2 max-w-md text-xs text-muted">{quote.notes}</p> : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-accent/10 px-2 py-1 text-xs font-semibold text-accent">{quote.offer}</span>
                    <p className="mt-2 text-xs text-muted">{quote.dedicatedWorkers} worker(s) dédié(s) · {quote.fineTuning ? 'fine-tuning' : 'sans fine-tuning'}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-fg">{compact(quote.monthlyTokens)} tokens/mois<br />{quote.latencyTargetMs} ms cible</td>
                  <td className="px-4 py-3 text-xs text-muted">{quote.privacyLevel}</td>
                  <td className="px-4 py-3 text-right">
                    <p className="font-mono font-semibold text-fg">{money(quote.monthlyEstimateEur)} / mois</p>
                    <p className="text-xs text-muted">setup {money(quote.setupEstimateEur)}</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{dateTime(quote.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </AdminShell>
  )
}
