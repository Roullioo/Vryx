import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WorkerRoundMetrics } from './workerRoundMetrics'
import { WorkerComputeReport } from './WorkerComputeReport'
import { ChatMarkdown } from './ChatMarkdown'
import { buildSession, saveSession, saveSessionToDb } from '../../lib/sessions'

type QuantizationMode = 'int8' | 'q4' | 'fp16'
type PoolPreference = 'auto' | 'velocity_mlx' | 'velocity_vllm' | 'legacy_pytorch'

/** Plafond interactif: ajusté selon le modèle live, avec garde-fou côté serveur. */
export const P2P_ADMIN_MAX_NEW_TOKENS = 32768
const P2P_ADMIN_MIN_NEW_TOKENS = 16
const P2P_ADMIN_TOKEN_STEP = 64

function modelTokenBudget(model?: string | null) {
  const m = String(model || '').toLowerCase()
  if (m.includes('llama') && m.includes('70')) return 4096
  if (m.includes('llama-2') || m.includes('llama 2')) return 4096
  if (m.includes('qwen')) return 16384
  if (m.includes('mistral') || m.includes('mixtral')) return 8192
  return 8192
}

function modelSelectionTokenBudget(model?: string | null, fallbackWorkers: LiveWorker[] = []) {
  if (model) {
    return modelTokenBudget(model)
  }
  return poolTokenBudget(fallbackWorkers)
}

function poolTokenBudget(workers: LiveWorker[]) {
  const budgets = workers
    .map((worker) => modelTokenBudget(worker.model))
    .filter((n) => Number.isFinite(n) && n > 0)
  return Math.min(P2P_ADMIN_MAX_NEW_TOKENS, Math.max(2048, ...(budgets.length ? budgets : [8192])))
}

function requiredWorkersForModel(model?: string | null) {
  const m = String(model || '').toLowerCase()
  if (m.includes('llama-2-70b') || m.includes('llama2-70b') || m.includes('70b')) return 2
  return 1
}

function availableWorkerModelOptions(workers: LiveWorker[]) {
  const counts = new Map<string, number>()
  for (const worker of workers) {
    const model = worker.model?.trim()
    if (!model) continue
    counts.set(model, (counts.get(model) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([model, count]) => {
      const required = requiredWorkersForModel(model)
      return { model, count, required, runnable: count >= required }
    })
    .sort((a, b) => Number(b.runnable) - Number(a.runnable) || b.count - a.count)
}

function defaultTokenBudget(max: number) {
  return Math.min(max, 2048)
}

function clampTokens(n: number, max = P2P_ADMIN_MAX_NEW_TOKENS) {
  const raw = Number.isFinite(n) ? Math.floor(n) : P2P_ADMIN_MIN_NEW_TOKENS
  const stepped = Math.round(raw / P2P_ADMIN_TOKEN_STEP) * P2P_ADMIN_TOKEN_STEP
  return Math.min(max, Math.max(P2P_ADMIN_MIN_NEW_TOKENS, stepped))
}

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
  pingMs?: number
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
    pingMs: t.pingMs,
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
  liveSec = 30,
  activeChatPeerId,
  onP2pRoundComplete,
  aside,
  layout = 'card',
}: {
  liveWorkers: LiveWorker[]
  /** Fenêtre heartbeat affichée (secondes), alignée sur l’API live. */
  liveSec?: number
  activeChatPeerId: string | null
  onP2pRoundComplete?: (
    workerPeerId: string,
    meta?: {
      pipelineTrace?: unknown
      pipelineWorkers?: unknown
      roundMetrics?: WorkerRoundMetrics
    },
  ) => void
  aside?: ReactNode
  layout?: 'card' | 'full'
}) {
  const [selectedModelId, setSelectedModelId] = useState('')
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
  const modelOptions = useMemo(() => availableWorkerModelOptions(liveWorkers), [liveWorkers])
  const runnableModelOptions = useMemo(() => modelOptions.filter((model) => model.runnable), [modelOptions])
  const chatModelId = selectedModelId || runnableModelOptions[0]?.model || ''
  const activeTokenBudget = modelSelectionTokenBudget(chatModelId, liveWorkers)
  const [maxNewTokens, setMaxNewTokens] = useState(defaultTokenBudget(activeTokenBudget))
  const chatAbortRef = useRef<AbortController | null>(null)
  const [isWideLayout, setIsWideLayout] = useState(
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true,
  )

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const sync = () => setIsWideLayout(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    setMaxNewTokens((current) => clampTokens(Math.min(current, activeTokenBudget), activeTokenBudget))
  }, [activeTokenBudget])

  useEffect(() => {
    const nextModel = runnableModelOptions[0]?.model || ''
    if (!nextModel) {
      setSelectedModelId('')
      return
    }
    if (selectedModelId && runnableModelOptions.some((option) => option.model === selectedModelId)) {
      return
    }
    if (!selectedModelId) {
      setSelectedModelId(nextModel)
    }
  }, [selectedModelId, runnableModelOptions])

  function cancelGeneration() {
    chatAbortRef.current?.abort()
    chatAbortRef.current = null
  }

  async function send() {
    if (!prompt.trim() || loading) return
    if (!chatModelId) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          content:
            'Aucun modèle exécutable pour le moment. Llama2 70B demande 2 workers compatibles en ligne ; le pool actuel est incomplet, donc je bloque l’envoi au lieu de lancer un faux calcul à 0 TPS.',
          trace: { worker: '—', latencyMs: 0, mode: 'Pool incomplet' },
        },
      ])
      return
    }
    const userMsg = prompt.trim()
    setPrompt('')
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }, { role: 'ai', content: '' }])
    setLoading(true)
    const ac = new AbortController()
    chatAbortRef.current = ac

    try {
      const response = await fetch('/api/admin/p2p/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: ac.signal,
        body: JSON.stringify({
          prompt: userMsg,
          quantization,
          pool_preference: poolPreference,
          load_mode: 'shard',
          force_distributed: true,
          maxNewTokens,
          model_id: chatModelId,
        }),
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
              pingMs?: number | null
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
                const errorText = data.error || 'Erreur P2P.'
                return [
                  ...rest,
                  {
                    ...last,
                    streamLog: undefined,
                    content: errorText,
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
                pingMs: Number(data.pingMs ?? 0) || undefined,
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
                      pingMs: data.pingMs ?? 0,
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
    } catch (e: unknown) {
      const aborted =
        (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError') ||
        (e instanceof Error && e.name === 'AbortError')
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        const rest = prev.slice(0, -1)
        return [
          ...rest,
          {
            ...last,
            streamLog: undefined,
            content: aborted
              ? 'Génération interrompue (annulation côté navigateur).'
              : 'Erreur lors de la génération P2P.',
            trace: { worker: '—', latencyMs: 0, mode: aborted ? 'Annulé' : 'Erreur' },
          },
        ]
      })
    } finally {
      chatAbortRef.current = null
      setLoading(false)
    }
  }

  const pipelineSettingsControls = (
    <div className="flex flex-col gap-1.5 lg:flex-row lg:flex-wrap lg:items-stretch lg:gap-2 lg:overflow-visible">
      <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg border border-border/80 bg-card/90 p-1.5 shadow-sm lg:min-w-0">
        <p className="text-[9px] font-semibold uppercase tracking-wide text-muted leading-none">Modèle</p>
        {modelOptions.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/60 px-2 py-2 text-[10px] text-muted">
            Aucun modèle worker disponible
          </div>
        ) : (
          <select
            value={chatModelId || ''}
            onChange={(ev) => setSelectedModelId(ev.target.value)}
            disabled={loading || runnableModelOptions.length === 0}
            className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
          >
            {runnableModelOptions.length > 0 ? <option value="">Sélection automatique</option> : null}
            {modelOptions.map((option) => (
              <option key={option.model} value={option.model} disabled={!option.runnable}>
                {option.model}
                {option.runnable ? '' : ` — attente ${option.count}/${option.required} worker(s)`}
              </option>
            ))}
          </select>
        )}
        <p className="text-[10px] text-muted">Modèle actif : {chatModelId || '—'}</p>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg border border-border/80 bg-card/90 p-1.5 shadow-sm lg:min-w-0">
        <p className="text-[9px] font-semibold uppercase tracking-wide text-muted leading-none">Transport P2P</p>
        <div className="grid grid-cols-3 gap-1">
          {[
            { id: 'q4' as const, short: 'Q4', title: 'Q4 transport', desc: 'Débit filaire privilégié (workers MLX).' },
            { id: 'int8' as const, short: 'INT8', title: 'INT8 transport', desc: 'Alternative entière 8 bits.' },
            { id: 'fp16' as const, short: 'FP16', title: 'FP16 transport', desc: 'Meilleure fidélité, plus lourd sur le réseau.' },
          ].map((item) => {
            const selected = quantization === item.id
            return (
              <button
                key={item.id}
                type="button"
                title={`${item.title} — ${item.desc}`}
                onClick={() => setQuantization(item.id)}
                disabled={loading}
                className={`rounded-md border px-1.5 py-1 text-left transition-colors ${
                  selected
                    ? 'border-accent/60 bg-accent/10 text-fg'
                    : 'border-border bg-surface text-muted hover:border-accent/30 hover:text-fg'
                } disabled:cursor-not-allowed disabled:opacity-60`}
                aria-pressed={selected}
              >
                <span className="flex items-center justify-between gap-1 text-[10px] font-semibold leading-tight">
                  <span className="truncate">{item.short}</span>
                  {selected ? (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3 shrink-0 text-accent" aria-hidden>
                      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                    </svg>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg border border-border/80 bg-card/90 p-1.5 shadow-sm lg:min-w-0">
        <p className="text-[9px] font-semibold uppercase tracking-wide text-muted leading-none">Pool de calcul</p>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
          {[
            { id: 'auto' as const, short: 'Auto', title: 'Auto', desc: 'Velocity si saine, sinon legacy.' },
            { id: 'velocity_mlx' as const, short: 'MLX', title: 'Velocity MLX', desc: 'Pool Mac optimisée.' },
            { id: 'velocity_vllm' as const, short: 'vLLM', title: 'Velocity vLLM', desc: 'Pool Nvidia PagedAttention.' },
            { id: 'legacy_pytorch' as const, short: 'PyTorch', title: 'Legacy PyTorch', desc: 'Chemin stable actuel.' },
          ].map((item) => {
            const selected = poolPreference === item.id
            return (
              <button
                key={item.id}
                type="button"
                title={`${item.title} — ${item.desc}`}
                onClick={() => setPoolPreference(item.id)}
                disabled={loading}
                className={`rounded-md border px-1.5 py-1 text-left transition-colors ${
                  selected
                    ? 'border-success/60 bg-success/10 text-fg'
                    : 'border-border bg-surface text-muted hover:border-success/30 hover:text-fg'
                } disabled:cursor-not-allowed disabled:opacity-60`}
                aria-pressed={selected}
              >
                <span className="block text-[10px] font-semibold leading-tight">{item.short}</span>
              </button>
            )
          })}
        </div>
      </div>
      <div
        className="flex min-w-0 shrink-0 flex-col gap-1 rounded-lg border border-accent/25 bg-gradient-to-br from-accent/[0.06] to-card p-1.5 lg:w-[min(100%,18rem)] xl:w-80"
        title={`max_new_tokens côté initiateur ; plafond modèle actif ${activeTokenBudget.toLocaleString('fr-FR')} jetons. Le serveur applique aussi son garde-fou.`}
      >
        <p className="text-[9px] font-semibold uppercase tracking-wide text-muted leading-none">Budget jetons</p>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={P2P_ADMIN_MIN_NEW_TOKENS}
            max={activeTokenBudget}
            step={P2P_ADMIN_TOKEN_STEP}
            value={maxNewTokens}
            onChange={(e) => setMaxNewTokens(clampTokens(Number(e.target.value), activeTokenBudget))}
            disabled={loading}
            className="h-2 min-h-0 min-w-0 flex-1 cursor-pointer accent-accent"
            aria-valuemin={P2P_ADMIN_MIN_NEW_TOKENS}
            aria-valuemax={activeTokenBudget}
            aria-valuenow={maxNewTokens}
            aria-label="Nombre maximum de tokens à générer"
          />
          <label className="flex shrink-0 items-center gap-1">
            <span className="sr-only">Valeur exacte</span>
            <input
              type="number"
              min={P2P_ADMIN_MIN_NEW_TOKENS}
              max={activeTokenBudget}
              step={P2P_ADMIN_TOKEN_STEP}
              value={maxNewTokens}
              onChange={(e) => setMaxNewTokens(clampTokens(Number(e.target.value), activeTokenBudget))}
              disabled={loading}
              className="w-16 rounded-md border border-border bg-card px-1 py-1 text-center font-mono text-xs font-semibold text-fg tabular-nums"
            />
          </label>
        </div>
      </div>
      {loading && (
        <p className="flex w-full min-w-0 basis-full items-center gap-2 rounded-xl border border-accent/20 bg-accent/5 px-2 py-1.5 text-[10px] font-medium leading-tight text-accent">
          <span className="vryx-mini-loader shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {(() => {
              const tail = messages[messages.length - 1]
              const lastLine =
                tail?.role === 'ai' && tail.streamLog?.length
                  ? tail.streamLog[tail.streamLog.length - 1]
                  : null
              if (lastLine) return lastLine
              return liveWorkers.length > 0
                ? 'Routage initiateur : étapes sous la bulle assistant.'
                : 'Recherche worker P2P ; étapes sous la bulle assistant.'
            })()}
          </span>
        </p>
      )}
      {!loading && activeChatPeerId && (
        <p className="w-full basis-full text-[9px] text-muted">
          Pair : <span className="font-mono text-fg">{activeChatPeerId.slice(0, 18)}…</span>
        </p>
      )}
    </div>
  )

  const isFull = layout === 'full'

  return (
    <section
      className={
        isFull
          ? aside
            ? 'flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-card lg:flex-row'
            : 'flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-card'
          : 'flex w-full flex-col overflow-hidden rounded-2xl border border-border/90 bg-card shadow-md ring-1 ring-zinc-950/4 dark:bg-zinc-950/40 dark:ring-white/[0.07] min-h-[min(86dvh,calc(100dvh-10.5rem))] max-h-[min(92dvh,calc(100dvh-7.5rem))] sm:min-h-[min(80dvh,calc(100dvh-9rem))] lg:max-h-[min(90dvh,calc(100dvh-6.5rem))]'
      }
      aria-labelledby="p2p-admin-chat-title"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border/80 bg-gradient-to-b from-surface/95 to-card px-3 py-3 sm:px-5 sm:py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3
              id="p2p-admin-chat-title"
              className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-fg sm:text-base"
            >
              <span
                className={`flex h-2 w-2 shrink-0 rounded-full ${loading ? 'animate-pulse bg-accent' : 'bg-success'}`}
                aria-hidden
              />
              Zone de dialogue
            </h3>
            <p className="mt-1 text-[11px] leading-snug text-muted sm:text-xs">
              Initiateur Rust · SSE · chaîne <span className="font-mono text-fg/85">initiator_sequential</span>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <div
              className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-surface/90 px-2.5 py-1 text-[10px] font-medium text-muted sm:text-xs"
              title="Workers vus par l’API live dans la fenêtre heartbeat"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
              <span>
                <span className="font-semibold tabular-nums text-fg">{liveWorkers.length}</span> pair
                {liveWorkers.length !== 1 ? 's' : ''} · {liveSec}s
              </span>
            </div>
            {loading ? (
              <div className="flex shrink-0 items-center gap-2 rounded-full border border-accent/25 bg-accent/8 px-2.5 py-1 text-[10px] font-semibold text-accent">
                <span className="vryx-mini-loader scale-75" aria-hidden />
                En cours
              </div>
            ) : null}
          </div>
        </div>
        <details className="mt-2 rounded-lg border border-border/70 bg-surface/40 text-left sm:mt-3">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-muted marker:text-muted sm:px-3 sm:text-xs">
            Aide · variables serveur et worker Mac
          </summary>
          <div className="space-y-2 border-t border-border/60 px-2 py-2 text-[11px] leading-relaxed text-muted sm:px-3 sm:text-xs">
            <p>
              Côté API : <span className="font-mono text-fg/90">VRYX_INITIATOR_CHAT_URL</span>, option{' '}
              <span className="font-mono text-fg/90">VRYX_ALLOWED_INITIATOR_CHAT_PREFIXES</span> pour surcharger l&apos;URL
              initiateur.
            </p>
            <p className="rounded-md border border-border/60 bg-card/80 px-2 py-1.5 text-[10px] sm:text-[11px]">
              Après chaque réponse : ouvrir « Détails du traitement » sous la bulle (QUIC, KV cache, TPS, tokens).
            </p>
            <details className="rounded-md border border-border/60 bg-card/80">
              <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-semibold text-fg sm:text-xs">
                « Aucun worker P2P actif » : lancer le worker sur Apple Silicon
              </summary>
              <div className="space-y-2 border-t border-border/50 px-2 py-2 text-[10px] sm:text-[11px]">
                <p>
                  L&apos;initiateur doit voir au moins un pair dans le swarm (message d&apos;erreur : connectés P2P). Sur le Mac,
                  dans le dépôt :
                </p>
                <pre className="overflow-x-auto rounded-md border border-border bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-zinc-100">
                  {`cd nodeAndWorker
./start-worker.sh --model "Qwen/Qwen3.5-9B" --p2p-port 4021`}
                </pre>
                <p>
                  Laisser le terminal ouvert ; vérifier <span className="font-mono text-fg">worker_daemon.log</span> (ligne
                  « Heartbeat OK »), puis renvoyer un message ici.
                </p>
              </div>
            </details>
          </div>
        </details>
      </header>

      {isWideLayout ? (
        <div className="shrink-0 border-b border-border/70 bg-muted/35 px-2 py-1.5 sm:px-3">
          {pipelineSettingsControls}
        </div>
      ) : (
        <details className="shrink-0 border-b border-border/70 bg-muted/35">
          <summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-xs font-semibold text-fg [&::-webkit-details-marker]:hidden sm:px-3 sm:text-sm">
            <svg className="h-3.5 w-3.5 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h10M4 18h16" />
            </svg>
            Réglages du pipeline
          </summary>
          <div className="border-t border-border/50 px-2 pb-2 pt-1.5 sm:px-3">
            {pipelineSettingsControls}
          </div>
        </details>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={
            isFull
              ? 'min-h-0 flex-1 touch-pan-y space-y-6 overflow-y-auto overscroll-y-contain bg-gradient-to-b from-zinc-100/95 to-zinc-100/80 px-3 py-4 sm:px-5 sm:py-5 dark:from-zinc-900/90 dark:to-zinc-950/85 dark:ring-1 dark:ring-inset dark:ring-zinc-800/80'
              : 'min-h-[min(52dvh,22rem)] flex-1 touch-pan-y space-y-6 overflow-y-auto overscroll-y-contain bg-gradient-to-b from-zinc-100/95 to-zinc-100/80 px-3 py-4 sm:min-h-[min(48dvh,24rem)] sm:px-5 sm:py-5 dark:from-zinc-900/90 dark:to-zinc-950/85 dark:ring-1 dark:ring-inset dark:ring-zinc-800/80'
          }
        >
        {messages.length === 0 ? (
          <div
            className={
              isFull
                ? 'flex min-h-[min(36dvh,12rem)] flex-col items-center justify-center gap-4 px-2 py-8 text-center sm:min-h-0 sm:flex-1 sm:py-10'
                : 'flex min-h-[min(48dvh,18rem)] flex-col items-center justify-center gap-4 px-2 py-10 text-center sm:min-h-[min(44dvh,20rem)] sm:py-12'
            }
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/80 bg-card shadow-sm">
              <svg className="h-7 w-7 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <div className="max-w-md space-y-2">
              <p className="text-base font-medium leading-relaxed text-zinc-900 dark:text-zinc-50 sm:text-lg">
                Premier message
              </p>
              <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                Le texte traverse le réseau P2P natif (gRPC). Réglez le budget de tokens ci-dessus si besoin, puis
                écrivez votre consigne.
              </p>
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex flex-col gap-1.5 ${m.role === 'user' ? 'items-end' : 'items-stretch sm:items-start'}`}>
              {m.role === 'ai' && (m.streamLog?.length || (loading && i === messages.length - 1 && !m.trace)) ? (
                <details
                  className={`mb-1 max-w-[95%] rounded-xl border border-border/80 bg-white/95 px-3 py-2 text-xs leading-snug text-zinc-700 shadow-sm open:pb-2.5 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 sm:max-w-[90%]`}
                  aria-live="polite"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-left text-sm font-semibold text-zinc-900 marker:content-none dark:text-zinc-50 [&::-webkit-details-marker]:hidden">
                    <svg className="h-3.5 w-3.5 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    <span className="min-w-0 shrink-0">Flux temps réel</span>
                    <span className="min-w-0 truncate font-mono text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
                      {(m.streamLog ?? []).length
                        ? (m.streamLog ?? [])[(m.streamLog ?? []).length - 1]
                        : loading && i === messages.length - 1
                          ? 'Connexion au flux SSE…'
                          : ''}
                    </span>
                  </summary>
                  <ul className="mt-2 max-h-28 space-y-1 overflow-y-auto border-t border-border/50 pt-2 font-mono text-[11px] leading-snug text-zinc-600 dark:border-zinc-600 dark:text-zinc-300 sm:max-h-32">
                    {(m.streamLog ?? []).slice(-10).map((line, li) => (
                      <li key={`${i}-${li}-${line.slice(0, 24)}`} className="border-l-2 border-accent/50 pl-2 text-zinc-800 dark:text-zinc-100">
                        {line}
                      </li>
                    ))}
                    {loading && i === messages.length - 1 && !(m.streamLog?.length) ? (
                      <li className="border-l-2 border-accent/50 pl-2 text-zinc-700 dark:text-zinc-200">Connexion au flux SSE…</li>
                    ) : null}
                  </ul>
                </details>
              ) : null}
              <div
                className={`rounded-2xl px-4 py-3.5 text-[15px] leading-[1.7] shadow-sm sm:px-5 sm:text-base ${
                  isFull ? 'max-w-[min(100%,min(94vw,88rem))]' : 'max-w-[min(100%,42rem)]'
                } ${
                  m.role === 'user'
                    ? 'border border-chat-self/35 bg-chat-self text-chat-self-fg'
                    : 'border border-zinc-200/90 bg-white text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800/95 dark:text-zinc-50'
                }`}
              >
                {m.role === 'ai' && !m.content && loading && i === messages.length - 1 ? (
                  <span className="inline-flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
                    <span className="vryx-mini-loader shrink-0" aria-hidden />
                    En attente des premiers jetons…
                  </span>
                ) : m.content?.trim() ? (
                  <ChatMarkdown text={m.content} tone={m.role === 'user' ? 'self' : 'default'} />
                ) : null}
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
                    {(m.trace.pingMs ?? 0) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted">Ping P2P</span>
                        <span className="text-fg">{Math.round(m.trace.pingMs ?? 0)} ms</span>
                      </div>
                    )}
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
      </div>

      <footer className="shrink-0 border-t border-border/90 bg-card/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-10px_30px_-18px_rgba(0,0,0,0.1)] dark:bg-zinc-950/95 sm:px-5 sm:pb-4 sm:pt-4">
        {loading ? (
          <div className="mb-2 flex justify-end sm:mb-3">
            <button
              type="button"
              onClick={cancelGeneration}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-fg transition-colors hover:bg-surface/80 active:scale-[0.99]"
            >
              Annuler la requête
            </button>
          </div>
        ) : null}
        <div className="relative flex items-end gap-2 sm:gap-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="Votre message au réseau P2P… (Maj + Entrée : nouvelle ligne)"
            rows={3}
            className="min-h-[5.5rem] max-h-[40vh] w-full resize-y rounded-2xl border border-zinc-300 bg-white py-3 pl-4 pr-14 text-base leading-relaxed text-zinc-900 placeholder:text-zinc-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 sm:min-h-[6rem] sm:py-3.5 sm:pl-5 sm:pr-16 sm:text-[17px]"
          />
          <button
            type="button"
            onClick={send}
            disabled={loading || !prompt.trim() || !chatModelId}
            className="absolute bottom-2.5 right-2.5 flex h-11 w-11 items-center justify-center rounded-full bg-chat-self text-chat-self-fg shadow-md transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45 sm:bottom-3 sm:right-3 sm:h-12 sm:w-12"
            aria-label="Envoyer"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
      </footer>
      </div>
      {aside ? (
        <aside className="max-h-[min(42vh,18rem)] w-full shrink-0 overflow-y-auto overscroll-contain border-t border-border bg-card/95 p-3 lg:max-h-none lg:w-[min(100%,24rem)] lg:border-l lg:border-t-0 lg:p-4 xl:w-[26rem]">
          {aside}
        </aside>
      ) : null}
    </section>
  )
}
