import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminShell } from '../components/admin/AdminShell'
import { workerLabel, type LiveWorker } from '../components/admin/AdminP2PChatPanel'
import { apiJson, apiUrl } from '../lib/api'
import { displayLabel } from '../lib/displayLabels'

type Worker = {
  pid: number
  command: string
  mode: 'initiator' | 'worker' | 'inference' | 'unknown'
  grpcPort: number | null
  p2pPort: number | null
  cpuPercent: number
  memMB: number
  startedAt: string
  uptimeSec: number
  listenIps: string[]
  peerIps: string[]
  status: 'online' | 'starting' | 'unreachable'
  lastLatencyMs: number | null
}

type RegisteredWorker = {
  peerId: string
  mode: string
  grpcPort: number | null
  p2pPort: number | null
  publicIp: string | null
  version: string | null
  p2pPeers: number
  tokensGenerated: number
  tokensIn: number
  tokensOut: number
  model: string | null
  ownerEmail: string | null
  lastHeartbeatAt: string | null
  firstSeenAt: string | null
  online: boolean
  secondsSinceHeartbeat: number
  gpuName?: string | null
  gpuVramMb?: number | null
}

type NodeStatus = {
  sampledAt: number
  cumulativeRequests: number
  system: {
    hostname: string
    platform: string
    kernel: string
    arch: string
    uptimeSec: number
    cpu: { model: string; cores: number; loadAvg: number[]; usagePercent: number }
    memory: { totalMB: number; usedMB: number; freeMB: number; percent: number }
    gpus: {
      vendor: string
      name: string
      driver: string
      vramTotalMB: number
      vramUsedMB: number
      utilizationPercent: number
    }[]
    vram: { totalMB: number; usedMB: number; count: number }
    network: { interfaces: { iface: string; ip: string }[] }
  }
  workers: Worker[]
}

type HistoryPayload = {
  points: {
    t: number
    cpuPercent: number
    memPercent: number
    workerCount: number
    avgComputeMs: number
    avgP2pMs: number
  }[]
  tests: TestReport[]
}

type TestReport = {
  id: string
  startedAt: string
  finishedAt: string
  durationMs: number
  type: 'unit' | 'stress'
  parallel: number
  repeat: number
  totalCalls: number
  successCalls: number
  failedCalls: number
  workersDetected: number
  metrics: {
    avgComputeMs: number | null
    avgP2pMs: number | null
    minLatencyMs: number | null
    maxLatencyMs: number | null
  }
}

type PoolSnapshot = {
  ok: boolean
  sampledAt: number
  liveSec: number
  registeredWorkers: RegisteredWorker[]
  liveWorkers: LiveWorker[]
  totalTokensGenerated: number
  nodeStatus: NodeStatus
  history: HistoryPayload
  pool: {
    id: string
    status: string
    model: string
    routingPath: string[]
    totalVramMb: number
    requiredModelVramMb: number
    estimatedWorkersNeeded: number
    replicationFactor: number
    hotWorkers: number
    warmReplicas: number
    largestGpu: { peerId: string; gpuName: string | null; gpuVramMb: number | null } | null
    latencyTargetsMs: {
      hotRouting: [number, number]
      firstTokenSmallModel: [number, number]
      nextTokenWithKvCache: [number, number]
      hotFailover: [number, number]
      coldShardReload: [number, number]
    }
    assignments: {
      peer: string
      rank: number
      role: string
      gpu: string | null
      vramMb: number | null
      ready: boolean
    }[]
  }
}

function formatUptime(sec: number) {
  if (!sec || sec < 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d} j ${h} h`
  if (h > 0) return `${h} h ${m} min`
  return `${m} min`
}

function formatMs(v: number | null) {
  if (v == null) return '—'
  if (v < 10) return `${v.toFixed(2)} ms`
  return `${Math.round(v)} ms`
}

function StatusDot({ status }: { status: Worker['status'] }) {
  const color =
    status === 'online' ? 'bg-success' : status === 'unreachable' ? 'bg-alert' : 'bg-warning'
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ${color} ${
          status === 'online' ? 'animate-pulse' : ''
        }`}
        aria-hidden
      />
      <span className="text-xs font-medium text-fg">{displayLabel(status)}</span>
    </span>
  )
}

function MiniSparkline({
  points,
  field,
  color = '#2563eb',
}: {
  points: HistoryPayload['points']
  field: 'cpuPercent' | 'memPercent' | 'avgComputeMs' | 'workerCount'
  color?: string
}) {
  if (points.length === 0) {
    return <div className="h-12 text-xs text-muted">Pas encore de données.</div>
  }
  const values = points.map((p) => p[field] as number)
  const max = Math.max(1, ...values)
  const min = Math.min(0, ...values)
  const range = Math.max(0.1, max - min)
  const w = 320
  const h = 60
  const step = points.length > 1 ? w / (points.length - 1) : w
  const path = values
    .map((v, i) => {
      const x = i * step
      const y = h - ((v - min) / range) * (h - 6) - 3
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full">
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  )
}


export function AdminNodePage() {
  const [status, setStatus] = useState<NodeStatus | null>(null)
  const [history, setHistory] = useState<HistoryPayload | null>(null)
  const [registeredWorkers, setRegisteredWorkers] = useState<RegisteredWorker[]>([])
  const [liveWorkers, setLiveWorkers] = useState<LiveWorker[]>([])
  const [liveSec, _setLiveSec] = useState(30)
  void liveSec; void _setLiveSec
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(5)
  const [poolSnapshot, setPoolSnapshot] = useState<PoolSnapshot | null>(null)

  const [testParallel, setTestParallel] = useState(4)
  const [testRepeat, setTestRepeat] = useState(20)
  const [testRunning, setTestRunning] = useState<'unit' | 'stress' | null>(null)
  const [lastReport, setLastReport] = useState<TestReport | null>(null)
  const [totalTokens, setTotalTokens] = useState(0)
  /** Horloge locale pour afficher l’âge du dernier échantillon sans appeler Date.now() au rendu. */
  const [clockMs, setClockMs] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    const [s, h, w] = await Promise.all([
      apiJson<NodeStatus>('/api/admin/node/status'),
      apiJson<HistoryPayload>('/api/admin/node/history?limit=120'),
      apiJson<{ workers: RegisteredWorker[]; totalTokensGenerated: number }>('/api/admin/workers/registered'),
    ])
    if (s.ok === true) {
      setStatus(s.data)
      setError(null)
    } else {
      setError(s.error)
    }
    if (h.ok === true) setHistory(h.data)
    if (w.ok === true) {
      setRegisteredWorkers(w.data.workers)
      // On calcule les tokens cumulés en temps réel si besoin, 
      // mais on fait confiance à totalTokensGenerated du backend
      setTotalTokens(w.data.totalTokensGenerated)
    }
  }, [])

  useEffect(() => {
    const source = new EventSource(apiUrl('/api/admin/pool/stream'))
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as PoolSnapshot | { ok: false; error?: string }
        if ('error' in data && data.ok === false) {
          setError(data.error || 'Flux pool indisponible.')
          return
        }
        const snapshot = data as PoolSnapshot
        setPoolSnapshot(snapshot)
        setStatus(snapshot.nodeStatus)
        setHistory(snapshot.history)
        setRegisteredWorkers(snapshot.registeredWorkers)
        setLiveWorkers(snapshot.liveWorkers)
        setTotalTokens(snapshot.totalTokensGenerated)
        _setLiveSec(snapshot.liveSec)
        setError(null)
      } catch {
        setError('Flux pool invalide.')
      }
    }
    source.onerror = () => {
      setError('Flux pool interrompu, bascule en actualisation manuelle.')
      source.close()
      void refresh()
    }
    return () => source.close()
  }, [refresh])

  useEffect(() => {
    const id = window.setInterval(() => setClockMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const refreshLive = useCallback(async () => {
    const r = await apiJson<{ workers: LiveWorker[]; liveSec?: number }>('/api/admin/workers/live')
    if (r.ok === true && r.data) {
      setLiveWorkers(r.data.workers)
      if (typeof r.data.liveSec === 'number') _setLiveSec(r.data.liveSec)
    }
  }, [])

  useEffect(() => {
    if (poolSnapshot) return
    const timerBoot = window.setTimeout(() => {
      void refreshLive()
    }, 0)
    return () => window.clearTimeout(timerBoot)
  }, [refreshLive])

  async function runTest(stress: boolean) {
    setTestRunning(stress ? 'stress' : 'unit')
    const r = await apiJson<{ report: TestReport }>(
      stress ? '/api/admin/node/stress' : '/api/admin/node/test',
      {
        method: 'POST',
        body: JSON.stringify({ parallel: testParallel, repeat: testRepeat }),
      },
    )
    setTestRunning(null)
    if (r.ok === true) {
      setLastReport(r.data.report)
      setHint(
        `Test ${stress ? 'de charge' : 'unitaire'} terminé : ${r.data.report.successCalls}/${r.data.report.totalCalls} appels réussis`,
      )
      window.setTimeout(() => setHint(null), 5000)
      await refresh()
    } else {
      setError(r.error)
    }
  }

  const workersByMode = useMemo(() => {
    if (!status) return { initiator: 0, worker: 0, inference: 0 }
    return {
      initiator: status.workers.filter((w) => w.mode === 'initiator').length,
      worker: status.workers.filter((w) => w.mode === 'worker').length,
      inference: status.workers.filter((w) => w.mode === 'inference').length,
    }
  }, [status])

  const onlineWorkers = useMemo(
    () => status?.workers.filter((w) => w.status === 'online') ?? [],
    [status],
  )
  const onlineRegistered = registeredWorkers.filter(w => w.online)

  const aggregateStats = useMemo(() => {
    return onlineRegistered.reduce(
      (acc, w) => {
        acc.gpuCount += 1
        acc.totalTokens += w.tokensGenerated
        acc.totalIn += w.tokensIn || 0
        acc.totalOut += w.tokensOut || 0
        if (w.gpuVramMb != null && w.gpuVramMb > 0) {
          acc.vramTotalMB += w.gpuVramMb
          acc.gpuWithInventory += 1
        }
        return acc
      },
      {
        vramTotalMB: 0,
        gpuCount: 0,
        gpuWithInventory: 0,
        totalTokens: 0,
        totalIn: 0,
        totalOut: 0,
      },
    )
  }, [onlineRegistered])

  const uniqueWorkers = useMemo(() => {
    const map = new Map<string, RegisteredWorker>()
    // On priorise les workers enregistrés, mais on fusionne avec les infos "online"
    registeredWorkers.forEach(w => map.set(w.peerId, w))
    return Array.from(map.values())
  }, [registeredWorkers])

  const avgWorkerLatency = useMemo(() => {
    if (lastReport?.metrics.avgP2pMs) return lastReport.metrics.avgP2pMs;
    const list = onlineWorkers.filter((w) => w.lastLatencyMs != null)
    if (list.length === 0) return null
    return Math.round(
      (list.reduce((s, w) => s + (w.lastLatencyMs || 0), 0) / list.length) * 100,
    ) / 100
  }, [onlineWorkers, lastReport, aggregateStats.gpuCount])


  const navSections = [
    { id: 'synthese', label: 'Synthèse' },
    { id: 'pool-p2p', label: 'Pool P2P' },
    { id: 'live-reseau', label: 'Réseau live' },
    { id: 'systeme-gpu', label: 'Système et GPU' },
    { id: 'workers', label: 'Workers' },
    { id: 'tests', label: 'Tests' },
  ] as const

  return (
    <AdminShell title="Nœud Vryx" subtitle="Supervision du daemon et du réseau (heartbeats, métriques hôte)">
      <div className="mx-auto max-w-6xl space-y-6 pb-10">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Link
            to="/admin/chat-p2p"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-accent/35 bg-accent/10 px-4 py-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/15 sm:order-2 sm:shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4" aria-hidden>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Ouvrir le Chat P2P dédié
          </Link>
          <p className="text-xs leading-relaxed text-muted sm:order-1 sm:max-w-xl">
            Le chat temps réel et les traces détaillées du pipeline distribué sont sur la page Chat P2P.
          </p>
        </div>

        <nav
          className="-mx-1 flex gap-1 overflow-x-auto pb-1 scrollbar-thin sm:mx-0"
          aria-label="Sections du nœud"
        >
          {navSections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="shrink-0 rounded-lg border border-border/80 bg-surface px-3 py-2 text-[11px] font-medium text-muted transition-colors hover:border-accent/40 hover:text-fg"
            >
              {s.label}
            </a>
          ))}
        </nav>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between" id="synthese">
          <div>
            <h2 className="font-display text-xl font-bold text-fg">
              Vryx Control Center — LIVE
            </h2>
            <p className="mt-1 text-sm text-muted">
              {status
                ? `Hôte ${status.system.hostname} · ${status.system.platform} · uptime ${formatUptime(status.system.uptimeSec)}`
                : 'Connexion au nœud…'}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <label htmlFor="refresh">Flux</label>
            <select
              id="refresh"
              value={refreshIntervalSec}
              onChange={(e) => setRefreshIntervalSec(Number(e.target.value))}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg"
            >
              <option value={5}>SSE 15 s</option>
            </select>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-md border border-border px-3 py-1 text-xs text-fg hover:border-accent/40 hover:text-accent"
            >
              Actualiser
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-alert/50 bg-alert/10 px-4 py-3 text-sm text-alert" role="alert">
            {error}
          </div>
        )}
        {hint && (
          <div
            className="rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm text-success"
            role="status"
          >
            {hint}
          </div>
        )}

        <section id="pool-p2p" className="scroll-mt-24 space-y-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-fg">Pool P2P LLM persistante</h3>
              <p className="text-[11px] text-muted">
                Placement pondéré par VRAM, routing sticky et modèle résident côté workers. Les données arrivent par SSE.
              </p>
            </div>
            <span className="shrink-0 rounded-md border border-accent/25 bg-accent/5 px-2 py-1 text-[11px] font-medium text-accent">
              {displayLabel(poolSnapshot?.pool.status || 'initialisation')}
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-4">
            <div className="panel p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted">VRAM pool</p>
              <p className="mt-1 font-display text-xl font-bold text-fg">
                {poolSnapshot ? `${(poolSnapshot.pool.totalVramMb / 1024).toFixed(1)} Go` : '—'}
              </p>
              <p className="mt-1 text-[10px] text-muted">
                Besoin cible : {poolSnapshot ? `${(poolSnapshot.pool.requiredModelVramMb / 1024).toFixed(0)} Go` : '—'}
              </p>
            </div>
            <div className="panel p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted">Workers hot</p>
              <p className="mt-1 font-display text-xl font-bold text-success">
                {poolSnapshot?.pool.hotWorkers ?? '—'}
              </p>
              <p className="mt-1 text-[10px] text-muted">
                Réplication : x{poolSnapshot?.pool.replicationFactor ?? 0}
              </p>
            </div>
            <div className="panel p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted">Routage hot</p>
              <p className="mt-1 font-display text-xl font-bold text-electric">
                {poolSnapshot ? `${poolSnapshot.pool.latencyTargetsMs.hotRouting[0]}-${poolSnapshot.pool.latencyTargetsMs.hotRouting[1]} ms` : '—'}
              </p>
              <p className="mt-1 text-[10px] text-muted">Préparation de chaîne sans reload.</p>
            </div>
            <div className="panel p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted">Failover hot</p>
              <p className="mt-1 font-display text-xl font-bold text-fg">
                {poolSnapshot ? `${poolSnapshot.pool.latencyTargetsMs.hotFailover[0]}-${poolSnapshot.pool.latencyTargetsMs.hotFailover[1]} ms` : '—'}
              </p>
              <p className="mt-1 text-[10px] text-muted">Si shard répliqué déjà chargé.</p>
            </div>
          </div>
          <div className="panel overflow-hidden p-0">
            <div className="border-b border-border px-4 py-3">
              <p className="text-xs font-semibold text-fg">Chaîne active et placement</p>
              <p className="mt-1 text-[10px] text-muted">
                Gros GPU réservés aux extrémités : embedding au début, lm_head à la fin.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-surface/60 text-[10px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2">Rang</th>
                    <th className="px-4 py-2">Pair</th>
                    <th className="px-4 py-2">Rôle</th>
                    <th className="px-4 py-2">GPU</th>
                    <th className="px-4 py-2">VRAM</th>
                    <th className="px-4 py-2">État</th>
                  </tr>
                </thead>
                <tbody>
                  {(poolSnapshot?.pool.assignments ?? []).map((a) => (
                    <tr key={`${a.peer}-${a.rank}`} className="border-t border-border/60">
                      <td className="px-4 py-2 font-mono">{a.rank}</td>
                      <td className="px-4 py-2 font-mono">{a.peer.slice(0, 18)}…</td>
                      <td className="px-4 py-2">{a.role}</td>
                      <td className="px-4 py-2">{a.gpu || '—'}</td>
                      <td className="px-4 py-2">{a.vramMb ? `${(a.vramMb / 1024).toFixed(1)} Go` : '—'}</td>
                      <td className="px-4 py-2">{a.ready ? 'Prêt' : 'En attente'}</td>
                    </tr>
                  ))}
                  {!poolSnapshot?.pool.assignments?.length && (
                    <tr>
                      <td className="px-4 py-6 text-center text-muted" colSpan={6}>
                        Aucun placement pool prêt pour le moment.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="live-reseau" className="scroll-mt-24 space-y-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-fg">Workers réseau (heartbeat rapide)</h3>
              <p className="text-[11px] text-muted">
                Rafraîchissement toutes les 3 s · fenêtre « live » {liveSec} s · hors fenêtre : voir le tableau
                enregistré plus bas.
              </p>
            </div>
            <span className="shrink-0 rounded-md border border-accent/25 bg-accent/5 px-2 py-1 text-[11px] font-medium text-accent">
              {liveWorkers.length} pair(s) récent(s)
            </span>
          </div>
          {liveWorkers.length === 0 ? (
            <div className="rounded-xl border border-border/80 bg-surface/40 px-4 py-6 text-center text-sm text-muted">
              Aucun heartbeat récent dans la fenêtre live. Les workers avec{' '}
              <span className="font-mono text-fg/90">--api-url</span> vers ce serveur apparaîtront ici.
            </div>
          ) : (
            <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
              {liveWorkers.map((w) => (
                <article
                  key={w.peerId}
                  className="min-w-[min(100%,17rem)] shrink-0 rounded-xl border border-border bg-surface p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-mono text-[11px] font-semibold leading-snug text-fg">{workerLabel(w)}</p>
                    <span className="flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-success" aria-hidden />
                  </div>
                  <p className="mt-2 text-[10px] uppercase tracking-wide text-muted">
                    {w.model || 'Modèle inconnu'} · {w.mode}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                    <dt className="text-muted">Pairs P2P</dt>
                    <dd className="text-right font-mono text-fg">{w.p2pPeers}</dd>
                    <dt className="text-muted">Heartbeat</dt>
                    <dd className="text-right text-fg">il y a {w.secondsSinceHeartbeat}s</dd>
                    <dt className="text-muted">GPU</dt>
                    <dd className="text-right text-fg">
                      {w.gpuName || '—'}
                      {w.gpuVramMb != null && w.gpuVramMb > 0 ? (
                        <span className="text-muted"> · {w.gpuVramMb} Mo</span>
                      ) : null}
                    </dd>
                  </dl>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="panel p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Workers détectés
            </p>
            <p className="mt-1 font-display text-2xl font-bold text-fg">
              {status?.workers.length ?? '—'}
            </p>
            <p className="mt-2 text-xs text-muted">
              {workersByMode.initiator} initiator · {workersByMode.worker} worker ·{' '}
              {workersByMode.inference} inference
            </p>
          </div>
          <div className="panel p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Tokens P2P Générés
            </p>
            <p className="mt-1 font-display text-2xl font-bold text-success">
              {totalTokens.toLocaleString()}
            </p>
            <div className="mt-2 flex gap-3 text-[10px] font-mono uppercase tracking-tighter">
              <span className="text-muted">
                Online (agrégé) in/out :{' '}
                <span className="text-fg">{aggregateStats.totalIn.toLocaleString()}</span> /{' '}
                <span className="text-fg">{aggregateStats.totalOut.toLocaleString()}</span>
              </span>
            </div>
            <p className="mt-1 text-[10px] text-muted">
              Total base : somme <span className="font-mono">tokens_generated</span> enregistrée (pas de double comptage avec les workers en ligne).
            </p>
          </div>
          <div className="panel p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Latence moyenne interne
            </p>
            <p className="mt-1 font-display text-2xl font-bold text-electric">
              {formatMs(avgWorkerLatency)}
            </p>
            <p className="mt-2 text-xs text-muted">
              {onlineWorkers.length} instance(s) répondante(s)
            </p>
          </div>
          <div className="panel p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              VRAM réseau (inventaire)
            </p>
            <p className="mt-1 font-display text-2xl font-bold text-fg">
              {aggregateStats.vramTotalMB > 0
                ? `${(aggregateStats.vramTotalMB / 1024).toFixed(1)} Go`
                : aggregateStats.gpuCount > 0
                  ? 'Non rapportée'
                  : '—'}
            </p>
            <p className="mt-2 text-xs text-muted">
              {aggregateStats.gpuWithInventory}/{aggregateStats.gpuCount} worker(s) avec{' '}
              <span className="font-mono">gpu_vram_mb</span> dans le heartbeat
            </p>
          </div>
          <div className="panel p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Compute Latency global
            </p>
            <p className="mt-1 font-display text-2xl font-bold text-fg">
              {formatMs(lastReport?.metrics.avgComputeMs ?? avgWorkerLatency)}
            </p>
            <p className="mt-2 text-xs text-muted">
              P2P Network : {formatMs(lastReport?.metrics.avgP2pMs ?? null)}
            </p>
          </div>
        </section>

        <section id="systeme-gpu" className="scroll-mt-24 grid gap-4 lg:grid-cols-2">
          <div className="panel p-5 sm:p-6">
            <h3 className="text-sm font-semibold text-fg">Système hôte</h3>
            {status ? (
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt className="text-muted">Hôte</dt>
                <dd className="font-mono text-fg">{status.system.hostname}</dd>
                <dt className="text-muted">OS</dt>
                <dd className="text-fg">
                  {status.system.platform} · {status.system.arch}
                </dd>
                <dt className="text-muted">Kernel</dt>
                <dd className="font-mono text-xs text-fg">{status.system.kernel}</dd>
                <dt className="text-muted">CPU</dt>
                <dd className="text-fg">
                  {status.system.cpu.cores} cœurs · {status.system.cpu.usagePercent}%
                </dd>
                <dt className="text-muted">Modèle CPU</dt>
                <dd className="text-xs text-fg">{status.system.cpu.model}</dd>
                <dt className="text-muted">Mémoire</dt>
                <dd className="text-fg">
                  {Math.round(status.system.memory.usedMB / 1024)} /{' '}
                  {Math.round(status.system.memory.totalMB / 1024)} Go (
                  {status.system.memory.percent}%)
                </dd>
                <dt className="text-muted">Load avg</dt>
                <dd className="font-mono text-xs text-fg">
                  {status.system.cpu.loadAvg.map((v) => v.toFixed(2)).join(' / ')}
                </dd>
                <dt className="text-muted">Interfaces</dt>
                <dd className="font-mono text-xs text-fg">
                  {status.system.network.interfaces.length === 0
                    ? '—'
                    : status.system.network.interfaces.map((i) => `${i.iface}: ${i.ip}`).join(', ')}
                </dd>
              </dl>
            ) : (
              <p className="mt-4 text-sm text-muted">Chargement…</p>
            )}
          </div>

          <div className="panel p-5 sm:p-6">
            <h3 className="text-sm font-semibold text-fg">Inventaire GPU du Réseau (P2P)</h3>
            {uniqueWorkers.filter(w => w.online).length > 0 ? (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {uniqueWorkers.filter(w => w.online).map((w) => (
                  <div key={w.peerId} className="group relative overflow-hidden rounded-xl border border-border bg-elevated p-4 transition-all hover:border-electric/35">
                    <div className="flex items-start justify-between">
                      <div>
                        <h4 className="font-mono text-[11px] font-bold text-fg">
                          {w.peerId.slice(0, 15)}...
                        </h4>
                        <p className="text-[10px] text-muted uppercase tracking-widest">{w.model || '—'}</p>
                      </div>
                      <div className="flex h-5 items-center rounded bg-success/10 px-2 text-[9px] font-bold text-success uppercase">
                        Online
                      </div>
                    </div>
                    
                    <div className="mt-4 flex items-end justify-between">
                      <div className="space-y-1">
                        <p className="text-[9px] uppercase text-muted font-medium">Mode</p>
                        <p className="text-xs font-bold text-electric">{w.mode.toUpperCase()}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[9px] uppercase text-muted font-medium">GPU / VRAM</p>
                        <p className="max-w-[10rem] truncate text-xs font-bold text-fg" title={w.gpuName || undefined}>
                          {w.gpuName || 'Non rapporté'}
                        </p>
                        <p className="text-[10px] text-muted">
                          {w.gpuVramMb != null && w.gpuVramMb > 0
                            ? `${(w.gpuVramMb / 1024).toFixed(1)} Go`
                            : '—'}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 space-y-1">
                      <div className="flex justify-between text-[9px] uppercase">
                        <span className="text-muted">Contribution Réseau</span>
                        <span className="text-success font-bold">{w.tokensGenerated} tokens</span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-fg/10">
                        <div 
                          className="h-full bg-gradient-to-r from-primary via-accent to-success transition-all duration-1000" 
                          style={{ width: `${Math.min(100, (w.tokensGenerated / 1000) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted">
                Aucun worker GPU détecté. Connectez votre Mac pour voir sa puissance s'ajouter ici.
              </p>
            )}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="panel p-5 sm:p-6">
            <h3 className="text-sm font-semibold text-fg">CPU (historique)</h3>
            <MiniSparkline
              points={history?.points ?? []}
              field="cpuPercent"
              color="var(--color-fg)"
            />
            <p className="mt-1 text-xs text-muted">
              {(history?.points.length ?? 0)} point(s) ·{' '}
              {status?.system.cpu.usagePercent ?? 0}% maintenant
            </p>
          </div>
          <div className="panel p-5 sm:p-6">
            <h3 className="text-sm font-semibold text-fg">Latence interne historique</h3>
            <MiniSparkline
              points={history?.points ?? []}
              field="avgComputeMs"
              color="var(--color-electric)"
            />
            <p className="mt-1 text-xs text-muted">
              Moyenne actuelle : {formatMs(avgWorkerLatency)}
            </p>
          </div>
        </section>

        <section id="workers" className="scroll-mt-24 space-y-6">
          <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg">Workers temps réel</h3>
            <span className="text-xs text-muted">
              Mis à jour il y a&nbsp;
              {status
                ? Math.max(0, Math.round((clockMs - status.sampledAt) / 1000))
                : '—'}
              &nbsp;s
            </span>
          </div>
          <div className="overflow-x-auto panel">
            <table className="w-full min-w-[60rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="px-4 py-3 pl-5">Statut</th>
                  <th className="px-4 py-3">PID</th>
                  <th className="px-4 py-3">Mode</th>
                  <th className="px-4 py-3">Ports internes</th>
                  <th className="px-4 py-3">IPs distantes</th>
                  <th className="px-4 py-3">CPU</th>
                  <th className="px-4 py-3">RAM</th>
                  <th className="px-4 py-3">Latence</th>
                  <th className="px-4 py-3 pr-5">Uptime</th>
                </tr>
              </thead>
              <tbody>
                {status && status.workers.length > 0 ? (
                  status.workers.map((w) => (
                    <tr key={w.pid} className="border-b border-border/70 hover:bg-surface/40">
                      <td className="px-4 py-3 pl-5">
                        <StatusDot status={w.status} />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-fg">{w.pid}</td>
                      <td className="px-4 py-3">
                        <span className="rounded bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                          {w.mode}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-fg">
                        {w.grpcPort ?? '—'} / {w.p2pPort ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {w.peerIps.length === 0
                          ? '—'
                          : w.peerIps.slice(0, 3).join(', ') +
                            (w.peerIps.length > 3 ? ` +${w.peerIps.length - 3}` : '')}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-fg">
                        {w.cpuPercent.toFixed(1)}%
                      </td>
                      <td className="px-4 py-3 tabular-nums text-fg">{w.memMB} Mo</td>
                      <td className="px-4 py-3 tabular-nums text-electric">
                        {formatMs(w.lastLatencyMs)}
                      </td>
                      <td className="px-4 py-3 pr-5 text-xs text-muted">
                        {formatUptime(w.uptimeSec)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-5 py-6 text-muted" colSpan={9}>
                      Aucun worker rust-daemon ou inférence Python détecté en local. Lancez le
                      daemon (cargo run) pour le voir apparaître automatiquement.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          </div>

          <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg">Workers enregistrés (heartbeat DB)</h3>
            <span className="rounded bg-accent/10 px-2 py-1 text-xs font-semibold text-accent">
              {registeredWorkers.filter((w) => w.online).length} en ligne ·{' '}
              {registeredWorkers.length} total
            </span>
          </div>
          <p className="text-xs text-muted">
            Workers rust-daemon ayant envoyé un heartbeat via{' '}
            <code className="rounded bg-surface border border-border px-1 font-mono">
              --api-url https://vryx.eu
            </code>
            . Un worker absent depuis &gt; 90 s est affiché hors ligne.
          </p>
          <div className="overflow-x-auto panel">
            <table className="w-full min-w-[60rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="px-4 py-3 pl-5">Statut</th>
                  <th className="px-4 py-3 text-left text-[10px] font-bold text-muted uppercase tracking-widest">Score / Modèle</th>
                  <th className="px-4 py-3 text-left text-[10px] font-bold text-muted uppercase tracking-widest">Propriétaire</th>
                  <th className="px-4 py-3">Mode</th>
                  <th className="px-4 py-3 text-center">Pairs P2P</th>
                  <th className="px-4 py-3 text-center">Tokens (In / Out)</th>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-muted">GPU</th>
                  <th className="px-4 py-3">IP / Ports</th>
                  <th className="px-4 py-3">Dernier heartbeat</th>
                  <th className="px-4 py-3 pr-5">Version</th>
                </tr>
              </thead>
              <tbody>
                {registeredWorkers.length === 0 ? (
                  <tr>
                    <td className="px-5 py-6 text-muted" colSpan={10}>
                      Aucun worker enregistré. Lancez{' '}
                      <code className="font-mono">start-worker.sh</code> avec{' '}
                      <code className="font-mono">--api-url https://vryx.eu</code>.
                    </td>
                  </tr>
                ) : (
                  registeredWorkers.map((w) => (
                    <tr key={w.peerId} className="border-b border-border/70 hover:bg-surface/40">
                      <td className="px-4 py-3 pl-5">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={`inline-block h-2.5 w-2.5 rounded-full ${
                              w.online ? 'animate-pulse bg-success' : 'bg-border'
                            }`}
                            aria-hidden
                          />
                          <span className="text-xs font-medium text-fg">
                            {w.online ? 'En ligne' : 'Hors ligne'}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col">
                          <span className="text-[11px] font-bold text-white">{w.model || 'Inconnu'}</span>
                          <span className="text-[10px] text-muted">Contrib: {(w.tokensGenerated / 1000).toFixed(1)}k</span>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span className="text-[11px] font-medium text-accent">
                          {w.ownerEmail || <span className="italic text-muted/50 text-[9px]">Non lié</span>}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                          {w.mode}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center font-mono text-xs text-fg">
                        {w.p2pPeers}
                      </td>
                      <td className="px-4 py-3 text-center font-mono text-xs">
                        <div className="flex flex-col items-center">
                          <span className="text-success" title="Total">{w.tokensGenerated}</span>
                          <span className="text-[10px] text-muted">{w.tokensIn || 0} in / {w.tokensOut || 0} out</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top text-[10px] leading-snug text-fg">
                        <span className="line-clamp-2">{w.gpuName || '—'}</span>
                        {w.gpuVramMb != null && w.gpuVramMb > 0 ? (
                          <span className="block text-muted">{w.gpuVramMb} Mo</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col">
                          <span className="font-mono text-xs text-fg">{w.publicIp || '—'}</span>
                          <span className="text-[10px] text-muted">
                            {w.grpcPort || '—'} / {w.p2pPort || '—'}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {w.online
                          ? `il y a ${w.secondsSinceHeartbeat} s`
                          : w.lastHeartbeatAt
                            ? new Date(w.lastHeartbeatAt).toLocaleString('fr-FR')
                            : '—'}
                      </td>
                      <td className="px-4 py-3 pr-5 text-[11px] text-muted">{w.version || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          </div>
        </section>

        <section id="tests" className="scroll-mt-24 panel p-5 sm:p-6">
          <h3 className="text-sm font-semibold text-fg">
            Communication & tests des workers
          </h3>
          <p className="mt-1 text-xs text-muted">
            Lance des sondes internes vers les workers détectés et mesure leurs latences. Le
            stress test envoie plusieurs appels en parallèle pour évaluer la robustesse.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <label className="block text-xs">
              <span className="mb-1 block text-muted">Appels en parallèle</span>
              <input
                type="number"
                min={1}
                max={64}
                value={testParallel}
                onChange={(e) => setTestParallel(Math.max(1, Math.min(64, Number(e.target.value) || 1)))}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-fg"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted">Répétitions</span>
              <input
                type="number"
                min={1}
                max={200}
                value={testRepeat}
                onChange={(e) => setTestRepeat(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-fg"
              />
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => void runTest(false)}
                disabled={testRunning !== null}
                className="btn-primary flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
              >
                {testRunning === 'unit' ? 'Test en cours…' : 'Lancer test unitaire'}
              </button>
              <button
                type="button"
                onClick={() => void runTest(true)}
                disabled={testRunning !== null}
                className="rounded-lg border border-warning/50 bg-warning/10 px-4 py-2.5 text-sm font-semibold text-warning disabled:opacity-60"
              >
                {testRunning === 'stress' ? 'Stress…' : 'Stress test'}
              </button>
            </div>
          </div>

          {lastReport && (
            <div className="mt-5 rounded-lg border border-border bg-surface p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Dernier rapport</p>
              <div className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-muted">Type</p>
                  <p className="font-mono text-fg">{lastReport.type}</p>
                </div>
                <div>
                  <p className="text-muted">Appels</p>
                  <p className="font-mono text-fg">
                    {lastReport.successCalls}/{lastReport.totalCalls}
                    {lastReport.failedCalls > 0 && (
                      <span className="ml-1 text-alert">({lastReport.failedCalls} KO)</span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-muted">Latence moyenne</p>
                  <p className="font-mono text-electric">
                    {formatMs(lastReport.metrics.avgComputeMs)}
                  </p>
                </div>
                <div>
                  <p className="text-muted">Min / Max</p>
                  <p className="font-mono text-fg">
                    {formatMs(lastReport.metrics.minLatencyMs)} ·{' '}
                    {formatMs(lastReport.metrics.maxLatencyMs)}
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted">
                Durée totale : {lastReport.durationMs} ms · workers détectés :{' '}
                {lastReport.workersDetected}
              </p>
            </div>
          )}
        </section>

        <section className="panel p-5 sm:p-6">
          <h3 className="text-sm font-semibold text-fg">Historique des tests</h3>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="px-4 py-3 pl-5">Date</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Réussite</th>
                  <th className="px-4 py-3 pr-5">Latence</th>
                </tr>
              </thead>
              <tbody>
                {history?.tests.length ? (
                  history.tests.slice(0, 10).map((t) => (
                    <tr key={t.id} className="border-b border-border/70">
                      <td className="px-4 py-3 pl-5 text-[11px] text-muted">
                        {new Date(t.startedAt).toLocaleTimeString('fr-FR')}
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                          {t.type}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`font-mono text-xs ${
                            t.failedCalls === 0 ? 'text-success' : 'text-warning'
                          }`}
                        >
                          {Math.round((t.successCalls / Math.max(1, t.totalCalls)) * 100)}%
                        </span>
                      </td>
                      <td className="px-4 py-3 pr-5 text-[11px] text-electric">
                        {formatMs(t.metrics.avgComputeMs)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-5 py-4 text-muted" colSpan={4}>
                      —
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AdminShell>
  )
}
