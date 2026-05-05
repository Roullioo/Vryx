import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AdminShell } from '../components/admin/AdminShell'
import { loadSessions, deleteSession, clearSessions, type WorkSession } from '../lib/sessions'

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
function fmt(n: number) { return n.toLocaleString('fr-FR') }
function ms(n: number) { return `${n.toLocaleString('fr-FR')} ms` }
function shortId(s: string, n = 16) { return s.length > n ? `${s.slice(0, n)}…` : s }

function relativeTime(ts: number) {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `il y a ${sec}s`
  if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`
  if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h`
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

/* ─── Diagramme de flux ──────────────────────────────────────────────────── */
function FlowDiagram({ session: s }: { session: WorkSession }) {
  const totalMs = Math.max(1, s.latencyMs)
  const vps = s.vpsDelegateMs
  const wrk = s.workerComputeMs
  const net = Math.max(0, totalMs - vps - wrk)
  const peers = s.peers.length > 0 ? s.peers : s.workerSteps.length > 0 ? s.workerSteps.map(w => w.peerId) : s.workerPeerId ? [s.workerPeerId] : []

  return (
    <div className="space-y-4">
      {/* Timeline visuelle */}
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Chronologie — {ms(totalMs)} total
        </p>
        <div className="overflow-hidden rounded-xl border border-border bg-[#f9f9f9]">
          {/* Légende */}
          <div className="flex items-center gap-4 border-b border-border px-4 py-2.5 text-[10px] font-medium text-muted">
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" />VPS / Initiateur</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-success" />Worker(s)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-border" />Réseau</span>
          </div>
          {/* Barre */}
          <div className="px-4 py-4">
            <div className="flex h-8 w-full overflow-hidden rounded-lg">
              {vps > 0 && (
                <div
                  title={`VPS : ${ms(vps)}`}
                  className="flex h-full items-center justify-center bg-accent text-[10px] font-medium text-white transition-all"
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
                  className="flex h-full flex-1 items-center justify-center bg-border/50 text-[10px] text-muted"
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
        <div className="overflow-x-auto rounded-xl border border-border bg-[#f9f9f9] p-4">
          <div className="flex min-w-max items-center gap-0">
            {/* Client */}
            <div className="flex flex-col items-center">
              <div className="flex h-12 w-28 items-center justify-center rounded-xl border-2 border-border bg-white shadow-sm">
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
              <div className="flex h-16 w-36 items-center justify-center rounded-xl border-2 border-accent/30 bg-accent/5 shadow-sm">
                <div className="text-center">
                  <p className="text-[11px] font-bold text-accent">VPS / Initiateur</p>
                  <p className="text-[9px] text-muted">gRPC → Python</p>
                  {vps > 0 && <p className="text-[9px] font-mono text-accent/70">{ms(vps)}</p>}
                </div>
              </div>
            </div>

            {/* P2P arrows */}
            {peers.length > 0 && (
              <>
                <div className="flex flex-col items-center px-2">
                  <div className="h-0.5 w-10 bg-success/50" />
                  <p className="text-[9px] text-muted whitespace-nowrap">
                    {s.pipelineLayout === 'row_split_tensor_parallel' ? 'découpe matrice' : 'P2P'}
                  </p>
                </div>

                {/* Workers */}
                <div className="relative flex flex-col gap-2 rounded-xl border border-success/20 bg-success/5 p-2">
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-success/20 px-2 py-0.5 text-[8px] font-bold uppercase text-success">
                    Calcul en parallèle
                  </span>
                  {peers.map((p, i) => {
                    const step = s.workerSteps.find(w => w.peerId === p)
                    return (
                      <div key={p} className="flex h-12 w-40 items-center justify-center rounded-xl border-2 border-success/30 bg-white shadow-sm">
                        <div className="text-center">
                          <p className="text-[10px] font-bold text-success">Worker #{i + 1}</p>
                          <p className="font-mono text-[9px] text-muted">{shortId(p, 14)}</p>
                          {step ? (
                            <p className="text-[9px] font-mono text-success/70">{ms(step.latencyMs)}</p>
                          ) : s.workerComputeMs > 0 ? (
                            <p className="text-[9px] font-mono text-success/70">{ms(Math.round(s.workerComputeMs / Math.max(1, peers.length)))}</p>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Flèche retour */}
                <div className="flex flex-col items-center px-2">
                  <div className="h-0.5 w-10 bg-success/50" />
                  <p className="text-[9px] text-muted whitespace-nowrap">
                    {s.pipelineLayout === 'row_split_tensor_parallel' ? 'concaténation' : 'réponse'}
                  </p>
                </div>
              </>
            )}

            {/* Ollama si P2P + Ollama */}
            {s.mode.toLowerCase().includes('ollama') && (
              <>
                {peers.length === 0 && (
                  <div className="flex flex-col items-center px-2">
                    <div className="h-0.5 w-10 bg-border" />
                  </div>
                )}
                <div className="flex flex-col items-center">
                  <div className="flex h-12 w-28 items-center justify-center rounded-xl border-2 border-warning/30 bg-warning/5 shadow-sm">
                    <div className="text-center">
                      <p className="text-[11px] font-bold text-warning">Ollama</p>
                      <p className="text-[9px] text-muted">LLM local VPS</p>
                    </div>
                  </div>
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
          <div className="overflow-x-auto rounded-xl border border-border bg-white">
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
                    <div className="h-full rounded-full bg-accent" style={{ width: `${(tk.totalMs / max) * 100}%` }} />
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
function SessionCard({ session: s, onDelete }: { session: WorkSession; onDelete: () => void }) {
  return (
    <div className="group rounded-2xl border border-border bg-white shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="font-mono">{new Date(s.timestamp).toLocaleString('fr-FR')}</span>
            <span>·</span>
            <span>{relativeTime(s.timestamp)}</span>
            <span className="rounded-full bg-border/50 px-1.5 py-0.5 text-[10px]">{s.mode}</span>
          </div>
          <p className="mt-1.5 truncate text-sm font-medium text-fg">{s.prompt}</p>
          <p className="mt-0.5 truncate text-[12px] text-muted">{s.response}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <p className="font-mono text-sm font-bold text-fg">{fmt(s.latencyMs)} ms</p>
            <p className="text-[10px] text-muted">{fmt(s.completionTokens)} tok.</p>
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
        <div className="flex flex-wrap gap-4 text-[10px] text-muted">
          <span>VPS <span className="font-mono text-fg">{fmt(s.vpsDelegateMs)} ms</span></span>
          <span>Worker <span className="font-mono text-fg">{fmt(s.workerComputeMs)} ms</span></span>
          <span>Prompt <span className="font-mono text-fg">{fmt(s.promptTokens)}</span></span>
          <span>Complétion <span className="font-mono text-fg">{fmt(s.completionTokens)}</span></span>
          {s.peers.length > 0 && <span><span className="font-mono text-fg">{s.peers.length}</span> pair(s)</span>}
          {s.pipelineLayout && <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-accent">{s.pipelineLayout}</span>}
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

  function refresh() { setSessions(loadSessions()) }

  function handleDelete(id: string) {
    deleteSession(id)
    refresh()
  }

  function handleClear() {
    clearSessions()
    refresh()
  }

  return (
    <AdminShell
      title="Sessions"
      subtitle={`${sessions.length} session${sessions.length > 1 ? 's' : ''} enregistrée${sessions.length > 1 ? 's' : ''}`}
      actions={
        sessions.length > 0 ? (
          <button
            onClick={handleClear}
            className="rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-muted hover:border-alert/40 hover:text-alert"
          >
            Tout effacer
          </button>
        ) : undefined
      }
    >
      {sessions.length === 0 ? (
        <div className="rounded-2xl border border-border bg-white p-12 text-center">
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
        <div className="space-y-3">
          {sessions.map((s) => (
            <SessionCard key={s.id} session={s} onDelete={() => handleDelete(s.id)} />
          ))}
        </div>
      )}
    </AdminShell>
  )
}

/* ─── Page détail session ────────────────────────────────────────────────── */
export function AdminSessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const sessions = loadSessions()
  const session = sessions.find((s) => s.id === sessionId) ?? null

  if (!session) return (
    <AdminShell title="Détail session">
      <div className="rounded-2xl border border-border bg-white p-12 text-center">
        <p className="text-sm text-muted">Session introuvable (peut-être effacée).</p>
        <Link to="/admin/sessions" className="mt-3 inline-block text-sm text-accent hover:underline">
          Retour aux sessions
        </Link>
      </div>
    </AdminShell>
  )

  return (
    <AdminShell
      title="Détail de session"
      subtitle={new Date(session.timestamp).toLocaleString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })}
      actions={
        <Link to="/admin/sessions" className="rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface">
          ← Retour
        </Link>
      }
    >
      <div className="space-y-5">
        {/* Prompt / réponse */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Prompt</p>
            <p className="text-sm leading-relaxed text-fg">{session.prompt}</p>
          </div>
          <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Réponse</p>
            <p className="text-sm leading-relaxed text-fg">{session.response}</p>
          </div>
        </div>

        {/* Métriques clés */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Latence totale', value: ms(session.latencyMs), accent: false },
            { label: 'VPS (orch.)', value: ms(session.vpsDelegateMs) },
            { label: 'Worker (calcul)', value: ms(session.workerComputeMs) },
            { label: 'Tokens générés', value: fmt(session.completionTokens) },
          ].map((m) => (
            <div key={m.label} className="rounded-2xl border border-border bg-white p-4 shadow-sm">
              <p className="text-xs text-muted">{m.label}</p>
              <p className="mt-1 font-display text-xl font-bold text-fg">{m.value}</p>
            </div>
          ))}
        </div>

        {/* Explication du mode */}
        <div className="rounded-2xl border border-accent/20 bg-accent/5 p-5">
          <h3 className="text-sm font-semibold text-fg">Comprendre ce traitement</h3>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {session.pipelineLayout === 'row_split_tensor_parallel' ? (
              <>
                <strong>Tensor Parallelism (TP) :</strong> Les workers ont collaboré pour générer cette réponse. 
                La matrice de poids a été découpée en bandes (row-split). Chaque worker a calculé une fraction des mathématiques 
                en parallèle, puis le VPS a rassemblé les résultats. C'est ce qui permet d'utiliser la puissance combinée de plusieurs machines.
              </>
            ) : session.pipelineLayout === 'distributed_fanout' ? (
              <>
                <strong>Fan-out distribué :</strong> Le prompt a été envoyé à plusieurs workers en même temps. 
                Le premier worker à répondre a "gagné" et sa réponse a été utilisée. Les autres workers ont été contactés mais leur résultat a été ignoré car ils étaient plus lents.
              </>
            ) : (
              <>
                <strong>Mode Standard (Ollama) :</strong> Le texte a été généré intégralement par le modèle local sur le VPS. 
                Aucun découpage Tensor Parallel n'a été appliqué sur ce tour.
              </>
            )}
          </p>
        </div>

        {/* Diagramme complet */}
        <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
          <p className="mb-4 text-sm font-semibold text-fg">Analyse détaillée</p>
          <FlowDiagram session={session} />
        </div>

        {/* Infos worker */}
        {(session.primaryWorkerPeerId || session.workerPeerId) && (
          <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
            <p className="mb-3 text-sm font-semibold text-fg">Informations worker</p>
            <dl className="space-y-2">
              {[
                { label: 'Peer ID principal', value: session.primaryWorkerPeerId || session.workerPeerId, mono: true },
                { label: 'Mode', value: session.mode },
                { label: 'Layout pipeline', value: session.pipelineLayout || '—' },
                { label: 'Pipeline OK', value: session.pipelineLayout ? (session.pipelineOk ? 'Oui' : 'Non') : '—' },
                { label: 'Workers contactés', value: String(session.schedulerWorkersUsed) },
                { label: 'Warmup historique', value: String(session.schedulerWarmupSent) },
                { label: 'Messages P2P in', value: String(session.p2pMessagesIn) },
                { label: 'Messages P2P out', value: String(session.p2pMessagesOut) },
                { label: 'Prompt tokens', value: fmt(session.promptTokens) },
                { label: 'Complétion tokens', value: fmt(session.completionTokens) },
                { label: 'Total tokens', value: fmt(session.totalTokens) },
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
        {session.peers.length > 0 && (
          <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
            <p className="mb-3 text-sm font-semibold text-fg">Pairs impliqués ({session.peers.length})</p>
            <ul className="space-y-1">
              {session.peers.map((p, i) => (
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
