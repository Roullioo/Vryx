import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiJson } from '../lib/api'
import { displayLabel } from '../lib/displayLabels'

type PublicWorker = {
  peerId: string
  peerLabel: string
  online: boolean
  live: boolean
  model: string | null
  gpuName: string | null
  gpuClass?: string
  gpuVramGb: number | null
  allocatedVramGb: number | null
  memoryTier?: string
  runtimeBackend: string
  weightQuantization: string
  tokensGenerated?: number
  presence?: string
  uptimeBucket?: string
}

type PublicModel = {
  id: string
  label: string
  family: string
  source: string
  ready: boolean
  local: boolean
  workersOnline: number
  workersTotal: number
}

type PublicStatus = {
  ok: boolean
  sampledAt: string
  pricing: {
    published?: boolean
    minInputEurPerMillion?: number | null
    minOutputEurPerMillion?: number | null
    eurPerMillionTokens: number | null
    eurPerThousandTokens: number | null
    estimatedGrossMarginPercent: number
    workerRewardSharePercent: number
  }
  network: {
    workersRegistered: number
    workersOnline: number
    workersLive: number
    modelsReady: number
    tokens1h: number
    tokens24h: number
    tokens30d: number
    activeWorkers24h: number
    activeSessionSamples24h: number
    tpsActiveAvg: number
    tpsActiveP50: number
    tpsActiveP95: number
    latencyP50Ms: number
    latencyP95Ms: number
    ttftP50Ms: number
    ttftP95Ms: number
    pingP50Ms: number
    pingP95Ms: number
    revenue24h: number
    workerRewards24h: number
    apiRequests24h: number
    apiTokens24h: number
    apiRevenue24h: number
  }
  benchmark: {
    label: string
    device: string
    modelTarget: string
    source: string
    latencyFirstTokenMs: number
    tpsAverageActive: number
    tpsP95Active: number
    costEstimatedEurPerMillion: number | null
    sampleSize: number
    note: string
  }
  models: PublicModel[]
  workers: PublicWorker[]
}

function fmtInt(value?: number | null) {
  return Math.round(Number(value || 0)).toLocaleString('fr-FR')
}

function fmtMs(value?: number | null) {
  const n = Number(value || 0)
  return n > 0 ? `${fmtInt(n)} ms` : 'en attente'
}

function fmtTps(value?: number | null) {
  const n = Number(value || 0)
  return n > 0 ? n.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : '0'
}

function fmtEur(value?: number | null, digits = 4) {
  return Number(value || 0).toLocaleString('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function KpiCard({ label, value, hint, tone = 'cyan' }: { label: string; value: string; hint?: string; tone?: 'cyan' | 'emerald' | 'amber' | 'slate' }) {
  const tones = {
    cyan: 'border-cyan-200/35 bg-cyan-50 text-cyan-950 dark:border-cyan-300/20 dark:bg-cyan-300/10 dark:text-cyan-50',
    emerald: 'border-emerald-200/40 bg-emerald-50 text-emerald-950 dark:border-emerald-300/20 dark:bg-emerald-300/10 dark:text-emerald-50',
    amber: 'border-amber-200/45 bg-amber-50 text-amber-950 dark:border-amber-300/25 dark:bg-amber-300/10 dark:text-amber-50',
    slate: 'border-border bg-card text-fg',
  }
  return (
    <div className={`rounded-lg border p-5 ${tones[tone]}`}>
      <p className="text-xs font-semibold uppercase opacity-65">{label}</p>
      <p className="mt-3 font-display text-3xl font-semibold md:text-4xl">{value}</p>
      {hint ? <p className="mt-2 text-sm leading-6 opacity-70">{hint}</p> : null}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-right font-mono text-sm font-semibold text-fg">{value}</span>
    </div>
  )
}

function NetworkHeroAnimation({ status, workers }: { status: PublicStatus | null; workers: PublicWorker[] }) {
  const nodeCount = Math.min(Math.max(status?.network.workersLive ?? workers.length, 7), 12)
  const nodes = Array.from({ length: nodeCount }, (_, index) => {
    const worker = workers[index % Math.max(workers.length, 1)]
    const live = worker?.live ?? index < Math.max(3, Math.floor(nodeCount * 0.7))
    return {
      id: worker?.peerId ?? `fallback-${index}`,
      label: worker?.peerLabel ?? `W-${String(index + 1).padStart(2, '0')}`,
      live,
      model: worker?.model || 'pool public',
      angle: (360 / nodeCount) * index - 90,
      delay: `${index * 0.22}s`,
    }
  })

  return (
    <div className="network-hero-visual" aria-label="Animation du réseau live Vryx">
      <div className="network-hero-grid" aria-hidden />
      <div className="network-hero-orbit network-hero-orbit--outer" aria-hidden />
      <div className="network-hero-orbit network-hero-orbit--inner" aria-hidden />

      <div className="network-hero-core">
        <span className="network-hero-core-pulse" aria-hidden />
        <span className="font-mono text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-cyan-100/70">
          Vryx Core
        </span>
        <strong className="mt-2 font-display text-4xl font-semibold text-white">
          {fmtInt(status?.network.workersLive)}
        </strong>
        <span className="mt-1 text-xs text-white/58">workers live</span>
      </div>

      <div className="network-hero-links" aria-hidden>
        {nodes.map((node) => (
          <span
            key={`link-${node.id}`}
            className="network-hero-link"
            style={
              {
                '--node-angle': `${node.angle}deg`,
                '--node-delay': node.delay,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <div className="network-hero-nodes">
        {nodes.map((node, index) => (
          <div
            key={node.id}
            className={`network-hero-node ${node.live ? 'is-live' : ''}`}
            style={
              {
                '--node-angle': `${node.angle}deg`,
                '--node-delay': node.delay,
              } as CSSProperties
            }
          >
            <span className="network-hero-node-dot" aria-hidden />
            <span className="network-hero-node-label">
              <span className="font-mono">{node.label}</span>
              <span>{index < 4 ? node.model : node.live ? 'actif' : 'standby'}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="network-hero-streams" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </div>

      <dl className="network-hero-stats">
        <div>
          <dt>TPS p95</dt>
          <dd>{fmtTps(status?.network.tpsActiveP95)}</dd>
        </div>
        <div>
          <dt>TTFT p50</dt>
          <dd>{fmtMs(status?.network.ttftP50Ms)}</dd>
        </div>
        <div>
          <dt>Modèles</dt>
          <dd>{fmtInt(status?.network.modelsReady)}</dd>
        </div>
      </dl>
    </div>
  )
}

export function StatusPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null)
  const [error, setError] = useState('')
  const [modelFilter, setModelFilter] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      const suffix = modelFilter ? `?model=${encodeURIComponent(modelFilter)}` : ''
      const result = await apiJson<PublicStatus>(`/api/public/network-status${suffix}`)
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
  }, [modelFilter])

  const topModels = useMemo(() => (status?.models || []).slice(0, 8), [status])
  const liveWorkers = useMemo(() => (status?.workers || []).filter((worker) => worker.live).slice(0, 10), [status])
  const pricingLabel = status?.pricing.published === false
    ? 'Sur devis'
    : status?.pricing.minInputEurPerMillion != null && status?.pricing.minOutputEurPerMillion != null
      ? `${status.pricing.minInputEurPerMillion.toFixed(2)} / ${status.pricing.minOutputEurPerMillion.toFixed(2)} €/M`
      : fmtEur(status?.pricing.eurPerMillionTokens)

  return (
    <main className="bg-bg text-fg">
      <section className="page-hero bg-[#071018] text-white">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_18%_24%,rgba(34,211,238,.20),transparent_32%),radial-gradient(circle_at_84%_30%,rgba(16,185,129,.16),transparent_30%),linear-gradient(135deg,#020617_0%,#071018_48%,#061625_100%)]" />
        <div className="absolute inset-0 -z-10 opacity-[0.16] [background-image:linear-gradient(rgba(255,255,255,.16)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.14)_1px,transparent_1px)] [background-size:52px_52px]" />
        <div className="mx-auto grid min-h-[inherit] max-w-6xl items-center gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)] lg:gap-12 lg:px-8">
          <div className="pb-3">
            <p className="text-xs font-semibold uppercase text-cyan-100/70">Live Network</p>
            <h1 className="mt-5 max-w-4xl font-display text-4xl font-semibold leading-[1.03] text-white sm:text-5xl lg:text-6xl">
              Le tableau public du réseau Vryx.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-8 text-white/72 sm:text-lg">
              Workers, modèles, tokens, latence, TPS, pricing et benchmark: cette page expose les preuves utiles sans
              publier les peer IDs complets, IPs, ports ou informations sensibles.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/compte/chat" className="rounded-lg bg-white px-5 py-3 text-sm font-semibold text-slate-950 hover:bg-white/90">
                Tester le chat
              </Link>
              <Link to="/race-pool" className="rounded-lg border border-white/25 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/15">
                Comprendre l’infra
              </Link>
            </div>
          </div>

          <NetworkHeroAnimation status={status} workers={liveWorkers} />
        </div>
      </section>

      <section className="border-b border-border bg-card py-5">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div>
            <p className="text-xs font-semibold uppercase text-muted">Filtre public</p>
            <p className="mt-1 text-sm text-muted">Le filtre s’applique aux métriques publiques 24h quand le modèle est disponible.</p>
          </div>
          <select
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            className="min-h-11 rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none focus:border-accent"
          >
            <option value="">Tous les modèles</option>
            {topModels.map((m) => (
              <option key={m.id} value={m.id}>{m.label || m.id}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        {error ? (
          <div className="mb-6 rounded-lg border border-alert/40 bg-alert/10 p-4 text-sm text-alert">{error}</div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Workers en ligne" value={fmtInt(status?.network.workersOnline)} hint={`${fmtInt(status?.network.workersRegistered)} enregistrés`} tone="cyan" />
          <KpiCard label="Tokens 24h" value={fmtInt(status?.network.tokens24h)} hint={`${fmtInt(status?.network.tokens30d)} sur 30 jours`} tone="emerald" />
          <KpiCard label="Latence p95" value={fmtMs(status?.network.latencyP95Ms)} hint={`p50 ${fmtMs(status?.network.latencyP50Ms)}`} tone="amber" />
          <KpiCard label="Prix public" value={pricingLabel} hint={status?.pricing.published === false ? 'pricing privé' : 'input / output €/M'} tone="slate" />
        </div>

        <div className="mt-8 grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
          <section className="rounded-lg border border-border bg-card p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase text-muted">Benchmark du jour</p>
                <h2 className="mt-2 font-display text-2xl font-semibold">{status?.benchmark.label || 'Benchmark en attente'}</h2>
              </div>
              <span className="rounded-full border border-border bg-bg px-3 py-1 text-xs font-semibold text-muted">
                {fmtInt(status?.benchmark.sampleSize)} samples
              </span>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-bg p-4">
                <p className="text-xs text-muted">Premier token</p>
                <p className="mt-2 font-mono text-xl font-semibold">{fmtMs(status?.benchmark.latencyFirstTokenMs)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg p-4">
                <p className="text-xs text-muted">TPS moyen actif</p>
                <p className="mt-2 font-mono text-xl font-semibold">{fmtTps(status?.benchmark.tpsAverageActive)}</p>
              </div>
              <div className="rounded-lg border border-border bg-bg p-4">
                <p className="text-xs text-muted">Coût estimé</p>
                <p className="mt-2 font-mono text-xl font-semibold">{status?.pricing.published === false ? 'Sur devis' : fmtEur(status?.benchmark.costEstimatedEurPerMillion)}</p>
              </div>
            </div>
            <p className="mt-5 text-sm leading-7 text-muted">{status?.benchmark.note || 'Les artefacts de bench apparaissent ici quand la fenêtre publique contient assez de données.'}</p>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <p className="text-xs font-semibold uppercase text-muted">Économie réseau</p>
            <div className="mt-4">
              <DetailRow label="Tokens 1h" value={fmtInt(status?.network.tokens1h)} />
              <DetailRow label="Revenu estimé 24h" value={fmtEur(status?.network.revenue24h)} />
              <DetailRow label="Redistribution worker 24h" value={fmtEur(status?.network.workerRewards24h)} />
              <DetailRow label="Marge brute estimée" value={`${fmtInt(status?.pricing.estimatedGrossMarginPercent)} %`} />
              <DetailRow label="Part worker" value={`${fmtInt(status?.pricing.workerRewardSharePercent)} %`} />
            </div>
          </section>
        </div>

        <div className="mt-8 grid gap-5 xl:grid-cols-2">
          <section className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-2xl font-semibold">Modèles disponibles</h2>
              <span className="text-xs font-semibold uppercase text-muted">{fmtInt(status?.network.modelsReady)} prêts</span>
            </div>
            <div className="mt-5 space-y-3">
              {topModels.length > 0 ? topModels.map((model) => (
                <div key={model.id} className="rounded-lg border border-border bg-bg p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{model.label}</p>
                      <p className="mt-1 truncate text-xs text-muted">{model.id}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${model.ready ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-300' : 'bg-muted/10 text-muted'}`}>
                      {model.ready ? displayLabel('ready') : displayLabel('offline')}
                    </span>
                  </div>
                  <p className="mt-3 text-sm text-muted">
                    {model.workersOnline}/{model.workersTotal} worker(s) · {model.family} · {model.source}
                  </p>
                </div>
              )) : (
                <p className="rounded-lg border border-border bg-bg p-5 text-sm text-muted">Aucun modèle public dans la fenêtre actuelle.</p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-2xl font-semibold">Workers live</h2>
              <span className="text-xs font-semibold uppercase text-muted">identifiants redacted</span>
            </div>
            <div className="mt-5 space-y-3">
              {liveWorkers.length > 0 ? liveWorkers.map((worker) => (
                <div key={worker.peerId} className="rounded-lg border border-border bg-bg p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-accent">{worker.peerLabel}</p>
                      <p className="mt-1 truncate text-sm text-muted">{worker.gpuName || worker.gpuClass || 'Hardware masqué'}</p>
                    </div>
                    <span className="rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted">
                      {worker.runtimeBackend}
                    </span>
                  </div>
                  <p className="mt-3 truncate text-xs text-muted">{worker.model || 'Modèle non déclaré'}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted">
                    <span className="rounded-full bg-card px-2.5 py-1">{worker.allocatedVramGb ? `${worker.allocatedVramGb} Go alloués` : worker.memoryTier || 'VRAM masquée'}</span>
                    <span className="rounded-full bg-card px-2.5 py-1">{worker.weightQuantization}</span>
                    <span className="rounded-full bg-card px-2.5 py-1">{worker.uptimeBucket || worker.presence || 'live'}</span>
                  </div>
                </div>
              )) : (
                <p className="rounded-lg border border-border bg-bg p-5 text-sm text-muted">
                  Aucun worker live dans la fenêtre de présence actuelle.
                </p>
              )}
            </div>
          </section>
        </div>

        <p className="mt-8 text-center text-xs text-muted">
          Dernière mesure: {status?.sampledAt ? new Date(status.sampledAt).toLocaleString('fr-FR') : 'chargement'}
        </p>
      </section>
    </main>
  )
}
