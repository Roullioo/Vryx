import { apiJson } from './api'

/** Stockage des sessions de travail P2P en localStorage, synchronisé avec la DB admin si disponible. */

export type SessionWorkerStep = {
  rank: number
  peerId: string
  role: string
  latencyMs: number
  outRows?: number
}

export type SessionTokenStep = {
  tokenIndex: number
  totalMs: number
  hopCount: number
  byte?: number
}

export type SessionLoadStep = {
  rank: number
  peerId: string
  loadMs: number
}

export type WorkSession = {
  id: string
  timestamp: number
  prompt: string
  response: string
  /** Total latence client→réponse (ms) */
  latencyMs: number
  vpsDelegateMs: number
  workerComputeMs: number
  /** Proto `compute_time_ms` (télémétrie réelle worker). */
  computeTimeMs?: number
  /** Chemin Daisy Chain (`routing_path`). */
  routingPath?: string[]
  promptTokens: number
  completionTokens: number
  totalTokens: number
  p2pMessagesIn: number
  p2pMessagesOut: number
  mode: string
  workerPeerId: string
  primaryWorkerPeerId: string
  schedulerWorkersUsed: number
  schedulerWarmupSent: number
  /** Layout du pipeline (pipeline_relay_daisy_chain, worker_only_pipeline, anciennes traces TP, …) */
  pipelineLayout: string
  pipelineOk: boolean
  /** Pairs qui ont reçu des calculs */
  peers: string[]
  /** Étapes de génération par token */
  tokenSteps: SessionTokenStep[]
  /** Chargement des poids par pair */
  loadSteps: SessionLoadStep[]
  /** Étapes TP / pipeline */
  workerSteps: SessionWorkerStep[]
  /** Infos worker principal */
  workerInfo?: {
    peerId: string
    publicIp: string | null
    grpcPort: number | null
    p2pPort: number | null
    model: string | null
    ownerEmail: string | null
    online: boolean
    secondsSinceHeartbeat: number
  }
  /** Transport QUIC UDP activé */
  quicUsed?: boolean
  /** KV cache distribué activé */
  kvCacheUsed?: boolean
  /** Format des hidden states (int8, fp16…) */
  hiddenTransport?: string
  /** Latence moyenne par token (ms) */
  avgMsPerToken?: number
  /** TPS mesuré sur le tour */
  hotPathTps?: number
  /** Raison d'arrêt de la génération */
  stopReason?: string | null
  /** Prefix cache : hit ? */
  prefixCacheHit?: boolean
  /** Tokens récupérés du prefix cache */
  prefixCacheTokens?: number
  /** Setup du pipeline (ms) */
  setupMs?: number
  /** TPS benchmark agrégé */
  benchmarkActualTps?: number
  /** Format demandé par l'admin dans le chat P2P. */
  requestedQuantization?: 'int8' | 'q4' | 'fp16'
  /** Format réellement utilisé après validation/fallback. */
  effectiveQuantization?: string
  /** Raison du fallback, si q4 n'a pas pu être appliqué. */
  quantizationFallbackReason?: string | null
  poolPreference?: 'auto' | 'velocity_mlx' | 'velocity_vllm' | 'legacy_pytorch'
  poolClass?: string
  poolFallbackReason?: string | null
  batching?: Record<string, unknown> | null
  overlap?: Record<string, unknown> | null
}

const KEY = 'vryx_admin_sessions'
const MAX = 100

function asNum(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function loadSessions(): WorkSession[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as WorkSession[]) : []
  } catch {
    return []
  }
}

export function saveSession(s: WorkSession): void {
  try {
    const sessions = loadSessions()
    const filtered = sessions.filter((x) => x.id !== s.id)
    const updated = [s, ...filtered].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(updated))
  } catch {
    /* quota exceeded, ignore */
  }
}

export function deleteSession(id: string): void {
  try {
    const sessions = loadSessions().filter((s) => s.id !== id)
    localStorage.setItem(KEY, JSON.stringify(sessions))
  } catch {
    void 0
  }
}

export function clearSessions(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    void 0
  }
}

export async function fetchSessionsFromDb(): Promise<WorkSession[]> {
  const r = await apiJson<{ ok?: boolean; sessions?: WorkSession[] }>('/api/admin/sessions')
  if (r.ok !== true) return loadSessions()
  const sessions = Array.isArray(r.data.sessions) ? r.data.sessions : []
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions.slice(0, MAX)))
  } catch {
    void 0
  }
  return sessions
}

export async function fetchSessionFromDb(id: string): Promise<WorkSession | null> {
  const r = await apiJson<{ ok?: boolean; session?: WorkSession }>(`/api/admin/sessions/${encodeURIComponent(id)}`)
  if (r.ok !== true || !r.data.session) return null
  return r.data.session
}

export async function saveSessionToDb(s: WorkSession): Promise<void> {
  await apiJson('/api/admin/sessions', {
    method: 'POST',
    body: JSON.stringify({ session: s }),
  })
}

export async function deleteSessionFromDb(id: string): Promise<void> {
  await apiJson(`/api/admin/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function clearSessionsFromDb(): Promise<void> {
  await apiJson('/api/admin/sessions', { method: 'DELETE' })
}

/** Construit une WorkSession depuis les données brutes d'un tour P2P. */
export function buildSession(params: {
  prompt: string
  response: string
  data: Record<string, unknown>
  pipelineTrace: unknown
  pipelineWorkers: unknown
  workerInfo?: WorkSession['workerInfo']
}): WorkSession {
  const { prompt, response, data, pipelineTrace, pipelineWorkers, workerInfo } = params
  const t = pipelineTrace && typeof pipelineTrace === 'object' && !Array.isArray(pipelineTrace)
    ? (pipelineTrace as Record<string, unknown>)
    : null
  const pw = Array.isArray(pipelineWorkers) ? pipelineWorkers : []

  const metrics = t?.metrics && typeof t.metrics === 'object' && !Array.isArray(t.metrics)
    ? (t.metrics as Record<string, unknown>)
    : null

  let peers: string[] = Array.isArray(t?.peers)
    ? (t!.peers as unknown[]).filter((p): p is string => typeof p === 'string')
    : []

  const routingFromTrace = Array.isArray(t?.routing_path)
    ? (t!.routing_path as unknown[]).filter((p): p is string => typeof p === 'string')
    : []

  const routingFromData = Array.isArray((params.data as Record<string, unknown>).routingPath)
    ? ((params.data as Record<string, unknown>).routingPath as unknown[]).filter(
        (p): p is string => typeof p === 'string',
      )
    : []

  const routingPath = routingFromData.length > 0 ? routingFromData : routingFromTrace

  if (peers.length === 0 && routingPath.length > 0) {
    peers = [...routingPath]
  }

  // Token steps depuis pipeline_trace.generation_steps
  const tokenSteps: SessionTokenStep[] = []
  const genRaw = Array.isArray(t?.generation_steps) ? t!.generation_steps as unknown[] : []
  for (const item of genRaw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const ti = typeof o.token_index === 'number' ? o.token_index : Number(o.token_index)
    if (Number.isNaN(ti)) continue
    const hops = Array.isArray(o.hop_ms) ? (o.hop_ms as unknown[]).filter((x): x is number => typeof x === 'number') : []
    tokenSteps.push({ tokenIndex: ti, totalMs: hops.reduce((a, b) => a + b, 0), hopCount: hops.length, byte: typeof o.byte === 'number' ? o.byte : undefined })
  }

  // Fallback token steps depuis pipelineWorkers
  if (tokenSteps.length === 0) {
    for (const item of pw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const o = item as Record<string, unknown>
      if (typeof o.token_index !== 'number') continue
      const hops = Array.isArray(o.hop_ms) ? (o.hop_ms as unknown[]).filter((x): x is number => typeof x === 'number') : []
      tokenSteps.push({ tokenIndex: o.token_index, totalMs: hops.reduce((a, b) => a + b, 0), hopCount: hops.length, byte: typeof o.byte === 'number' ? o.byte : undefined })
    }
  }

  // Load steps
  const loadSteps: SessionLoadStep[] = []
  const loadRaw = Array.isArray(t?.steps_load) ? t!.steps_load as unknown[] : []
  for (const item of loadRaw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const peer = typeof o.peer === 'string' ? o.peer : ''
    if (peer) loadSteps.push({ rank: asNum(o.rank), peerId: peer, loadMs: asNum(o.load_ms) })
  }

  // Worker steps (TP)
  const workerSteps: SessionWorkerStep[] = []
  const stepsRaw = Array.isArray(t?.steps) ? t!.steps as unknown[] : []
  for (const item of stepsRaw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const peer = typeof o.peer === 'string' ? o.peer : ''
    if (peer) workerSteps.push({ rank: asNum(o.rank), peerId: peer, role: asStr(o.role, 'étape'), latencyMs: asNum(o.latency_ms), outRows: typeof o.out_rows === 'number' ? o.out_rows : undefined })
  }

  const traceCompute = typeof t?.compute_time_ms === 'number' ? asNum(t.compute_time_ms) : 0
  const dataCompute = asNum((data as Record<string, unknown>).computeTimeMs)
  const computeTimeMs =
    dataCompute > 0 ? dataCompute : traceCompute > 0 ? traceCompute : undefined

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    prompt,
    response,
    latencyMs: asNum(data.latencyMs),
    vpsDelegateMs: asNum(data.vpsDelegateMs),
    workerComputeMs: asNum(data.workerComputeMs),
    computeTimeMs,
    routingPath: routingPath.length > 0 ? routingPath : undefined,
    promptTokens: asNum(data.promptTokens) || asNum(metrics?.prompt_tokens),
    completionTokens: asNum(data.completionTokens) || asNum(metrics?.completion_tokens),
    totalTokens: asNum(data.totalTokens) || asNum(metrics?.total_tokens),
    p2pMessagesIn: asNum(data.p2pMessagesIn),
    p2pMessagesOut: asNum(data.p2pMessagesOut),
    mode: asStr(data.mode, 'P2P'),
    workerPeerId: asStr(data.workerPeerId),
    primaryWorkerPeerId: asStr(data.primaryWorkerPeerId),
    schedulerWorkersUsed: asNum(data.schedulerWorkersUsed),
    schedulerWarmupSent: asNum(data.schedulerWarmupSent),
    pipelineLayout: asStr(t?.layout),
    pipelineOk: t?.ok === true,
    peers,
    tokenSteps,
    loadSteps,
    workerSteps,
    workerInfo,
    quicUsed: data.quicUsed != null ? Boolean(data.quicUsed) : (t?.quic_used != null ? Boolean(t.quic_used) : undefined),
    kvCacheUsed: data.kvCacheUsed != null ? Boolean(data.kvCacheUsed) : (t?.worker_kv_cache != null ? Boolean(t.worker_kv_cache) : undefined),
    hiddenTransport: asStr(data.hiddenTransport) || asStr(t?.hidden_transport) || undefined,
    avgMsPerToken: asNum(data.avgMsPerToken) || asNum(t?.avg_ms_per_token) || undefined,
    hotPathTps: asNum(data.hotPathTps) || asNum(t?.hot_path_tps) || undefined,
    stopReason: data.stopReason != null
      ? String(data.stopReason) || null
      : (t?.generation_control && typeof t.generation_control === 'object' && !Array.isArray(t.generation_control))
        ? String((t.generation_control as Record<string, unknown>).stop_reason ?? '') || null
        : undefined,
    prefixCacheHit: data.prefixCacheHit != null
      ? Boolean(data.prefixCacheHit)
      : t?.prefix_cache && typeof t.prefix_cache === 'object' && !Array.isArray(t.prefix_cache)
        ? Boolean((t.prefix_cache as Record<string, unknown>).hit)
        : undefined,
    prefixCacheTokens: asNum(data.prefixCacheTokens) ||
      (t?.prefix_cache && typeof t.prefix_cache === 'object' && !Array.isArray(t.prefix_cache)
        ? asNum((t.prefix_cache as Record<string, unknown>).tokens)
        : 0) || undefined,
    setupMs: asNum(data.setupMs) || asNum(t?.setup_ms) || undefined,
    benchmarkActualTps: asNum(data.benchmarkActualTps) || asNum(t?.hot_path_tps) || undefined,
    requestedQuantization:
      data.requestedQuantization === 'q4' || data.requestedQuantization === 'int8'
        ? data.requestedQuantization
        : t?.requested_quantization === 'q4' || t?.requested_quantization === 'int8'
          ? t.requested_quantization
          : undefined,
    effectiveQuantization: asStr(data.effectiveQuantization) || asStr(t?.effective_quantization) || undefined,
    quantizationFallbackReason: data.quantizationFallbackReason != null
      ? String(data.quantizationFallbackReason) || null
      : t?.quantization_fallback_reason != null
        ? String(t.quantization_fallback_reason) || null
        : undefined,
    poolPreference:
      data.poolPreference === 'auto' ||
      data.poolPreference === 'velocity_mlx' ||
      data.poolPreference === 'velocity_vllm' ||
      data.poolPreference === 'legacy_pytorch'
        ? data.poolPreference
        : undefined,
    poolClass: asStr(data.poolClass) || asStr(t?.pool_class) || undefined,
    poolFallbackReason: data.poolFallbackReason != null
      ? String(data.poolFallbackReason) || null
      : t?.pool_fallback_reason != null
        ? String(t.pool_fallback_reason) || null
        : undefined,
    batching: t?.batching && typeof t.batching === 'object' && !Array.isArray(t.batching)
      ? t.batching as Record<string, unknown>
      : undefined,
    overlap: t?.overlap && typeof t.overlap === 'object' && !Array.isArray(t.overlap)
      ? t.overlap as Record<string, unknown>
      : undefined,
  }
}
