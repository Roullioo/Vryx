import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiJson } from '../lib/api'

type PublicWorker = {
  peerId: string
  peerLabel: string
  online: boolean
  live: boolean
  model: string | null
  gpuName: string | null
  gpuVramGb: number | null
  allocatedVramGb: number | null
  runtimeBackend: string
  weightQuantization: string
  tokensGenerated: number
  secondsSinceHeartbeat: number
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
    eurPerMillionTokens: number
    eurPerThousandTokens: number
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
    costEstimatedEurPerMillion: number
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

function fmtEur(value?: number | null) {
  return Number(value || 0).toLocaleString('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })
}

function MetricCard({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="status-glass status-wave rounded-[1.65rem] p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/50">{label}</p>
      <p className="mt-3 font-display text-3xl font-black text-white md:text-4xl" style={{ color: accent }}>
        {value}
      </p>
      {hint ? <p className="mt-2 text-sm text-white/55">{hint}</p> : null}
    </div>
  )
}

export function StatusPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      const result = await apiJson<PublicStatus>('/api/public/network-status')
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

  const topModels = useMemo(() => (status?.models || []).slice(0, 8), [status])
  const liveWorkers = useMemo(() => (status?.workers || []).filter((worker) => worker.live).slice(0, 10), [status])

  return (
    <main className="min-h-screen overflow-hidden bg-[#050713] text-white">
      <section className="relative isolate px-4 pb-16 pt-12 sm:px-6 lg:px-8">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_18%_12%,rgba(56,189,248,.34),transparent_30%),radial-gradient(circle_at_88%_14%,rgba(217,70,239,.28),transparent_28%),linear-gradient(135deg,#050713,#0b1020_52%,#060815)]" />
        <div className="absolute inset-0 -z-10 opacity-[0.14] [background-image:linear-gradient(rgba(255,255,255,.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.1)_1px,transparent_1px)] [background-size:56px_56px]" />

        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[1fr_420px] lg:items-center">
            <div>
              <p className="inline-flex rounded-full border border-cyan-200/25 bg-white/8 px-4 py-2 text-xs font-bold uppercase tracking-[0.22em] text-cyan-100 backdrop-blur-xl">
                Status réseau public
              </p>
              <h1 className="mt-7 max-w-4xl font-display text-5xl font-black leading-none text-white sm:text-6xl lg:text-7xl">
                VRYX mesure son réseau comme une infra temps réel.
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-white/62">
                Workers connectés, modèles disponibles, TPS actif, p50/p95, prix token et benchmark public. Les chiffres viennent des sessions P2P réelles et se rafraîchissent automatiquement.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/compte/chat" className="rounded-2xl bg-cyan-200 px-5 py-3 text-sm font-bold text-slate-950 shadow-[0_0_42px_rgba(103,232,249,.35)]">
                  Tester le chat P2P
                </Link>
                <Link to="/compte/api" className="rounded-2xl border border-white/15 bg-white/8 px-5 py-3 text-sm font-bold text-white backdrop-blur-xl hover:bg-white/12">
                  Générer une clé API
                </Link>
              </div>
            </div>

            <div className="status-orbit relative aspect-square min-h-[320px] rounded-[2rem] border border-white/12 bg-white/8 p-8 backdrop-blur-2xl">
              <div className="absolute inset-12 rounded-full border border-cyan-200/25" />
              <div className="absolute inset-24 rounded-full border border-fuchsia-200/20" />
              <div className="absolute left-1/2 top-1/2 h-32 w-32 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-200/90 shadow-[0_0_90px_rgba(103,232,249,.75)]" />
              <div className="absolute left-8 top-12 rounded-2xl border border-white/12 bg-black/28 p-4 backdrop-blur-xl">
                <p className="text-xs text-white/50">Workers live</p>
                <p className="mt-1 font-display text-3xl font-black">{fmtInt(status?.network.workersLive)}</p>
              </div>
              <div className="absolute bottom-12 right-8 rounded-2xl border border-white/12 bg-black/28 p-4 text-right backdrop-blur-xl">
                <p className="text-xs text-white/50">TPS actif moyen</p>
                <p className="mt-1 font-display text-3xl font-black">{fmtTps(status?.network.tpsActiveAvg)}</p>
              </div>
            </div>
          </div>

          {error ? (
            <div className="mt-8 rounded-2xl border border-rose-300/25 bg-rose-400/10 p-4 text-sm text-rose-100">{error}</div>
          ) : null}

          <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Workers online" value={fmtInt(status?.network.workersOnline)} hint={`${fmtInt(status?.network.workersRegistered)} enregistrés`} accent="#7dd3fc" />
            <MetricCard label="TPS actif" value={fmtTps(status?.network.tpsActiveAvg)} hint={`p95 ${fmtTps(status?.network.tpsActiveP95)} TPS`} accent="#a7f3d0" />
            <MetricCard label="TTFT p50" value={fmtMs(status?.network.ttftP50Ms)} hint={`latence p95 ${fmtMs(status?.network.latencyP95Ms)}`} accent="#f0abfc" />
            <MetricCard label="Prix public" value={fmtEur(status?.pricing.eurPerMillionTokens)} hint="par million de tokens" accent="#fde68a" />
          </div>

          <div className="mt-8 grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
            <section className="status-glass rounded-[1.8rem] p-5 sm:p-6">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/45">Benchmark public</p>
                  <h2 className="mt-2 font-display text-2xl font-black">{status?.benchmark.label || 'Qwen 9B / M4 Max'}</h2>
                </div>
                <p className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-xs text-white/55">
                  {fmtInt(status?.benchmark.sampleSize)} samples 24h
                </p>
              </div>
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl bg-white/7 p-4">
                  <p className="text-xs text-white/45">Premier token</p>
                  <p className="mt-2 font-mono text-xl font-bold">{fmtMs(status?.benchmark.latencyFirstTokenMs)}</p>
                </div>
                <div className="rounded-2xl bg-white/7 p-4">
                  <p className="text-xs text-white/45">TPS moyen actif</p>
                  <p className="mt-2 font-mono text-xl font-bold">{fmtTps(status?.benchmark.tpsAverageActive)}</p>
                </div>
                <div className="rounded-2xl bg-white/7 p-4">
                  <p className="text-xs text-white/45">Coût estimé</p>
                  <p className="mt-2 font-mono text-xl font-bold">{fmtEur(status?.benchmark.costEstimatedEurPerMillion)}</p>
                </div>
              </div>
              <p className="mt-5 text-sm leading-6 text-white/55">{status?.benchmark.note}</p>
            </section>

            <section className="status-glass rounded-[1.8rem] p-5 sm:p-6">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/45">Économie réseau</p>
              <div className="mt-5 space-y-3">
                {[
                  ['Tokens 1h', fmtInt(status?.network.tokens1h)],
                  ['Tokens 24h', fmtInt(status?.network.tokens24h)],
                  ['Revenu estimé 24h', fmtEur(status?.network.revenue24h)],
                  ['Redistribution worker 24h', fmtEur(status?.network.workerRewards24h)],
                  ['Marge brute estimée', `${fmtInt(status?.pricing.estimatedGrossMarginPercent)} %`],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/6 px-4 py-3">
                    <span className="text-sm text-white/55">{label}</span>
                    <span className="font-mono text-sm font-bold">{value}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="mt-8 grid gap-5 xl:grid-cols-2">
            <section className="status-glass rounded-[1.8rem] p-5 sm:p-6">
              <h2 className="font-display text-2xl font-black">Modèles disponibles</h2>
              <div className="mt-5 space-y-3">
                {topModels.map((model) => (
                  <div key={model.id} className="rounded-2xl border border-white/10 bg-white/6 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{model.label}</p>
                        <p className="mt-1 truncate text-xs text-white/45">{model.id}</p>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-bold ${model.ready ? 'bg-emerald-300/18 text-emerald-100' : 'bg-white/8 text-white/45'}`}>
                        {model.ready ? 'ready' : 'offline'}
                      </span>
                    </div>
                    <p className="mt-3 text-sm text-white/55">
                      {model.workersOnline}/{model.workersTotal} worker(s) · {model.family} · {model.source}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section className="status-glass rounded-[1.8rem] p-5 sm:p-6">
              <h2 className="font-display text-2xl font-black">Workers live</h2>
              <div className="mt-5 space-y-3">
                {liveWorkers.length > 0 ? (
                  liveWorkers.map((worker) => (
                    <div key={worker.peerId} className="rounded-2xl border border-white/10 bg-white/6 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="font-mono text-sm font-bold text-cyan-100">{worker.peerLabel}</p>
                          <p className="mt-1 truncate text-sm text-white/55">{worker.gpuName || 'GPU non déclaré'}</p>
                        </div>
                        <span className="rounded-full bg-cyan-300/15 px-3 py-1 text-xs font-bold text-cyan-100">
                          {worker.runtimeBackend}
                        </span>
                      </div>
                      <p className="mt-3 truncate text-xs text-white/45">{worker.model || 'Modèle non déclaré'}</p>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-white/50">
                        <span>{worker.allocatedVramGb || 0} Go alloués</span>
                        <span>{worker.weightQuantization}</span>
                        <span>{fmtInt(worker.tokensGenerated)} tokens</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="rounded-2xl border border-white/10 bg-white/6 p-5 text-sm text-white/55">
                    Aucun worker live dans la fenêtre de présence actuelle.
                  </p>
                )}
              </div>
            </section>
          </div>

          <p className="mt-8 text-center text-xs text-white/35">
            Dernière mesure: {status?.sampledAt ? new Date(status.sampledAt).toLocaleString('fr-FR') : 'chargement'}
          </p>
        </div>
      </section>
    </main>
  )
}
