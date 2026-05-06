import { useState } from 'react'
import type { WorkerRoundMetrics } from './workerRoundMetrics'
import { WorkerComputeReport } from './WorkerComputeReport'
import { buildSession, saveSession } from '../../lib/sessions'

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
  lastHeartbeatAt: string | null
  secondsSinceHeartbeat: number
  ownerEmail: string | null
}

function roundMetricsFromAiTrace(t: {
  latencyMs?: number
  vpsDelegateMs?: number
  workerComputeMs?: number
  computeTimeMs?: number
  routingPath?: string[]
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  p2pMessagesIn?: number
  p2pMessagesOut?: number
  mode?: string
}): WorkerRoundMetrics {
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
      computeTimeMs?: number
      routingPath?: string[]
      schedulerWarmupSent?: number
      schedulerWorkersUsed?: number
      shardSessionId?: string | null
      primaryWorkerPeerId?: string
      pipelineTrace?: unknown
      pipelineWorkers?: unknown
      workerInfo?: LiveWorker & { online?: boolean }
    }
  }[]>([])
  const [loading, setLoading] = useState(false)

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
              /** Temps réel de calcul rapporté par le worker (proto champ 12). */
              computeTimeMs?: number
              /** Chemin de relais Daisy Chain (proto `routing_path`). */
              routingPath?: string[]
              schedulerWarmupSent?: number
              schedulerWorkersUsed?: number
              shardSessionId?: string | null
              primaryWorkerPeerId?: string
              pipelineTrace?: unknown
              pipelineWorkers?: unknown
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
              }
              onP2pRoundComplete?.(sidebarPeerId, {
                pipelineTrace: data.pipelineTrace,
                pipelineWorkers: data.pipelineWorkers,
                roundMetrics,
              })
              // Enregistrer la session pour la page Sessions
              let currentResponse = ''
              setMessages((prev) => { currentResponse = prev[prev.length - 1]?.content ?? ''; return prev })
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
              saveSession(buildSession({
                prompt: userMsg,
                response: currentResponse,
                data: data as Record<string, unknown>,
                pipelineTrace: data.pipelineTrace,
                pipelineWorkers: data.pipelineWorkers,
                workerInfo: workerInfoForSession,
              }))
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

  return (
    <div className="panel flex h-full min-h-[22rem] flex-col overflow-hidden border-accent/20 bg-accent/[0.02] xl:max-h-[calc(100svh-10rem)]">
      <div className="border-b border-border bg-surface/50 px-4 py-3 sm:px-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <span className={`flex h-2 w-2 rounded-full ${loading ? 'animate-pulse bg-accent' : 'bg-success'}`} />
          Chat P2P natif (initiateur Rust)
        </h3>
        <p className="mt-1 text-[10px] leading-relaxed text-muted">
          Toutes les requêtes traversent le pipeline gRPC : l’initiateur enchaîne les nœuds via{' '}
          <span className="font-mono">routing_path</span> (Daisy Chain). Aucune dépendance Web2.
        </p>
        <p className="mt-1.5 rounded-md border border-accent/20 bg-accent/5 px-2 py-1.5 text-[10px] leading-relaxed text-fg">
          Après chaque réponse, ouvrez « Détails du traitement » : chaîne de relais, temps réel{' '}
          <span className="font-mono">compute_time_ms</span>, tokens et métriques P2P du tour.
        </p>
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
            {liveWorkers.length > 0
              ? 'Routage côté initiateur (pair P2P choisi dynamiquement)…'
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
              Écrivez un message : il sera relayé en chaîne sur le réseau P2P natif (gRPC, sans API centrale).
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
                <WorkerComputeReport
                  trace={m.trace.pipelineTrace}
                  pipelineWorkers={m.trace.pipelineWorkers}
                  roundMetrics={roundMetricsFromAiTrace(m.trace)}
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
                        <span className="text-fg">
                          {m.trace.routingPath?.length} nœud(s) · Daisy Chain
                        </span>
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
                        <span className="text-muted">Nœud d’entrée (relais)</span>
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
                        {(m.trace.workerInfo.gpuName || m.trace.workerInfo.gpuVramMb != null) && (
                          <div className="flex justify-between">
                            <span className="text-muted">GPU (heartbeat)</span>
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
