import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { EurSign, IconBolt, IconClock, IconShield, IconTerminal } from '../components/icons/Icons'
import { WorkerSetupPanel } from '../components/workers/WorkerSetupPanel'
import { GPU_CATALOG, type GpuTier } from '../data/gpuCatalog'
import { WORKERS_FAQ } from '../data/workersContent'
import { STORYTELLING } from '../data/storytelling'
import { useAuth } from '../context/AuthContext'
import { apiJson } from '../lib/api'
import {
  WORKER_EUR_PER_TFLOP_HOUR,
  computeFleetWorkerProfit,
  computeWorkerGpuProfit,
  formatEur,
  workerNetSparkline12,
  type FleetLine,
  type WorkerSimMode,
} from '../lib/simulator'

type WorkerNetworkStats = {
  ok: boolean
  sampledAt: string
  onlineCount: number
  registeredWorkers: number
  activeWorkers30d: number
  totalTokensGenerated: number
  totalTokens1h: number
  totalTokens24h: number
  totalTokens30d: number
  avgTokensPerActiveWorker30d: number
}

type PublicWorker = {
  peerLabel: string
  live: boolean
  model: string | null
  gpuName: string | null
  gpuVramGb: number | null
  allocatedVramGb: number | null
  runtimeBackend: string
  weightQuantization: string
  presence?: string
  uptimeBucket?: string
}

type PublicStatus = {
  ok: boolean
  sampledAt: string
  pricing: {
    workerRewardSharePercent: number
    estimatedGrossMarginPercent: number
  }
  network: {
    workersRegistered: number
    workersOnline: number
    workersLive: number
    modelsReady: number
    tokens24h: number
    tokens30d: number
    latencyP50Ms: number
    latencyP95Ms: number
    tpsActiveP50: number
    tpsActiveP95: number
    ttftP50Ms: number
    ttftP95Ms: number
    workerRewards24h: number
    revenue24h: number
  }
  benchmark: {
    modelTarget: string
    tpsAverageActive: number
    tpsP95Active: number
    latencyFirstTokenMs: number
    sampleSize: number
    costEstimatedEurPerMillion: number | null
    note: string
  }
  workers: PublicWorker[]
}

type PublicBenchmarks = {
  ok: boolean
  sampledAt: string
  summary: {
    samples: number
    activeSamples: number
    okSamples: number
    hotSamples: number
    tpsP50: number
    tpsP95: number
    hotTpsP50: number
    hotTpsP95: number
    latencyP50Ms: number
    latencyP95Ms: number
    ttftP50Ms: number
    ttftP95Ms: number
  }
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

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1e-6)
  const w = 100
  const h = 28
  const denom = Math.max(values.length - 1, 1)
  const pts = values
    .map((v, i) => {
      const x = (i / denom) * w
      const y = h - (v / max) * (h - 4) - 2
      return `${x},${y}`
    })
    .join(' ')
  return (
    <svg width={88} height={32} viewBox={`0 0 ${w} ${h}`} className="text-success" aria-hidden>
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
        opacity={0.85}
      />
    </svg>
  )
}

function WorkerKpi({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone: 'cyan' | 'emerald' | 'amber' | 'slate'
}) {
  const tones = {
    cyan: 'border-cyan-200/35 bg-cyan-50 text-cyan-950 dark:border-cyan-300/20 dark:bg-cyan-300/10 dark:text-cyan-50',
    emerald: 'border-emerald-200/40 bg-emerald-50 text-emerald-950 dark:border-emerald-300/20 dark:bg-emerald-300/10 dark:text-emerald-50',
    amber: 'border-amber-200/45 bg-amber-50 text-amber-950 dark:border-amber-300/25 dark:bg-amber-300/10 dark:text-amber-50',
    slate: 'border-border bg-card text-fg',
  }
  return (
    <div className={`rounded-2xl border p-5 ${tones[tone]}`}>
      <p className="text-xs font-semibold uppercase opacity-65">{label}</p>
      <p className="mt-3 font-display text-3xl font-semibold md:text-4xl">{value}</p>
      <p className="mt-2 text-sm leading-6 opacity-70">{detail}</p>
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

export function WorkersPage() {
  const wp = STORYTELLING.workersPage
  const disc = STORYTELLING.disclaimer
  const { user } = useAuth()
  const { hash, pathname } = useLocation()

  const [networkStats, setNetworkStats] = useState<WorkerNetworkStats | null>(null)
  const [status, setStatus] = useState<PublicStatus | null>(null)
  const [benchmarks, setBenchmarks] = useState<PublicBenchmarks | null>(null)
  const [error, setError] = useState('')

  const [utilizationPct, setUtilizationPct] = useState(55)
  const [electricityEurPerKwh, setElectricityEurPerKwh] = useState(0.18)
  const [workerMode, setWorkerMode] = useState<WorkerSimMode>('race-pool')
  const [gpuQuery, setGpuQuery] = useState('')
  const [vendorFilter, setVendorFilter] = useState<'all' | 'NVIDIA' | 'AMD' | 'Apple'>('all')
  const [tierFilter, setTierFilter] = useState<'all' | GpuTier>('all')
  const [vramMin, setVramMin] = useState(0)
  const [sortKey, setSortKey] = useState<'net' | 'name' | 'roi' | 'vram'>('net')
  const [selectedGpuId, setSelectedGpuId] = useState<string>('')
  const [fleetCounts, setFleetCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    if (pathname !== '/workers' || hash !== '#install') return
    window.requestAnimationFrame(() => {
      document.getElementById('install')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [hash, pathname])

  useEffect(() => {
    let active = true
    const load = async () => {
      const [networkResult, statusResult, benchResult] = await Promise.all([
        apiJson<WorkerNetworkStats>('/api/workers/network-stats'),
        apiJson<PublicStatus>('/api/public/network-status'),
        apiJson<PublicBenchmarks>('/api/public/benchmarks'),
      ])
      if (!active) return
      if (networkResult.ok) setNetworkStats(networkResult.data)
      if (statusResult.ok) setStatus(statusResult.data)
      if (benchResult.ok) setBenchmarks(benchResult.data)
      const firstError = !networkResult.ok
        ? networkResult.error
        : !statusResult.ok
          ? statusResult.error
          : !benchResult.ok
            ? benchResult.error
            : ''
      setError(firstError)
    }
    void load()
    const timer = window.setInterval(load, 15000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const workerInput = useMemo(
    () => ({
      utilizationPct,
      electricityEurPerKwh,
      mode: workerMode,
    }),
    [utilizationPct, electricityEurPerKwh, workerMode],
  )

  const workerRows = useMemo(() => {
    const q = gpuQuery.trim().toLowerCase()
    let list = GPU_CATALOG.map((gpu) => ({
      gpu,
      profit: computeWorkerGpuProfit(gpu, workerInput),
    }))
    if (q) list = list.filter(({ gpu }) => gpu.name.toLowerCase().includes(q) || gpu.id.includes(q))
    if (vendorFilter !== 'all') list = list.filter(({ gpu }) => gpu.vendor === vendorFilter)
    if (tierFilter !== 'all') list = list.filter(({ gpu }) => gpu.tier === tierFilter)
    if (vramMin > 0) list = list.filter(({ gpu }) => gpu.vram >= vramMin)

    list.sort((a, b) => {
      if (sortKey === 'name') return a.gpu.name.localeCompare(b.gpu.name, 'fr')
      if (sortKey === 'roi') {
        const ra = a.profit.roiMonths ?? 9999
        const rb = b.profit.roiMonths ?? 9999
        return ra - rb
      }
      if (sortKey === 'vram') return b.gpu.vram - a.gpu.vram
      return b.profit.netMonthlyEuro - a.profit.netMonthlyEuro
    })
    return list
  }, [gpuQuery, vendorFilter, tierFilter, vramMin, sortKey, workerInput])

  const liveSuggestedGpuId = useMemo(() => {
    const firstGpuName = status?.workers?.find((worker) => worker.gpuName)?.gpuName?.toLowerCase() || ''
    if (!firstGpuName) return ''
    return (
      GPU_CATALOG.find((gpu) => firstGpuName.includes(gpu.name.toLowerCase().split('·')[0].trim().toLowerCase()))?.id || ''
    )
  }, [status])

  const selectedGpu =
    GPU_CATALOG.find((gpu) => gpu.id === selectedGpuId) ??
    GPU_CATALOG.find((gpu) => gpu.id === liveSuggestedGpuId) ??
    workerRows[0]?.gpu ??
    GPU_CATALOG[0]
  const selectedProfit = selectedGpu ? computeWorkerGpuProfit(selectedGpu, workerInput) : null

  const fleetLines: FleetLine[] = useMemo(
    () =>
      Object.entries(fleetCounts)
        .filter(([, count]) => count > 0)
        .map(([id, count]) => {
          const gpu = GPU_CATALOG.find((entry) => entry.id === id)
          return gpu ? { gpu, count } : null
        })
        .filter(Boolean) as FleetLine[],
    [fleetCounts],
  )

  const fleetProfit = useMemo(() => computeFleetWorkerProfit(fleetLines, workerInput), [fleetLines, workerInput])
  const liveWorkers = useMemo(() => (status?.workers || []).filter((worker) => worker.live).slice(0, 6), [status])
  const topGpuRows = workerRows.slice(0, 8)
  const payoutShare = status?.pricing.workerRewardSharePercent ?? 60
  const marginShare = status?.pricing.estimatedGrossMarginPercent ?? 0

  function addGpuToFleet(id: string) {
    setFleetCounts((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
  }

  function removeOneFromFleet(id: string) {
    setFleetCounts((prev) => {
      const n = (prev[id] ?? 0) - 1
      const next = { ...prev }
      if (n <= 0) delete next[id]
      else next[id] = n
      return next
    })
  }

  return (
    <div className="border-b border-border bg-bg">
      <section
        className="page-hero"
        aria-labelledby="workers-hero-heading"
      >
        <div className="page-hero-media-shell" aria-hidden>
          <div
            className="page-hero-media blur-[3px]"
            style={{ backgroundImage: "url('/heroes/worker-hero.webp')" }}
          />
        </div>
        <div className="page-hero-overlay" aria-hidden />

        <div className="relative z-10 mx-auto flex min-h-[inherit] w-full max-w-6xl flex-1 items-end px-4 pb-12 pt-8 sm:px-6 lg:px-8">
          <div className="grid w-full gap-8 lg:grid-cols-[1fr_24rem] lg:items-end">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              className="max-w-3xl"
            >
              <p className="font-mono text-xs uppercase tracking-[0.28em] text-white/68">Workers Vryx</p>
              <h1
                id="workers-hero-heading"
                className="mt-5 font-display text-4xl font-semibold leading-[1.02] tracking-tight text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.45)] sm:text-5xl lg:text-6xl"
              >
                {wp.title}
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-8 text-white/78 sm:text-lg">
                {wp.intro} Cette page reprend le vrai moteur du simulateur GPU, les métriques publiques du réseau et
                les benchmarks redacted du pool.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  to="/simulateur"
                  className="inline-flex min-h-11 items-center justify-center rounded-xl border border-transparent bg-white px-6 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-white/90"
                >
                  Ouvrir le simulateur complet
                </Link>
                <Link
                  to="/workers#install"
                  className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/35 bg-white/5 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/12"
                >
                  Installer le worker
                </Link>
              </div>
            </motion.div>

            <div className="rounded-2xl border border-white/14 bg-white/8 p-5 backdrop-blur-xl">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase text-white/50">Workers live</p>
                  <p className="mt-2 font-display text-5xl font-semibold text-white">
                    {fmtInt(status?.network.workersLive ?? networkStats?.onlineCount)}
                  </p>
                </div>
                <span className="rounded-full border border-emerald-200/25 bg-emerald-300/12 px-3 py-1 text-xs font-semibold text-emerald-100">
                  refresh 15s
                </span>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <p className="text-xs text-white/50">Tokens 24h</p>
                  <p className="mt-1 font-mono text-xl font-semibold text-white">
                    {fmtInt(networkStats?.totalTokens24h ?? status?.network.tokens24h)}
                  </p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <p className="text-xs text-white/50">Bench TPS p95</p>
                  <p className="mt-1 font-mono text-xl font-semibold text-white">
                    {fmtTps(benchmarks?.summary.hotTpsP95 ?? status?.benchmark.tpsP95Active)}
                  </p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <p className="text-xs text-white/50">TTFT p50</p>
                  <p className="mt-1 font-mono text-xl font-semibold text-white">
                    {fmtMs(benchmarks?.summary.ttftP50Ms ?? status?.network.ttftP50Ms)}
                  </p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <p className="text-xs text-white/50">Part worker</p>
                  <p className="mt-1 font-mono text-xl font-semibold text-white">{fmtInt(payoutShare)}%</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        {error ? (
          <div className="mb-6 rounded-2xl border border-alert/40 bg-alert/10 p-4 text-sm text-alert">{error}</div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <WorkerKpi
            label="Workers online"
            value={fmtInt(status?.network.workersOnline ?? networkStats?.onlineCount)}
            detail={`${fmtInt(status?.network.workersRegistered ?? networkStats?.registeredWorkers)} enregistrés`}
            tone="cyan"
          />
          <WorkerKpi
            label="Tokens 30 jours"
            value={fmtInt(networkStats?.totalTokens30d ?? status?.network.tokens30d)}
            detail={`${fmtInt(networkStats?.activeWorkers30d)} worker(s) actifs sur 30j`}
            tone="emerald"
          />
          <WorkerKpi
            label="Latence p95"
            value={fmtMs(benchmarks?.summary.latencyP95Ms ?? status?.network.latencyP95Ms)}
            detail={`TTFT p50 ${fmtMs(benchmarks?.summary.ttftP50Ms ?? status?.network.ttftP50Ms)}`}
            tone="amber"
          />
          <WorkerKpi
            label="Reward share"
            value={`${fmtInt(payoutShare)}%`}
            detail={`marge publique estimée ${fmtInt(marginShare)}%`}
            tone="slate"
          />
        </div>

        <div className="mt-8 grid gap-5 xl:grid-cols-[1.08fr_.92fr]">
          <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Preuve réseau</p>
                <h2 className="mt-2 font-display text-2xl font-semibold text-fg">Métriques publiques redacted</h2>
              </div>
              <Link to="/network" className="text-sm font-semibold text-accent hover:underline">
                Voir la page network
              </Link>
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="panel-inset rounded-2xl p-4">
                <p className="font-mono text-xs uppercase tracking-wide text-muted">Benchmark public</p>
                <p className="mt-2 text-sm text-muted">
                  {status?.benchmark.modelTarget || 'Modèle benchmark'} · {fmtInt(benchmarks?.summary.hotSamples ?? status?.benchmark.sampleSize)} runs actifs
                </p>
                <p className="mt-4 font-display text-3xl font-bold text-fg">
                  {fmtTps(benchmarks?.summary.hotTpsP50 ?? status?.benchmark.tpsAverageActive)} TPS
                </p>
                <p className="mt-1 text-xs text-muted">
                  p95 {fmtTps(benchmarks?.summary.hotTpsP95 ?? status?.benchmark.tpsP95Active)} · coût estimé{' '}
                  {status?.benchmark.costEstimatedEurPerMillion != null
                    ? `${status.benchmark.costEstimatedEurPerMillion.toFixed(4)} €/M`
                    : '—'}
                </p>
              </div>
              <div className="panel-inset rounded-2xl p-4">
                <p className="font-mono text-xs uppercase tracking-wide text-muted">Ledger worker</p>
                <p className="mt-2 text-sm text-muted">
                  Tokens 1h {fmtInt(networkStats?.totalTokens1h)} · tokens 24h {fmtInt(networkStats?.totalTokens24h)}
                </p>
                <p className="mt-4 font-display text-3xl font-bold text-fg">
                  {fmtInt(networkStats?.avgTokensPerActiveWorker30d)}
                </p>
                <p className="mt-1 text-xs text-muted">tokens moyens / worker actif sur 30 jours</p>
              </div>
            </div>
            <div className="mt-6 rounded-2xl border border-border bg-bg/60 p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-muted">Workers live</p>
              <div className="mt-4 space-y-3">
                {liveWorkers.length === 0 ? (
                  <p className="text-sm text-muted">Aucun worker public visible dans la fenêtre heartbeat.</p>
                ) : (
                  liveWorkers.map((worker) => (
                    <div key={`${worker.peerLabel}-${worker.gpuName || 'gpu'}`} className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-fg">{worker.gpuName || 'GPU non déclaré'}</p>
                        <p className="mt-1 truncate font-mono text-xs text-muted">
                          {worker.peerLabel} · {worker.runtimeBackend} · {worker.weightQuantization} · {worker.model || 'modèle auto'}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-mono text-sm text-fg">
                          {worker.allocatedVramGb || worker.gpuVramGb || 0} Go
                        </p>
                        <p className="text-xs text-muted">{worker.uptimeBucket || worker.presence || 'heartbeat récent'}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>

          <div className="flex flex-col gap-5">
            <section className="panel rounded-2xl border-electric/20 bg-gradient-to-b from-surface to-bg p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-xs uppercase tracking-wide text-muted">Simulation ciblée</p>
                  <h2 className="mt-2 font-display text-2xl font-semibold text-fg">{selectedGpu?.name || 'GPU'}</h2>
                </div>
                <span className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 font-mono text-[11px] font-semibold text-accent">
                  {workerMode === 'race-pool' ? 'pool réservé' : 'solo'}
                </span>
              </div>
              {selectedGpu && selectedProfit ? (
                <>
                  <div className="mt-6 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl border border-border/80 bg-bg/55 p-3">
                      <p className="font-mono text-[10px] text-muted">Net / mois</p>
                      <p className="mt-1 font-display text-2xl font-bold text-success">
                        {formatEur(selectedProfit.netMonthlyEuro)}
                        <EurSign className="text-success" />
                      </p>
                    </div>
                    <div className="rounded-xl border border-border/80 bg-bg/55 p-3">
                      <p className="font-mono text-[10px] text-muted">Brut / mois</p>
                      <p className="mt-1 font-display text-2xl font-bold text-fg">
                        {formatEur(selectedProfit.grossMonthlyEuro)}
                        <EurSign />
                      </p>
                    </div>
                    <div className="rounded-xl border border-border/80 bg-bg/55 p-3">
                      <p className="font-mono text-[10px] text-muted">ROI MSRP</p>
                      <p className="mt-1 font-display text-2xl font-bold text-electric">
                        {selectedProfit.roiMonths != null ? `${selectedProfit.roiMonths.toFixed(0)} m` : '—'}
                      </p>
                    </div>
                  </div>
                  <div className="mt-5 rounded-2xl border border-border bg-bg/55 p-4">
                    <DetailRow label="VRAM" value={`${selectedGpu.vram} Go`} />
                    <DetailRow label="Indice perf" value={String(selectedGpu.fp16Tflops)} />
                    <DetailRow label="Électricité / mois" value={`${formatEur(selectedProfit.electricityMonthlyEuro)} €`} />
                    <DetailRow label="Facteur mémoire" value={`×${selectedProfit.vramRevenueFactor.toFixed(2)}`} />
                    <DetailRow label="Taux interne" value={`${WORKER_EUR_PER_TFLOP_HOUR.toFixed(3)} € / unité / h`} />
                  </div>
                </>
              ) : null}
            </section>
            <WorkerSetupPanel showDownloadCta={false} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12 lg:px-6 lg:py-16" aria-labelledby="worker-simulator-heading">
        <div className="flex flex-col gap-10 lg:flex-row lg:items-start lg:gap-12">
          <aside className="w-full shrink-0 space-y-8 lg:w-[min(100%,280px)] lg:max-w-[300px] lg:pr-2">
            <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">Hypothèses</p>
              <label htmlFor="worker-util" className="mt-4 block font-mono text-xs text-muted">
                Disponibilité (% du mois)
              </label>
              <div className="mt-2 flex items-center gap-3">
                <input
                  id="worker-util"
                  type="range"
                  min={10}
                  max={100}
                  value={utilizationPct}
                  onChange={(e) => setUtilizationPct(Number(e.target.value))}
                  className="h-2 w-full accent-accent"
                />
                <span className="w-10 text-right font-mono text-sm">{utilizationPct}</span>
              </div>
              <label htmlFor="worker-kwh" className="mt-5 block font-mono text-xs text-muted">
                Électricité (€ / kWh)
              </label>
              <div className="mt-2 flex items-center gap-3">
                <input
                  id="worker-kwh"
                  type="range"
                  min={0.08}
                  max={0.55}
                  step={0.01}
                  value={electricityEurPerKwh}
                  onChange={(e) => setElectricityEurPerKwh(Number(e.target.value))}
                  className="h-2 w-full accent-electric"
                />
                <span className="w-12 text-right font-mono text-sm">{electricityEurPerKwh.toFixed(2)}</span>
              </div>
              <p className="mt-2 text-xs text-muted">
                On réutilise ici le vrai moteur de simulation du produit, pas une fourchette marketing séparée.
              </p>
              <p className="mt-4 font-mono text-xs text-muted">Mode worker</p>
              <div className="mt-2 flex rounded-lg bg-surface p-1">
                <button
                  type="button"
                  className={`flex-1 rounded-md py-2 text-xs font-semibold sm:text-sm ${
                    workerMode === 'solo' ? 'bg-card text-fg shadow-sm' : 'text-muted'
                  }`}
                  onClick={() => setWorkerMode('solo')}
                >
                  Solo
                </button>
                <button
                  type="button"
                  className={`flex-1 rounded-md py-2 text-xs font-semibold sm:text-sm ${
                    workerMode === 'race-pool' ? 'bg-card text-fg shadow-sm' : 'text-muted'
                  }`}
                  onClick={() => setWorkerMode('race-pool')}
                >
                  Pool réservé
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">Cadre réel</p>
              <div className="mt-4 space-y-4">
                <div className="flex gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-300/10 text-cyan-500">
                    <IconTerminal className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-fg">Heartbeat + déclaration</p>
                    <p className="text-sm text-muted">Le worker remonte son runtime, sa VRAM, son backend et son état.</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-300/10 text-emerald-500">
                    <IconBolt className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-fg">Scheduler réservé</p>
                    <p className="text-sm text-muted">Les tâches partent vers des workers compatibles, pas vers un broadcast opaque.</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-300/10 text-amber-500">
                    <IconClock className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-fg">Bench et ledger</p>
                    <p className="text-sm text-muted">Latence, TTFT, TPS et tokens worker sont journalisés côté réseau.</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-fuchsia-300/10 text-fuchsia-500">
                    <IconShield className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-fg">Flux redacted</p>
                    <p className="text-sm text-muted">Les preuves publiques restent redacted ; les détails sensibles restent côté admin.</p>
                  </div>
                </div>
              </div>
            </div>

            {selectedGpu && selectedProfit ? (
              <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
                <p className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">Flotte simulée</p>
                <button
                  type="button"
                  className="btn-primary mt-5 w-full rounded-lg py-3 text-sm font-semibold"
                  onClick={() => addGpuToFleet(selectedGpu.id)}
                >
                  Ajouter {selectedGpu.name}
                </button>
                {fleetLines.length > 0 ? (
                  <>
                    <ul className="mt-4 space-y-2 text-sm">
                      {fleetLines.map(({ gpu, count }) => (
                        <li key={gpu.id} className="flex items-center justify-between gap-2">
                          <span className="truncate text-fg">
                            {gpu.name} <span className="text-muted">×{count}</span>
                          </span>
                          <button
                            type="button"
                            className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted hover:border-alert/40 hover:text-alert"
                            onClick={() => removeOneFromFleet(gpu.id)}
                          >
                            −1
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="divider my-4" />
                    <div className="flex justify-between text-sm">
                      <span className="text-muted">Net flotte / mois</span>
                      <span className="font-mono font-bold text-success">
                        {formatEur(fleetProfit.netMonthlyEuro)}
                        <EurSign />
                      </span>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </aside>

          <div className="min-w-0 flex-1">
            <div className="mb-6">
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">Simulateur worker</p>
              <h2 id="worker-simulator-heading" className="mt-2 font-display text-3xl font-semibold text-fg">
                Rentabilité GPU, branchée sur le vrai moteur Vryx.
              </h2>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-muted sm:text-base">
                Même logique que dans l’application : disponibilité, électricité, mode d’exécution, facteur VRAM et
                simulation de flotte. La différence ici, c’est qu’on l’inscrit dans le contexte live du réseau.
              </p>
            </div>

            <div className="mb-6 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <input
                  type="search"
                  placeholder="Rechercher un GPU…"
                  value={gpuQuery}
                  onChange={(e) => setGpuQuery(e.target.value)}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg sm:col-span-2"
                />
                <select
                  value={vendorFilter}
                  onChange={(e) => setVendorFilter(e.target.value as typeof vendorFilter)}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                >
                  <option value="all">Tous fabricants</option>
                  <option value="NVIDIA">NVIDIA</option>
                  <option value="AMD">AMD</option>
                  <option value="Apple">Apple</option>
                </select>
                <select
                  value={tierFilter}
                  onChange={(e) => setTierFilter(e.target.value as typeof tierFilter)}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                >
                  <option value="all">Tous segments</option>
                  <option value="consumer">Grand public</option>
                  <option value="workstation">Workstation</option>
                  <option value="datacenter">Datacenter</option>
                </select>
                <label className="flex items-center gap-2 text-sm text-muted sm:col-span-2 lg:col-span-1">
                  VRAM min.
                  <input
                    type="number"
                    min={0}
                    max={192}
                    value={vramMin || ''}
                    placeholder="0"
                    onChange={(e) => setVramMin(Number(e.target.value) || 0)}
                    className="w-20 rounded-lg border border-border bg-bg px-2 py-1.5 text-fg"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-muted sm:col-span-2 lg:col-span-3">
                  Trier par
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-fg"
                  >
                    <option value="net">Net décroissant</option>
                    <option value="vram">VRAM (Go)</option>
                    <option value="roi">ROI (mois)</option>
                    <option value="name">Nom</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <WorkerKpi
                label="GPU sélectionné"
                value={selectedGpu?.vram ? `${selectedGpu.vram} Go` : '—'}
                detail={selectedGpu?.name || 'Aucun GPU'}
                tone="slate"
              />
              <WorkerKpi
                label="Net / mois"
                value={`${formatEur(selectedProfit?.netMonthlyEuro || 0)} €`}
                detail={`${utilizationPct}% disponibilité · ${electricityEurPerKwh.toFixed(2)} €/kWh`}
                tone="emerald"
              />
              <WorkerKpi
                label="Top 8 moyen"
                value={`${formatEur(topGpuRows.reduce((sum, row) => sum + row.profit.netMonthlyEuro, 0) / Math.max(1, topGpuRows.length))} €`}
                detail="net mensuel moyen des GPU actuellement visibles"
                tone="amber"
              />
              <WorkerKpi
                label="Flotte / mois"
                value={`${formatEur(fleetProfit.netMonthlyEuro)} €`}
                detail={`${fleetLines.reduce((sum, row) => sum + row.count, 0)} GPU dans la flotte simulée`}
                tone="cyan"
              />
            </div>

            <div className="mt-5 overflow-x-auto rounded-2xl border border-border bg-card">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                    <th className="px-3 py-3">GPU</th>
                    <th className="px-2 py-3">VRAM</th>
                    <th className="px-2 py-3">Perf</th>
                    <th className="px-2 py-3">TDP</th>
                    <th className="px-2 py-3">Brut</th>
                    <th className="px-2 py-3">Élec.</th>
                    <th className="px-2 py-3">Net</th>
                    <th className="px-2 py-3">ROI</th>
                    <th className="px-2 py-3">12 m.</th>
                  </tr>
                </thead>
                <tbody>
                  {workerRows.map(({ gpu, profit }) => {
                    const active = gpu.id === selectedGpuId
                    return (
                      <tr
                        key={gpu.id}
                        className={`cursor-pointer border-b border-border last:border-0 ${active ? 'bg-accent/5' : 'hover:bg-elevated/80'}`}
                        onClick={() => setSelectedGpuId(gpu.id)}
                      >
                        <td className="px-3 py-2.5 font-medium text-fg">
                          <span className="block max-w-[220px] truncate sm:max-w-none">{gpu.name}</span>
                          <span className="font-mono text-[10px] text-muted">{gpu.vendor} · {gpu.tier}</span>
                        </td>
                        <td className="px-2 py-2.5 font-mono text-muted">{gpu.vram} Go</td>
                        <td className="px-2 py-2.5 font-mono text-muted">{gpu.fp16Tflops}</td>
                        <td className="px-2 py-2.5 font-mono text-muted">{gpu.tdp} W</td>
                        <td className="px-2 py-2.5 font-mono tabular-nums">{formatEur(profit.grossMonthlyEuro)}</td>
                        <td className="px-2 py-2.5 font-mono tabular-nums text-warning">{formatEur(profit.electricityMonthlyEuro)}</td>
                        <td className="px-2 py-2.5 font-mono font-semibold tabular-nums text-success">{formatEur(profit.netMonthlyEuro)}</td>
                        <td className="px-2 py-2.5 font-mono text-muted">
                          {profit.roiMonths != null ? `${profit.roiMonths.toFixed(0)} m` : '-'}
                        </td>
                        <td className="px-2 py-2">
                          <Sparkline values={workerNetSparkline12(profit.netMonthlyEuro)} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-muted">{disc.workerSim}</p>
          </div>
        </div>
      </section>

      <section className="relative isolate overflow-hidden border-y border-border py-16 sm:py-20 lg:py-24" aria-labelledby="workflow-workers">
        <div className="absolute inset-0 bg-cover bg-center bg-no-repeat" style={{ backgroundImage: "url('/heroes/mid-section.webp')" }} aria-hidden />
        <div className="hero-overlay absolute inset-0" aria-hidden />
        <div className="relative z-10 mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <h2 id="workflow-workers" className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              Chemin réel d’un worker
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-white/72 sm:text-base">
              La page ne raconte plus un simple onboarding : elle suit la logique réelle du réseau, de la déclaration à
              la réservation puis au ledger.
            </p>
          </div>
          <ol className="mx-auto mt-12 grid max-w-5xl list-none gap-5 p-0 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { step: '01', title: 'Déclaration', body: 'Le worker enregistre son hardware, son backend, sa VRAM et son heartbeat.' },
              { step: '02', title: 'Sélection', body: 'Le scheduler réserve des workers compatibles avec le modèle et le mode demandé.' },
              { step: '03', title: 'Run', body: 'Le pipeline exécute les fragments utiles et renvoie les métriques de latence et TPS.' },
              { step: '04', title: 'Ledger', body: 'Les tokens générés alimentent les preuves réseau et le futur payout worker.' },
            ].map((row) => (
              <li
                key={row.step}
                className="flex flex-col rounded-2xl border border-white/10 bg-black/50 px-5 pb-5 pt-6 text-center shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] sm:px-6 sm:pb-6 sm:pt-7"
              >
                <div className="mx-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/20 bg-page-hero/85 font-mono text-xs font-semibold tabular-nums text-white dark:bg-black/50">
                  {row.step}
                </div>
                <h3 className="mt-4 font-display text-base font-semibold text-white sm:text-lg">{row.title}</h3>
                <p className="mt-2 grow text-sm leading-relaxed text-white/68">{row.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="bg-bg py-14 sm:py-20" aria-labelledby="faq-workers">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <h2 id="faq-workers" className="font-display text-2xl font-semibold text-fg sm:text-3xl">
            Questions fréquentes
          </h2>
          <div className="mt-8 space-y-3">
            {WORKERS_FAQ.map((item) => (
              <details key={item.q} className="group panel px-4 py-1 open:border-electric/30">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 font-medium text-fg [&::-webkit-details-marker]:hidden">
                  <span>{item.q}</span>
                  <span className="shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden>
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m19 9-7 7-7-7" />
                    </svg>
                  </span>
                </summary>
                <p className="border-t border-border/80 pb-4 text-sm leading-relaxed text-muted">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border bg-surface py-14 sm:py-16" aria-labelledby="cta-workers">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 id="cta-workers" className="font-display text-xl font-semibold text-fg sm:text-2xl">
            Rejoindre le réseau
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-muted">
            {user
              ? 'Installez le client worker, laissez le scheduler vous placer, puis suivez la progression réseau depuis votre compte.'
              : 'Créez votre compte, installez le client worker, puis laissez le scheduler vous placer dans les runs compatibles.'}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to={user ? '/compte' : '/inscription'} className="btn-primary rounded-xl px-8 py-3 text-sm font-semibold sm:text-base">
              {user ? 'Mon compte' : 'S’inscrire'}
            </Link>
            <Link to="/clients" className="btn-secondary rounded-xl px-8 py-3 text-sm font-semibold sm:text-base">
              Côté client API
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
