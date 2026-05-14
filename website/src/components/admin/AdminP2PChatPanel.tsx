import { useState } from 'react'
import type { WorkerRoundMetrics } from './workerRoundMetrics'
import { WorkerComputeReport } from './WorkerComputeReport'
import { buildSession, saveSession, saveSessionToDb } from '../../lib/sessions'

type QuantizationMode = 'int8' | 'q4' | 'fp16'
type PoolPreference = 'auto' | 'velocity_mlx' | 'velocity_vllm' | 'legacy_pytorch'

/** Workers avec heartbeat récent (route admin `/workers/live`). */
export type LiveWorker = {
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
  llmPromptTokens?: number
  llmCompletionTokens?: number
  llmTotalTokens?: number
  model: string | null
  gpuName?: string | null
  gpuVramMb?: number | null
  runtimeBackend?: string | null
  weightQuantization?: string | null
  supportsQ4Weights?: boolean
  supportsMlx?: boolean
  supportsVllm?: boolean
  lastHeartbeatAt: string | null
  secondsSinceHeartbeat: number
  ownerEmail: string | null
}

type TraceData = {
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
  computeTimeMs?: number
  routingPath?: string[]
  schedulerWarmupSent?: number
  schedulerWorkersUsed?: number
  shardSessionId?: string | null
  primaryWorkerPeerId?: string
  pipelineTrace?: unknown
  pipelineWorkers?: unknown
  workerInfo?: LiveWorker & { online?: boolean }
  quicUsed?: boolean
  quicAvailable?: boolean
  kvCacheUsed?: boolean
  hiddenTransport?: string
  avgMsPerToken?: number
  hotPathTps?: number
  stopReason?: string | null
  prefixCacheHit?: boolean
  prefixCacheTokens?: number
  setupMs?: number
  benchmarkActualTps?: number
  genControl?: Record<string, unknown> | null
  requestedQuantization?: QuantizationMode
  effectiveQuantization?: string
  quantizationFallbackReason?: string | null
  poolPreference?: PoolPreference
  poolClass?: string
  poolFallbackReason?: string | null
  batching?: Record<string, unknown> | null
  overlap?: Record<string, unknown> | null
  runtimeBackendPerWorker?: unknown
  weightQuantizationPerWorker?: unknown
  attentionBackendPerWorker?: unknown
}

function timingScopeFromPipelineTrace(pipelineTrace: unknown): string | undefined {
  if (!pipelineTrace || typeof pipelineTrace !== 'object' || Array.isArray(pipelineTrace)) return undefined
  const ts = (pipelineTrace as Record<string, unknown>).timing_scope
  return typeof ts === 'string' ? ts : undefined
}

function roundMetricsFromTrace(t: TraceData): WorkerRoundMetrics {
  return {
    latencyMs: Number(t.latencyMs ?? 0) || 0,
    vpsDelegateMs: Number(t.vpsDelegateMs ?? 0) || 0,
    workerComputeMs: Number(t.workerComputeMs ?? 0) || 0,
    computeTimeMs: Number(t.computeTimeMs ?? 0) || 0,
    routingPath: Array.isArray(t.routingPath) ? t.routingPath : [],
    promptTokens: t.promptTokens,
    completionTokens: t.completionTokens,
    totalTokens: t.totalTokens,
    p2pMessagesIn: t.p2pMessagesIn,
    p2pMessagesOut: t.p2pMessagesOut,
    mode: t.mode,
    quicUsed: t.quicUsed,
    quicAvailable: t.quicAvailable,
    kvCacheUsed: t.kvCacheUsed,
    hiddenTransport: t.hiddenTransport,
    avgMsPerToken: t.avgMsPerToken,
    hotPathTps: t.hotPathTps,
    stopReason: t.stopReason,
    prefixCacheHit: t.prefixCacheHit,
    prefixCacheTokens: t.prefixCacheTokens,
    setupMs: t.setupMs,
    benchmarkActualTps: t.benchmarkActualTps,
    genControl: t.genControl,
    requestedQuantization: t.requestedQuantization,
    effectiveQuantization: t.effectiveQuantization,
    quantizationFallbackReason: t.quantizationFallbackReason,
    poolPreference: t.poolPreference,
    poolClass: t.poolClass,
    poolFallbackReason: t.poolFallbackReason,
    batching: t.batching,
    overlap: t.overlap,
    runtimeBackendPerWorker: t.runtimeBackendPerWorker,
    weightQuantizationPerWorker: t.weightQuantizationPerWorker,
    attentionBackendPerWorker: t.attentionBackendPerWorker,
    timingScope: timingScopeFromPipelineTrace(t.pipelineTrace) ?? null,
  }
}

function firstPeerIdFromPipelineTrace(trace: unknown): string {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return ''
  const peers = (trace as Record<string, unknown>).peers
  if (!Array.isArray(peers)) return ''
  const hit = peers.find((p): p is string => typeof p === 'string' && p.length > 0)
  return hit ?? ''
}

export function workerLabel(w: LiveWorker) {
  const short = w.peerId.length > 14 ? `${w.peerId.slice(0, 12)}…` : w.peerId
  if (w.ownerEmail) return `${w.ownerEmail.split('@')[0]} · ${short}`
  return `${w.mode} · ${short}`
}

function quantizationLabel(q: string) {
  if (q === 'q4') return '4-bit'
  if (q === 'int8') return '8-bit'
  if (q === 'fp16') return 'fp16'
  return q
}

export function AdminP2PChatPanel({
  liveWorkers,
  activeChatPeerId,
  onP2pRoundComplete,
}: {
  liveWorkers: LiveWorker[]
  activeChatPeerId: string | null
  onP2pRoundComplete?: (
    workerPeerId: string,
    meta?: {
      pipelineTrace?: unknown
      pipelineWorkers?: unknown
      roundMetrics?: WorkerRoundMetrics
    },
  ) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<{
    role: 'user' | 'ai'
    content: string
    trace?: TraceData
    /** Lignes de statut SSE avant la fin du tour (progression initiateur). */
    streamLog?: string[]
  }[]>([])
  const [loading, setLoading] = useState(false)
  // fp16 défaut : qualité logits fiable avec MLX/Vélocité ; q4 coupe la bande passante mais peut brouiller les activités.
  const [quantization, setQuantization] = useState<QuantizationMode>('fp16')
  const [poolPreference, setPoolPreference] = useState<PoolPreference>('auto')
  const [maxNewTokens, setMaxNewTokens] = useState(256)

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
        body: JSON.stringify({ prompt: userMsg, quantization, pool_preference: poolPreference, maxNewTokens }),
      })

      if (!response.ok) throw new Error('Erreur chat P2P')
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Flux illisible')

      const decoder = new TextDecoder()
      let buf = ''
      let aiBuffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const line of parts) {
          const trimmed = line.replace(/\r$/, '').trimStart()
          if (!trimmed.startsWith('data: ')) continue
          try {
            const data = JSON.parse(trimmed.slice(6)) as {
              status?: string
              stage?: string
              elapsedSec?: number
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
              computeTimeMs?: number
              routingPath?: string[]
              schedulerWarmupSent?: number
              schedulerWorkersUsed?: number
              shardSessionId?: string | null
              primaryWorkerPeerId?: string
              pipelineTrace?: unknown
              pipelineWorkers?: unknown
              mode?: string
              worker?: LiveWorker & { online?: boolean }
              quicUsed?: boolean
              quicAvailable?: boolean
              kvCacheUsed?: boolean
              hiddenTransport?: string
              avgMsPerToken?: number
              hotPathTps?: number
              stopReason?: string | null
              prefixCacheHit?: boolean
              prefixCacheTokens?: number
              setupMs?: number
              benchmarkActualTps?: number
              genControl?: Record<string, unknown> | null
              requestedQuantization?: QuantizationMode
              effectiveQuantization?: string
              quantizationFallbackReason?: string | null
              poolPreference?: PoolPreference
              poolClass?: string
              poolFallbackReason?: string | null
              batching?: Record<string, unknown> | null
              overlap?: Record<string, unknown> | null
              runtimeBackendPerWorker?: unknown
              weightQuantizationPerWorker?: unknown
              attentionBackendPerWorker?: unknown
            }
            if (typeof data.status === 'string' && data.status.trim().length > 0) {
              const statusLine = data.status.trim()
              setMessages((prev) => {
                const last = prev[prev.length - 1]
                if (!last || last.role !== 'ai') return prev
                const rest = prev.slice(0, -1)
                const nextLog = [...(last.streamLog ?? []), statusLine].slice(-48)
                return [...rest, { ...last, streamLog: nextLog }]
              })
            }
            if (data.error) {
              setMessages((prev) => {
                const last = prev[prev.length - 1]
                const rest = prev.slice(0, -1)
                return [
                  ...rest,
                  {
                    ...last,
                    streamLog: undefined,
                    content: last.content || data.error || 'Erreur P2P.',
                    trace: {
                      worker: '—',
                      latencyMs: data.latencyMs ?? 0,
                      mode: 'Erreur P2P',
                      workerComputeMs: data.workerComputeMs ?? 0,
                      computeTimeMs: data.computeTimeMs ?? 0,
                      routingPath: data.routingPath ?? [],
                      pipelineTrace: data.pipelineTrace,
                      pipelineWorkers: data.pipelineWorkers,
                    },
                  },
                ]
              })
              continue
            }
            if (data.token) {
              aiBuffer += data.token
              setMessages((prev) => {
                const last = prev[prev.length - 1]
                const rest = prev.slice(0, -1)
                return [...rest, { ...last, content: last.content + data.token }]
              })
            }
            if (data.done) {
              const wid = data.workerPeerId || ''
              const primary =
                typeof data.primaryWorkerPeerId === 'string' && data.primaryWorkerPeerId.length > 0
                  ? data.primaryWorkerPeerId
                  : ''
              const tracePeer = firstPeerIdFromPipelineTrace(data.pipelineTrace)
              const sidebarPeerId = wid || primary || tracePeer
              const matchW =
                data.worker ||
                (sidebarPeerId ? liveWorkers.find((x) => x.peerId === sidebarPeerId) : undefined)
              const label = matchW
                ? workerLabel(matchW)
                : sidebarPeerId
                  ? `Peer ${sidebarPeerId.slice(0, 16)}…`
                  : 'Réseau P2P'
              const roundMetrics: WorkerRoundMetrics = {
                latencyMs: Number(data.latencyMs ?? 0) || 0,
                vpsDelegateMs: Number(data.vpsDelegateMs ?? 0) || 0,
                workerComputeMs: Number(data.workerComputeMs ?? 0) || 0,
                computeTimeMs: Number(data.computeTimeMs ?? 0) || 0,
                routingPath: Array.isArray(data.routingPath) ? data.routingPath : [],
                promptTokens: data.promptTokens,
                completionTokens: data.completionTokens,
                totalTokens: data.totalTokens,
                p2pMessagesIn: data.p2pMessagesIn,
                p2pMessagesOut: data.p2pMessagesOut,
                mode: data.mode,
                quicUsed: data.quicUsed,
                quicAvailable: data.quicAvailable,
                kvCacheUsed: data.kvCacheUsed,
                hiddenTransport: data.hiddenTransport,
                avgMsPerToken: data.avgMsPerToken,
                hotPathTps: data.hotPathTps,
                stopReason: data.stopReason,
                prefixCacheHit: data.prefixCacheHit,
                prefixCacheTokens: data.prefixCacheTokens,
                setupMs: data.setupMs,
                benchmarkActualTps: data.benchmarkActualTps,
                genControl: data.genControl,
                requestedQuantization: data.requestedQuantization,
                effectiveQuantization: data.effectiveQuantization,
                quantizationFallbackReason: data.quantizationFallbackReason,
                poolPreference: data.poolPreference,
                poolClass: data.poolClass,
                poolFallbackReason: data.poolFallbackReason,
                batching: data.batching,
                overlap: data.overlap,
                runtimeBackendPerWorker: data.runtimeBackendPerWorker,
                weightQuantizationPerWorker: data.weightQuantizationPerWorker,
                attentionBackendPerWorker: data.attentionBackendPerWorker,
                timingScope: timingScopeFromPipelineTrace(data.pipelineTrace) ?? null,
              }
              onP2pRoundComplete?.(sidebarPeerId, {
                pipelineTrace: data.pipelineTrace,
                pipelineWorkers: data.pipelineWorkers,
                roundMetrics,
              })
              const workerInfoForSession = data.worker
                ? {
                    peerId: data.worker.peerId,
                    publicIp: data.worker.publicIp ?? null,
                    grpcPort: data.worker.grpcPort ?? null,
                    p2pPort: data.worker.p2pPort ?? null,
                    model: data.worker.model ?? null,
                    gpuName: data.worker.gpuName ?? null,
                    gpuVramMb: data.worker.gpuVramMb ?? null,
                    ownerEmail: data.worker.ownerEmail ?? null,
                    online: data.worker.online ?? false,
                    secondsSinceHeartbeat: data.worker.secondsSinceHeartbeat ?? 0,
                  }
                : undefined
              const session = buildSession({
                prompt: userMsg,
                response: aiBuffer,
                data: data as Record<string, unknown>,
                pipelineTrace: data.pipelineTrace,
                pipelineWorkers: data.pipelineWorkers,
                workerInfo: workerInfoForSession,
              })
              saveSession(session)
              void saveSessionToDb(session)
              setMessages((prev) => {
                const last = prev[prev.length - 1]
                const rest = prev.slice(0, -1)
                return [
                  ...rest,
                  {
                    ...last,
                    streamLog: undefined,
                    trace: {
                      worker: label,
                      latencyMs: data.latencyMs ?? 0,
                      mode: data.mode || 'Pipeline P2P natif',
                      tokensIn: data.tokensIn ?? data.worker?.tokensIn,
                      tokensOut: data.tokensOut ?? data.worker?.tokensOut,
                      promptTokens: data.promptTokens,
                      completionTokens: data.completionTokens,
                      totalTokens: data.totalTokens,
                      p2pMessagesIn: data.p2pMessagesIn,
                      p2pMessagesOut: data.p2pMessagesOut,
                      vpsDelegateMs: data.vpsDelegateMs,
                      workerComputeMs: data.workerComputeMs,
                      computeTimeMs: data.computeTimeMs,
                      routingPath: Array.isArray(data.routingPath) ? data.routingPath : [],
                      schedulerWarmupSent: data.schedulerWarmupSent,
                      schedulerWorkersUsed: data.schedulerWorkersUsed,
                      shardSessionId: data.shardSessionId,
                      primaryWorkerPeerId: data.primaryWorkerPeerId,
                      pipelineTrace: data.pipelineTrace,
                      pipelineWorkers: data.pipelineWorkers,
                      workerInfo: data.worker,
                      quicUsed: data.quicUsed,
                      quicAvailable: data.quicAvailable,
                      kvCacheUsed: data.kvCacheUsed,
                      hiddenTransport: data.hiddenTransport,
                      avgMsPerToken: data.avgMsPerToken,
                      hotPathTps: data.hotPathTps,
                      stopReason: data.stopReason,
                      prefixCacheHit: data.prefixCacheHit,
                      prefixCacheTokens: data.prefixCacheTokens,
                      setupMs: data.setupMs,
                      benchmarkActualTps: data.benchmarkActualTps,
                      genControl: data.genControl,
                      requestedQuantization: data.requestedQuantization,
                      effectiveQuantization: data.effectiveQuantization,
                      quantizationFallbackReason: data.quantizationFallbackReason,
                      poolPreference: data.poolPreference,
                      poolClass: data.poolClass,
                      poolFallbackReason: data.poolFallbackReason,
                      batching: data.batching,
                      overlap: data.overlap,
                      runtimeBackendPerWorker: data.runtimeBackendPerWorker,
                      weightQuantizationPerWorker: data.weightQuantizationPerWorker,
                      attentionBackendPerWorker: data.attentionBackendPerWorker,
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
            streamLog: undefined,
            content: 'Erreur lors de la génération P2P.',
            trace: { worker: '—', latencyMs: 0, mode: 'Erreur' },
          },
        ]
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="panel flex h-full min-h-[78svh] flex-col overflow-hidden border-border bg-card shadow-lg xl:max-h-[calc(100svh-7rem)]">
      <div className="border-b border-border bg-surface/50 px-4 py-4 sm:px-6">
        <h3 className="flex items-center gap-2 text-base font-semibold text-fg sm:text-lg">
          <span className={`flex h-2 w-2 rounded-full ${loading ? 'animate-pulse bg-accent' : 'bg-success'}`} />
          Chat P2P natif (initiateur Rust)
        </h3>
        <p className="mt-1 text-[10px] leading-relaxed text-muted">
          Toutes les requêtes traversent le pipeline gRPC. Avec{' '}
          <span className="font-mono">initiator_sequential</span>, les workers se suivent en chaîne directe pour limiter
          les allers-retours WAN. Côté serveur : <span className="font-mono">VRYX_INITIATOR_CHAT_URL</span> (et
          optionnellement des préfixes CSV pour <span className="font-mono">initiator_chat_url</span>). Aucune
          dépendance Web2 pour l’inférence.
        </p>
        <p className="mt-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] leading-relaxed text-fg">
          Après chaque réponse, ouvrez « Détails du traitement » : QUIC, KV Cache, TPS, tokens et métriques pipeline.
        </p>
        <div className="mt-3 rounded-xl border border-border bg-card p-2">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Quantification du transport P2P
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              {
                id: 'q4' as const,
                title: 'Q4 transport',
                desc: 'Débit filaire privilégié (workers MLX).',
              },
              {
                id: 'int8' as const,
                title: 'INT8 transport',
                desc: 'Alternative entière 8 bits.',
              },
              {
                id: 'fp16' as const,
                title: 'FP16 transport',
                desc: 'Meilleure fidélité, plus lourd sur le réseau.',
              },
            ].map((item) => {
              const selected = quantization === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setQuantization(item.id)}
                  disabled={loading}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? 'border-accent/60 bg-accent/10 text-fg'
                      : 'border-border bg-surface text-muted hover:border-accent/30 hover:text-fg'
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                  aria-pressed={selected}
                >
                  <span className="flex items-center justify-between gap-2 text-[12px] font-semibold">
                    {item.title}
                    {selected ? (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5 text-accent" aria-hidden>
                        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted">{item.desc}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="mt-3 rounded-xl border border-border bg-card p-2">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Pool de calcul
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { id: 'auto' as const, title: 'Auto', desc: 'Velocity si saine, sinon legacy.' },
              { id: 'velocity_mlx' as const, title: 'Velocity MLX', desc: 'Pool Mac optimisée.' },
              { id: 'velocity_vllm' as const, title: 'Velocity vLLM', desc: 'Pool Nvidia PagedAttention.' },
              { id: 'legacy_pytorch' as const, title: 'Legacy PyTorch', desc: 'Chemin stable actuel.' },
            ].map((item) => {
              const selected = poolPreference === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setPoolPreference(item.id)}
                  disabled={loading}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? 'border-success/60 bg-success/10 text-fg'
                      : 'border-border bg-surface text-muted hover:border-success/30 hover:text-fg'
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                  aria-pressed={selected}
                >
                  <span className="block text-[12px] font-semibold">{item.title}</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted">{item.desc}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="mt-3 rounded-xl border border-accent/20 bg-accent/4 p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                Longueur de réponse
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                Le plafond était bloqué à 32 tokens. Ce réglage pilote maintenant{' '}
                <span className="font-mono text-fg">max_new_tokens</span> jusqu’à 1 024 tokens.
              </p>
            </div>
            <div className="flex min-w-0 items-center gap-3 sm:min-w-72">
              <input
                type="range"
                min={32}
                max={1024}
                step={32}
                value={maxNewTokens}
                onChange={(e) => setMaxNewTokens(Number(e.target.value))}
                disabled={loading}
                className="min-w-0 flex-1 accent-current"
                aria-label="Nombre maximum de tokens à générer"
              />
              <span className="w-20 rounded-lg border border-border bg-card px-2 py-1 text-center font-mono text-xs font-semibold text-fg">
                {maxNewTokens}
              </span>
            </div>
          </div>
        </div>
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
            {(() => {
              const tail = messages[messages.length - 1]
              const lastLine =
                tail?.role === 'ai' && tail.streamLog?.length
                  ? tail.streamLog[tail.streamLog.length - 1]
                  : null
              if (lastLine) return lastLine
              return liveWorkers.length > 0
                ? 'Routage côté initiateur (pair P2P choisi dynamiquement). Les étapes détaillées s’affichent sous la bulle.'
                : 'Recherche d’un worker P2P actif. Les étapes détaillées s’affichent sous la bulle.'
            })()}
          </p>
        )}
        {!loading && activeChatPeerId && (
          <p className="mt-2 text-[10px] text-muted">
            Dernier pair actif :{' '}
            <span className="font-mono text-fg">{activeChatPeerId.slice(0, 20)}…</span>
          </p>
        )}
      </div>

      <div className="min-h-[360px] flex-1 space-y-5 overflow-y-auto bg-neutral-100 p-4 sm:p-6 dark:bg-black">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center text-center">
            <p className="text-sm text-muted dark:text-zinc-500">
              Écrivez un message : il sera relayé en chaîne sur le réseau P2P natif (gRPC, sans API centrale).
            </p>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              {m.role === 'ai' && (m.streamLog?.length || (loading && i === messages.length - 1 && !m.trace)) ? (
                <div
                  className={`mb-2 max-w-[95%] rounded-xl border border-border/80 bg-surface/80 px-3 py-2 text-[11px] leading-snug text-muted shadow-sm dark:border-zinc-700 dark:bg-zinc-900/90 sm:max-w-[90%]`}
                  aria-live="polite"
                >
                  <div className="mb-1 flex items-center gap-1.5 font-semibold text-fg">
                    <svg className="h-3.5 w-3.5 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Flux temps réel
                  </div>
                  <ul className="max-h-28 space-y-0.5 overflow-y-auto font-mono text-[10px] text-muted">
                    {(m.streamLog ?? []).slice(-14).map((line, li) => (
                      <li key={`${i}-${li}-${line.slice(0, 24)}`} className="border-l-2 border-accent/35 pl-2 text-fg/90">
                        {line}
                      </li>
                    ))}
                    {loading && i === messages.length - 1 && !(m.streamLog?.length) ? (
                      <li className="border-l-2 border-accent/35 pl-2 text-fg/80">Connexion au flux SSE…</li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
              <div
                className={`max-w-[94%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed sm:max-w-[86%] ${
                  m.role === 'user'
                    ? 'border border-chat-self/35 bg-chat-self text-chat-self-fg shadow-sm'
                    : 'border border-border bg-card text-fg shadow-sm dark:border-zinc-700 dark:bg-zinc-900'
                }`}
              >
                {m.role === 'ai' && !m.content && loading && i === messages.length - 1 ? (
                  <span className="inline-flex items-center gap-2 text-muted">
                    <svg className="h-4 w-4 shrink-0 animate-pulse text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                    En attente des premiers jetons…
                  </span>
                ) : (
                  m.content
                )}
              </div>

              {m.role === 'ai' && m.trace && (
                <WorkerComputeReport
                  trace={m.trace.pipelineTrace}
                  pipelineWorkers={m.trace.pipelineWorkers}
                  roundMetrics={roundMetricsFromTrace(m.trace)}
                />
              )}

              {m.role === 'ai' && m.trace && (
                <details className="mt-1 group">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] text-muted hover:text-accent [&::-webkit-details-marker]:hidden">
                    <svg className="h-3 w-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    Détails du traitement
                  </summary>
                  <div className="mt-1 ml-4 space-y-1 rounded-md border border-border/50 bg-surface/50 p-2 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-900/80">
                    {/* Badges transport & optimisations */}
                    <div className="flex flex-wrap gap-1 pb-1.5 border-b border-border/40">
                      {m.trace.quicUsed != null && (
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${m.trace.quicUsed ? 'bg-success/15 text-success' : 'bg-border/40 text-muted'}`}>
                          {m.trace.quicUsed ? 'QUIC UDP' : 'TCP'}
                        </span>
                      )}
                      {m.trace.kvCacheUsed != null && (
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${m.trace.kvCacheUsed ? 'bg-electric/15 text-electric' : 'bg-border/40 text-muted'}`}>
                          {m.trace.kvCacheUsed ? 'KV Cache ON' : 'KV Cache OFF'}
                        </span>
                      )}
                      {m.trace.hiddenTransport && (
                        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-accent">
                          {m.trace.hiddenTransport}
                        </span>
                      )}
                      {m.trace.requestedQuantization && (
                        <span className="rounded bg-electric/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-electric">
                          demandé : {quantizationLabel(m.trace.requestedQuantization)}
                        </span>
                      )}
                      {m.trace.quantizationFallbackReason && (
                        <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold text-warning">
                          fallback : {m.trace.quantizationFallbackReason}
                        </span>
                      )}
                      {m.trace.poolClass && (
                        <span className="rounded bg-success/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-success">
                          pool : {m.trace.poolClass}
                        </span>
                      )}
                      {m.trace.poolFallbackReason && (
                        <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold text-warning">
                          pool fallback : {m.trace.poolFallbackReason}
                        </span>
                      )}
                      {m.trace.prefixCacheHit != null && (
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${m.trace.prefixCacheHit ? 'bg-primary/15 text-primary' : 'bg-border/40 text-muted'}`}>
                          {m.trace.prefixCacheHit
                            ? `Prefix Cache HIT (${m.trace.prefixCacheTokens ?? 0} tok)`
                            : 'Prefix Cache MISS'}
                        </span>
                      )}
                      {m.trace.stopReason && m.trace.stopReason !== 'null' && (
                        <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold text-warning">
                          arrêt : {m.trace.stopReason}
                        </span>
                      )}
                    </div>
                    {/* TPS & performance */}
                    {(m.trace.hotPathTps != null && m.trace.hotPathTps > 0) && (
                      <div className="flex justify-between border-b border-border/40 pb-1">
                        <span className="text-muted">TPS réel</span>
                        <span className="font-bold text-success">{m.trace.hotPathTps.toFixed(3)} tok/s</span>
                      </div>
                    )}
                    {(m.trace.avgMsPerToken != null && m.trace.avgMsPerToken > 0) && (
                      <div className="flex justify-between">
                        <span className="text-muted">Moy. ms/token</span>
                        <span className="text-fg">{m.trace.avgMsPerToken} ms</span>
                      </div>
                    )}
                    <div className="flex justify-between gap-2">
                      <span className="text-muted">Worker</span>
                      <span className="max-w-[60%] text-right text-accent">{m.trace.worker}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Latence</span>
                      <span className="text-fg">{m.trace.latencyMs} ms</span>
                    </div>
                    {(m.trace.setupMs != null && m.trace.setupMs > 0) && (
                      <div className="flex justify-between">
                        <span className="text-muted">Setup pipeline</span>
                        <span className="text-fg">{m.trace.setupMs} ms</span>
                      </div>
                    )}
                    <div className="flex justify-between border-t border-border/60 pt-1">
                      <span className="text-muted">Tokens LLM</span>
                      <span className="text-electric">
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
                      <span className="text-muted">Calcul worker (compute_time_ms)</span>
                      <span className="text-fg">
                        {(m.trace.computeTimeMs ?? m.trace.workerComputeMs ?? 0) > 0
                          ? `${m.trace.computeTimeMs ?? m.trace.workerComputeMs} ms`
                          : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Orchestration initiateur</span>
                      <span className="text-fg">{m.trace.vpsDelegateMs ?? 0} ms</span>
                    </div>
                    {(m.trace.routingPath?.length ?? 0) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted">Chaîne de relais</span>
                        <span className="text-fg">{m.trace.routingPath?.length} nœud(s) · Daisy Chain</span>
                      </div>
                    )}
                    {(m.trace.schedulerWorkersUsed ?? 0) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted">Pipeline</span>
                        <span className="text-fg">
                          {Array.isArray(m.trace.pipelineWorkers) && m.trace.pipelineWorkers.length > 0
                            ? `${m.trace.pipelineWorkers.length} étape(s) P2P`
                            : `${m.trace.schedulerWorkersUsed} worker(s) contacté(s)`}
                          {(m.trace.schedulerWarmupSent ?? 0) > 0
                            ? ` · warmup historique ${m.trace.schedulerWarmupSent}`
                            : ''}
                        </span>
                      </div>
                    )}
                    {m.trace.primaryWorkerPeerId ? (
                      <div className="flex justify-between">
                        <span className="text-muted">Nœud d'entrée (relais)</span>
                        <span className="max-w-[58%] truncate text-right text-fg" title={m.trace.primaryWorkerPeerId}>
                          {m.trace.primaryWorkerPeerId.slice(0, 18)}…
                        </span>
                      </div>
                    ) : null}
                    {m.trace.shardSessionId ? (
                      <div className="flex justify-between">
                        <span className="text-muted">Session shard</span>
                        <span className="max-w-[55%] truncate text-fg" title={m.trace.shardSessionId}>
                          {m.trace.shardSessionId}
                        </span>
                      </div>
                    ) : null}
                    {/* Paramètres de génération */}
                    {m.trace.genControl && (
                      <div className="mt-0.5 border-t border-border/40 pt-1 space-y-0.5">
                        <p className="text-[9px] font-semibold uppercase tracking-wide text-muted">Génération</p>
                        {m.trace.genControl.temperature != null && (
                          <div className="flex justify-between">
                            <span className="text-muted">Température</span>
                            <span className="text-fg">{String(m.trace.genControl.temperature)}</span>
                          </div>
                        )}
                        {m.trace.genControl.top_p != null && (
                          <div className="flex justify-between">
                            <span className="text-muted">Top-P / Top-K</span>
                            <span className="text-fg">
                              {String(m.trace.genControl.top_p)} / {String(m.trace.genControl.top_k ?? '—')}
                            </span>
                          </div>
                        )}
                        {m.trace.genControl.repetition_penalty != null && (
                          <div className="flex justify-between">
                            <span className="text-muted">Pén. répétition</span>
                            <span className="text-fg">{String(m.trace.genControl.repetition_penalty)}</span>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex justify-between border-t border-border/60 pt-1">
                      <span className="text-muted">Méthode</span>
                      <span className="text-fg">{m.trace.mode}</span>
                    </div>
                    {m.trace.workerInfo && (
                      <>
                        <div className="flex justify-between border-t border-border/60 pt-1">
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
                        {(m.trace.workerInfo.gpuName || m.trace.workerInfo.gpuVramMb != null) && (
                          <div className="flex justify-between">
                            <span className="text-muted">GPU</span>
                            <span className="max-w-[58%] text-right text-fg">
                              {m.trace.workerInfo.gpuName || '—'}
                              {m.trace.workerInfo.gpuVramMb != null && m.trace.workerInfo.gpuVramMb > 0
                                ? ` · ${m.trace.workerInfo.gpuVramMb} Mo`
                                : ''}
                            </span>
                          </div>
                        )}
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

      <div className="border-t border-border bg-card p-3 dark:bg-zinc-950 sm:p-4">
        <div className="relative flex items-end gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="Message complet au réseau P2P… Maj + Entrée pour une nouvelle ligne."
            rows={3}
            className="max-h-52 min-h-24 w-full resize-y rounded-2xl border border-border bg-surface py-3 pl-4 pr-14 text-sm leading-relaxed text-fg focus:border-accent/50 focus:ring-1 focus:ring-accent/20 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="button"
            onClick={send}
            disabled={loading || !prompt.trim()}
            className="absolute bottom-2.5 right-2.5 flex h-10 w-10 items-center justify-center rounded-full bg-chat-self text-chat-self-fg shadow-sm transition-opacity hover:opacity-95 disabled:opacity-50"
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
