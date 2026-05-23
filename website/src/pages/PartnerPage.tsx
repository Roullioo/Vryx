import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { apiJson } from '../lib/api'

type AffiliatePartner = {
  id: string
  name: string
  code: string
  link: string
  status: string
  commissionPercent: number
  commissionMonths: number
  clientCapEur: number | null
  clients: number
  referredRevenueEur: number
  commissionEur: number
  rowsCount: number
  paidRows: number
  recent: Array<{
    customerAmountEur: number
    commissionEur: number
    status: string
    createdAt: string | null
  }>
}

type AffiliateResponse = {
  ok: true
  partner: AffiliatePartner | null
  defaults?: {
    commissionPercent: number
    commissionMonths: number
    clientCapEur: number
  }
}

function money(value: number) {
  return Number(value || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 })
}

function dateTime(value: string | null) {
  if (!value) return '-'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

export function PartnerPage() {
  const { user, loading } = useAuth()
  const [data, setData] = useState<AffiliateResponse | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  async function load() {
    const r = await apiJson<AffiliateResponse>('/api/account/affiliate')
    if (!r.ok) {
      setError(r.error)
      return
    }
    setData(r.data)
    setError('')
  }

  useEffect(() => {
    if (user) void load()
  }, [user])

  async function createPartner() {
    setCreating(true)
    const r = await apiJson<{ ok: true; code: string; link: string }>('/api/account/affiliate', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    setCreating(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    await load()
  }

  if (loading) return <main className="min-h-screen bg-bg pt-28 text-fg" />
  if (!user) return <Navigate to="/connexion" replace />

  const partner = data?.partner ?? null

  return (
    <main className="min-h-screen bg-bg px-4 py-24 text-fg sm:px-6 lg:px-8">
      <section className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Programme partenaire</p>
          <h1 className="mt-3 font-display text-4xl font-semibold">Affiliation Vryx</h1>
          <p className="mt-4 text-sm leading-7 text-muted">
            Par défaut : 10 % pendant 12 mois avec plafond par client. Les commissions lifetime sont réservées aux partenariats stratégiques signés.
          </p>
        </div>

        {error ? <div className="mt-6 rounded-lg border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">{error}</div> : null}

        {!partner ? (
          <div className="mt-8 rounded-lg border border-border bg-card p-6">
            <p className="font-semibold">Activer ton lien partenaire</p>
            <p className="mt-2 text-sm text-muted">
              Tu obtiens un code referral, un lien traçable, et un dashboard de commissions.
            </p>
            <button type="button" onClick={createPartner} disabled={creating} className="mt-5 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-on-accent disabled:opacity-50">
              {creating ? 'Activation...' : 'Activer mon affiliation'}
            </button>
          </div>
        ) : (
          <div className="mt-8 space-y-6">
            <section className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs uppercase text-muted">Clients attribués</p>
                <p className="mt-2 font-display text-2xl font-semibold">{partner.clients}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs uppercase text-muted">Revenu référé</p>
                <p className="mt-2 font-display text-2xl font-semibold">{money(partner.referredRevenueEur)}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs uppercase text-muted">Commission</p>
                <p className="mt-2 font-display text-2xl font-semibold">{money(partner.commissionEur)}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs uppercase text-muted">Durée</p>
                <p className="mt-2 font-display text-2xl font-semibold">{partner.commissionMonths} mois</p>
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card p-5">
              <p className="text-sm font-semibold">Lien affilié</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
                <input readOnly value={partner.link} className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-fg" />
                <a href={partner.link} className="rounded-lg border border-border px-4 py-2 text-center text-sm font-semibold text-fg hover:bg-surface">
                  Tester
                </a>
              </div>
              <p className="mt-3 text-xs text-muted">
                Code {partner.code} · {partner.commissionPercent}% · plafond {partner.clientCapEur ? money(partner.clientCapEur) : 'sans plafond'} par client · statut {partner.status}
              </p>
            </section>

            <section className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="border-b border-border bg-surface text-xs uppercase text-muted">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Achat client</th>
                    <th className="px-4 py-3">Commission</th>
                    <th className="px-4 py-3">Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {partner.recent.length === 0 ? (
                    <tr><td colSpan={4} className="px-4 py-6 text-sm text-muted">Aucune commission enregistrée.</td></tr>
                  ) : partner.recent.map((row, index) => (
                    <tr key={`${row.createdAt}-${index}`} className="border-b border-border/70">
                      <td className="px-4 py-3 text-muted">{dateTime(row.createdAt)}</td>
                      <td className="px-4 py-3 font-mono">{money(row.customerAmountEur)}</td>
                      <td className="px-4 py-3 font-mono text-success">{money(row.commissionEur)}</td>
                      <td className="px-4 py-3">{row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </section>
    </main>
  )
}
