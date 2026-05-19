/** Types et helpers pour les métriques P2P d'un tour (séparés du rapport pour react-refresh). */

export type WorkerRoundMetrics = {
  latencyMs: number
  /** Ping/aller-retour P2P estimé ou mesuré pour le tour (ms), sans contenu token. */
  pingMs?: number
  vpsDelegateMs: number
  workerComputeMs: number
  /** Temps réel de calcul rapporté par le worker (proto `compute_time_ms`, champ 12). */
  computeTimeMs?: number
  /** Chemin de relais (Pipeline Parallelism). Tableau d'IDs de pairs traversés. */
  routingPath?: string[]
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  p2pMessagesIn?: number
  p2pMessagesOut?: number
  mode?: string
  /** Transport réseau activé (QUIC UDP ou TCP). */
  quicUsed?: boolean
  quicAvailable?: boolean
  /** KV cache distribué activé sur les workers. */
  kvCacheUsed?: boolean
  /** Format de transport des hidden states (int8, fp16…). */
  hiddenTransport?: string
  /** Latence moyenne par token généré (ms). */
  avgMsPerToken?: number
  /** TPS réel mesuré sur le tour. */
  hotPathTps?: number
  /** Raison d'arrêt de la génération (stop_token, sentence_boundary, repetition_guard…). */
  stopReason?: string | null
  /** Prefix cache : hit ou miss. */
  prefixCacheHit?: boolean
  /** Nombre de tokens récupérés du prefix cache. */
  prefixCacheTokens?: number
  /** Temps de setup du pipeline (ms). */
  setupMs?: number
  /** TPS du benchmark agrégé. */
  benchmarkActualTps?: number
  /** Paramètres de génération (temperature, top_p, top_k…). */
  genControl?: Record<string, unknown> | null
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
  runtimeBackendPerWorker?: unknown
  weightQuantizationPerWorker?: unknown
  attentionBackendPerWorker?: unknown
  /** Ex. `stage1_wall_ms` : durée mur serveur avant succès GPU, pas uniquement du forward worker. */
  timingScope?: string | null
}

/** Choisit la meilleure source pour le temps de calcul worker, en priorisant le proto. */
export function effectiveComputeMs(m: WorkerRoundMetrics | undefined): number {
  if (!m) return 0
  return Math.max(m.computeTimeMs ?? 0, m.workerComputeMs ?? 0)
}

export function isFallbackMetricsUsable(m: WorkerRoundMetrics | undefined): boolean {
  if (!m) return false
  if (m.latencyMs > 0 || m.vpsDelegateMs > 0 || effectiveComputeMs(m) > 0) return true
  if ((m.completionTokens ?? 0) > 0 || (m.promptTokens ?? 0) > 0) return true
  if ((m.p2pMessagesIn ?? 0) > 0 || (m.p2pMessagesOut ?? 0) > 0) return true
  if ((m.routingPath?.length ?? 0) > 0) return true
  if (m.hotPathTps != null && m.hotPathTps > 0) return true
  if (m.avgMsPerToken != null && m.avgMsPerToken > 0) return true
  return false
}
