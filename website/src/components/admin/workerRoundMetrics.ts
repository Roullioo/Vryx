/** Types et helpers pour les métriques P2P d’un tour (séparés du rapport pour react-refresh). */

export type WorkerRoundMetrics = {
  latencyMs: number
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
  return false
}
