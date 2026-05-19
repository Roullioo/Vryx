import { Fragment, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AdminShell } from '../components/admin/AdminShell'
import {
  clearSessions,
  clearSessionsFromDb,
  deleteSession,
  deleteSessionFromDb,
  fetchSessionFromDb,
  fetchSessionsFromDb,
  loadSessions,
  normalizeSession,
  type WorkSession,
} from '../lib/sessions'

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
function fmt(n: number) { return n.toLocaleString('fr-FR') }
function ms(n: number) { return `${n.toLocaleString('fr-FR')} ms` }
function shortId(s: string, n = 16) { return s.length > n ? `${s.slice(0, n)}…` : s }
function quantizationLabel(q: string) {
  if (q === 'q4') return '4-bit'
  if (q === 'int8') return '8-bit'
  if (q === 'fp16') return 'fp16'
  return q
}

function relativeTime(ts: number) {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `il y a ${sec}s`
  if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`
  if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h`
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function avg(values: number[]) {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0)
  if (clean.length === 0) return 0
  return clean.reduce((sum, value) => sum + value, 0) / clean.length
}

function percentile(values: number[], p: number) {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  if (clean.length === 0) return 0
  const idx = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1))
  return clean[idx]
}

function sessionStats(session: WorkSession) {
  const s = normalizeSession(session)
  const computeMs = Math.max(s.workerComputeMs || 0, s.computeTimeMs || 0)
  const activeMs = computeMs > 0 ? computeMs : s.latencyMs || 0
  const tokenLatencies = s.tokenSteps.map((step) => step.totalMs).filter((v) => Number.isFinite(v) && v > 0)
  const instantTps = s.tokenSteps
    .map((step) => (step.tps && step.tps > 0 ? step.tps : step.totalMs > 0 ? 1000 / step.totalMs : 0))
    .filter((v) => Number.isFinite(v) && v > 0)
  const avgActiveTps =
    s.hotPathTps && s.hotPathTps > 0
      ? s.hotPathTps
      : s.completionTokens > 0 && activeMs > 0
        ? s.completionTokens / (activeMs / 1000)
        : avg(instantTps)
  const networkMs = Math.max(0, (s.latencyMs || 0) - (s.vpsDelegateMs || 0) - computeMs)
  return {
    activeMs,
    computeMs,
    networkMs,
    avgActiveTps,
    avgInstantTps: avg(instantTps),
    maxInstantTps: Math.max(0, ...instantTps),
    minInstantTps: instantTps.length ? Math.min(...instantTps) : 0,
    firstTokenMs: tokenLatencies[0] || 0,
    p50TokenMs: percentile(tokenLatencies, 50),
    p95TokenMs: percentile(tokenLatencies, 95),
  }
}

function SessionsOverview({ sessions: rawSessions }: { sessions: WorkSession[] }) {
  const sessions = rawSessions.map(normalizeSession)
  const active = sessions.filter((s) => s.completionTokens > 0)
  const totalTokens = active.reduce((sum, s) => sum + (s.completionTokens || 0), 0)
  const avgTps = avg(active.map((s) => sessionStats(s).avgActiveTps))
  const avgPing = avg(active.map((s) => s.pingMs || 0))
  const avgLatency = avg(active.map((s) => s.latencyMs || 0))
  const best = active.reduce<WorkSession | null>((winner, s) => {
    if (!winner) return s
    return sessionStats(s).avgActiveTps > sessionStats(winner).avgActiveTps ? s : winner
  }, null)
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {[
        { label: 'Sessions actives', value: fmt(active.length), hint: `${sessions.length} enregistrée${sessions.length > 1 ? 's' : ''}` },
        { label: 'Tokens générés', value: fmt(totalTokens), hint: 'contenu jamais stocké' },
        { label: 'TPS moyen actif', value: avgTps ? avgTps.toFixed(2) : '—', hint: 'hors périodes idle' },
        { label: 'Ping moyen', value: avgPing ? ms(Math.round(avgPing)) : '—', hint: 'P2P / relay' },
        { label: 'Meilleure session', value: best ? `${sessionStats(best).avgActiveTps.toFixed(2)} TPS` : '—', hint: best ? relativeTime(best.timestamp) : 'aucune' },
      ].map((card) => (
        <div key={card.label} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted">{card.label}</p>
          <p className="mt-1 font-display text-2xl font-bold text-fg">{card.value}</p>
          <p className="mt-1 text-[11px] text-muted">{card.hint}</p>
        </div>
      ))}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:col-span-2 xl:col-span-5">
        <div className="flex flex-wrap gap-4 text-[11px] text-muted">
          <span>Latence moyenne <strong className="font-mono text-fg">{avgLatency ? ms(Math.round(avgLatency)) : '—'}</strong></span>
          <span>TPS calculé uniquement sur les sessions avec génération réelle</span>
          <span>Les graphes ne contiennent aucun token lisible</span>
        </div>
      </div>
    </div>
  )
}

function MiniBarChart({
  title,
  points,
  unit,
  tone = 'bg-electric',
}: {
  title: string
  points: { label: string; value: number }[]
  unit: string
  tone?: string
}) {
  const max = Math.max(1, ...points.map((p) => p.value))
  return (
    <div className="rounded-xl border border-border bg-surface p-4 dark:bg-elevated">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
        <p className="font-mono text-[11px] text-fg">
          moy. {avg(points.map((p) => p.value)).toFixed(unit === 'TPS' ? 2 : 0)} {unit}
        </p>
      </div>
      {points.length === 0 ? (
        <p className="text-xs text-muted">Pas assez de points pour ce graphe.</p>
      ) : (
        <div className="flex h-36 items-end gap-1.5 overflow-x-auto border-b border-border/60 pb-2">
          {points.slice(0, 80).map((p, i) => (
            <div key={`${p.label}-${i}`} className="flex min-w-5 flex-1 flex-col items-center gap-1">
              <div
                className={`w-full rounded-t ${tone}`}
                title={`${p.label}: ${p.value.toFixed(unit === 'TPS' ? 2 : 0)} ${unit}`}
                style={{ height: `${Math.max(4, (p.value / max) * 120)}px` }}
              />
              {points.length <= 24 && <span className="text-[8px] text-muted">{p.label}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SessionMetricGraphs({ session }: { session: WorkSession }) {
  const s = normalizeSession(session)
  const stats = sessionStats(s)
  const tpsPoints = s.tokenSteps.map((step) => {
    const tps = step.tps && step.tps > 0 ? step.tps : step.totalMs > 0 ? 1000 / step.totalMs : 0
    return { label: `#${step.tokenIndex}`, value: tps }
  })
  const latencyPoints = s.tokenSteps.map((step) => ({ label: `#${step.tokenIndex}`, value: step.totalMs }))
  const infrastructurePoints = [
    { label: 'Ping', value: s.pingMs || 0 },
    { label: 'VPS', value: s.vpsDelegateMs || 0 },
    { label: 'Worker', value: Math.max(s.workerComputeMs || 0, s.computeTimeMs || 0) },
    { label: 'Total', value: s.latencyMs || 0 },
  ].filter((p) => p.value > 0)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted">TPS moyen actif</p>
          <p className="mt-1 font-display text-2xl font-bold text-success">{stats.avgActiveTps.toFixed(2)}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted">Ping P2P</p>
          <p className="mt-1 font-display text-2xl font-bold text-fg">{s.pingMs ? ms(Math.round(s.pingMs)) : '—'}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted">P50 token</p>
          <p className="mt-1 font-display text-2xl font-bold text-fg">{stats.p50TokenMs ? ms(Math.round(stats.p50TokenMs)) : '—'}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted">P95 token</p>
          <p className="mt-1 font-display text-2xl font-bold text-fg">{stats.p95TokenMs ? ms(Math.round(stats.p95TokenMs)) : '—'}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted">TPS max instant.</p>
          <p className="mt-1 font-display text-2xl font-bold text-fg">{stats.maxInstantTps ? stats.maxInstantTps.toFixed(2) : '—'}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted">Confidentialité</p>
          <p className="mt-1 text-sm font-semibold text-success">Tokens masqués</p>
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <MiniBarChart title="TPS par point généré" points={tpsPoints} unit="TPS" tone="bg-success" />
        <MiniBarChart title="Latence par point" points={latencyPoints} unit="ms" tone="bg-electric" />
        <MiniBarChart title="Ping & temps système" points={infrastructurePoints} unit="ms" tone="bg-accent" />
      </div>
    </div>
  )
}

/* ─── Diagramme de flux ──────────────────────────────────────────────────── */
function FlowDiagram({ session }: { session: WorkSession }) {
  const s = normalizeSession(session)
  const totalMs = Math.max(1, s.latencyMs)
  const vps = s.vpsDelegateMs
  const wrk = Math.max(s.workerComputeMs, s.computeTimeMs ?? 0)
  const net = Math.max(0, totalMs - vps - wrk)
  const peers = s.peers.length > 0 ? s.peers : s.workerSteps.length > 0 ? s.workerSteps.map(w => w.peerId) : s.workerPeerId ? [s.workerPeerId] : []
  const isDaisyChain =
    s.pipelineLayout === 'pipeline_relay_daisy_chain' ||
    (Array.isArray(s.routingPath) && s.routingPath.length > 1)
  const chainPeers =
    isDaisyChain && s.routingPath && s.routingPath.length > 0 ? s.routingPath : peers

  return (
    <div className="space-y-4">
      {/* Timeline visuelle */}
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Chronologie — {ms(totalMs)} total
        </p>
        <div className="overflow-hidden rounded-xl border border-border bg-surface dark:bg-elevated">
          {/* Légende */}
          <div className="flex items-center gap-4 border-b border-border px-4 py-2.5 text-[10px] font-medium text-muted">
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-electric" />VPS / Initiateur</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-success" />Worker(s)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-border" />Réseau</span>
          </div>
          {/* Barre */}
          <div className="px-4 py-4">
            <div className="flex h-8 w-full overflow-hidden rounded-lg">
              {vps > 0 && (
                <div
                  title={`VPS : ${ms(vps)}`}
                  className="flex h-full items-center justify-center bg-electric text-[10px] font-medium text-white transition-all"
                  style={{ width: `${(vps / totalMs) * 100}%` }}
                >
                  {vps > totalMs * 0.08 ? ms(vps) : ''}
                </div>
              )}
              {wrk > 0 && (
                <div
                  title={`Worker : ${ms(wrk)}`}
                  className="flex h-full items-center justify-center bg-success text-[10px] font-medium text-white"
                  style={{ width: `${(wrk / totalMs) * 100}%` }}
                >
                  {wrk > totalMs * 0.08 ? ms(wrk) : ''}
                </div>
              )}
              {net > 2 && (
                <div
                  title={`Réseau : ${ms(net)}`}
                  className="flex h-full flex-1 items-center justify-center bg-border/60 text-[10px] text-muted dark:bg-zinc-700/60 dark:text-zinc-300"
                >
                  {net > totalMs * 0.08 ? ms(net) : ''}
                </div>
              )}
            </div>
            <div className="mt-2 flex justify-between text-[10px] text-muted">
              <span>0</span>
              <span>{ms(totalMs)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Schéma Node → Workers */}
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Flux de traitement
        </p>
        <div className="overflow-x-auto rounded-xl border border-border bg-surface p-4 dark:bg-elevated">
          <div className="flex min-w-max items-center gap-0">
            {/* Client */}
            <div className="flex flex-col items-center">
              <div className="flex h-12 w-28 items-center justify-center rounded-xl border-2 border-border bg-card shadow-sm">
                <div className="text-center">
                  <p className="text-[11px] font-bold text-fg">Client</p>
                  <p className="text-[9px] text-muted">HTTP</p>
                </div>
              </div>
            </div>

            {/* Arrow */}
            <div className="flex flex-col items-center px-2">
              <div className="h-0.5 w-10 bg-border" />
              <p className="text-[9px] text-muted">requête</p>
            </div>

            {/* VPS Initiateur */}
            <div className="flex flex-col items-center">
              <div className="flex h-16 w-36 items-center justify-center rounded-xl border-2 border-electric/35 bg-electric/10 shadow-sm dark:border-electric/40 dark:bg-electric/15">
                <div className="text-center">
                  <p className="text-[11px] font-bold text-electric">VPS / Initiateur</p>
                  <p className="text-[9px] text-muted">gRPC → Python</p>
                  {vps > 0 && <p className="text-[9px] font-mono text-electric/80">{ms(vps)}</p>}
                </div>
              </div>
            </div>

            {/* P2P arrows */}
            {peers.length > 0 && (
              <>
                <div className="flex flex-col items-center px-2">
                  <div className="h-0.5 w-10 bg-success/50" />
                  <p className="text-[9px] text-muted whitespace-nowrap">
                    {isDaisyChain
                      ? 'relais séquentiel'
                      : s.pipelineLayout === 'row_split_tensor_parallel'
                        ? 'ancien TP'
                        : 'P2P'}
                  </p>
                </div>

                {/* Workers : parallèle (TP) ou chaîne Daisy (pipeline) */}
                {isDaisyChain ? (
                  <div className="flex flex-wrap items-center gap-1 rounded-xl border border-success/20 bg-success/5 px-3 py-2">
                    <span className="mr-1 whitespace-nowrap rounded-full bg-success/20 px-2 py-0.5 text-[8px] font-bold uppercase text-success">
                      Chaîne de relais
                    </span>
                    {chainPeers.map((p, i) => {
                      const step = s.workerSteps.find(w => w.peerId === p)
                      const hopMs =
                        step?.latencyMs ??
                        (wrk > 0 ? Math.round(wrk / Math.max(1, chainPeers.length)) : 0)
                      return (
                        <Fragment key={`${p}-${i}`}>
                          {i > 0 ? (
                            <span className="px-0.5 text-[11px] font-semibold text-success" aria-hidden>
                              →
                            </span>
                          ) : null}
                          <div className="flex h-12 min-w-28 max-w-36 items-center justify-center rounded-xl border-2 border-success/30 bg-card px-2 shadow-sm">
                            <div className="text-center">
                              <p className="text-[10px] font-bold text-success">Nœud {i + 1}</p>
                              <p className="font-mono text-[9px] text-muted">{shortId(p, 12)}</p>
                              {hopMs > 0 ? (
                                <p className="text-[9px] font-mono text-success/70">{ms(hopMs)}</p>
                              ) : null}
                            </div>
                          </div>
                        </Fragment>
                      )
                    })}
                  </div>
                ) : (
                  <div className="relative flex flex-col gap-2 rounded-xl border border-success/20 bg-success/5 p-2">
                    <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-success/20 px-2 py-0.5 text-[8px] font-bold uppercase text-success">
                      Calcul en parallèle
                    </span>
                    {peers.map((p, i) => {
                      const step = s.workerSteps.find(w => w.peerId === p)
                      return (
                        <div key={p} className="flex h-12 w-40 items-center justify-center rounded-xl border-2 border-success/30 bg-card shadow-sm">
                          <div className="text-center">
                            <p className="text-[10px] font-bold text-success">Worker #{i + 1}</p>
                            <p className="font-mono text-[9px] text-muted">{shortId(p, 14)}</p>
                            {step ? (
                              <p className="text-[9px] font-mono text-success/70">{ms(step.latencyMs)}</p>
                            ) : s.workerComputeMs > 0 ? (
                              <p className="text-[9px] font-mono text-success/70">
                                {ms(Math.round(s.workerComputeMs / Math.max(1, peers.length)))}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Flèche retour */}
                <div className="flex flex-col items-center px-2">
                  <div className="h-0.5 w-10 bg-success/50" />
                  <p className="text-[9px] text-muted whitespace-nowrap">
                    {s.pipelineLayout === 'row_split_tensor_parallel' ? 'sortie TP' : 'réponse'}
                  </p>
                </div>
              </>
            )}

          </div>
        </div>
      </div>

      {/* Étapes TP si disponibles */}
      {s.workerSteps.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Étapes pipeline ({s.workerSteps.length})
          </p>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[400px] text-left text-[11px]">
              <thead>
                <tr className="border-b border-border bg-surface/80 text-muted">
                  <th className="px-3 py-2">Rang</th>
                  <th className="px-3 py-2">Pair</th>
                  <th className="px-3 py-2">Rôle</th>
                  <th className="px-3 py-2 text-right">Latence</th>
                  <th className="px-3 py-2 text-right">Sortie</th>
                </tr>
              </thead>
              <tbody>
                {s.workerSteps.map((step, i) => (
                  <tr key={i} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 text-muted">{step.rank}</td>
                    <td className="px-3 py-2 font-mono text-[10px]" title={step.peerId}>{shortId(step.peerId)}</td>
                    <td className="px-3 py-2">{step.role}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ms(step.latencyMs)}</td>
                    <td className="px-3 py-2 text-right text-muted">{step.outRows != null ? `${step.outRows} dims` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Chargement poids */}
      {s.loadSteps.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Chargement des poids</p>
          <div className="space-y-2">
            {s.loadSteps.map((l, i) => {
              const max = Math.max(1, ...s.loadSteps.map((x) => x.loadMs))
              return (
                <div key={i} className="space-y-0.5">
                  <div className="flex justify-between text-[10px]">
                    <span className="font-mono text-muted">#{l.rank} {shortId(l.peerId, 20)}</span>
                    <span className="text-fg">{ms(l.loadMs)}</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-border/40">
                    <div className="h-full rounded-full bg-success" style={{ width: `${(l.loadMs / max) * 100}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Latence par token */}
      {s.tokenSteps.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Latence par token ({s.tokenSteps.length} tokens)
          </p>
          <div className="space-y-1.5">
            {s.tokenSteps.slice(0, 30).map((tk) => {
              const max = Math.max(1, ...s.tokenSteps.map((x) => x.totalMs))
              return (
                <div key={tk.tokenIndex} className="flex items-center gap-2 text-[10px]">
                  <span className="w-6 shrink-0 text-right text-muted">#{tk.tokenIndex}</span>
                  <div className="flex-1 overflow-hidden rounded-full bg-border/30 h-2">
                    <div className="h-full rounded-full bg-electric" style={{ width: `${(tk.totalMs / max) * 100}%` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right font-mono text-fg">{tk.totalMs.toFixed(1)} ms</span>
                </div>
              )
            })}
            {s.tokenSteps.length > 30 && (
              <p className="text-[10px] text-muted">… {s.tokenSteps.length - 30} tokens supplémentaires</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Carte session ──────────────────────────────────────────────────────── */
function SessionCard({ session, onDelete }: { session: WorkSession; onDelete: () => void }) {
  const s = normalizeSession(session)
  const stats = sessionStats(s)
  return (
    <div className="group rounded-2xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="font-mono">{new Date(s.timestamp).toLocaleString('fr-FR')}</span>
            <span>·</span>
            <span>{relativeTime(s.timestamp)}</span>
            <span className="rounded-full bg-border/50 px-1.5 py-0.5 text-[10px]">{s.mode}</span>
          </div>
          <p className="mt-1.5 truncate text-sm font-medium text-fg">Session P2P sécurisée</p>
          <p className="mt-0.5 truncate text-[12px] text-muted">Contenu masqué, métriques conservées</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <p className="font-mono text-sm font-bold text-fg">{stats.avgActiveTps ? stats.avgActiveTps.toFixed(2) : '—'} TPS</p>
            <p className="text-[10px] text-muted">{fmt(s.completionTokens)} tok. · {fmt(s.latencyMs)} ms</p>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="hidden rounded-lg p-1.5 text-muted hover:bg-alert/10 hover:text-alert group-hover:block"
            title="Supprimer"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
              <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        </div>
      </div>
      <div className="border-t border-border/50 px-4 py-2.5">
        <div className="flex flex-wrap gap-3 text-[10px] text-muted">
          <span>VPS <span className="font-mono text-fg">{fmt(s.vpsDelegateMs)} ms</span></span>
          <span>Worker <span className="font-mono text-fg">{fmt(stats.computeMs)} ms</span></span>
          <span>Ping <span className="font-mono text-fg">{s.pingMs ? fmt(Math.round(s.pingMs)) : '—'} ms</span></span>
          <span>P95 tok <span className="font-mono text-fg">{stats.p95TokenMs ? fmt(Math.round(stats.p95TokenMs)) : '—'} ms</span></span>
          <span>Prompt <span className="font-mono text-fg">{fmt(s.promptTokens)}</span></span>
          <span>Complétion <span className="font-mono text-fg">{fmt(s.completionTokens)}</span></span>
          {s.peers.length > 0 && <span><span className="font-mono text-fg">{s.peers.length}</span> pair(s)</span>}
          {s.hotPathTps != null && s.hotPathTps > 0 && (
            <span className="rounded bg-success/10 px-1.5 py-0.5 font-mono font-bold text-success">
              {s.hotPathTps.toFixed(3)} TPS
            </span>
          )}
          {s.pipelineLayout && <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-accent">{s.pipelineLayout}</span>}
        </div>
      </div>
      <div className="border-t border-border/50 px-4 py-2">
        <div className="flex flex-wrap gap-1">
          {s.quicUsed != null && (
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${s.quicUsed ? 'bg-success/15 text-success' : 'bg-border/40 text-muted'}`}>
              {s.quicUsed ? 'QUIC' : 'TCP'}
            </span>
          )}
          {s.kvCacheUsed != null && (
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${s.kvCacheUsed ? 'bg-electric/15 text-electric' : 'bg-border/40 text-muted'}`}>
              {s.kvCacheUsed ? 'KV ON' : 'KV OFF'}
            </span>
          )}
          {s.hiddenTransport && (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-accent">
              {s.hiddenTransport}
            </span>
          )}
          {s.requestedQuantization && (
            <span className="rounded bg-electric/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-electric">
              demandé : {quantizationLabel(s.requestedQuantization)}
            </span>
          )}
          {s.quantizationFallbackReason && (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[9px] text-warning">
              fallback : {s.quantizationFallbackReason}
            </span>
          )}
          {s.poolClass && (
            <span className="rounded bg-success/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-success">
              pool : {s.poolClass}
            </span>
          )}
          {s.prefixCacheHit != null && (
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${s.prefixCacheHit ? 'bg-primary/15 text-primary' : 'bg-border/40 text-muted'}`}>
              {s.prefixCacheHit ? 'Cache HIT' : 'Cache MISS'}
            </span>
          )}
          {s.stopReason && s.stopReason !== 'null' && (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[9px] text-warning">
              {s.stopReason}
            </span>
          )}
        </div>
      </div>
      <div className="border-t border-border/50 px-4 py-2.5">
        <Link
          to={`/admin/sessions/${s.id}`}
          className="text-[11px] font-medium text-accent hover:underline"
        >
          Voir le détail →
        </Link>
      </div>
    </div>
  )
}

/* ─── Page liste sessions ────────────────────────────────────────────────── */
export function AdminSessionsPage() {
  const [sessions, setSessions] = useState<WorkSession[]>(() => loadSessions())
  const [loading, setLoading] = useState(true)
  const safeSessions = (Array.isArray(sessions) ? sessions : []).map(normalizeSession)

  async function refresh() {
    setLoading(true)
    try {
      setSessions(await fetchSessionsFromDb())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function handleDelete(id: string) {
    deleteSession(id)
    await deleteSessionFromDb(id)
    refresh()
  }

  async function handleClear() {
    clearSessions()
    await clearSessionsFromDb()
    refresh()
  }

  return (
    <AdminShell
      title="Sessions"
      subtitle={`${safeSessions.length} session${safeSessions.length > 1 ? 's' : ''} enregistrée${safeSessions.length > 1 ? 's' : ''}${loading ? ' · synchronisation DB…' : ''}`}
      actions={
        safeSessions.length > 0 ? (
          <button
            onClick={handleClear}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted hover:border-alert/40 hover:text-alert"
          >
            Tout effacer
          </button>
        ) : undefined
      }
    >
      {safeSessions.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-12 text-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="mx-auto mb-4 h-10 w-10 text-muted/40">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <p className="text-sm font-medium text-muted">Aucune session enregistrée</p>
          <p className="mt-1 text-xs text-muted/70">
            Chaque message envoyé dans le{' '}
            <Link to="/admin/noeud" className="text-accent hover:underline">Chat P2P</Link>{' '}
            crée une session ici.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <SessionsOverview sessions={safeSessions} />
          <div className="space-y-3">
            {safeSessions.map((s) => (
              <SessionCard key={s.id} session={s} onDelete={() => handleDelete(s.id)} />
            ))}
          </div>
        </div>
      )}
    </AdminShell>
  )
}

/* ─── Page détail session ────────────────────────────────────────────────── */
export function AdminSessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [session, setSession] = useState<WorkSession | null>(() => {
    const sessions = loadSessions()
    return sessions.find((s) => s.id === sessionId) ?? null
  })

  useEffect(() => {
    if (!sessionId) return
    void (async () => {
      const remote = await fetchSessionFromDb(sessionId)
      if (remote) setSession(remote)
    })()
  }, [sessionId])

  if (!session) return (
    <AdminShell title="Détail session">
      <div className="rounded-2xl border border-border bg-card p-12 text-center">
        <p className="text-sm text-muted">Session introuvable (peut-être effacée).</p>
        <Link to="/admin/sessions" className="mt-3 inline-block text-sm text-accent hover:underline">
          Retour aux sessions
        </Link>
      </div>
    </AdminShell>
  )

  const safeSession = normalizeSession(session)
  const stats = sessionStats(safeSession)

  return (
    <AdminShell
      title="Détail de session"
      subtitle={new Date(safeSession.timestamp).toLocaleString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })}
      actions={
        <Link to="/admin/sessions" className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface">
          ← Retour
        </Link>
      }
    >
      <div className="space-y-5">
        {/* Confidentialité contenu */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Prompt</p>
            <p className="text-sm leading-relaxed text-fg">Contenu masqué pour ne pas rendre les tokens lisibles dans l’historique.</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Réponse</p>
            <p className="text-sm leading-relaxed text-fg">Seules les métriques de performance sont conservées.</p>
          </div>
        </div>

        {/* Métriques clés */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Latence totale', value: ms(safeSession.latencyMs), accent: false },
            { label: 'Ping P2P', value: safeSession.pingMs ? ms(Math.round(safeSession.pingMs)) : '—' },
            { label: 'VPS (orch.)', value: ms(safeSession.vpsDelegateMs) },
            { label: 'Worker actif', value: ms(stats.computeMs) },
            { label: 'TPS moyen actif', value: stats.avgActiveTps ? `${stats.avgActiveTps.toFixed(2)}` : '—' },
            { label: 'Points générés', value: fmt(safeSession.completionTokens) },
          ].map((m) => (
            <div key={m.label} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
              <p className="text-xs text-muted">{m.label}</p>
              <p className="mt-1 font-display text-xl font-bold text-fg">{m.value}</p>
            </div>
          ))}
        </div>

        {/* Badges transport & performance */}
        <div className="flex flex-wrap gap-2 rounded-2xl border border-border bg-card p-4 shadow-sm">
          {safeSession.hotPathTps != null && safeSession.hotPathTps > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-3 py-1 text-xs font-bold text-success">
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden><circle cx="8" cy="8" r="3"/></svg>
              {safeSession.hotPathTps.toFixed(3)} TPS
            </span>
          )}
          {safeSession.avgMsPerToken != null && safeSession.avgMsPerToken > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-border/40 px-3 py-1 text-xs font-semibold text-muted">
              {safeSession.avgMsPerToken} ms/tok
            </span>
          )}
          {safeSession.quicUsed != null && (
            <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${safeSession.quicUsed ? 'bg-success/10 text-success' : 'bg-border/40 text-muted'}`}>
              {safeSession.quicUsed ? 'QUIC UDP' : 'TCP'}
            </span>
          )}
          {safeSession.kvCacheUsed != null && (
            <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${safeSession.kvCacheUsed ? 'bg-electric/10 text-electric' : 'bg-border/40 text-muted'}`}>
              {safeSession.kvCacheUsed ? 'KV Cache ON' : 'KV Cache OFF'}
            </span>
          )}
          {safeSession.hiddenTransport && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-bold text-accent">
              {safeSession.hiddenTransport}
            </span>
          )}
          {safeSession.requestedQuantization && (
            <span className="inline-flex items-center gap-1 rounded-full bg-electric/10 px-3 py-1 text-xs font-bold text-electric">
              Demandé : {quantizationLabel(safeSession.requestedQuantization)}
            </span>
          )}
          {safeSession.effectiveQuantization && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-3 py-1 text-xs font-bold text-success">
              Effectif : {safeSession.effectiveQuantization}
            </span>
          )}
          {safeSession.quantizationFallbackReason && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-3 py-1 text-xs font-semibold text-warning">
              Fallback : {safeSession.quantizationFallbackReason}
            </span>
          )}
          {safeSession.poolClass && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-3 py-1 text-xs font-bold text-success">
              Pool : {safeSession.poolClass}
            </span>
          )}
          {safeSession.poolFallbackReason && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-3 py-1 text-xs font-semibold text-warning">
              Pool fallback : {safeSession.poolFallbackReason}
            </span>
          )}
          {safeSession.prefixCacheHit != null && (
            <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${safeSession.prefixCacheHit ? 'bg-primary/10 text-primary' : 'bg-border/40 text-muted'}`}>
              {safeSession.prefixCacheHit
                ? `Prefix Cache HIT${safeSession.prefixCacheTokens ? ` (${fmt(safeSession.prefixCacheTokens)} tok)` : ''}`
                : 'Prefix Cache MISS'}
            </span>
          )}
          {safeSession.stopReason && safeSession.stopReason !== 'null' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-3 py-1 text-xs font-semibold text-warning">
              arrêt : {safeSession.stopReason}
            </span>
          )}
        </div>

        {/* Explication du mode */}
        <div className="rounded-2xl border border-border bg-surface p-5 dark:border-border dark:bg-elevated">
          <h3 className="text-sm font-semibold text-fg">Comprendre ce traitement</h3>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {safeSession.pipelineLayout === 'pipeline_relay_daisy_chain' ? (
              <>
                <strong>Pipeline Parallelism (Daisy Chain) :</strong> Les tenseurs ont traversé les nœuds dans l&apos;ordre du{' '}
                <span className="font-mono">routing_path</span> : chaque pair calcule son segment puis passe au suivant (relais séquentiel), 
                sans passer par une API Web2 centralisée.
              </>
            ) : safeSession.pipelineLayout === 'row_split_tensor_parallel' ? (
              <>
                <strong>Ancienne trace Tensor Parallelism :</strong> ce layout row-split est conservé seulement pour lire les anciennes sessions.
                Le chat admin actuel utilise la chaîne de relais Daisy Chain via <span className="font-mono">routing_path</span>.
              </>
            ) : safeSession.pipelineLayout === 'distributed_fanout' ? (
              <>
                <strong>Fan-out distribué :</strong> Le prompt a été envoyé à plusieurs workers en même temps. 
                Le premier worker à répondre a "gagné" et sa réponse a été utilisée. Les autres workers ont été contactés mais leur résultat a été ignoré car ils étaient plus lents.
              </>
            ) : (
              <>
                <strong>Pipeline P2P natif :</strong> L&apos;initiateur Rust orchestre l&apos;inférence via gRPC et libp2p ; les segments peuvent transiter en{' '}
                <strong>chaîne de relais</strong> (Daisy Chain, <span className="font-mono">routing_path</span>) ou en parallèle selon le layout du tour.
              </>
            )}
          </p>
        </div>

        {/* Diagramme complet */}
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <p className="mb-4 text-sm font-semibold text-fg">Analyse détaillée</p>
          <SessionMetricGraphs session={safeSession} />
          <div className="mt-5">
          <FlowDiagram session={safeSession} />
          </div>
        </div>

        {/* Infos worker */}
        {(safeSession.primaryWorkerPeerId || safeSession.workerPeerId) && (
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="mb-3 text-sm font-semibold text-fg">Informations worker</p>
            <dl className="space-y-2">
              {[
                { label: 'Peer ID principal', value: safeSession.primaryWorkerPeerId || safeSession.workerPeerId, mono: true },
                { label: 'Mode', value: safeSession.mode },
                { label: 'Layout pipeline', value: safeSession.pipelineLayout || '—' },
                { label: 'Pipeline OK', value: safeSession.pipelineLayout ? (safeSession.pipelineOk ? 'Oui' : 'Non') : '—' },
                { label: 'Workers contactés', value: String(safeSession.schedulerWorkersUsed) },
                { label: 'Warmup historique', value: String(safeSession.schedulerWarmupSent) },
                { label: 'Messages P2P in', value: String(safeSession.p2pMessagesIn) },
                { label: 'Messages P2P out', value: String(safeSession.p2pMessagesOut) },
                { label: 'Prompt tokens', value: fmt(safeSession.promptTokens) },
                { label: 'Complétion tokens', value: fmt(safeSession.completionTokens) },
                { label: 'Total tokens', value: fmt(safeSession.totalTokens) },
                ...(safeSession.setupMs != null && safeSession.setupMs > 0 ? [{ label: 'Setup pipeline', value: ms(safeSession.setupMs) }] : []),
                ...(safeSession.avgMsPerToken != null && safeSession.avgMsPerToken > 0 ? [{ label: 'Moy. ms/token', value: `${safeSession.avgMsPerToken} ms` }] : []),
                ...(safeSession.hotPathTps != null && safeSession.hotPathTps > 0 ? [{ label: 'TPS mesuré', value: `${safeSession.hotPathTps.toFixed(3)} tok/s` }] : []),
                ...(safeSession.benchmarkActualTps != null && safeSession.benchmarkActualTps > 0 ? [{ label: 'TPS benchmark', value: `${safeSession.benchmarkActualTps.toFixed(3)} tok/s (cible : 15)` }] : []),
              ].map((r) => (
                <div key={r.label} className="flex justify-between border-b border-border/40 py-1.5 text-[12px] last:border-0">
                  <dt className="text-muted">{r.label}</dt>
                  <dd className={`max-w-[60%] break-all text-right ${r.mono ? 'font-mono text-[10px]' : ''} text-fg`}>{r.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {/* Pairs */}
        {safeSession.peers.length > 0 && (
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="mb-3 text-sm font-semibold text-fg">Pairs impliqués ({safeSession.peers.length})</p>
            <ul className="space-y-1">
              {safeSession.peers.map((p, i) => (
                <li key={p} className="flex items-center gap-2 text-[11px]">
                  <span className="rounded bg-success/10 px-1.5 py-0.5 text-[9px] font-bold text-success">#{i + 1}</span>
                  <span className="font-mono text-fg">{p}</span>
                  <Link to={`/admin/workers/${encodeURIComponent(p)}`} className="ml-auto text-accent hover:underline">détail →</Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </AdminShell>
  )
}
