import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AdminShell } from '../components/admin/AdminShell'
import { ConfirmDialog } from '../components/admin/ConfirmDialog'
import { apiJson } from '../lib/api'
import { useAuth } from '../context/AuthContext'

type AdminUser = {
  id: string
  email: string
  isAdmin: boolean
  balanceEuro: number
  createdAt: string | null
  lastLoginAt: string | null
}

type AdminUserDetail = {
  user: AdminUser & {
    googleLinked?: boolean
    updatedAt?: string | null
  }
  usage: {
    apiRequests: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    costEur: number
    avgLatencyMs: number
    sessionCount: number
    sessionCompletionTokens: number
    avgSessionTps: number
  }
  workers: Array<{
    peerId: string
    mode: string
    publicIp: string | null
    model: string | null
    gpuName: string | null
    allocatedVramMb: number | null
    gpuVramMb: number | null
    runtimeBackend: string | null
    tokensGenerated: number
    desiredState: string
    desiredModel: string | null
    lastCommandStatus: string | null
    lastHeartbeatAt: string | null
    online: boolean
    secondsSinceHeartbeat: number
  }>
  apiKeys: Array<{
    id: string
    name: string
    keyPrefix: string
    createdAt: string | null
    lastUsedAt: string | null
    revokedAt: string | null
    requestCount: number
    totalTokens: number
    costEur: number
  }>
  sessions: Array<{
    id: string
    createdAt: string | null
    metrics: {
      completionTokens?: number
      hotPathTps?: number
      latencyMs?: number
      modelId?: string
      pipelineLayout?: string
    }
  }>
}

type Pending =
  | { kind: 'promote'; user: AdminUser }
  | { kind: 'demote'; user: AdminUser }
  | { kind: 'delete'; user: AdminUser }
  | null

function formatDate(d: string | null) {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return d
  }
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString('fr-FR')
}

function fmtGb(mb?: number | null) {
  if (!mb) return '—'
  return `${Math.round((mb / 1024) * 10) / 10} Go`
}

export function AdminUsersPage() {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async (q = '') => {
    setLoading(true)
    const r = await apiJson<{ users: AdminUser[] }>(
      `/api/admin/users${q ? `?search=${encodeURIComponent(q)}` : ''}`,
    )
    setLoading(false)
    if (r.ok) {
      setUsers(r.data.users)
      setError(null)
    } else {
      setError(r.error)
    }
  }, [])

  useEffect(() => {
    const tid = window.setTimeout(() => {
      void load('')
    }, 0)
    return () => window.clearTimeout(tid)
  }, [load])

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault()
    void load(search.trim())
  }

  async function performPending() {
    if (!pending) return
    setSubmitting(true)
    const u = pending.user
    let r: Awaited<ReturnType<typeof apiJson>>
    if (pending.kind === 'delete') {
      r = await apiJson(`/api/admin/users/${u.id}`, { method: 'DELETE' })
    } else {
      r = await apiJson(`/api/admin/users/${u.id}/admin`, {
        method: 'PATCH',
        body: JSON.stringify({ isAdmin: pending.kind === 'promote' }),
      })
    }
    setSubmitting(false)
    if (!r.ok) {
      setError(r.error)
      setPending(null)
      return
    }
    setHint(
      pending.kind === 'delete'
        ? `Compte ${u.email} supprimé.`
        : pending.kind === 'promote'
          ? `${u.email} est désormais administrateur.`
          : `${u.email} n'est plus administrateur.`,
    )
    window.setTimeout(() => setHint(null), 4000)
    setPending(null)
    await load(search.trim())
  }

  return (
    <AdminShell
      title="Utilisateurs"
      subtitle="Gérez les comptes et les droits administrateur"
      actions={
        <form onSubmit={onSearch} className="flex w-60 gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher…"
              className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <button type="submit" className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90">
              OK
            </button>
          </form>
      }
    >
      <div className="space-y-5">

        {error && (
          <div
            className="rounded-lg border border-alert/50 bg-alert/10 px-4 py-3 text-sm text-alert"
            role="alert"
          >
            {error}
          </div>
        )}
        {hint && (
          <div
            className="rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm text-success"
            role="status"
          >
            {hint}
          </div>
        )}

        <div className="overflow-x-auto panel">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-4 py-3 pl-5">E-mail</th>
                <th className="px-4 py-3 text-center">Solde</th>
                <th className="px-4 py-3 text-center">Rôle</th>
                <th className="px-4 py-3">Inscription</th>
                <th className="px-4 py-3">Dernière connexion</th>
                <th className="px-4 py-3 pr-5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && users.length === 0 ? (
                <tr>
                  <td className="px-5 py-6 text-muted" colSpan={6}>
                    Chargement…
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td className="px-5 py-6 text-muted" colSpan={6}>
                    Aucun utilisateur trouvé.
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const isMe = me?.id === u.id
                  return (
                    <tr key={u.id} className="border-b border-border/70 hover:bg-surface/40">
                      <td className="px-4 py-3 pl-5">
                        <Link to={`/admin/utilisateurs/${u.id}`} className="font-medium text-fg hover:text-accent">
                          {u.email}
                        </Link>
                        <div className="font-mono text-[11px] text-muted">id {u.id}</div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="font-mono font-bold text-success bg-success/5 px-2 py-1 rounded border border-success/10">
                          {Number(u.balanceEuro || 0).toFixed(2)} €
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {u.isAdmin ? (
                          <span className="rounded-md bg-accent/10 px-2 py-1 text-xs font-semibold text-accent">
                            Administrateur
                          </span>
                        ) : (
                          <span className="rounded-md border border-border px-2 py-1 text-xs text-muted">
                            Utilisateur
                          </span>
                        )}
                        {isMe && (
                          <span className="ml-2 rounded bg-electric/15 px-2 py-0.5 text-[11px] font-medium text-electric">
                            vous
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted">{formatDate(u.createdAt)}</td>
                      <td className="px-4 py-3 text-muted">{formatDate(u.lastLoginAt)}</td>
                      <td className="px-4 py-3 pr-5 text-right">
                        <div className="inline-flex items-center gap-2">
                          {u.isAdmin ? (
                            <button
                              type="button"
                              onClick={() => setPending({ kind: 'demote', user: u })}
                              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg hover:border-warning/50 hover:text-warning"
                              disabled={isMe}
                              title={
                                isMe
                                  ? 'Vous ne pouvez pas vous rétrograder vous-même.'
                                  : undefined
                              }
                            >
                              Retirer admin
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPending({ kind: 'promote', user: u })}
                              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg hover:border-accent/40 hover:text-accent"
                            >
                              Promouvoir admin
                            </button>
                          )}
                          <Link
                            to={`/admin/utilisateurs/${u.id}`}
                            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg hover:border-accent/40 hover:text-accent"
                          >
                            Détail
                          </Link>
                          <button
                            type="button"
                            onClick={() => setPending({ kind: 'delete', user: u })}
                            className="rounded-md border border-alert/30 px-3 py-1.5 text-xs font-medium text-alert hover:bg-alert/10 disabled:opacity-50"
                            disabled={isMe}
                          >
                            Supprimer
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted">
          {users.length} compte(s) listé(s). Les actions sensibles déclenchent toujours une
          confirmation.
        </p>
      </div>

      <ConfirmDialog
        open={pending?.kind === 'promote'}
        title="Promouvoir en administrateur ?"
        description={
          pending && (
            <>
              Le compte <strong className="text-fg">{pending.user.email}</strong> aura accès
              au panel admin et pourra modifier les autres utilisateurs.
            </>
          )
        }
        confirmLabel="Promouvoir"
        loading={submitting}
        onConfirm={performPending}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending?.kind === 'demote'}
        title="Retirer les droits administrateur ?"
        description={
          pending && (
            <>
              <strong className="text-fg">{pending.user.email}</strong> redeviendra un
              utilisateur standard.
            </>
          )
        }
        confirmLabel="Retirer admin"
        variant="danger"
        loading={submitting}
        onConfirm={performPending}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending?.kind === 'delete'}
        title="Supprimer définitivement ce compte ?"
        description={
          pending && (
            <>
              Le compte <strong className="text-fg">{pending.user.email}</strong> sera
              effacé de la base. Cette action est irréversible.
            </>
          )
        }
        confirmLabel="Supprimer"
        variant="danger"
        loading={submitting}
        onConfirm={performPending}
        onCancel={() => setPending(null)}
      />
    </AdminShell>
  )
}

export function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [detail, setDetail] = useState<AdminUserDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creditAmount, setCreditAmount] = useState('50')
  const [creditDescription, setCreditDescription] = useState('Crédit pilote')
  const [creditLoading, setCreditLoading] = useState(false)
  const [creditHint, setCreditHint] = useState<string | null>(null)

  const loadDetail = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const r = await apiJson<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`)
    setLoading(false)
    if (r.ok) {
      setDetail(r.data)
      setError(null)
    } else {
      setError(r.error)
    }
  }, [id])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const addCredit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    if (!id || creditLoading) return
    const amountEur = Number(creditAmount.replace(',', '.'))
    if (!Number.isFinite(amountEur) || Math.abs(amountEur) <= 0) {
      setError('Montant de crédit invalide.')
      return
    }
    setCreditLoading(true)
    setError(null)
    const r = await apiJson<{ ok: true; balanceEur: number }>(`/api/admin/billing/users/${encodeURIComponent(id)}/credit`, {
      method: 'POST',
      body: JSON.stringify({ amountEur, description: creditDescription.trim() || 'Ajustement admin' }),
    })
    setCreditLoading(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setCreditHint(`Solde mis à jour: ${Number(r.data.balanceEur || 0).toFixed(2)} €`)
    window.setTimeout(() => setCreditHint(null), 4000)
    await loadDetail()
  }, [creditAmount, creditDescription, creditLoading, id, loadDetail])

  if (loading) {
    return (
      <AdminShell title="Détail utilisateur">
        <div className="space-y-4">
          {[1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-3xl border border-border bg-card" />)}
        </div>
      </AdminShell>
    )
  }

  if (!detail || error) {
    return (
      <AdminShell title="Détail utilisateur">
        <div className="rounded-3xl border border-border bg-card p-12 text-center">
          <p className="text-sm text-muted">{error || 'Utilisateur introuvable.'}</p>
          <Link to="/admin/utilisateurs" className="mt-3 inline-block text-sm text-accent hover:underline">
            Retour aux utilisateurs
          </Link>
        </div>
      </AdminShell>
    )
  }

  const { user, usage, workers, apiKeys, sessions } = detail
  return (
    <AdminShell
      title={user.email}
      subtitle={`Compte #${user.id} · ${user.isAdmin ? 'administrateur' : 'utilisateur'} · Google ${user.googleLinked ? 'lié' : 'non lié'}`}
      actions={
        <Link to="/admin/utilisateurs" className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface">
          ← Retour
        </Link>
      }
    >
      <div className="space-y-6">
        {creditHint ? (
          <div className="rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm text-success" role="status">
            {creditHint}
          </div>
        ) : null}
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {[
            ['Solde crédits', `${Number(user.balanceEuro || 0).toFixed(2)} €`],
            ['Requêtes API', fmt(usage.apiRequests)],
            ['Tokens API', fmt(usage.totalTokens)],
            ['Coût API', `${Number(usage.costEur || 0).toFixed(4)} €`],
            ['Sessions P2P', fmt(usage.sessionCount)],
            ['Tokens sessions', fmt(usage.sessionCompletionTokens)],
            ['TPS moyen', usage.avgSessionTps ? usage.avgSessionTps.toFixed(2) : '—'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-3xl border border-white/10 bg-card/80 p-4 shadow-sm backdrop-blur-xl">
              <p className="text-[11px] text-muted">{label}</p>
              <p className="mt-1 font-display text-xl font-bold text-fg">{value}</p>
            </div>
          ))}
        </section>

        <section className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
          <div className="rounded-3xl border border-border bg-card p-5 shadow-sm">
            <p className="mb-4 text-sm font-semibold text-fg">Identité</p>
            <dl className="space-y-2 text-[12px]">
              {[
                ['Email', user.email],
                ['ID', user.id],
                ['Solde crédits', `${Number(user.balanceEuro || 0).toFixed(2)} €`],
                ['Rôle', user.isAdmin ? 'Administrateur' : 'Utilisateur'],
                ['Google OAuth', user.googleLinked ? 'Oui' : 'Non'],
                ['Créé le', formatDate(user.createdAt)],
                ['Mis à jour', formatDate(user.updatedAt || null)],
                ['Dernière connexion', formatDate(user.lastLoginAt)],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-b border-border/50 py-2 last:border-0">
                  <dt className="text-muted">{label}</dt>
                  <dd className="max-w-[65%] break-all text-right text-fg">{value}</dd>
                </div>
              ))}
            </dl>
            <form onSubmit={addCredit} className="mt-5 rounded-2xl border border-border bg-surface/70 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Ajuster les crédits</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-[8rem_1fr]">
                <input
                  value={creditAmount}
                  onChange={(event) => setCreditAmount(event.target.value)}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                  inputMode="decimal"
                  aria-label="Montant en euros"
                />
                <input
                  value={creditDescription}
                  onChange={(event) => setCreditDescription(event.target.value)}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                  placeholder="Description"
                />
              </div>
              <button
                type="submit"
                disabled={creditLoading}
                className="mt-3 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creditLoading ? 'Enregistrement...' : 'Ajouter / retirer'}
              </button>
            </form>
          </div>

          <div className="rounded-3xl border border-border bg-card p-5 shadow-sm">
            <p className="mb-4 text-sm font-semibold text-fg">Clés API</p>
            <div className="space-y-2">
              {apiKeys.length === 0 ? (
                <p className="text-[12px] text-muted">Aucune clé API.</p>
              ) : apiKeys.map((key) => (
                <div key={key.id} className="rounded-2xl border border-border/70 bg-surface/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-fg">{key.name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${key.revokedAt ? 'bg-alert/10 text-alert' : 'bg-success/10 text-success'}`}>
                      {key.revokedAt ? 'révoquée' : 'active'}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-muted">{key.keyPrefix}</p>
                  <p className="mt-2 text-[11px] text-muted">
                    {fmt(key.requestCount)} req · {fmt(key.totalTokens)} tok · {Number(key.costEur || 0).toFixed(4)} €
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold text-fg">Workers liés ({workers.length})</p>
            <Link to="/admin/workers" className="text-[12px] text-accent hover:underline">Voir tous</Link>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {workers.length === 0 ? (
              <p className="text-[12px] text-muted">Aucun worker lié.</p>
            ) : workers.map((w) => (
              <Link key={w.peerId} to={`/admin/workers/${encodeURIComponent(w.peerId)}`} className="rounded-2xl border border-border/70 bg-surface/60 p-4 hover:border-accent/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[11px] font-semibold text-fg">{w.peerId}</p>
                    <p className="mt-1 text-[12px] text-muted">{w.gpuName || 'GPU inconnu'} · {fmtGb(w.allocatedVramMb || w.gpuVramMb)}</p>
                    <p className="mt-1 text-[11px] text-muted">{w.model || 'Modèle non déclaré'}</p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${w.online ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                    {w.online ? 'online' : 'offline'}
                  </span>
                </div>
                <p className="mt-3 text-[11px] text-muted">
                  {fmt(w.tokensGenerated)} tokens · état {w.desiredState || 'active'} · commande {w.lastCommandStatus || '—'}
                </p>
              </Link>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
          <p className="mb-4 text-sm font-semibold text-fg">Dernières sessions</p>
          <div className="space-y-2">
            {sessions.length === 0 ? (
              <p className="text-[12px] text-muted">Aucune session.</p>
            ) : sessions.map((session) => (
              <Link key={session.id} to={`/admin/sessions/${session.id}`} className="grid gap-2 rounded-2xl border border-border/70 bg-surface/60 p-3 text-[12px] hover:border-accent/40 sm:grid-cols-[1fr_120px_120px_150px]">
                <span className="font-mono text-fg">{session.id}</span>
                <span className="text-muted">{fmt(Number(session.metrics?.completionTokens || 0))} tokens</span>
                <span className="text-muted">{session.metrics?.hotPathTps ? `${Number(session.metrics.hotPathTps).toFixed(2)} TPS` : '—'}</span>
                <span className="text-right text-muted">{formatDate(session.createdAt)}</span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </AdminShell>
  )
}
