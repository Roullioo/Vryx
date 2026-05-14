import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminShell } from '../components/admin/AdminShell'
import {
  AdminP2PChatPanel,
  type LiveWorker,
} from '../components/admin/AdminP2PChatPanel'
import { DaisyChainViz, WorkerComputeReport } from '../components/admin/WorkerComputeReport'
import { isFallbackMetricsUsable, type WorkerRoundMetrics } from '../components/admin/workerRoundMetrics'
import { apiJson } from '../lib/api'

export function AdminP2PChatPage() {
  const [liveWorkers, setLiveWorkers] = useState<LiveWorker[]>([])
  const [liveSec, setLiveSec] = useState(30)
  const [lastP2pPeer, setLastP2pPeer] = useState<string | null>(null)
  const [lastPipelineTrace, setLastPipelineTrace] = useState<Record<string, unknown> | null>(null)
  const [lastRoundMetrics, setLastRoundMetrics] = useState<WorkerRoundMetrics | null>(null)
  const [shardInfo, setShardInfo] = useState<{ mode?: string; description?: string } | null>(null)

  const refreshLive = useCallback(async () => {
    const r = await apiJson<{ workers: LiveWorker[]; liveSec?: number }>('/api/admin/workers/live')
    if (r.ok === true && r.data) {
      setLiveWorkers(r.data.workers)
      if (typeof r.data.liveSec === 'number') setLiveSec(r.data.liveSec)
    }
  }, [])

  useEffect(() => {
    void refreshLive()
    const id = window.setInterval(refreshLive, 3000)
    return () => window.clearInterval(id)
  }, [refreshLive])

  useEffect(() => {
    void (async () => {
      const r = await apiJson<{
        ok?: boolean
        mode?: string
        description?: string
      }>('/api/admin/p2p/shard-runtime')
      if (r.ok === true && r.data) setShardInfo(r.data)
    })()
  }, [])

  return (
    <AdminShell
      title="Chat P2P"
      subtitle="Inférence distribuée via l’initiateur Rust (SSE, métriques pipeline)"
    >
      <div className="mx-auto max-w-384 space-y-6 pb-12">
        <div className="flex flex-col gap-3 border-b border-border/80 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <Link
            to="/admin/noeud"
            className="inline-flex items-center gap-2 text-[13px] font-medium text-muted transition-colors hover:text-accent"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Retour au nœud (supervision)
          </Link>
          <p className="text-[11px] text-muted">
            Flux : navigateur → API Node (<span className="font-mono">/api/admin/p2p/chat/stream</span>) → initiateur{' '}
            <span className="font-mono">VRYX_INITIATOR_CHAT_URL</span>
            {' '}(ou surcharge contrôlée <span className="font-mono">initiator_chat_url</span> + préfixes) → chaîne{' '}
            <span className="font-mono">initiator_sequential</span> sur les workers P2P (gRPC).
          </p>
        </div>

        <section className="grid gap-4 rounded-2xl border border-border/80 bg-surface/30 p-4 sm:p-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <h2 className="font-display text-lg font-semibold text-fg">Ce que fait cette page</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Chaque message est envoyé au daemon initiateur Vryx. Le serveur relaie un flux SSE : événements de
              progression pendant l’attente de l’initiateur, puis fragments de réponse au fil de l’eau, et enfin un
              événement final avec la latence, le chemin <span className="font-mono text-fg/90">routing_path</span>,
              les compteurs P2P et la trace pipeline si le worker la renvoie. Chaque tour est historisé en base pour
              alimenter la page Sessions, avec une copie locale de secours.
            </p>
            <ul className="mt-4 space-y-2 text-[13px] text-muted">
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                <span>
                  <strong className="text-fg">Daisy Chain</strong> : plusieurs peer IDs dans{' '}
                  <span className="font-mono">routing_path</span>, chaque nœud calcule son segment puis relaie au
                  suivant.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                <span>
                  <strong className="text-fg">compute_time_ms</strong> : temps de calcul côté worker (proto / trace),
                  distinct de la latence HTTP totale.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                <span>
                  Les workers « live » ci-dessous utilisent la même fenêtre que le panneau Nœud (heartbeat récent,{' '}
                  {liveSec} s).
                </span>
              </li>
            </ul>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Runtime shard (API)</h3>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              {shardInfo?.description ??
                'Description indisponible : vérifiez que le serveur expose /api/admin/p2p/shard-runtime.'}
            </p>
            {shardInfo?.mode ? (
              <p className="mt-3 font-mono text-[11px] text-fg">
                mode : <span className="text-accent">{shardInfo.mode}</span>
              </p>
            ) : null}
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] xl:items-start">
          <div className="min-w-0 space-y-4">
            <AdminP2PChatPanel
              liveWorkers={liveWorkers}
              activeChatPeerId={lastP2pPeer}
              onP2pRoundComplete={(id, meta) => {
                if (id) setLastP2pPeer(id)
                const tr = meta?.pipelineTrace
                if (tr && typeof tr === 'object' && !Array.isArray(tr) && Object.keys(tr as object).length > 0) {
                  setLastPipelineTrace(tr as Record<string, unknown>)
                } else {
                  setLastPipelineTrace(null)
                }
                setLastRoundMetrics(meta?.roundMetrics ?? null)
              }}
            />
          </div>

          <aside className="space-y-4 xl:sticky xl:top-28">
            {(lastPipelineTrace && Object.keys(lastPipelineTrace).length > 0) ||
            isFallbackMetricsUsable(lastRoundMetrics ?? undefined) ? (
              <div className="panel border-accent/25 bg-accent/4 p-4 sm:p-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Dernier tour</h3>
                <p className="mt-1 text-[10px] leading-relaxed text-muted">
                  Visualisation du dernier message envoyé : chaîne de relais et métriques agrégées.
                </p>
                {lastRoundMetrics?.routingPath && lastRoundMetrics.routingPath.length > 0 ? (
                  <div className="mt-3">
                    <DaisyChainViz
                      routingPath={lastRoundMetrics.routingPath}
                      computeTimeMs={lastRoundMetrics.computeTimeMs}
                    />
                  </div>
                ) : null}
                <div className="mt-3">
                  <WorkerComputeReport trace={lastPipelineTrace} roundMetrics={lastRoundMetrics ?? undefined} />
                </div>
              </div>
            ) : (
              <div className="panel border border-dashed border-border/80 p-4 text-[12px] text-muted">
                Envoyez un premier message pour afficher ici la trace du pipeline (routing, temps de calcul, agrégats).
              </div>
            )}

            <div className="panel p-4 sm:p-5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Workers visibles (live)</h3>
              <p className="mt-1 text-[10px] text-muted">{liveWorkers.length} pair(s) dans les {liveSec} dernières secondes.</p>
              <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto text-[11px]">
                {liveWorkers.length === 0 ? (
                  <li className="text-muted">Aucun heartbeat récent.</li>
                ) : (
                  liveWorkers.map((w) => (
                    <li key={w.peerId} className="rounded-lg border border-border/60 bg-surface/50 px-2 py-1.5 font-mono">
                      <span className="text-fg">{w.peerId.slice(0, 18)}…</span>
                      <span className="ml-2 text-muted">{w.mode}</span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </AdminShell>
  )
}
