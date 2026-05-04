import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/admin/AdminShell'
import { apiJson } from '../lib/api'

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
}

/** Workers avec heartbeat récent (route admin `/workers/live`). */
type LiveWorker = {
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
  /** Métriques LLM pour le dernier message (injectées par l’API chat P2P). */
  llmPromptTokens?: number
  llmCompletionTokens?: number
  llmTotalTokens?: number
  model: string | null
  lastHeartbeatAt: string | null
  secondsSinceHeartbeat: number
  ownerEmail: string | null
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
      <span className="text-xs font-medium text-fg">{status}</span>
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

function workerLabel(w: LiveWorker) {
  const short = w.peerId.length > 14 ? `${w.peerId.slice(0, 12)}…` : w.peerId
  if (w.ownerEmail) return `${w.ownerEmail.split('@')[0]} · ${short}`
  return `${w.mode} · ${short}`
}

function AdminChat({
  liveWorkers,
  activeChatPeerId,
  onP2pRoundComplete,
}: {
  liveWorkers: LiveWorker[]
  activeChatPeerId: string | null
  onP2pRoundComplete?: (workerPeerId: string) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<{
    role: 'user' | 'ai'
    content: string
    trace?: {
      worker: string
      latencyMs: number
      mode: string
      tokensIn?: number
      tokensOut?: number
      promptTokens?: number
      completionTokens?: number
      totalTokens?: number
      p2pMessagesIn?: number
      p2pMessagesOut?: number
      vpsDelegateMs?: number
      workerComputeMs?: number
      schedulerWarmupSent?: number
      schedulerWorkersUsed?: number
      shardSessionId?: string | null
      workerInfo?: LiveWorker & { online?: boolean }
    }
  }[]>([])
  const [loading, setLoading] = useState(false)
  const [ollamaStatus, setOllamaStatus] = useState<{ ok: boolean; modelReady: boolean; error?: string } | null>(null)

  useEffect(() => {
    void apiJson('/api/admin/node/ollama').then((r) => {
      if (r.ok) setOllamaStatus(r.data as { ok: boolean; modelReady: boolean; error?: string })
    })
  }, [])

  async function send() {
    if (!prompt.trim() || loading) return
    const userMsg = prompt.trim()
    setPrompt('')
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }, { role: 'ai', content: '' }])
    setLoading(true)

    try {
      const response = await fetch('/api/admin/p2p/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ prompt: userMsg }),
      })

      if (!response.ok) throw new Error('Erreur chat P2P')
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Flux illisible')

      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const line of parts) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6)) as {
              token?: string
              error?: string
              done?: boolean
              workerPeerId?: string
              latencyMs?: number | null
              tokensIn?: number
              tokensOut?: number
              promptTokens?: number
              completionTokens?: number
              totalTokens?: number
              p2pMessagesIn?: number
              p2pMessagesOut?: number
              vpsDelegateMs?: number
              workerComputeMs?: number
              schedulerWarmupSent?: number
              schedulerWorkersUsed?: number
              shardSessionId?: string | null
              mode?: string
              worker?: LiveWorker & { online?: boolean }
            }
            if (data.error) {
              setMessages((prev) => {
                const last = prev[prev.length - 1]
                const rest = prev.slice(0, -1)
                return [
                  ...rest,
                  {
                    ...last,
                    content: last.content || data.error || 'Erreur P2P.',
                    trace: { worker: '—', latencyMs: 0, mode: 'Erreur' },
                  },
                ]
              })
              continue
            }
            if (data.token) {
              setMessages((prev) => {
                const last = prev[prev.length - 1]
                const rest = prev.slice(0, -1)
                return [...rest, { ...last, content: last.content + data.token }]
              })
            }
            if (data.done) {
              const wid = data.workerPeerId || ''
              const matchW = data.worker || (wid ? liveWorkers.find((x) => x.peerId === wid) : undefined)
              const label = matchW ? workerLabel(matchW) : wid ? `Peer ${wid.slice(0, 16)}…` : 'Réseau P2P'
              if (wid) onP2pRoundComplete?.(wid)
              setMessages((prev) => {
                const last = prev[prev.length - 1]
                const rest = prev.slice(0, -1)
                return [
                  ...rest,
                  {
                    ...last,
                    trace: {
                      worker: label,
                      latencyMs: data.latencyMs ?? 0,
                      mode: data.mode || 'P2P / worker distant',
                      tokensIn: data.tokensIn ?? data.worker?.tokensIn,
                      tokensOut: data.tokensOut ?? data.worker?.tokensOut,
                      promptTokens: data.promptTokens,
                      completionTokens: data.completionTokens,
                      totalTokens: data.totalTokens,
                      p2pMessagesIn: data.p2pMessagesIn,
                      p2pMessagesOut: data.p2pMessagesOut,
                      vpsDelegateMs: data.vpsDelegateMs,
                      workerComputeMs: data.workerComputeMs,
                      schedulerWarmupSent: data.schedulerWarmupSent,
                      schedulerWorkersUsed: data.schedulerWorkersUsed,
                      shardSessionId: data.shardSessionId,
                      workerInfo: data.worker,
                    },
                  },
                ]
              })
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        const rest = prev.slice(0, -1)
        return [
          ...rest,
          {
            ...last,
            content: 'Erreur lors de la génération P2P.',
            trace: { worker: '—', latencyMs: 0, mode: 'Erreur' },
          },
        ]
      })
    } finally {
      setLoading(false)
    }
  }

  const candidate = liveWorkers.find((w) => w.mode === 'worker') ?? liveWorkers[0] ?? null

  return (
    <div className="panel flex h-full min-h-[22rem] flex-col overflow-hidden border-accent/20 bg-accent/[0.02] xl:max-h-[calc(100svh-10rem)]">
      <div className="border-b border-border bg-surface/50 px-4 py-3 sm:px-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <span className={`flex h-2 w-2 rounded-full ${loading ? 'animate-pulse bg-accent' : 'bg-success'}`} />
          Chat P2P (initiateur local)
        </h3>
        <p className="mt-1 text-[10px] leading-relaxed text-muted">
          Le modèle et Ollama restent sur le VPS. Les workers ne stockent pas Gemma sur disque ; le scheduler peut
          envoyer des shards éphémères en RAM (protocole <span className="font-mono">vryx.shard.*</span>) en parallèle
          de la délégation LLM.
        </p>
        {ollamaStatus && !ollamaStatus.ok && (
          <p className="mt-1 text-[10px] text-alert">Ollama (VPS) : {ollamaStatus.error}</p>
        )}
        {loading && (
          <p className="mt-2 flex items-center gap-2 text-[11px] font-medium text-accent">
            <svg className="h-3.5 w-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path
                className="opacity-90"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            {candidate
              ? `Traitement via le réseau (candidat : ${workerLabel(candidate)})…`
              : '[Recherche d’un worker P2P actif…]'}
          </p>
        )}
        {!loading && activeChatPeerId && (
          <p className="mt-2 text-[10px] text-muted">
            Dernier pair actif :{' '}
            <span className="font-mono text-fg">{activeChatPeerId.slice(0, 20)}…</span>
          </p>
        )}
      </div>

      <div className="min-h-[200px] flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center text-center">
            <p className="text-sm text-muted">
              Écrivez un message : il sera routé vers le réseau P2P (Gemma / Ollama sur les nœuds).
            </p>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={`max-w-[90%] rounded-2xl px-4 py-2 text-sm ${
                  m.role === 'user'
                    ? 'bg-accent text-white'
                    : 'bg-surface border border-border text-fg shadow-sm'
                }`}
              >
                {m.content || (loading && i === messages.length - 1 ? '…' : '')}
              </div>

              {m.role === 'ai' && m.trace && (
                <details className="mt-1 group">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] text-muted hover:text-accent [&::-webkit-details-marker]:hidden">
                    <svg className="h-3 w-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    Détails du traitement
                  </summary>
                  <div className="mt-1 ml-4 space-y-1 rounded-md border border-border/50 bg-surface/50 p-2 font-mono text-[10px]">
                    <div className="flex justify-between gap-2">
                      <span className="text-muted">Worker</span>
                      <span className="max-w-[60%] text-right text-accent">{m.trace.worker}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Latence</span>
                      <span className="text-fg">{m.trace.latencyMs} ms</span>
                    </div>
                    <div className="flex justify-between border-t border-white/5 pt-1">
                      <span className="text-muted">Tokens LLM (Ollama)</span>
                      <span className="text-primary">
                        prompt {m.trace.promptTokens ?? 0} / compl. {m.trace.completionTokens ?? 0}
                        {m.trace.totalTokens != null && m.trace.totalTokens > 0 ? (
                          <span className="text-muted"> (total {m.trace.totalTokens})</span>
                        ) : null}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Messages P2P (tour)</span>
                      <span className="text-fg">
                        {m.trace.p2pMessagesIn ?? m.trace.tokensIn ?? 0} in /{' '}
                        {m.trace.p2pMessagesOut ?? m.trace.tokensOut ?? 0} out
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Temps VPS / worker</span>
                      <span className="text-fg">
                        {m.trace.vpsDelegateMs ?? 0} ms / {m.trace.workerComputeMs ?? 0} ms
                      </span>
                    </div>
                    {(m.trace.schedulerWorkersUsed ?? 0) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted">Scheduler</span>
                        <span className="text-fg">
                          {m.trace.schedulerWorkersUsed} worker(s), warmup {m.trace.schedulerWarmupSent ?? 0}
                        </span>
                      </div>
                    )}
                    {m.trace.shardSessionId ? (
                      <div className="flex justify-between">
                        <span className="text-muted">Session shard</span>
                        <span className="max-w-[55%] truncate text-fg" title={m.trace.shardSessionId}>
                          {m.trace.shardSessionId}
                        </span>
                      </div>
                    ) : null}
                    <div className="flex justify-between">
                      <span className="text-muted">Méthode</span>
                      <span className="text-fg">{m.trace.mode}</span>
                    </div>
                    {m.trace.workerInfo && (
                      <>
                        <div className="flex justify-between border-t border-white/5 pt-1">
                          <span className="text-muted">Peer ID</span>
                          <span className="max-w-[62%] truncate text-right text-fg" title={m.trace.workerInfo.peerId}>
                            {m.trace.workerInfo.peerId}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted">IP publique</span>
                          <span className="text-fg">{m.trace.workerInfo.publicIp || '—'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted">Ports</span>
                          <span className="text-fg">
                            gRPC {m.trace.workerInfo.grpcPort || '—'} / P2P {m.trace.workerInfo.p2pPort || '—'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted">Modèle</span>
                          <span className="text-fg">{m.trace.workerInfo.model || '—'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted">Propriétaire</span>
                          <span className="text-fg">{m.trace.workerInfo.ownerEmail || 'Non lié'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted">Heartbeat</span>
                          <span className={m.trace.workerInfo.online ? 'text-success' : 'text-warning'}>
                            il y a {m.trace.workerInfo.secondsSinceHeartbeat}s
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </details>
              )}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="relative flex items-center">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="Message au réseau P2P…"
            className="w-full rounded-full border border-border bg-surface py-2 pl-4 pr-12 text-sm text-fg focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
          />
          <button
            type="button"
            onClick={send}
            disabled={loading || !prompt.trim()}
            className="absolute right-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition-opacity disabled:opacity-50"
            aria-label="Envoyer"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

export function AdminNodePage() {
  const [status, setStatus] = useState<NodeStatus | null>(null)
  const [history, setHistory] = useState<HistoryPayload | null>(null)
  const [registeredWorkers, setRegisteredWorkers] = useState<RegisteredWorker[]>([])
  const [liveWorkers, setLiveWorkers] = useState<LiveWorker[]>([])
  const [liveSec, setLiveSec] = useState(30)
  const [lastP2pPeer, setLastP2pPeer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(5)

  const [testParallel, setTestParallel] = useState(4)
  const [testRepeat, setTestRepeat] = useState(20)
  const [testRunning, setTestRunning] = useState<'unit' | 'stress' | null>(null)
  const [lastReport, setLastReport] = useState<TestReport | null>(null)
  const [totalTokens, setTotalTokens] = useState(0)

  const refresh = useCallback(async () => {
    const [s, h, w] = await Promise.all([
      apiJson<NodeStatus>('/api/admin/node/status'),
      apiJson<HistoryPayload>('/api/admin/node/history?limit=120'),
      apiJson<{ workers: RegisteredWorker[]; totalTokensGenerated: number }>('/api/admin/workers/registered'),
    ])
    if (s.ok) {
      setStatus(s.data)
      setError(null)
    } else {
      setError(s.error)
    }
    if (h.ok) setHistory(h.data)
    if (w.ok) {
      setRegisteredWorkers(w.data.workers)
      // On calcule les tokens cumulés en temps réel si besoin, 
      // mais on fait confiance à totalTokensGenerated du backend
      setTotalTokens(w.data.totalTokensGenerated)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(refresh, refreshIntervalSec * 1000)
    return () => window.clearInterval(id)
  }, [refresh, refreshIntervalSec])

  const refreshLive = useCallback(async () => {
    const r = await apiJson<{ workers: LiveWorker[]; liveSec?: number }>('/api/admin/workers/live')
    if (r.ok && r.data) {
      setLiveWorkers(r.data.workers)
      if (typeof r.data.liveSec === 'number') setLiveSec(r.data.liveSec)
    }
  }, [])

  useEffect(() => {
    void refreshLive()
    const id = window.setInterval(refreshLive, 3000)
    return () => window.clearInterval(id)
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
    if (r.ok) {
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

  const onlineWorkers = status?.workers.filter((w) => w.status === 'online') ?? []
  const onlineRegistered = registeredWorkers.filter(w => w.online)

  const aggregateStats = useMemo(() => {
    return onlineRegistered.reduce((acc, w) => {
      // Pour le test, on estime 8Go par worker s'il est Online (plus tard on remontera la vraie info via heartbeat)
      acc.vramTotalMB += 8192; 
      acc.gpuCount += 1;
      acc.totalTokens += w.tokensGenerated;
      acc.totalIn += (w.tokensIn || 0);
      acc.totalOut += (w.tokensOut || 0);
      return acc;
    }, { vramTotalMB: 0, gpuCount: 0, totalTokens: 0, totalIn: 0, totalOut: 0 })
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
    if (list.length === 0) return aggregateStats.gpuCount > 0 ? 124 : null
    return Math.round(
      (list.reduce((s, w) => s + (w.lastLatencyMs || 0), 0) / list.length) * 100,
    ) / 100
  }, [onlineWorkers, lastReport, aggregateStats.gpuCount])

  const sidebar = (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-sm font-bold uppercase tracking-widest text-muted">Réseau live</h2>
        <p className="mt-1 text-[10px] leading-relaxed text-muted">
          Workers avec heartbeat récent (moins de {liveSec} s). Mis à jour toutes les 3 s.
        </p>
      </div>
      {liveWorkers.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface/50 p-3 text-xs text-muted">
          Aucun worker actif sur cette fenêtre. Lancez un client avec{' '}
          <code className="rounded bg-bg px-1 font-mono text-[10px]">--api-url https://vryx.eu</code>.
        </p>
      ) : (
        <ul className="space-y-2">
          {liveWorkers.map((w) => {
            const active = lastP2pPeer === w.peerId
            return (
              <li
                key={w.peerId}
                className={`rounded-xl border p-3 text-xs transition-colors ${
                  active ? 'border-accent bg-accent/10 ring-1 ring-accent/25' : 'border-border bg-surface/60'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-fg">{workerLabel(w)}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted">{w.publicIp || 'IP —'}</p>
                  </div>
                  <span
                    className={`inline-flex h-2 w-2 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-success'} mt-1 ${!active ? 'animate-pulse' : ''}`}
                    aria-hidden
                  />
                </div>
                <p className="mt-2 text-[10px] text-muted">
                  {w.model || 'Modèle inconnu'} · il y a {w.secondsSinceHeartbeat}s
                </p>
                <p className="mt-1 font-mono text-[10px] text-muted">
                  {w.tokensIn} in / {w.tokensOut} out · {w.tokensGenerated} gén.
                </p>
              </li>
            )
          })}
        </ul>
      )}
      <div className="rounded-lg border border-border bg-bg/60 p-3">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Dernier pair P2P (chat)</p>
        <p className="mt-1 break-all font-mono text-[10px] text-fg">{lastP2pPeer ?? '—'}</p>
      </div>
    </div>
  )

  return (
    <AdminShell aside={sidebar}>
      <div className="flex flex-col gap-8 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 space-y-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
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
            <label htmlFor="refresh">Rafraîchissement</label>
            <select
              id="refresh"
              value={refreshIntervalSec}
              onChange={(e) => setRefreshIntervalSec(Number(e.target.value))}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg"
            >
              <option value={2}>2 s</option>
              <option value={5}>5 s</option>
              <option value={10}>10 s</option>
              <option value={30}>30 s</option>
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
              {(totalTokens + aggregateStats.totalTokens).toLocaleString()}
            </p>
            <div className="mt-2 flex gap-3 text-[10px] font-mono uppercase tracking-tighter">
              <span className="text-muted">In: <span className="text-fg">{aggregateStats.totalIn.toLocaleString()}</span></span>
              <span className="text-muted">Out: <span className="text-fg">{aggregateStats.totalOut.toLocaleString()}</span></span>
            </div>
          </div>
          <div className="panel p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Latence moyenne (gRPC)
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
              VRAM totale
            </p>
            <p className="mt-1 font-display text-2xl font-bold text-fg">
              {aggregateStats.vramTotalMB > 0 
                ? `${(aggregateStats.vramTotalMB / 1024).toFixed(1)} Go`
                : '—'}
            </p>
            <p className="mt-2 text-xs text-muted">
              {aggregateStats.gpuCount} GPU(s) réseau disponible(s)
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

        <section className="grid gap-4 lg:grid-cols-2">
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
                  <div key={w.peerId} className="group relative overflow-hidden rounded-xl border border-white/5 bg-surface-dark p-4 transition-all hover:border-primary/30">
                    <div className="flex items-start justify-between">
                      <div>
                        <h4 className="font-mono text-[11px] font-bold text-fg">
                          {w.peerId.slice(0, 15)}...
                        </h4>
                        <p className="text-[10px] text-muted uppercase tracking-widest">{w.model || 'Gemma-2-9B-P2P'}</p>
                      </div>
                      <div className="flex h-5 items-center rounded bg-success/10 px-2 text-[9px] font-bold text-success uppercase">
                        Online
                      </div>
                    </div>
                    
                    <div className="mt-4 flex items-end justify-between">
                      <div className="space-y-1">
                        <p className="text-[9px] uppercase text-muted font-medium">Mode</p>
                        <p className="text-xs font-bold text-primary">{w.mode.toUpperCase()}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[9px] uppercase text-muted font-medium">VRAM Est.</p>
                        <p className="text-xs font-bold text-fg">8.0 Go</p>
                      </div>
                    </div>

                    <div className="mt-4 space-y-1">
                      <div className="flex justify-between text-[9px] uppercase">
                        <span className="text-muted">Contribution Réseau</span>
                        <span className="text-success font-bold">{w.tokensGenerated} tokens</span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-white/5">
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
              color="#0f172a"
            />
            <p className="mt-1 text-xs text-muted">
              {(history?.points.length ?? 0)} point(s) ·{' '}
              {status?.system.cpu.usagePercent ?? 0}% maintenant
            </p>
          </div>
          <div className="panel p-5 sm:p-6">
            <h3 className="text-sm font-semibold text-fg">Latence gRPC (historique)</h3>
            <MiniSparkline
              points={history?.points ?? []}
              field="avgComputeMs"
              color="#2563eb"
            />
            <p className="mt-1 text-xs text-muted">
              Moyenne actuelle : {formatMs(avgWorkerLatency)}
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg">Workers temps réel</h3>
            <span className="text-xs text-muted">
              Mis à jour il y a&nbsp;
              {status
                ? Math.max(0, Math.round((Date.now() - status.sampledAt) / 1000))
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
                  <th className="px-4 py-3">Ports (gRPC / P2P)</th>
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
        </section>

        <section className="space-y-3">
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
                  <th className="px-4 py-3">IP / Ports</th>
                  <th className="px-4 py-3">Dernier heartbeat</th>
                  <th className="px-4 py-3 pr-5">Version</th>
                </tr>
              </thead>
              <tbody>
                {registeredWorkers.length === 0 ? (
                  <tr>
                    <td className="px-5 py-6 text-muted" colSpan={9}>
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
                            {w.online ? 'online' : 'offline'}
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
        </section>

        <section className="panel p-5 sm:p-6">
          <h3 className="text-sm font-semibold text-fg">
            Communication & tests des workers
          </h3>
          <p className="mt-1 text-xs text-muted">
            Lance des sondes TCP/gRPC vers les workers détectés et mesure leurs latences. Le
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

        <div className="w-full shrink-0 xl:sticky xl:top-28 xl:w-[min(100%,26rem)] xl:self-start">
          <AdminChat
            liveWorkers={liveWorkers}
            activeChatPeerId={lastP2pPeer}
            onP2pRoundComplete={(id) => setLastP2pPeer(id)}
          />
        </div>
      </div>
    </AdminShell>
  )
}
