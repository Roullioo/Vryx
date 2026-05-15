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

  const aside = (
    <div className="flex flex-col gap-4">
      {(lastPipelineTrace && Object.keys(lastPipelineTrace).length > 0) ||
      isFallbackMetricsUsable(lastRoundMetrics ?? undefined) ? (
        <div className="rounded-2xl border border-accent/20 bg-gradient-to-b from-accent/[0.08] to-card p-4 shadow-md sm:rounded-3xl sm:p-5">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4" aria-hidden>
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </span>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Dernier tour</h3>
              <p className="text-[11px] text-muted">Relais et métriques</p>
            </div>
          </div>
          {lastRoundMetrics?.routingPath && lastRoundMetrics.routingPath.length > 0 ? (
            <div className="mt-4 overflow-x-auto rounded-xl border border-border/50 bg-surface/40 p-2">
              <DaisyChainViz routingPath={lastRoundMetrics.routingPath} computeTimeMs={lastRoundMetrics.computeTimeMs} />
            </div>
          ) : null}
          <div className="mt-4">
            <WorkerComputeReport trace={lastPipelineTrace} roundMetrics={lastRoundMetrics ?? undefined} />
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border/70 bg-surface/20 p-4 text-center text-sm leading-relaxed text-muted sm:rounded-3xl sm:p-5">
          <span className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full border border-border/60 bg-card">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5 text-muted" aria-hidden>
              <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </span>
          Envoyez un message pour afficher la trace du pipeline ici.
        </div>
      )}

      <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-md sm:rounded-3xl sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Workers live</h3>
          <span className="rounded-full bg-surface px-2 py-0.5 font-mono text-[10px] font-medium text-muted">{liveSec}s</span>
        </div>
        <ul className="mt-3 max-h-40 space-y-2 overflow-y-auto overscroll-contain sm:max-h-52 lg:max-h-[min(32vh,20rem)]">
          {liveWorkers.length === 0 ? (
            <li className="rounded-xl border border-border/50 bg-surface/40 px-3 py-4 text-center text-sm text-muted">
              Aucun heartbeat dans la fenêtre.
            </li>
          ) : (
            liveWorkers.map((w) => (
              <li
                key={w.peerId}
                className="rounded-xl border border-border/60 bg-surface/50 px-3 py-2.5 font-mono text-[11px] leading-snug transition-colors hover:border-accent/25 sm:text-xs"
              >
                <div className="break-all text-fg">{w.peerId.slice(0, 20)}…</div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted sm:text-[11px]">
                  <span>{w.mode}</span>
                  {w.model ? <span className="truncate text-fg/80 normal-case">{w.model}</span> : null}
                </div>
              </li>
            ))
          )}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          to="/admin/noeud"
          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-2xl border border-border/90 bg-surface/80 px-3 text-sm font-semibold text-fg transition-colors hover:border-accent/40 hover:bg-surface hover:text-accent sm:flex-none sm:px-4"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4 shrink-0" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Nœud
        </Link>
        <details className="min-w-0 flex-1 rounded-2xl border border-border/80 bg-surface/50 text-left backdrop-blur-sm sm:max-w-xs sm:flex-none">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted marker:content-none [&::-webkit-details-marker]:hidden sm:px-3.5 sm:text-sm">
            <svg className="h-4 w-4 shrink-0 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
            Flux technique
          </summary>
          <p className="border-t border-border/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted sm:px-3.5 sm:text-xs">
            Navigateur → <span className="font-mono text-fg/90">/api/admin/p2p/chat/stream</span> → initiateur{' '}
            <span className="font-mono text-fg/90">VRYX_INITIATOR_CHAT_URL</span> → workers P2P (gRPC).
          </p>
        </details>
      </div>
    </div>
  )

  return (
    <AdminShell title="Chat P2P" mainSpacing="none" showDesktopTitleBar={false}>
      <div className="flex min-h-0 flex-1 flex-col">
        <AdminP2PChatPanel
          layout="full"
          aside={aside}
          liveWorkers={liveWorkers}
          liveSec={liveSec}
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
    </AdminShell>
  )
}
