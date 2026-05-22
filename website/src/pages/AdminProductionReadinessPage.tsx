import { useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/admin/AdminShell'
import { apiJson } from '../lib/api'
import { displayLabel, displayMaybeCode } from '../lib/displayLabels'

type Readiness = {
  score: number
  grade: string
  goldenPath: {
    models: string[]
    liveWorkers: number
    q4NativeWorkers?: number
    q4LlamaWorkers: number
    minDecodeTps: number
    maxTtftP95Ms: number
  }
  metrics: {
    requestCount: number
    successRate: number
    failureRate: number
    tpsP50: number
    tpsBest: number
    ttftP95: number
    latencyP95: number
    recentEmptyResponses: number
    validBenchmarks: number
  }
  blockers: string[]
  warnings: string[]
  actions: string[]
}

type ReadinessResponse = {
  ok: boolean
  sampledAt: string
  windowHours: number
  readiness: Readiness
}

type InferenceSummaryResponse = {
  ok: boolean
  windowHours: number
  summary: {
    count: number
    ok: number
    failed: number
    decodeTps?: { p50?: number; p95?: number; best?: number }
    latencyMs?: { p50?: number; p95?: number }
    ttftMs?: { p50?: number; p95?: number }
    costEur?: number
    totalTokens?: number
  }
}

type GoldenPathResponse = {
  ok: boolean
  sampledAt: string
  goldenPath: {
    models: string[]
    stable99Proven: boolean
    directWorkers: number
    relayWorkers: number
    benchmarkRuns: number
    benchmarkOk: number
    latestBenchmark: null | {
      model: string
      status: string
      tps: number
      ttftMs: number
      latencyMs: number
      workerCount: number
      createdAt: string | null
      error: string | null
    }
  }
}

type BenchmarksResponse = {
  ok: boolean
  summary: {
    samples: number
    okSamples: number
    tpsP50: number
    tpsP95: number
    latencyP95Ms: number
    ttftP95Ms: number
  }
}

function numberFr(value: number, digits = 0) {
  return Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function dateTime(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

function scoreTone(score: number) {
  if (score >= 90) return 'text-success'
  if (score >= 80) return 'text-electric'
  if (score >= 70) return 'text-warning'
  return 'text-alert'
}

function MetricCard({ label, value, hint, tone = 'text-fg' }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="panel p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 font-display text-2xl font-bold ${tone}`}>{value}</p>
      {hint ? <p className="mt-2 text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

function ListPanel({ title, items, empty, tone = 'text-fg' }: { title: string; items: string[]; empty: string; tone?: string }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-semibold text-muted">{items.length}</span>
      </div>
      <div className="mt-4 space-y-2">
        {items.length ? (
          items.map((item) => (
            <div key={item} className="rounded-xl bg-surface px-3 py-2 text-sm text-muted">
              <span className={tone}>{item}</span>
            </div>
          ))
        ) : (
          <p className="rounded-xl bg-surface px-3 py-2 text-sm text-muted">{empty}</p>
        )}
      </div>
    </section>
  )
}

export function AdminProductionReadinessPage() {
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null)
  const [inference, setInference] = useState<InferenceSummaryResponse | null>(null)
  const [goldenPath, setGoldenPath] = useState<GoldenPathResponse | null>(null)
  const [benchmarks, setBenchmarks] = useState<BenchmarksResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [r, i, g, b] = await Promise.all([
        apiJson<ReadinessResponse>('/api/admin/production-readiness?hours=24'),
        apiJson<InferenceSummaryResponse>('/api/admin/inference/summary?hours=24'),
        apiJson<GoldenPathResponse>('/api/public/golden-path-status?hours=24'),
        apiJson<BenchmarksResponse>('/api/public/benchmarks'),
      ])
      if (cancelled) return
      const failures = [r, i, g, b].map((item) => (item.ok ? null : item.error)).filter((item): item is string => Boolean(item))
      setError(failures[0] || null)
      if (r.ok) setReadiness(r.data)
      if (i.ok) setInference(i.data)
      if (g.ok) setGoldenPath(g.data)
      if (b.ok) setBenchmarks(b.data)
    }
    void load()
    const id = window.setInterval(load, 20_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const ready = readiness?.readiness
  const latestBenchmark = goldenPath?.goldenPath.latestBenchmark
  const scoreLabel = ready ? `${ready.score}/100` : '—'
  const proofItems = useMemo(() => {
    if (!ready) return []
    return [
      `${ready.metrics.requestCount} requêtes sur 24 h`,
      `${numberFr(ready.metrics.successRate, 2)}% de succès`,
      `${ready.metrics.validBenchmarks} benchmark(s) valides`,
      `${ready.goldenPath.liveWorkers} worker(s) golden live`,
    ]
  }, [ready])

  return (
    <AdminShell title="Production readiness" subtitle="Score investisseur, golden path et preuves techniques sur 24 heures">
      {error && (
        <div className="mb-5 rounded-xl border border-alert/40 bg-alert/8 px-4 py-3 text-sm text-alert" role="alert">
          {error}
        </div>
      )}

      <div className="space-y-6">
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Score readiness" value={scoreLabel} hint={ready ? displayLabel(ready.grade) : 'Chargement'} tone={ready ? scoreTone(ready.score) : 'text-muted'} />
          <MetricCard label="Succès golden path" value={ready ? `${numberFr(ready.metrics.successRate, 2)} %` : '—'} hint={`${ready?.metrics.recentEmptyResponses ?? 0} réponse vide`} tone="text-success" />
          <MetricCard label="TPS p50 / best" value={ready ? `${numberFr(ready.metrics.tpsP50, 2)} / ${numberFr(ready.metrics.tpsBest, 2)}` : '—'} hint={`cible ${ready?.goldenPath.minDecodeTps ?? 10} TPS`} tone="text-electric" />
          <MetricCard label="TTFT p95" value={ready ? `${numberFr(ready.metrics.ttftP95)} ms` : '—'} hint={`max ${numberFr(ready?.goldenPath.maxTtftP95Ms ?? 0)} ms`} tone="text-warning" />
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,.8fr)]">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Golden path figé</p>
                <h2 className="mt-1 font-display text-2xl font-bold text-fg">{ready?.goldenPath.models.join(', ') || '—'}</h2>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${goldenPath?.goldenPath.stable99Proven ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                {goldenPath?.goldenPath.stable99Proven ? '99% prouvé' : 'preuve incomplète'}
              </span>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {proofItems.map((item) => (
                <div key={item} className="rounded-xl bg-surface p-4 text-sm font-semibold text-fg">{item}</div>
              ))}
            </div>
            <div className="mt-5 rounded-xl bg-surface p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Dernier benchmark</p>
              <p className="mt-2 text-sm text-fg">
                {latestBenchmark
                  ? `${latestBenchmark.model} · ${displayLabel(latestBenchmark.status)} · ${numberFr(latestBenchmark.tps, 2)} TPS · ${numberFr(latestBenchmark.ttftMs)} ms TTFT · ${dateTime(latestBenchmark.createdAt)}`
                  : 'Aucun benchmark récent.'}
              </p>
              {latestBenchmark?.error ? <p className="mt-2 text-xs text-alert">{latestBenchmark.error}</p> : null}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Benchmarks publics</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-surface p-3"><p className="text-xs text-muted">Samples</p><p className="mt-1 font-mono font-semibold">{numberFr(benchmarks?.summary.samples ?? 0)}</p></div>
              <div className="rounded-xl bg-surface p-3"><p className="text-xs text-muted">OK</p><p className="mt-1 font-mono font-semibold">{numberFr(benchmarks?.summary.okSamples ?? 0)}</p></div>
              <div className="rounded-xl bg-surface p-3"><p className="text-xs text-muted">TPS p95</p><p className="mt-1 font-mono font-semibold">{numberFr(benchmarks?.summary.tpsP95 ?? 0, 2)}</p></div>
              <div className="rounded-xl bg-surface p-3"><p className="text-xs text-muted">Latence p95</p><p className="mt-1 font-mono font-semibold">{numberFr(benchmarks?.summary.latencyP95Ms ?? 0)} ms</p></div>
            </div>
            <p className="mt-4 text-xs text-muted">
              Inference 24 h: {numberFr(inference?.summary.count ?? 0)} requêtes, {numberFr(inference?.summary.totalTokens ?? 0)} tokens, {numberFr(inference?.summary.costEur ?? 0, 6)} €.
            </p>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-3">
          <ListPanel title="Blockers" items={(ready?.blockers ?? []).map(displayMaybeCode)} empty="Aucun blocker déclaré." tone="text-alert" />
          <ListPanel title="Warnings" items={(ready?.warnings ?? []).map(displayMaybeCode)} empty="Aucun warning déclaré." tone="text-warning" />
          <ListPanel title="Actions" items={(ready?.actions ?? []).map(displayMaybeCode)} empty="Aucune action requise." tone="text-electric" />
        </section>
      </div>
    </AdminShell>
  )
}
