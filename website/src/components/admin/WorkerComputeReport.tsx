/**
 * Rapport visuel des workers : barres CSS (pas de SVG), fonctionne dans tous les contextes.
 * - Mode riche : parse pipeline_trace → graphiques par token + chargement par pair.
 * - Mode agrégé : métriques du tour (latency_ms, compute_time_ms, tokens).
 *
 * Source de vérité du temps de calcul : `compute_time_ms` du proto `ProcessedTensorData`
 * (champ 12), retransmis par l'initiateur P2P. Plus de fallback sur des heuristiques
 * qui produisaient des "0 ms" / "1 ms" trompeurs.
 */
import { useMemo } from 'react'

import { displayLabel } from '../../lib/displayLabels'
import {
  effectiveComputeMs,
  type WorkerRoundMetrics,
  isFallbackMetricsUsable,
} from './workerRoundMetrics'

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function shortPeer(id: string | undefined, max = 20) {
  if (!id) return '—'
  return id.length > max ? `${id.slice(0, max)}…` : id
}

function sum(nums: number[]) {
  return nums.reduce((a, b) => a + b, 0)
}

type TR = Record<string, unknown>

function asRecord(v: unknown): TR | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as TR) : null
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/* ─── sous-composants barres CSS ──────────────────────────────────────────── */

/** Barre de progression simple avec label et valeur. */
function Bar({
  pct,
  color,
  label,
  value,
}: {
  pct: number
  color: string
  label: string
  value: string
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono tabular-nums text-fg">{value}</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-fg/10">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${Math.min(100, Math.max(pct * 100, pct > 0 ? 3 : 0))}%` }}
        />
      </div>
    </div>
  )
}

/** Graphique agrégé pour un tour P2P (avec ou sans pipeline_trace détaillé). */
function RoundTimingCharts({ m }: { m: WorkerRoundMetrics }) {
  const orch = Math.max(0, m.vpsDelegateMs)
  // `compute_time_ms` du proto est la source de vérité ; sinon retombée sur worker_compute_ms.
  const compute = effectiveComputeMs(m)
  const rawLat = Math.max(0, Number(m.latencyMs ?? 0) || 0)
  const total = Math.max(1, rawLat, orch + compute)
  const other = Math.max(0, total - orch - compute)

  const p = Math.max(0, m.promptTokens ?? 0)
  const c = Math.max(0, m.completionTokens ?? 0)
  const tokTotal = Math.max(1, p + c)

  const pi = Math.max(0, m.p2pMessagesIn ?? 0)
  const po = Math.max(0, m.p2pMessagesOut ?? 0)
  const msgMax = Math.max(1, pi, po)

  const msPerTok =
    c > 0 && compute > 0
      ? (compute / c).toFixed(0)
      : c > 0 && total > 0
        ? (total / c).toFixed(0)
        : null

  const timingScope = m.timingScope ?? ''
  const computeIsServerWall =
    timingScope === 'stage1_wall_ms' ||
    (typeof m.mode === 'string' && m.mode.includes('Erreur') && compute > 0 && (m.completionTokens ?? 0) === 0)
  const computeBarLabel = computeIsServerWall
    ? 'Stage1 / orchestrateur (mur serveur)'
    : 'Calcul worker (compute_time_ms)'

  const tps = m.hotPathTps != null && m.hotPathTps > 0
    ? m.hotPathTps.toFixed(3)
    : msPerTok && Number(msPerTok) > 0
      ? (1000 / Number(msPerTok)).toFixed(3)
      : null

  return (
    <div className="space-y-3">
      {/* Badges transport & optimisations */}
      {(m.quicUsed != null ||
        m.kvCacheUsed != null ||
        m.hiddenTransport ||
        m.requestedQuantization ||
        m.effectiveQuantization ||
        m.poolClass ||
        m.prefixCacheHit != null) && (
        <div className="flex flex-wrap gap-1 rounded-lg border border-border/60 bg-bg/60 px-3 py-2">
          {m.quicUsed != null && (
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${m.quicUsed ? 'bg-success/15 text-success' : 'bg-border/40 text-muted'}`}>
              {m.quicUsed ? 'QUIC UDP' : 'TCP'}
            </span>
          )}
          {m.kvCacheUsed != null && (
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${m.kvCacheUsed ? 'bg-electric/15 text-electric' : 'bg-border/40 text-muted'}`}>
              {m.kvCacheUsed ? 'KV Cache ON' : 'KV Cache OFF'}
            </span>
          )}
          {m.hiddenTransport && (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-accent">
              {m.hiddenTransport}
            </span>
          )}
          {m.requestedQuantization && (
            <span className="rounded bg-electric/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-electric">
              demandé : {m.requestedQuantization === 'q4' ? '4-bit' : '8-bit'}
            </span>
          )}
          {m.effectiveQuantization && m.effectiveQuantization !== m.hiddenTransport && (
            <span className="rounded bg-success/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-success">
              effectif : {m.effectiveQuantization}
            </span>
          )}
          {m.quantizationFallbackReason && (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold text-warning">
              fallback : {m.quantizationFallbackReason}
            </span>
          )}
          {m.poolClass && (
            <span className="rounded bg-success/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-success">
              pool : {m.poolClass}
            </span>
          )}
          {m.poolFallbackReason && (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold text-warning">
              pool fallback : {m.poolFallbackReason}
            </span>
          )}
          {m.prefixCacheHit != null && (
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${m.prefixCacheHit ? 'bg-primary/15 text-primary' : 'bg-border/40 text-muted'}`}>
              {m.prefixCacheHit
                ? `Prefix Cache HIT (${m.prefixCacheTokens ?? 0} tok)`
                : 'Prefix Cache MISS'}
            </span>
          )}
          {m.stopReason && m.stopReason !== 'null' && (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold text-warning">
              arrêt : {m.stopReason}
            </span>
          )}
        </div>
      )}
      {/* Temps du tour */}
      <div className="space-y-2 rounded-lg border border-border/60 bg-bg/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
            Temps du tour — {total.toLocaleString('fr-FR')} ms total
          </p>
          {tps && (
            <span className="rounded bg-success/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-success">
              {tps} TPS
            </span>
          )}
        </div>
        <Bar
          pct={orch / total}
          color="bg-accent"
          label="Orchestration initiateur"
          value={`${orch.toLocaleString('fr-FR')} ms`}
        />
        <Bar
          pct={compute / total}
          color="bg-success"
          label={computeBarLabel}
          value={compute > 0 ? `${compute.toLocaleString('fr-FR')} ms` : '—'}
        />
        {other > 2 ? (
          <Bar
            pct={other / total}
            color="bg-muted/40"
            label="Réseau P2P / attente"
            value={`${other.toLocaleString('fr-FR')} ms`}
          />
        ) : null}
        {msPerTok ? (
          <p className="pt-1 text-[9px] text-muted">
            Estimation ≈ <span className="font-mono text-fg">{msPerTok} ms / token</span> de complétion
            {m.avgMsPerToken != null && m.avgMsPerToken > 0 && (
              <> · réel <span className="font-mono text-success">{m.avgMsPerToken} ms</span></>
            )}
          </p>
        ) : m.avgMsPerToken != null && m.avgMsPerToken > 0 ? (
          <p className="pt-1 text-[9px] text-muted">
            Réel : <span className="font-mono text-success">{m.avgMsPerToken} ms / token</span>
          </p>
        ) : null}
        {m.setupMs != null && m.setupMs > 0 && (
          <p className="text-[9px] text-muted">Setup pipeline : <span className="font-mono text-fg">{m.setupMs} ms</span></p>
        )}
        {m.batching && (
          <p className="text-[9px] text-muted">
            Batching : <span className="font-mono text-fg">
              size {String(m.batching.batch_size ?? 1)} · queue {String(m.batching.queue_wait_ms ?? 0)} ms
            </span>
          </p>
        )}
        {m.overlap && (
          <p className="text-[9px] text-muted">
            Overlap : <span className="font-mono text-fg">
              {String(m.overlap.compute_overlap_pct ?? 0)}% · réseau caché {String(m.overlap.network_hidden_ms ?? '—')} ms
            </span>
          </p>
        )}
      </div>

      {/* Tokens */}
      {(p > 0 || c > 0) && (
        <div className="space-y-2 rounded-lg border border-border/60 bg-bg/60 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
            Tokens — {(p + c).toLocaleString('fr-FR')} total
          </p>
          <Bar pct={p / tokTotal} color="bg-accent/70" label="Prompt (entrée)" value={p.toLocaleString('fr-FR')} />
          <Bar pct={c / tokTotal} color="bg-primary/70" label="Complétion (sortie)" value={c.toLocaleString('fr-FR')} />
        </div>
      )}

      {/* Messages P2P */}
      {(pi > 0 || po > 0) && (
        <div className="space-y-2 rounded-lg border border-border/60 bg-bg/60 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Messages P2P</p>
          <Bar pct={pi / msgMax} color="bg-success/70" label="Reçus (in)" value={String(pi)} />
          <Bar pct={po / msgMax} color="bg-accent/60" label="Envoyés (out)" value={String(po)} />
        </div>
      )}

      {m.mode ? (
        <p className="text-[9px] text-muted">
          Mode : <span className="font-mono text-fg">{m.mode}</span>
        </p>
      ) : null}
      {/* Paramètres de génération */}
      {m.genControl && typeof m.genControl === 'object' && (
        <div className="rounded-lg border border-border/60 bg-bg/60 px-3 py-2">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Paramètres génération</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
            {m.genControl.temperature != null && (
              <><dt className="text-muted">Température</dt><dd className="font-mono tabular-nums">{String(m.genControl.temperature)}</dd></>
            )}
            {m.genControl.top_p != null && (
              <><dt className="text-muted">Top-P</dt><dd className="font-mono tabular-nums">{String(m.genControl.top_p)}</dd></>
            )}
            {m.genControl.top_k != null && (
              <><dt className="text-muted">Top-K</dt><dd className="font-mono tabular-nums">{String(m.genControl.top_k)}</dd></>
            )}
            {m.genControl.repetition_penalty != null && (
              <><dt className="text-muted">Pén. répétition</dt><dd className="font-mono tabular-nums">{String(m.genControl.repetition_penalty)}</dd></>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Barres par token généré avec generation_steps. */
function TokenStepsChart({ steps }: { steps: { tokenIndex: number; totalMs: number; hopCount: number; byte?: number }[] }) {
  if (steps.length === 0) return null
  const maxMs = Math.max(0.5, ...steps.map((s) => s.totalMs))
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-bg/60 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
        Latence par token généré ({steps.length} tokens)
      </p>
      <div className="space-y-1">
        {steps.slice(0, 32).map((s) => (
          <Bar
            key={s.tokenIndex}
            pct={s.totalMs / maxMs}
            color="bg-accent"
            label={`#${s.tokenIndex}${s.byte != null ? ` · byte ${s.byte}` : ''} (${s.hopCount} hop${s.hopCount > 1 ? 's' : ''})`}
            value={`${s.totalMs.toFixed(1)} ms`}
          />
        ))}
        {steps.length > 32 && (
          <p className="text-[9px] text-muted">… {steps.length - 32} token(s) supplémentaires non affichés</p>
        )}
      </div>
      <p className="text-[9px] text-muted">
        Max : {maxMs.toFixed(1)} ms · Moy : {(sum(steps.map((s) => s.totalMs)) / steps.length).toFixed(1)} ms
      </p>
    </div>
  )
}

/**
 * Visualisation relais : Nœud 1 → Nœud 2 → Nœud 3 …
 * Affiche le chemin de relais tracé par le proto.
 */
export function DaisyChainViz({
  routingPath,
  computeTimeMs,
  className = '',
}: {
  routingPath: string[]
  computeTimeMs?: number
  className?: string
}) {
  if (!routingPath || routingPath.length === 0) return null
  return (
    <div className={`rounded-lg border border-accent/30 bg-accent/5 p-3 ${className}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-accent">
          Chemin de relais ({routingPath.length} nœud{routingPath.length > 1 ? 's' : ''})
        </p>
        {computeTimeMs != null && computeTimeMs > 0 ? (
          <span className="font-mono text-[10px] text-fg">
            calcul total {computeTimeMs.toLocaleString('fr-FR')} ms
          </span>
        ) : null}
      </div>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {routingPath.map((peer, i) => (
          <li key={`${peer}-${i}`} className="flex items-center gap-1">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-bg/80 px-2.5 py-1">
              <span className="flex h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
              <span className="font-mono text-[10px] font-semibold text-fg">
                #{i + 1}
              </span>
              <span className="font-mono text-[10px] text-muted" title={peer}>
                {shortPeer(peer, 14)}
              </span>
            </span>
            {i < routingPath.length - 1 ? (
              <svg
                viewBox="0 0 16 16"
                className="h-3 w-3 shrink-0 text-accent"
                aria-hidden
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Chargement des poids par pair avec steps_load. */
function LoadChart({ loads }: { loads: { peer: string; loadMs: number; rank: number }[] }) {
  if (loads.length === 0) return null
  const maxMs = Math.max(1, ...loads.map((l) => l.loadMs))
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-bg/60 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
        Chargement des poids par worker
      </p>
      <div className="space-y-1">
        {loads.map((l) => (
          <Bar
            key={`${l.peer}-${l.rank}`}
            pct={l.loadMs / maxMs}
            color="bg-success"
            label={`#${l.rank} · ${shortPeer(l.peer, 22)}`}
            value={`${l.loadMs.toFixed(1)} ms`}
          />
        ))}
      </div>
    </div>
  )
}

/* ─── composant principal ─────────────────────────────────────────────────── */

export function WorkerComputeReport({
  trace,
  pipelineWorkers,
  roundMetrics,
}: {
  trace: unknown
  pipelineWorkers?: unknown
  /** Métriques agrégées du tour (toujours dispo, même sans pipeline_trace JSON). */
  roundMetrics?: WorkerRoundMetrics
}) {
  const parsed = useMemo(() => {
    const t = asRecord(trace)
    const pw = asArray(pipelineWorkers)

    if (!t) return null

    const layout = typeof t.layout === 'string' ? t.layout : ''
    const ok = t.ok === true

    const metrics = asRecord(t.metrics)
    const promptTokens = typeof metrics?.prompt_tokens === 'number' ? metrics.prompt_tokens : null
    const completionTokens = typeof metrics?.completion_tokens === 'number' ? metrics.completion_tokens : null
    const totalTokens = typeof metrics?.total_tokens === 'number' ? metrics.total_tokens : null
    const vpsDelegateMs = typeof metrics?.vps_delegate_ms === 'number' ? metrics.vps_delegate_ms : null

    const peers = asArray(t.peers).filter((p): p is string => typeof p === 'string')

    const generationRaw = asArray(t.generation_steps)
    const generationSteps: { tokenIndex: number; totalMs: number; hopCount: number; byte?: number }[] = []
    for (const item of generationRaw) {
      const o = asRecord(item)
      if (!o) continue
      const ti = typeof o.token_index === 'number' ? o.token_index : Number(o.token_index)
      if (Number.isNaN(ti)) continue
      const hops = asArray(o.hop_ms).filter((x): x is number => typeof x === 'number')
      generationSteps.push({ tokenIndex: ti, totalMs: sum(hops), hopCount: hops.length, byte: typeof o.byte === 'number' ? o.byte : undefined })
    }

    const loadRaw = asArray(t.steps_load)
    const loads: { peer: string; loadMs: number; rank: number }[] = []
    for (const item of loadRaw) {
      const o = asRecord(item)
      if (!o) continue
      const peer = typeof o.peer === 'string' ? o.peer : ''
      const loadMs = typeof o.load_ms === 'number' ? o.load_ms : 0
      const rank = typeof o.rank === 'number' ? o.rank : 0
      if (peer) loads.push({ peer, loadMs, rank })
    }
    loads.sort((a, b) => a.rank - b.rank)

    const stepsTp = asArray(t.steps)
    const rowSplitSteps: { peer: string; role: string; latencyMs: number; rank?: number; outRows?: number }[] = []
    for (const item of stepsTp) {
      const o = asRecord(item)
      if (!o) continue
      const peer = typeof o.peer === 'string' ? o.peer : ''
      if (peer) rowSplitSteps.push({
        peer,
        role: typeof o.role === 'string' ? o.role : 'étape',
        latencyMs: typeof o.latency_ms === 'number' ? o.latency_ms : 0,
        rank: typeof o.rank === 'number' ? o.rank : undefined,
        outRows: typeof o.out_rows === 'number' ? o.out_rows : undefined,
      })
    }

    // Fallback generation steps depuis pipelineWorkers
    const fallbackSteps: typeof generationSteps = []
    if (generationSteps.length === 0 && pw.length > 0) {
      for (const item of pw) {
        const o = asRecord(item)
        if (!o || typeof o.token_index !== 'number') continue
        const hops = asArray(o.hop_ms).filter((x): x is number => typeof x === 'number')
        fallbackSteps.push({ tokenIndex: o.token_index, totalMs: sum(hops), hopCount: hops.length, byte: typeof o.byte === 'number' ? o.byte : undefined })
      }
    }

    const tokenChartData = generationSteps.length > 0 ? generationSteps : fallbackSteps

    // Chemin de relais du proto.
    const routingPath = asArray(t.routing_path).filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    )

    const routeCount = routingPath.length || peers.filter((p) => p.length > 0).length
    let headline =
      layout === 'pipeline_relay_daisy_chain' || routingPath.length > 1
        ? `Pipeline distribué (${routeCount} nœuds)`
        : layout === 'worker_only_pipeline'
          ? 'Pipeline worker dédié'
          : layout === 'row_split_tensor_parallel'
            ? 'Ancienne trace distribuée — désactivée pour le chat'
            : displayLabel(layout || 'pipeline_distribue')

    if (!ok && routeCount === 0 && layout === 'pipeline_relay_daisy_chain') {
      headline =
        'Échec pipeline distribué (aucun nœud dans la trace ; consulter l’erreur ci-dessus et les logs)'
    }

    const traceComputeMs = typeof t.compute_time_ms === 'number' ? t.compute_time_ms : null

    return {
      layout, ok, headline,
      promptTokens, completionTokens, totalTokens, vpsDelegateMs,
      peers, tokenChartData, loads, rowSplitSteps,
      routingPath,
      traceComputeMs,
      sessionId: typeof t.session_id === 'string' ? t.session_id : null,
      hidden: typeof t.hidden === 'number' ? t.hidden : null,
      maxNewTokens: typeof t.max_new_tokens === 'number' ? t.max_new_tokens : null,
    }
  }, [trace, pipelineWorkers])

  const hasRichTrace = parsed !== null
  const fallbackOk = isFallbackMetricsUsable(roundMetrics)

  if (!hasRichTrace && !fallbackOk) {
    return (
      <p className="text-[10px] leading-relaxed text-muted">
        Aucune métrique disponible pour ce message.
      </p>
    )
  }

  return (
    <div className="mt-3 space-y-3">
      {/* En-tête pipeline détaillé */}
      {parsed && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-bg/60 px-3 py-2">
          <span className="text-[10px] font-bold text-fg">{parsed.headline}</span>
          {parsed.ok ? (
            <span className="rounded bg-success/15 px-2 py-0.5 text-[9px] font-semibold uppercase text-success">OK</span>
          ) : (
            <span className="rounded bg-warning/15 px-2 py-0.5 text-[9px] font-semibold uppercase text-warning">Vérifier</span>
          )}
          {parsed.sessionId && (
            <span className="ml-auto font-mono text-[9px] text-muted">{parsed.sessionId}</span>
          )}
        </div>
      )}

      {/* Métriques pipeline (tokens, temps, etc.) */}
      {parsed && (parsed.promptTokens != null || parsed.completionTokens != null || parsed.vpsDelegateMs != null || parsed.hidden != null) && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-border/60 bg-bg/60 px-3 py-2 text-[10px]">
          {parsed.promptTokens != null && <><dt className="text-muted">Tokens prompt</dt><dd className="font-mono tabular-nums">{parsed.promptTokens}</dd></>}
          {parsed.completionTokens != null && <><dt className="text-muted">Tokens générés</dt><dd className="font-mono tabular-nums text-accent">{parsed.completionTokens}</dd></>}
          {parsed.totalTokens != null && <><dt className="text-muted">Total</dt><dd className="font-mono tabular-nums">{parsed.totalTokens}</dd></>}
          {parsed.vpsDelegateMs != null && <><dt className="text-muted">Orchestration</dt><dd className="font-mono tabular-nums">{parsed.vpsDelegateMs} ms</dd></>}
          {parsed.hidden != null && <><dt className="text-muted">Dimension cachée</dt><dd className="font-mono">{parsed.hidden}</dd></>}
          {parsed.maxNewTokens != null && <><dt className="text-muted">Budget tokens</dt><dd className="font-mono">{parsed.maxNewTokens}</dd></>}
        </div>
      )}

      {/* Relais : Nœud 1 → Nœud 2 → Nœud 3, depuis le chemin de trace ou pipeline_trace.peers. */}
      {(() => {
        const path =
          (parsed?.routingPath && parsed.routingPath.length > 0
            ? parsed.routingPath
            : roundMetrics?.routingPath && roundMetrics.routingPath.length > 0
              ? roundMetrics.routingPath
              : parsed?.peers) ?? []
        if (path.length === 0) return null
        const computeMs = parsed?.traceComputeMs ?? roundMetrics?.computeTimeMs ?? 0
        return <DaisyChainViz routingPath={path} computeTimeMs={computeMs} />
      })()}

      {/* Graphiques riches */}
      {parsed && parsed.loads.length > 0 && <LoadChart loads={parsed.loads} />}
      {parsed && parsed.tokenChartData.length > 0 && <TokenStepsChart steps={parsed.tokenChartData} />}

      {/* Tableau TP étapes */}
      {parsed && parsed.rowSplitSteps.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border/60 bg-bg/60">
          <table className="w-full min-w-[240px] text-left text-[10px]">
            <thead>
              <tr className="border-b border-border bg-surface/80 text-muted">
                <th className="px-2 py-1.5">Rang</th><th className="px-2 py-1.5">Pair</th>
                <th className="px-2 py-1.5">Rôle</th><th className="px-2 py-1.5 text-right">ms</th>
                <th className="px-2 py-1.5 text-right">Sortie</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rowSplitSteps.map((s, i) => (
                <tr key={`${s.peer}-${i}`} className="border-b border-border/40">
                  <td className="px-2 py-1.5 text-muted">{s.rank ?? i}</td>
                  <td className="max-w-[140px] truncate px-2 py-1.5 font-mono" title={s.peer}>{shortPeer(s.peer, 16)}</td>
                  <td className="px-2 py-1.5">{s.role}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{s.latencyMs.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right text-muted">{s.outRows != null ? `${s.outRows} dims` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Graphiques agrégés sans trace détaillée. */}
      {fallbackOk && roundMetrics && (!hasRichTrace || (parsed && parsed.tokenChartData.length === 0 && parsed.loads.length === 0)) && (
        <RoundTimingCharts m={roundMetrics} />
      )}
    </div>
  )
}
