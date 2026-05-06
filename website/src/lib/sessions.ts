/** Stockage des sessions de travail P2P en localStorage. */

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
  }
}
