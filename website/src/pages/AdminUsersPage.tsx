import { useCallback, useEffect, useState } from 'react'
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
                  <td className="px-5 py-6 text-muted" colSpan={5}>
                    Chargement…
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td className="px-5 py-6 text-muted" colSpan={5}>
                    Aucun utilisateur trouvé.
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const isMe = me?.id === u.id
                  return (
                    <tr key={u.id} className="border-b border-border/70 hover:bg-surface/40">
                      <td className="px-4 py-3 pl-5">
                        <div className="font-medium text-fg">{u.email}</div>
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
