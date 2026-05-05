import { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { AdminShell } from '../components/admin/AdminShell'
import { apiJson } from '../lib/api'

type RegisteredWorker = {
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
  model: string | null
  ownerEmail: string | null
  lastHeartbeatAt: string | null
  firstSeenAt: string | null
  online: boolean
  secondsSinceHeartbeat: number
}

function fmt(n: number) {
  return n.toLocaleString('fr-FR')
}

function timeAgo(sec: number) {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}min`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}j`
}

function truncate(s: string, n = 16) {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${online ? 'bg-success' : 'bg-warning'}`} />
  )
}

function WorkerCard({ w }: { w: RegisteredWorker }) {
  const pct = w.tokensIn + w.tokensOut > 0
    ? Math.round((w.tokensOut / Math.max(1, w.tokensIn + w.tokensOut)) * 100)
    : 0

  return (
    <Link
      to={`/admin/workers/${encodeURIComponent(w.peerId)}`}
      className="block rounded-2xl border border-border bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot online={w.online} />
            <span className="font-mono text-[11px] font-semibold text-fg">{truncate(w.peerId, 20)}</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            {w.publicIp ?? '—'} · {w.model ?? 'Modèle inconnu'}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase ${
          w.online ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
        }`}>
          {w.online ? 'En ligne' : `il y a ${timeAgo(w.secondsSinceHeartbeat)}`}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border/50 pt-4">
        <div>
          <p className="text-[10px] text-muted">Tokens générés</p>
          <p className="font-display text-sm font-bold text-fg">{fmt(w.tokensGenerated)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted">In / Out</p>
          <p className="font-display text-sm font-bold text-fg">{fmt(w.tokensIn)} / {fmt(w.tokensOut)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted">Mode</p>
          <p className="font-display text-sm font-bold text-fg capitalize">{w.mode}</p>
        </div>
      </div>

      {/* Barre tokens out / total */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-[10px] text-muted">
          <span>Ratio sortie</span>
          <span>{pct}%</span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-border/50">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-muted">
        {w.grpcPort && <span>gRPC {w.grpcPort}</span>}
        {w.p2pPort && <span>P2P {w.p2pPort}</span>}
        {w.ownerEmail && <span>Propriétaire : {w.ownerEmail}</span>}
        {w.firstSeenAt && <span>Vu le {new Date(w.firstSeenAt).toLocaleDateString('fr-FR')}</span>}
      </div>
    </Link>
  )
}

/* ─── Page liste ─────────────────────────────────────────────────────────── */
export function AdminWorkersPage() {
  const [workers, setWorkers] = useState<RegisteredWorker[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const r = await apiJson<{ workers: RegisteredWorker[] }>('/api/admin/workers/registered')
    if (r.ok) setWorkers(r.data.workers)
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const id = setInterval(refresh, 10_000)
    return () => clearInterval(id)
  }, [refresh])

  const online = workers.filter((w) => w.online)
  const offline = workers.filter((w) => !w.online)
  const totalTokens = workers.reduce((s, w) => s + w.tokensGenerated, 0)

  return (
    <AdminShell
      title="Workers"
      subtitle={`${workers.length} nœud${workers.length > 1 ? 's' : ''} enregistré${workers.length > 1 ? 's' : ''} · ${online.length} en ligne`}
      actions={
        <button
          onClick={refresh}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
            <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Rafraîchir
        </button>
      }
    >
      {/* Stats rapides */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Total workers', value: String(workers.length) },
          { label: 'En ligne', value: String(online.length), accent: true },
          { label: 'Hors ligne', value: String(offline.length) },
          { label: 'Tokens générés', value: fmt(totalTokens) },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-white p-4 shadow-sm">
            <p className="text-xs text-muted">{s.label}</p>
            <p className={`mt-1 font-display text-2xl font-bold ${s.accent ? 'text-success' : 'text-fg'}`}>
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-2xl border border-border bg-white" />
          ))}
        </div>
      ) : workers.length === 0 ? (
        <div className="rounded-2xl border border-border bg-white p-12 text-center">
          <p className="text-sm text-muted">Aucun worker enregistré.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {online.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">En ligne ({online.length})</h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {online.map((w) => <WorkerCard key={w.peerId} w={w} />)}
              </div>
            </section>
          )}
          {offline.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Hors ligne ({offline.length})</h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {offline.map((w) => <WorkerCard key={w.peerId} w={w} />)}
              </div>
            </section>
          )}
        </div>
      )}
    </AdminShell>
  )
}

/* ─── Page détail worker ─────────────────────────────────────────────────── */
export function AdminWorkerDetailPage() {
  const { peerId } = useParams<{ peerId: string }>()
  const [worker, setWorker] = useState<RegisteredWorker | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!peerId) return
    const id = decodeURIComponent(peerId)
    apiJson<{ workers: RegisteredWorker[] }>('/api/admin/workers/registered').then((r) => {
      if (r.ok) {
        const found = r.data.workers.find((w) => w.peerId === id) ?? null
        setWorker(found)
      }
      setLoading(false)
    })
  }, [peerId])

  if (loading) return (
    <AdminShell title="Détail worker">
      <div className="space-y-4">
        {[1,2,3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl border border-border bg-white" />)}
      </div>
    </AdminShell>
  )

  if (!worker) return (
    <AdminShell title="Détail worker">
      <div className="rounded-2xl border border-border bg-white p-12 text-center">
        <p className="text-sm text-muted">Worker introuvable.</p>
        <Link to="/admin/workers" className="mt-3 inline-block text-sm text-accent hover:underline">
          Retour à la liste
        </Link>
      </div>
    </AdminShell>
  )

  const statRows = [
    { label: 'Peer ID', value: worker.peerId, mono: true },
    { label: 'IP publique', value: worker.publicIp ?? '—' },
    { label: 'Port gRPC', value: String(worker.grpcPort ?? '—') },
    { label: 'Port P2P', value: String(worker.p2pPort ?? '—') },
    { label: 'Mode', value: worker.mode },
    { label: 'Modèle', value: worker.model ?? '—' },
    { label: 'Version', value: worker.version ?? '—' },
    { label: 'Propriétaire', value: worker.ownerEmail ?? 'Non lié' },
    { label: 'Premier contact', value: worker.firstSeenAt ? new Date(worker.firstSeenAt).toLocaleString('fr-FR') : '—' },
    { label: 'Dernier heartbeat', value: worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).toLocaleString('fr-FR') : '—' },
    { label: 'Pairs P2P vus', value: String(worker.p2pPeers) },
  ]

  const tokenTotal = worker.tokensIn + worker.tokensOut
  const pctOut = tokenTotal > 0 ? Math.round((worker.tokensOut / tokenTotal) * 100) : 0

  return (
    <AdminShell
      title={`Worker · ${worker.peerId.slice(0, 20)}…`}
      subtitle={`${worker.online ? 'En ligne' : `Hors ligne depuis ${timeAgo(worker.secondsSinceHeartbeat)}`} · ${worker.publicIp ?? '—'}`}
      actions={
        <Link to="/admin/workers" className="rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface">
          ← Retour
        </Link>
      }
    >
      <div className="space-y-5">
        {/* Status + tokens */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Statut', value: worker.online ? 'En ligne' : 'Hors ligne', ok: worker.online },
            { label: 'Tokens générés', value: fmt(worker.tokensGenerated) },
            { label: 'Tokens in', value: fmt(worker.tokensIn) },
            { label: 'Tokens out', value: fmt(worker.tokensOut) },
          ].map((s) => (
            <div key={s.label} className="rounded-2xl border border-border bg-white p-4 shadow-sm">
              <p className="text-xs text-muted">{s.label}</p>
              <p className={`mt-1 font-display text-xl font-bold ${s.ok === false ? 'text-warning' : s.ok === true ? 'text-success' : 'text-fg'}`}>
                {s.value}
              </p>
            </div>
          ))}
        </div>

        {/* Ratio tokens */}
        <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
          <p className="mb-3 text-sm font-semibold text-fg">Répartition tokens</p>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-[11px] text-muted">
                <span>Tokens entrants (prompt)</span>
                <span className="font-mono">{fmt(worker.tokensIn)}</span>
              </div>
              <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-border/40">
                <div className="h-full rounded-full bg-accent/70" style={{ width: `${100 - pctOut}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-[11px] text-muted">
                <span>Tokens sortants (complétion)</span>
                <span className="font-mono">{fmt(worker.tokensOut)}</span>
              </div>
              <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-border/40">
                <div className="h-full rounded-full bg-success/70" style={{ width: `${pctOut}%` }} />
              </div>
            </div>
          </div>
        </div>

        {/* Infos techniques */}
        <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
          <p className="mb-3 text-sm font-semibold text-fg">Informations techniques</p>
          <dl className="space-y-2">
            {statRows.map((r) => (
              <div key={r.label} className="flex items-start justify-between gap-4 border-b border-border/40 py-2 text-[12px] last:border-0">
                <dt className="text-muted">{r.label}</dt>
                <dd className={`max-w-[60%] break-all text-right ${r.mono ? 'font-mono text-[10px]' : ''} text-fg`}>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Note sessions */}
        <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-fg">Sessions associées</p>
          <p className="mt-2 text-[12px] text-muted">
            Les sessions enregistrées impliquant ce worker sont visibles sur la page{' '}
            <Link to="/admin/sessions" className="text-accent hover:underline">Sessions</Link>.
          </p>
        </div>
      </div>
    </AdminShell>
  )
}
