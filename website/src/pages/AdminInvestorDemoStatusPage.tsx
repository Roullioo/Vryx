import { useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/admin/AdminShell'
import { apiJson } from '../lib/api'

type DemoCheckStatus = 'ok' | 'warning' | 'blocked' | 'not_enabled'

type DemoCheck = {
  check: string
  state: string
  status: DemoCheckStatus
  detail?: string
}

type InvestorDemoStatus = {
  ok: boolean
  sampledAt: string
  readiness: {
    score: number
    grade: string
    blockers: string[]
    warnings: string[]
  }
  summary: {
    ok: number
    notEnabled: number
    warnings: number
    blocked: number
    total: number
  }
  checks: DemoCheck[]
}

function dateTime(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })
}

function statusClass(status: DemoCheckStatus) {
  if (status === 'ok') return 'bg-success/12 text-success'
  if (status === 'not_enabled') return 'bg-surface text-muted'
  if (status === 'warning') return 'bg-warning/12 text-warning'
  return 'bg-alert/12 text-alert'
}

function stateClass(status: DemoCheckStatus) {
  if (status === 'ok') return 'text-success'
  if (status === 'not_enabled') return 'text-muted'
  if (status === 'warning') return 'text-warning'
  return 'text-alert'
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-2 font-display text-2xl font-bold text-fg">{value}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  )
}

export function AdminInvestorDemoStatusPage() {
  const [status, setStatus] = useState<InvestorDemoStatus | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      const result = await apiJson<InvestorDemoStatus>('/api/admin/investor-demo-status')
      if (!active) return
      if (result.ok) {
        setStatus(result.data)
        setError('')
      } else {
        setError(result.error)
      }
    }
    void load()
    const timer = window.setInterval(load, 15000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const rows = status?.checks || []
  const operationalChecks = useMemo(() => rows.filter((row) => row.status !== 'not_enabled'), [rows])
  const operationalOk = operationalChecks.filter((row) => row.status === 'ok').length

  return (
    <AdminShell title="Investor Demo Status" subtitle="Checklist assumée pour présenter le mode staging sans cacher les briques dev">
      {error ? <div className="mb-5 rounded-xl border border-alert/30 bg-alert/10 p-4 text-sm text-alert">{error}</div> : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Checklist"
          value={status ? `${operationalOk}/${operationalChecks.length}` : '—'}
          hint="Checks opérationnels validés"
        />
        <SummaryCard
          label="Readiness runtime"
          value={status ? `${status.readiness.score}/100` : '—'}
          hint={status?.readiness.grade || 'Chargement'}
        />
        <SummaryCard
          label="Not enabled"
          value={String(status?.summary.notEnabled ?? '—')}
          hint="Briques volontairement hors staging"
        />
        <SummaryCard
          label="Dernier check"
          value={dateTime(status?.sampledAt)}
          hint="Rafraîchi automatiquement"
        />
      </div>

      <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-display text-xl font-bold text-fg">Investor Demo Checklist</h2>
          <p className="mt-1 text-sm text-muted">Vue courte pour expliquer ce qui est prêt, ce qui est en staging, et ce qui reste production.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-surface/70 text-left text-xs font-semibold uppercase tracking-wide text-muted">
              <tr>
                <th className="px-5 py-3">Check</th>
                <th className="px-5 py-3">État</th>
                <th className="px-5 py-3">Détail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length ? rows.map((row) => (
                <tr key={row.check} className="bg-card">
                  <td className="px-5 py-4 font-medium text-fg">{row.check}</td>
                  <td className="px-5 py-4">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(row.status)}`}>
                      <span className={stateClass(row.status)}>{row.state}</span>
                    </span>
                  </td>
                  <td className="px-5 py-4 text-muted">{row.detail || '—'}</td>
                </tr>
              )) : (
                <tr>
                  <td className="px-5 py-6 text-sm text-muted" colSpan={3}>Chargement de la checklist.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {(status?.readiness.blockers.length || status?.readiness.warnings.length) ? (
        <section className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-fg">Blockers readiness</h2>
            <div className="mt-3 space-y-2">
              {status.readiness.blockers.length ? status.readiness.blockers.map((item) => (
                <p key={item} className="rounded-xl bg-alert/8 px-3 py-2 text-sm text-alert">{item}</p>
              )) : <p className="rounded-xl bg-surface px-3 py-2 text-sm text-muted">Aucun blocker actif.</p>}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-fg">Warnings readiness</h2>
            <div className="mt-3 space-y-2">
              {status.readiness.warnings.length ? status.readiness.warnings.map((item) => (
                <p key={item} className="rounded-xl bg-warning/8 px-3 py-2 text-sm text-warning">{item}</p>
              )) : <p className="rounded-xl bg-surface px-3 py-2 text-sm text-muted">Aucun warning actif.</p>}
            </div>
          </div>
        </section>
      ) : null}
    </AdminShell>
  )
}
