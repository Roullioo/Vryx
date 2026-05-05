import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminShell } from '../components/admin/AdminShell'
import { apiJson } from '../lib/api'

type SiteStats = {
  stats: {
    totalUsers: number
    totalAdmins: number
    newUsers24h: number
    newUsers7d: number
    activeUsers24h: number
    activeUsers7d: number
  }
  registrationsLast30d: { day: string; count: number }[]
}

type NodeStatus = {
  sampledAt: number
  cumulativeRequests: number
  system: {
    hostname: string
    platform: string
    cpu: { model: string; cores: number; usagePercent: number; loadAvg: number[] }
    memory: { totalMB: number; usedMB: number; percent: number }
    vram: { totalMB: number; count: number }
    gpus: { name: string; vendor: string; vramTotalMB: number }[]
  }
  workers: { pid: number; mode: string; status: string; lastLatencyMs: number | null }[]
}

function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'success' | 'electric' | 'warning'
}) {
  const colorClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'electric'
        ? 'text-electric'
        : tone === 'warning'
          ? 'text-warning'
          : 'text-fg'
  return (
    <div className="panel p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 font-display text-2xl font-bold ${colorClass}`}>{value}</p>
      {hint ? <p className="mt-2 text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

export function AdminOverviewPage() {
  const [site, setSite] = useState<SiteStats | null>(null)
  const [node, setNode] = useState<NodeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [s, n] = await Promise.all([
        apiJson<SiteStats>('/api/admin/site/stats'),
        apiJson<NodeStatus>('/api/admin/node/status'),
      ])
      if (cancelled) return
      if (s.ok) setSite(s.data)
      else setError(s.error)
      if (n.ok) setNode(n.data)
    }
    void load()
    const id = window.setInterval(load, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const maxReg = useMemo(() => {
    if (!site) return 1
    return Math.max(1, ...site.registrationsLast30d.map((p) => p.count))
  }, [site])

  return (
    <AdminShell title="Vue d'ensemble" subtitle="Supervision Vryx en temps réel">
      {error && (
        <div className="mb-5 rounded-xl border border-alert/40 bg-alert/8 px-4 py-3 text-sm text-alert" role="alert">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {/* Métriques site */}
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Site</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Utilisateurs totaux" value={site ? site.stats.totalUsers.toLocaleString('fr-FR') : '—'} hint={site ? `${site.stats.totalAdmins} admin(s)` : undefined} />
            <MetricCard label="Inscriptions 24 h" value={site ? `+${site.stats.newUsers24h}` : '—'} hint={site ? `+${site.stats.newUsers7d} sur 7 j` : undefined} tone="success" />
            <MetricCard label="Connexions 24 h" value={site ? site.stats.activeUsers24h.toLocaleString('fr-FR') : '—'} hint={site ? `${site.stats.activeUsers7d} sur 7 j` : undefined} tone="electric" />
            <MetricCard label="Workers (gRPC)" value={node ? String(node.workers.length) : '—'} hint={node ? `${node.workers.filter((w) => w.status === 'online').length} en ligne` : undefined} />
          </div>
        </section>

        {/* Graphe inscriptions */}
        <section className="rounded-2xl border border-border bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg">Inscriptions — 30 jours</h3>
            <Link to="/admin/utilisateurs" className="text-xs font-medium text-accent hover:underline">Gérer →</Link>
          </div>
          <div className="mt-4 flex h-28 items-end gap-1">
            {site?.registrationsLast30d.length ? (
              site.registrationsLast30d.map((p) => {
                const h = Math.max(4, Math.round((p.count / maxReg) * 108))
                return (
                  <div key={p.day} className="group relative flex-1" title={`${p.day} · ${p.count}`}>
                    <div className="w-full rounded-sm bg-fg/80 transition-colors group-hover:bg-accent" style={{ height: `${h}px` }} />
                  </div>
                )
              })
            ) : (
              <p className="text-xs text-muted">Aucune inscription sur la période.</p>
            )}
          </div>
        </section>

        {/* Métriques nœud */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Nœud Vryx</h2>
            <Link to="/admin/noeud" className="text-xs font-medium text-accent hover:underline">Tableau de bord →</Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="CPU" value={node ? `${node.system.cpu.usagePercent} %` : '—'} hint={node ? `${node.system.cpu.cores} cœurs` : undefined} tone={node && node.system.cpu.usagePercent > 80 ? 'warning' : 'default'} />
            <MetricCard label="Mémoire" value={node ? `${Math.round(node.system.memory.usedMB / 1024)} / ${Math.round(node.system.memory.totalMB / 1024)} Go` : '—'} hint={node ? `${node.system.memory.percent} %` : undefined} tone={node && node.system.memory.percent > 85 ? 'warning' : 'default'} />
            <MetricCard label="VRAM" value={node ? `${Math.round(node.system.vram.totalMB / 1024)} Go` : '—'} hint={node ? `${node.system.vram.count} GPU(s)` : undefined} />
            <MetricCard label="Requêtes traitées" value={node ? node.cumulativeRequests.toLocaleString('fr-FR') : '—'} hint="depuis le démarrage" tone="electric" />
          </div>
        </section>

        {/* Raccourcis */}
        <section className="grid gap-3 sm:grid-cols-3">
          {[
            { to: '/admin/workers', label: 'Workers', desc: 'Liste et détail de chaque nœud' },
            { to: '/admin/sessions', label: 'Sessions', desc: 'Historique des traitements P2P' },
            { to: '/admin/noeud', label: 'Chat P2P', desc: 'Tester le réseau en direct' },
          ].map((l) => (
            <Link key={l.to} to={l.to} className="rounded-2xl border border-border bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
              <p className="font-semibold text-fg">{l.label}</p>
              <p className="mt-1 text-xs text-muted">{l.desc}</p>
            </Link>
          ))}
        </section>
      </div>
    </AdminShell>
  )
}
