import { useEffect, useState } from 'react'
import { AdminShell } from '../components/admin/AdminShell'
import { apiJson } from '../lib/api'

type EventItem = {
  id: string
  ts: string
  level: string
  scope: string
  message: string
  data?: Record<string, unknown> | null
}

type ObservabilityEvents = {
  ok: boolean
  summary: {
    totalBuffered: number
    lastHour: number
    errorsLastHour: number
    warningsLastHour: number
    lastError: EventItem | null
  }
  events: EventItem[]
}

type ObservabilityHealth = {
  ok: boolean
  sampledAt: string
  alerts: {
    pm2Available: boolean
    apiRuntime?: string
    apiPm2?: string
    apiSystemd: string
    initiatorSystemd: string
  }
  eventSummary: ObservabilityEvents['summary']
}

function tone(level: string) {
  if (level === 'fatal' || level === 'error') return 'border-alert/30 bg-alert/10 text-alert'
  if (level === 'warn') return 'border-warning/30 bg-warning/10 text-warning'
  return 'border-border bg-surface text-muted'
}

function SmallCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-2 font-display text-2xl font-bold text-fg">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

export function AdminObservabilityPage() {
  const [events, setEvents] = useState<ObservabilityEvents | null>(null)
  const [health, setHealth] = useState<ObservabilityHealth | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      const [eventsRes, healthRes] = await Promise.all([
        apiJson<ObservabilityEvents>('/api/admin/observability/events?limit=120'),
        apiJson<ObservabilityHealth>('/api/admin/observability/health'),
      ])
      if (!active) return
      if (eventsRes.ok) setEvents(eventsRes.data)
      if (healthRes.ok) setHealth(healthRes.data)
      setError(!eventsRes.ok ? eventsRes.error : !healthRes.ok ? healthRes.error : '')
    }
    void load()
    const timer = window.setInterval(load, 12000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  return (
    <AdminShell title="Observabilité" subtitle="Erreurs structurées, alertes PM2/systemd et santé du pipeline">
      {error ? <div className="mb-5 rounded-xl border border-alert/30 bg-alert/10 p-4 text-sm text-alert">{error}</div> : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SmallCard label="Erreurs 1h" value={String(events?.summary.errorsLastHour ?? 0)} hint="HTTP 5xx, process, fatal" />
        <SmallCard label="Warnings 1h" value={String(events?.summary.warningsLastHour ?? 0)} hint="Requêtes API lentes" />
        <SmallCard label="API runtime" value={health?.alerts.apiRuntime || '—'} hint="PM2 prioritaire, systemd en fallback" />
        <SmallCard label="Systemd initiateur" value={health?.alerts.initiatorSystemd || '—'} hint="vryx-initiator.service" />
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <h2 className="font-display text-xl font-bold text-fg">Alertes système</h2>
          <div className="mt-4 space-y-3">
            {[
              ['API PM2', health?.alerts.apiPm2 || (health?.alerts.pm2Available ? 'OK' : 'À vérifier')],
              ['API systemd', health?.alerts.apiSystemd || '—'],
              ['Initiateur systemd', health?.alerts.initiatorSystemd || '—'],
              ['Dernier check', health?.sampledAt ? new Date(health.sampledAt).toLocaleString('fr-FR') : 'chargement'],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 rounded-xl bg-surface px-4 py-3">
                <span className="text-sm text-muted">{label}</span>
                <span className="font-mono text-sm font-semibold text-fg">{value}</span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm leading-6 text-muted">
            Sentry peut être activé ensuite avec une DSN dédiée. Cette page prépare déjà les événements structurés et les checks nécessaires aux alertes.
          </p>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-xl font-bold text-fg">Événements récents</h2>
              <p className="mt-1 text-sm text-muted">{events?.summary.totalBuffered ?? 0} événement(s) en mémoire</p>
            </div>
          </div>
          <div className="mt-4 max-h-[560px] space-y-3 overflow-auto pr-1">
            {(events?.events || []).length > 0 ? (
              events?.events.map((event) => (
                <article key={event.id} className={`rounded-xl border p-4 ${tone(event.level)}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{event.message}</p>
                      <p className="mt-1 font-mono text-xs opacity-70">{event.scope} · {new Date(event.ts).toLocaleString('fr-FR')}</p>
                    </div>
                    <span className="rounded-full bg-black/10 px-2.5 py-1 text-xs font-bold uppercase">{event.level}</span>
                  </div>
                  {event.data ? (
                    <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-black/10 p-3 text-xs leading-5">{JSON.stringify(event.data, null, 2)}</pre>
                  ) : null}
                </article>
              ))
            ) : (
              <p className="rounded-xl bg-surface p-4 text-sm text-muted">Aucun événement enregistré pour le moment.</p>
            )}
          </div>
        </section>
      </div>
    </AdminShell>
  )
}
