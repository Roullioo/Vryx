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
    <AdminShell>
      {error && (
        <div
          className="mb-6 rounded-lg border border-alert/50 bg-alert/10 px-4 py-3 text-sm text-alert"
          role="alert"
        >
          {error}
        </div>
      )}

      <section className="space-y-4">
        <h2 className="font-display text-xl font-bold text-fg">Site Vryx</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Utilisateurs totaux"
            value={site ? site.stats.totalUsers.toLocaleString('fr-FR') : '—'}
            hint={
              site ? `${site.stats.totalAdmins} administrateur(s)` : undefined
            }
          />
          <MetricCard
            label="Inscriptions (24 h)"
            value={site ? `+${site.stats.newUsers24h}` : '—'}
            hint={site ? `+${site.stats.newUsers7d} sur 7 j` : undefined}
            tone="success"
          />
          <MetricCard
            label="Connexions actives (24 h)"
            value={site ? site.stats.activeUsers24h.toLocaleString('fr-FR') : '—'}
            hint={site ? `${site.stats.activeUsers7d} sur 7 j` : undefined}
            tone="electric"
          />
          <MetricCard
            label="Workers détectés"
            value={node ? String(node.workers.length) : '—'}
            hint={
              node
                ? `${node.workers.filter((w) => w.status === 'online').length} en ligne`
                : undefined
            }
          />
        </div>

        <div className="panel p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg">Inscriptions sur 30 jours</h3>
            <Link to="/admin/utilisateurs" className="text-xs font-medium text-accent hover:underline">
              Gérer les utilisateurs →
            </Link>
          </div>
          <div className="mt-4 flex h-32 items-end gap-1">
            {site?.registrationsLast30d.length ? (
              site.registrationsLast30d.map((p) => {
                const h = Math.max(4, Math.round((p.count / maxReg) * 120))
                return (
                  <div
                    key={p.day}
                    className="group relative flex-1"
                    title={`${p.day} · ${p.count} inscription(s)`}
                  >
                    <div
                      className="w-full rounded-sm bg-fg/80 transition-colors group-hover:bg-electric"
                      style={{ height: `${h}px` }}
                    />
                  </div>
                )
              })
            ) : (
              <p className="text-xs text-muted">Aucune inscription sur la période.</p>
            )}
          </div>
        </div>
      </section>

      <section className="mt-10 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-bold text-fg">Nœud Vryx</h2>
          <Link to="/admin/noeud" className="text-xs font-medium text-accent hover:underline">
            Tableau de bord nœud →
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="CPU"
            value={node ? `${node.system.cpu.usagePercent} %` : '—'}
            hint={node ? `${node.system.cpu.cores} cœurs · ${node.system.cpu.model}` : undefined}
            tone={
              node && node.system.cpu.usagePercent > 80 ? 'warning' : 'default'
            }
          />
          <MetricCard
            label="Mémoire"
            value={
              node
                ? `${Math.round(node.system.memory.usedMB / 1024)} / ${Math.round(node.system.memory.totalMB / 1024)} Go`
                : '—'
            }
            hint={node ? `${node.system.memory.percent} %` : undefined}
            tone={node && node.system.memory.percent > 85 ? 'warning' : 'default'}
          />
          <MetricCard
            label="VRAM totale"
            value={node ? `${Math.round(node.system.vram.totalMB / 1024)} Go` : '—'}
            hint={node ? `${node.system.vram.count} GPU(s)` : undefined}
          />
          <MetricCard
            label="Requêtes traitées"
            value={node ? node.cumulativeRequests.toLocaleString('fr-FR') : '—'}
            hint="depuis le démarrage de l'API"
            tone="electric"
          />
        </div>
      </section>
    </AdminShell>
  )
}
