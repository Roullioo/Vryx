import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { AdminShell } from '../components/admin/AdminShell'
import type { PoolGraphLink, PoolGraphNode } from '../components/admin/PoolNetworkGraph'
import { apiJson, apiUrl } from '../lib/api'

const PoolNetworkGraph = lazy(() =>
  import('../components/admin/PoolNetworkGraph').then((m) => ({ default: m.PoolNetworkGraph })),
)

type RegisteredWorker = {
  peerId: string
  mode: string
  grpcPort: number | null
  p2pPort: number | null
  publicIp: string | null
  version: string | null
  p2pPeers: number
  tokensGenerated: number
  tokensGenerated1h?: number
  tokensGenerated24h?: number
  tokensIn: number
  tokensOut: number
  model: string | null
  ownerEmail: string | null
  lastHeartbeatAt: string | null
  firstSeenAt: string | null
  online: boolean
  secondsSinceHeartbeat: number
  gpuName?: string | null
  gpuVramMb?: number | null
  runtimeBackend?: string | null
  weightQuantization?: string | null
  supportsQ4Weights?: boolean
  supportsMlx?: boolean
  supportsVllm?: boolean
  allocatedVramMb?: number | null
  memoryLimitPercent?: number | null
  desiredState?: 'active' | 'paused' | 'draining' | 'stopped'
  desiredModel?: string | null
  desiredAllocatedVramMb?: number | null
  desiredMemoryLimitPercent?: number | null
  lastCommandAt?: string | null
  lastCommandStatus?: string | null
  lastCommandError?: string | null
  healthScore?: number
  healthState?: string
  healthReasons?: string[]
  runtimeState?: 'idle' | 'reserved' | 'running' | 'cooldown' | 'failed'
  reservedUntil?: string | null
  currentJobId?: string | null
  capabilities?: Record<string, unknown> | null
  machineInfo?: {
    platform?: string
    arch?: string
    os?: string
    cpu?: string
    gpuName?: string
    gpuVendor?: string
    controllers?: Array<{ model?: string; vendor?: string; vramMb?: number; bus?: string }>
    unifiedMemory?: boolean
    totalMemoryGb?: number
    availableMemoryGb?: number
    vramGb?: number
    backendCandidates?: string[]
  } | null
}

type WorkerCommand = {
  id: string
  action: string
  status: string
  error?: string | null
  createdAt: string | null
  deliveredAt?: string | null
  acknowledgedAt?: string | null
  expiresAt?: string | null
  supersededBy?: string | null
  requestedByEmail?: string | null
  payload?: {
    model?: string | null
    loadMode?: 'auto' | 'full' | 'shard' | null
    quantization?: string | null
    allocatedVramMb?: number | null
    memoryPercent?: number | null
  }
}

type WorkerRelease = {
  version: string
  channel: string
  macUrl?: string | null
  winX64Url?: string | null
  winArm64Url?: string | null
  runtimeUrl?: string | null
  mandatory?: boolean
  notes?: string | null
}

type AvailableModel = {
  id: string
  label?: string
  family?: string
  source?: string
  workersOnline?: number
  workersTotal?: number
  requiredWorkers?: number
  runnable?: boolean
  ready?: boolean
  local?: boolean
  recommendedMemoryGb?: number
  minMemoryGb?: number
  effectiveModelGb?: number
  totalLayers?: number
  supportedExecutionModes?: Array<'auto' | 'full' | 'shard'>
  executionModes?: Array<{
    id: 'full' | 'shard'
    label: string
    description?: string
    requiredWorkers?: number
    minMemoryGb?: number
    recommendedMemoryGb?: number
  }>
}

type ModelPlan = {
  model: string
  label: string
  mode: 'auto' | 'full' | 'shard'
  ready: boolean
  requiredWorkers: number
  availableWorkers: number
  totalLayers: number
  effectiveModelGb: number
  recommendedMemoryGb?: number | null
  blockers?: string[]
  assignments: Array<{
    peerId: string
    healthScore: number
    gpuName?: string | null
    allocatedVramMb?: number | null
    layerStart: number
    layerEnd: number
    layerCount: number
    role: string
  }>
}

type PoolStreamPayload = {
  ok: boolean
  pipelineActive?: boolean
  nodes?: PoolGraphNode[]
  links?: PoolGraphLink[]
  registeredWorkers?: RegisteredWorker[]
  streamEvent?: string
  error?: string
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

function fmtVramMb(mb: number | null | undefined, runtime?: string | null) {
  if (mb == null || mb <= 0) return null
  const gb = mb / 1024
  const rounded = Math.round(gb * 10) / 10
  const mlx = String(runtime || '').toLowerCase().includes('mlx')
  if (mlx) return `${rounded} Go (unifiée, indicative)`
  if (mb >= 1024) return `${rounded} Go`
  return `${Math.round(mb)} Mo`
}

function memoryProfile(worker: RegisteredWorker | null) {
  const maxMb = Number(worker?.gpuVramMb || 0)
  const allocatedMb = Number(worker?.desiredAllocatedVramMb || worker?.allocatedVramMb || 0)
  const unified =
    Boolean(worker?.machineInfo?.unifiedMemory) ||
    String(worker?.runtimeBackend || '').toLowerCase().includes('mlx') ||
    String(worker?.gpuName || '').toLowerCase().includes('apple')
  const reserveGb = unified ? 6 : 1
  const maxSafeMb = maxMb > 0 ? Math.max(1024, maxMb - reserveGb * 1024) : 0
  const recommendedMb = maxMb > 0
    ? Math.round(Math.min(maxSafeMb, maxMb * (unified ? 0.72 : 0.88)))
    : allocatedMb
  const currentPercent = Number(worker?.desiredMemoryLimitPercent || worker?.memoryLimitPercent || 0)
  return {
    maxMb,
    maxSafeMb,
    recommendedMb,
    currentMb: allocatedMb,
    currentPercent,
    unified,
  }
}

function memoryOptions(worker: RegisteredWorker | null) {
  const p = memoryProfile(worker)
  const base = [
    { key: 'recommended', label: `Conseillé · ${fmtVramMb(p.recommendedMb, worker?.runtimeBackend) || 'auto'}`, mb: p.recommendedMb, pct: p.maxMb ? Math.round((p.recommendedMb / p.maxMb) * 100) : 70 },
    { key: 'balanced', label: 'Équilibré · 70%', mb: p.maxMb ? Math.round(p.maxMb * 0.7) : 0, pct: 70 },
    { key: 'performance', label: 'Performance · 85%', mb: p.maxMb ? Math.round(p.maxMb * 0.85) : 0, pct: 85 },
    { key: 'max-safe', label: `Max conseillé · ${fmtVramMb(p.maxSafeMb, worker?.runtimeBackend) || 'auto'}`, mb: p.maxSafeMb, pct: p.maxMb ? Math.round((p.maxSafeMb / p.maxMb) * 100) : 90 },
  ]
  if (p.currentMb > 0) {
    base.unshift({
      key: 'current',
      label: `Actuel · ${fmtVramMb(p.currentMb, worker?.runtimeBackend)}${p.currentPercent ? ` · ${p.currentPercent}%` : ''}`,
      mb: p.currentMb,
      pct: p.currentPercent || (p.maxMb ? Math.round((p.currentMb / p.maxMb) * 100) : 0),
    })
  }
  const seen = new Set<string>()
  return base
    .filter((x) => x.mb > 0 || x.pct > 0)
    .map((x) => ({ ...x, mb: p.maxMb > 0 ? Math.min(x.mb, p.maxMb) : x.mb }))
    .filter((x) => {
      const key = `${x.mb}:${x.pct}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function truncate(s: string, n = 16) {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${online ? 'bg-success' : 'bg-warning'}`} />
  )
}

function WorkerApplicationDownloads() {
  const builds = [
    {
      name: 'macOS',
      detail: 'ZIP avec app + installateur Gatekeeper pour Apple Silicon / Intel',
      href: '/downloads/Vryx-Worker-mac-20260518.zip',
      cta: 'Télécharger Mac',
    },
    {
      name: 'Windows',
      detail: 'Installeur Windows x64. Signature Authenticode requise pour Smart App Control.',
      href: '/downloads/Vryx-Worker-Setup-x64.exe',
      cta: 'Télécharger Windows x64',
    },
    {
      name: 'Windows ARM64',
      detail: 'Installeur Windows ARM64. Signature Authenticode requise pour Smart App Control.',
      href: '/downloads/Vryx-Worker-Setup-arm64.exe',
      cta: 'Télécharger ARM64',
    },
  ]
  return (
    <section className="mb-8 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-bold text-fg">Application worker avancée</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Builds desktop pour configurer GPU, mémoire allouée, modèle, backend, shard et logs worker.
          </p>
        </div>
        <span className="rounded-full bg-accent/10 px-3 py-1 text-[11px] font-semibold uppercase text-accent">
          Admin preview
        </span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {builds.map((b) => (
          <a
            key={b.name}
            href={b.href}
            className="rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent/60"
          >
            <p className="font-display text-base font-bold text-fg">{b.name}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{b.detail}</p>
            <span className="mt-3 inline-flex rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white">
              {b.cta}
            </span>
          </a>
        ))}
      </div>
      <p className="mt-4 rounded-xl border border-warning/25 bg-warning/10 px-4 py-3 text-xs leading-5 text-warning">
        Windows Smart App Control bloque les builds non signés. Pour une distribution publique,
        publier uniquement un installateur généré avec <span className="font-mono">npm run build:win:signed</span>.
      </p>
    </section>
  )
}

function WorkerReleasePanel() {
  const [release, setRelease] = useState<WorkerRelease | null>(null)
  const [version, setVersion] = useState('')
  const [notes, setNotes] = useState('')
  const [mandatory, setMandatory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const loadRelease = useCallback(async () => {
    const r = await apiJson<{ release: WorkerRelease }>('/api/worker/releases/current')
    if (r.ok) {
      setRelease(r.data.release)
      setVersion(r.data.release.version || '')
      setNotes(r.data.release.notes || '')
      setMandatory(!!r.data.release.mandatory)
    }
  }, [])

  useEffect(() => {
    void loadRelease()
  }, [loadRelease])

  async function publishRelease() {
    const nextVersion = version.trim()
    if (!nextVersion) {
      setMsg('Version requise.')
      return
    }
    setBusy(true)
    setMsg(null)
    const r = await apiJson<{ release: WorkerRelease }>('/api/admin/worker/releases', {
      method: 'POST',
      body: JSON.stringify({
        version: nextVersion,
        channel: 'stable',
        macUrl: release?.macUrl || '/downloads/Vryx-Worker-mac-20260518.zip',
        winX64Url: release?.winX64Url || '/downloads/Vryx-Worker-Setup-x64.exe',
        winArm64Url: release?.winArm64Url || '/downloads/Vryx-Worker-Setup-arm64.exe',
        runtimeUrl: release?.runtimeUrl || null,
        mandatory,
        notes: notes.trim() || null,
      }),
    })
    setBusy(false)
    if (!r.ok) {
      setMsg(r.error)
      return
    }
    setMsg('Release publiée. Les workers obsolètes recevront une commande au prochain heartbeat.')
    await loadRelease()
  }

  return (
    <section className="mb-8 rounded-3xl border border-white/10 bg-card/80 p-4 shadow-[0_24px_80px_-56px_rgba(34,211,238,.9)] backdrop-blur-xl sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-bold text-fg">Canal de mise à jour workers</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Version stable publiée côté VPS. Les workers en ligne trop anciens reçoivent automatiquement
            une commande <span className="font-mono">update_software</span>; les workers redémarrés vérifient aussi ce manifeste.
          </p>
        </div>
        <span className="rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-[11px] font-bold text-accent">
          {release?.version ? `stable · ${release.version}` : 'stable'}
        </span>
      </div>

      {msg && (
        <div className="mt-4 rounded-xl border border-electric/25 bg-electric/10 px-4 py-3 text-[12px] text-electric">
          {msg}
        </div>
      )}

      <div className="mt-5 grid gap-3 lg:grid-cols-[180px_1fr_auto_auto]">
        <input
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="Version"
          className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes internes de release"
          className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
        <label className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-xs font-semibold text-fg">
          <input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />
          Obligatoire
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void publishRelease()}
          className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white shadow-[0_16px_50px_-28px_rgba(34,211,238,.9)] disabled:opacity-50"
        >
          {busy ? 'Publication…' : 'Publier'}
        </button>
      </div>
    </section>
  )
}

function WorkerCard({ w, pingMs }: { w: RegisteredWorker; pingMs?: number | null }) {
  const pct = w.tokensIn + w.tokensOut > 0
    ? Math.round((w.tokensOut / Math.max(1, w.tokensIn + w.tokensOut)) * 100)
    : 0
  const vramLabel = fmtVramMb(w.allocatedVramMb ?? w.gpuVramMb, w.runtimeBackend)
  const mem = memoryProfile(w)
  const t1h = Number(w.tokensGenerated1h ?? 0)
  const t24h = Number(w.tokensGenerated24h ?? 0)
  const cpu = w.machineInfo?.cpu
  const os = w.machineInfo?.os

  return (
    <Link
      to={`/admin/workers/${encodeURIComponent(w.peerId)}`}
      className="block rounded-2xl border border-border bg-card p-5 shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot online={w.online} />
            <span className="font-mono text-[11px] font-semibold text-fg">{truncate(w.peerId, 20)}</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            {w.publicIp ?? '—'}
            {w.gpuName ? ` · ${w.gpuName}` : ''}
            {vramLabel ? ` · ${vramLabel}` : ''}
          </p>
          {(cpu || os) && (
            <p className="mt-0.5 truncate text-[10px] text-muted" title={[cpu, os].filter(Boolean).join(' · ')}>
              {[cpu, os].filter(Boolean).join(' · ')}
            </p>
          )}
          <p className="mt-0.5 text-[11px] font-medium text-fg">
            {w.model?.trim() ? w.model : 'Modèle non déclaré'}
          </p>
          {w.runtimeBackend && (
            <p className="mt-0.5 text-[10px] text-muted">
              Runtime <span className="font-mono text-fg">{w.runtimeBackend}</span>
              {w.weightQuantization ? ` · quant. ${w.weightQuantization}` : ''}
            </p>
          )}
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase ${
          !w.online ? 'bg-warning/10 text-warning' : w.desiredState && w.desiredState !== 'active' ? 'bg-electric/10 text-electric' : 'bg-success/10 text-success'
        }`}>
          {!w.online ? `il y a ${timeAgo(w.secondsSinceHeartbeat)}` : w.desiredState && w.desiredState !== 'active' ? w.desiredState : 'En ligne'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border/50 pt-4 sm:grid-cols-3">
        <div>
          <p className="text-[10px] text-muted">Tokens (total)</p>
          <p className="font-display text-sm font-bold text-fg">{fmt(w.tokensGenerated)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted">Tokens (1 h)</p>
          <p className="font-display text-sm font-bold text-fg">{fmt(t1h)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted">Tokens (24 h)</p>
          <p className="font-display text-sm font-bold text-fg">{fmt(t24h)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted">Ping live</p>
          <p className={`font-display text-sm font-bold ${pingMs != null ? 'text-success' : 'text-muted'}`}>
            {pingMs != null ? `${pingMs} ms` : '—'}
          </p>
        </div>
        <div className="sm:col-span-2">
          <p className="text-[10px] text-muted">Mémoire max / conseillé</p>
          <p className="font-display text-sm font-bold text-fg">
            {fmtVramMb(mem.maxMb, w.runtimeBackend) || '—'} / {fmtVramMb(mem.recommendedMb, w.runtimeBackend) || '—'}
          </p>
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
        {w.lastCommandStatus && <span>Commande : {w.lastCommandStatus}</span>}
        {w.runtimeState && <span>Runtime : {w.runtimeState}</span>}
        {typeof w.healthScore === 'number' && <span>Santé : {w.healthScore}/100</span>}
        {w.firstSeenAt && <span>Vu le {new Date(w.firstSeenAt).toLocaleDateString('fr-FR')}</span>}
      </div>
    </Link>
  )
}

/* ─── Page liste ─────────────────────────────────────────────────────────── */
export function AdminWorkersPage() {
  const [workers, setWorkers] = useState<RegisteredWorker[]>([])
  const [loading, setLoading] = useState(true)
  const [graphNodes, setGraphNodes] = useState<PoolGraphNode[]>([])
  const [graphLinks, setGraphLinks] = useState<PoolGraphLink[]>([])
  const [pipelineActive, setPipelineActive] = useState(false)
  const [streamLabel, setStreamLabel] = useState<string>('Connexion SSE…')
  const [pingByPeer, setPingByPeer] = useState<Record<string, number | null>>({})

  const refresh = useCallback(async () => {
    const r = await apiJson<{ workers: RegisteredWorker[] }>('/api/admin/workers/registered')
    if (r.ok === true) setWorkers(r.data.workers)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const url = apiUrl('/api/admin/pool/stream')
    const es = new EventSource(url)
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as PoolStreamPayload
        if (data.ok && Array.isArray(data.registeredWorkers)) {
          setWorkers(data.registeredWorkers)
          setLoading(false)
        }
        if (data.ok && Array.isArray(data.nodes) && Array.isArray(data.links)) {
          setGraphNodes(data.nodes)
          setGraphLinks(data.links)
          setPipelineActive(!!data.pipelineActive)
        }
        if (data.streamEvent) setStreamLabel(`SSE · ${data.streamEvent}`)
      } catch {
        /* ignore */
      }
    }
    es.onerror = () => {
      setStreamLabel('SSE interrompu — les données peuvent être obsolètes.')
    }
    return () => es.close()
  }, [])

  useEffect(() => {
    const onlinePeers = workers.filter((w) => w.online).slice(0, 8).map((w) => w.peerId)
    if (onlinePeers.length === 0) {
      setPingByPeer({})
      return
    }
    let cancelled = false
    const run = async () => {
      for (const peer of onlinePeers) {
        const r = await apiJson<{ ok?: boolean; latencyMs?: number }>(`/api/admin/workers/${encodeURIComponent(peer)}/ping`)
        if (cancelled) return
        setPingByPeer((prev) => ({
          ...prev,
          [peer]: r.ok && r.data?.ok === true && typeof r.data.latencyMs === 'number' ? r.data.latencyMs : null,
        }))
      }
    }
    void run()
    const iv = window.setInterval(() => void run(), 15000)
    return () => {
      cancelled = true
      window.clearInterval(iv)
    }
  }, [workers.map((w) => `${w.peerId}:${w.online}`).join('|')])

  const online = workers.filter((w) => w.online)
  const totalTokens = workers.reduce((s, w) => s + w.tokensGenerated, 0)
  const totalTokens1h = workers.reduce((s, w) => s + Number(w.tokensGenerated1h ?? 0), 0)
  const totalTokens24h = workers.reduce((s, w) => s + Number(w.tokensGenerated24h ?? 0), 0)

  return (
    <AdminShell
      title="Workers"
      subtitle={`${online.length} en ligne · ${workers.length} enregistré${workers.length > 1 ? 's' : ''}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden max-w-[200px] truncate text-[10px] text-muted sm:inline" title={streamLabel}>
            {streamLabel}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
              <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Rafraîchir la liste
          </button>
        </div>
      }
    >
      <WorkerReleasePanel />
      <WorkerApplicationDownloads />

      {/* Nerve Center — graphe temps réel (SSE uniquement, pas de polling) */}
      <section className="mb-8 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
        <Suspense
          fallback={
            <div className="flex min-h-[280px] items-center justify-center rounded-xl border border-border/50 bg-surface/50 text-[12px] text-muted">
              Chargement du graphe…
            </div>
          }
        >
          <PoolNetworkGraph nodes={graphNodes} links={graphLinks} pipelineActive={pipelineActive} />
        </Suspense>
        {graphNodes.length === 0 && (
          <p className="mt-3 text-center text-[12px] text-muted">
            En attente du flux pool… Les workers apparaîtront ici avec la VRAM relative et la chaîne de relais.
          </p>
        )}
      </section>

      {/* Stats rapides */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[
          { label: 'Enregistrés', value: String(workers.length) },
          { label: 'En ligne', value: String(online.length), accent: true },
          { label: 'Tokens (total cumulé)', value: fmt(totalTokens) },
          { label: 'Tokens (24 h, réseau)', value: fmt(totalTokens24h) },
          { label: 'Tokens (1 h, réseau)', value: fmt(totalTokens1h) },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <p className="text-xs text-muted">{s.label}</p>
            <p className={`mt-1 font-display text-xl font-bold sm:text-2xl ${s.accent ? 'text-success' : 'text-fg'}`}>
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-2xl border border-border bg-card" />
          ))}
        </div>
      ) : workers.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-12 text-center">
          <p className="text-sm text-muted">Aucun worker enregistré.</p>
        </div>
      ) : online.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <p className="text-sm text-muted">Aucun worker en ligne pour le moment.</p>
          <p className="mt-2 text-xs text-muted">
            Les nœuds hors ligne restent en base mais ne sont plus listés ici.
          </p>
        </div>
      ) : (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">En ligne ({online.length})</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {online.map((w) => (
              <WorkerCard key={w.peerId} w={w} pingMs={pingByPeer[w.peerId]} />
            ))}
          </div>
        </section>
      )}
    </AdminShell>
  )
}

/* ─── Page détail worker ─────────────────────────────────────────────────── */

function workerPingMethodLabel(method: string | undefined | null): string {
  if (method === 'tcp_grpc') return 'TCP (port gRPC)'
  if (method === 'tcp_p2p') return 'TCP (port P2P)'
  if (method === 'icmp') return 'ICMP'
  return method || '—'
}

export function AdminWorkerDetailPage() {
  const { peerId } = useParams<{ peerId: string }>()
  const [worker, setWorker] = useState<RegisteredWorker | null>(null)
  const [loading, setLoading] = useState(true)
  const [livePingMs, setLivePingMs] = useState<number | null>(null)
  const [livePingMethod, setLivePingMethod] = useState<string | null>(null)
  const [livePingErr, setLivePingErr] = useState<string | null>(null)
  const [livePingBusy, setLivePingBusy] = useState(false)
  const [commands, setCommands] = useState<WorkerCommand[]>([])
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [commandMsg, setCommandMsg] = useState<string | null>(null)
  const [modelDraft, setModelDraft] = useState('')
  const [loadModeDraft, setLoadModeDraft] = useState<'auto' | 'full' | 'shard'>('auto')
  const [memoryGbDraft, setMemoryGbDraft] = useState('')
  const [memoryPercentDraft, setMemoryPercentDraft] = useState('')
  const [memoryPreset, setMemoryPreset] = useState('')
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [modelPlan, setModelPlan] = useState<ModelPlan | null>(null)

  const refreshWorker = useCallback(async () => {
    if (!peerId) return
    setLoading(true)
    const id = decodeURIComponent(peerId)
    const [workersRes, commandsRes] = await Promise.all([
      apiJson<{ workers: RegisteredWorker[] }>('/api/admin/workers/registered'),
      apiJson<{ commands: WorkerCommand[] }>(`/api/admin/workers/${encodeURIComponent(id)}/commands`),
    ])
    if (workersRes.ok) {
      const found = workersRes.data.workers.find((w) => w.peerId === id) ?? null
      setWorker(found)
      if (found) {
        setModelDraft(found.desiredModel || found.model || '')
        setMemoryGbDraft(found.desiredAllocatedVramMb ? String(Math.round(found.desiredAllocatedVramMb / 1024)) : found.allocatedVramMb ? String(Math.round(found.allocatedVramMb / 1024)) : '')
        setMemoryPercentDraft(found.desiredMemoryLimitPercent ? String(found.desiredMemoryLimitPercent) : found.memoryLimitPercent ? String(found.memoryLimitPercent) : '')
      }
    }
    if (commandsRes.ok) setCommands(commandsRes.data.commands)
    setLoading(false)
  }, [peerId])

  useEffect(() => {
    void refreshWorker()
  }, [refreshWorker])

  useEffect(() => {
    const loadModels = async () => {
      const r = await apiJson<{ models: AvailableModel[] }>('/api/account/models')
      if (r.ok && Array.isArray(r.data.models)) setAvailableModels(r.data.models)
    }
    void loadModels()
  }, [])

  useEffect(() => {
    const selected = availableModels.find((model) => model.id === modelDraft)
    const modes = new Set(selected?.supportedExecutionModes || ['auto', 'full'])
    if (!modes.has(loadModeDraft) && loadModeDraft !== 'auto') setLoadModeDraft('auto')
  }, [availableModels, loadModeDraft, modelDraft])

  useEffect(() => {
    if (!modelDraft) {
      setModelPlan(null)
      return
    }
    let cancelled = false
    const loadPlan = async () => {
      const r = await apiJson<{ ok: boolean; plan: ModelPlan }>(
        `/api/admin/models/plan?model=${encodeURIComponent(modelDraft)}&mode=${encodeURIComponent(loadModeDraft)}`,
      )
      if (!cancelled) setModelPlan(r.ok && r.data?.ok ? r.data.plan : null)
    }
    void loadPlan()
    return () => {
      cancelled = true
    }
  }, [loadModeDraft, modelDraft])

  async function sendWorkerAction(action: WorkerCommand['action'], body: Record<string, unknown> = {}) {
    if (!peerId) return
    const id = decodeURIComponent(peerId)
    setActionBusy(action)
    setCommandMsg(null)
    const r = await apiJson<{ command?: WorkerCommand }>(`/api/admin/workers/${encodeURIComponent(id)}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action, ...body }),
    })
    setActionBusy(null)
    if (!r.ok) {
      setCommandMsg(r.error)
      return
    }
    setCommandMsg('Commande créée. Elle sera livrée au prochain heartbeat du worker.')
    await refreshWorker()
  }

  async function cancelCommand(commandId: string) {
    if (!peerId) return
    const id = decodeURIComponent(peerId)
    setActionBusy(`cancel-${commandId}`)
    setCommandMsg(null)
    const r = await apiJson<{ ok: boolean }>(
      `/api/admin/workers/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/cancel`,
      { method: 'POST' },
    )
    setActionBusy(null)
    setCommandMsg(r.ok ? 'Commande annulée et intention worker restaurée.' : r.error)
    await refreshWorker()
  }

  function applyModelChange() {
    const model = modelDraft.trim()
    if (!model) {
      setCommandMsg('Modèle requis.')
      return
    }
    void sendWorkerAction('set_model', { model, loadMode: loadModeDraft, quantization: 'q4' })
  }

  function applyMemoryChange() {
    const gb = Number(memoryGbDraft)
    const pct = Number(memoryPercentDraft)
    const payload: Record<string, number> = {}
    if (Number.isFinite(gb) && gb > 0) payload.allocatedVramMb = Math.round(gb * 1024)
    if (Number.isFinite(pct) && pct > 0) payload.memoryPercent = Math.round(pct)
    void sendWorkerAction('set_memory', payload)
  }

  function selectMemoryPreset(value: string) {
    setMemoryPreset(value)
    const option = memoryOptions(worker).find((item) => item.key === value)
    if (!option) return
    if (option.mb > 0) setMemoryGbDraft(String(Math.round(option.mb / 1024)))
    if (option.pct > 0) setMemoryPercentDraft(String(option.pct))
  }

  useEffect(() => {
    if (!peerId || loading) return
    if (!worker) {
      setLivePingMs(null)
      setLivePingMethod(null)
      setLivePingErr(null)
      setLivePingBusy(false)
      return
    }
    const id = decodeURIComponent(peerId)
    let cancelled = false
    const run = async () => {
      setLivePingBusy(true)
      const r = await apiJson<{
        ok?: boolean
        latencyMs?: number
        method?: string
        error?: string
      }>(`/api/admin/workers/${encodeURIComponent(id)}/ping`)
      if (cancelled) return
      setLivePingBusy(false)
      if (r.ok === true && r.data?.ok === true && typeof r.data.latencyMs === 'number') {
        setLivePingMs(r.data.latencyMs)
        setLivePingMethod(r.data.method ?? null)
        setLivePingErr(null)
      } else {
        setLivePingMs(null)
        setLivePingMethod(null)
        const msg =
          r.ok === true && r.data && typeof r.data.error === 'string'
            ? r.data.error
            : r.ok === false
              ? r.error
              : 'Mesure indisponible.'
        setLivePingErr(msg)
      }
    }
    void run()
    const iv = window.setInterval(() => void run(), 2500)
    return () => {
      cancelled = true
      window.clearInterval(iv)
    }
  }, [peerId, loading, worker])

  if (loading) return (
    <AdminShell title="Détail worker">
      <div className="space-y-4">
        {[1,2,3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl border border-border bg-card" />)}
      </div>
    </AdminShell>
  )

  if (!worker) return (
    <AdminShell title="Détail worker">
      <div className="rounded-2xl border border-border bg-card p-12 text-center">
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
    { label: 'Modèle désiré', value: worker.desiredModel ?? worker.model ?? '—' },
    { label: 'État désiré', value: worker.desiredState ?? 'active' },
    { label: 'Mémoire allouée', value: fmtVramMb(worker.allocatedVramMb, worker.runtimeBackend) ?? '—' },
    { label: 'Mémoire désirée', value: fmtVramMb(worker.desiredAllocatedVramMb, worker.runtimeBackend) ?? '—' },
    { label: 'Commande', value: worker.lastCommandStatus ? `${worker.lastCommandStatus}${worker.lastCommandError ? ` · ${worker.lastCommandError}` : ''}` : '—' },
    { label: 'Santé scheduler', value: worker.healthScore != null ? `${worker.healthScore}/100 · ${worker.healthState || '—'}` : '—' },
    { label: 'Runtime', value: [worker.runtimeState || 'idle', worker.currentJobId ? `job ${worker.currentJobId}` : null].filter(Boolean).join(' · ') },
    { label: 'Réservé jusqu’à', value: worker.reservedUntil ? new Date(worker.reservedUntil).toLocaleTimeString('fr-FR') : '—' },
    { label: 'Version', value: worker.version ?? '—' },
    { label: 'Propriétaire', value: worker.ownerEmail ?? 'Non lié' },
    { label: 'Premier contact', value: worker.firstSeenAt ? new Date(worker.firstSeenAt).toLocaleString('fr-FR') : '—' },
    { label: 'Dernier heartbeat', value: worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).toLocaleString('fr-FR') : '—' },
    { label: 'Pairs P2P vus', value: String(worker.p2pPeers) },
  ]

  const tokenTotal = worker.tokensIn + worker.tokensOut
  const pctOut = tokenTotal > 0 ? Math.round((worker.tokensOut / tokenTotal) * 100) : 0
  const mem = memoryProfile(worker)
  const memOptions = memoryOptions(worker)
  const modelOptions = availableModels.length > 0
    ? availableModels
    : worker.model
      ? [{ id: worker.model, label: worker.model, runnable: true }]
      : []
  const selectedModel = modelOptions.find((model) => model.id === modelDraft)
  const supportedLoadModes = new Set(selectedModel?.supportedExecutionModes || ['auto', 'full'])
  const modelLoadModes = [
    {
      id: 'auto' as const,
      label: 'Auto intelligent',
      description: 'Le worker charge en solo si sa mémoire suffit, sinon il passe en shard.',
      disabled: false,
    },
    {
      id: 'full' as const,
      label: 'Solo complet',
      description: 'Un worker charge le modèle quantifié complet dans sa mémoire.',
      disabled: !supportedLoadModes.has('full'),
    },
    {
      id: 'shard' as const,
      label: 'Multi-worker shardé',
      description: 'Le worker ne charge que ses couches et attend les autres workers compatibles.',
      disabled: !supportedLoadModes.has('shard'),
    },
  ]
  const machineRows = [
    { label: 'GPU', value: worker.gpuName || worker.machineInfo?.gpuName || '—' },
    { label: 'VRAM max détectée', value: fmtVramMb(mem.maxMb, worker.runtimeBackend) || '—' },
    { label: 'Mémoire conseillée', value: fmtVramMb(mem.recommendedMb, worker.runtimeBackend) || '—' },
    { label: 'CPU', value: worker.machineInfo?.cpu || '—' },
    { label: 'OS', value: [worker.machineInfo?.os, worker.machineInfo?.arch].filter(Boolean).join(' · ') || '—' },
    { label: 'Mémoire système', value: worker.machineInfo?.totalMemoryGb ? `${worker.machineInfo.totalMemoryGb} Go total · ${worker.machineInfo.availableMemoryGb ?? '—'} Go libres` : '—' },
    { label: 'Mémoire unifiée', value: worker.machineInfo?.unifiedMemory ? 'Oui' : 'Non / inconnue' },
    { label: 'Backends possibles', value: worker.machineInfo?.backendCandidates?.join(', ') || worker.runtimeBackend || '—' },
  ]

  return (
    <AdminShell
      title={`Worker · ${worker.peerId.slice(0, 20)}…`}
      subtitle={`${worker.online ? 'En ligne' : `Hors ligne depuis ${timeAgo(worker.secondsSinceHeartbeat)}`} · ${worker.publicIp ?? '—'}`}
      actions={
        <Link to="/admin/workers" className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface">
          ← Retour
        </Link>
      }
    >
      <div className="space-y-5">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <p className="text-sm font-semibold text-fg">Latence temps réel (VPS → ce worker)</p>
          <p className="mt-2 font-display text-3xl font-bold tabular-nums text-fg">
            {livePingBusy && livePingMs == null && !livePingErr ? (
              <span className="text-muted">Mesure…</span>
            ) : livePingMs != null ? (
              `${livePingMs} ms`
            ) : (
              <span className="text-lg text-warning">—</span>
            )}
          </p>
          {livePingMethod && livePingMs != null && (
            <p className="mt-1 text-[11px] text-muted">
              Méthode : <span className="font-mono text-fg">{workerPingMethodLabel(livePingMethod)}</span>
            </p>
          )}
          {livePingErr && (
            <p className="mt-2 text-[12px] leading-snug text-warning">{livePingErr}</p>
          )}
          <p className="mt-3 text-[10px] leading-relaxed text-muted">
            Une requête toutes les 2,5 secondes, uniquement pour ce worker (aucune sonde sur les autres nœuds).
          </p>
        </div>

        <div className="rounded-3xl border border-white/10 bg-card/80 p-5 shadow-[0_24px_80px_-52px_rgba(16,185,129,.75)] backdrop-blur-xl">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-fg">Santé scheduler</p>
              <p className="mt-1 text-[12px] text-muted">Score utilisé pour éviter les workers instables, réservés ou trop vieux.</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-[11px] font-bold uppercase ${
              (worker.healthScore ?? 0) >= 70 ? 'bg-success/10 text-success' : (worker.healthScore ?? 0) >= 45 ? 'bg-warning/10 text-warning' : 'bg-alert/10 text-alert'
            }`}>
              {worker.healthScore ?? 0}/100 · {worker.healthState || 'unknown'}
            </span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-border/70 bg-surface/70 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">État runtime</p>
              <p className="mt-1 text-sm font-bold text-fg">{worker.runtimeState || 'idle'}</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-surface/70 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Réservation</p>
              <p className="mt-1 text-sm font-bold text-fg">{worker.reservedUntil ? new Date(worker.reservedUntil).toLocaleTimeString('fr-FR') : 'Libre'}</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-surface/70 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Raisons</p>
              <p className="mt-1 text-xs font-semibold text-fg">{worker.healthReasons?.length ? worker.healthReasons.join(', ') : 'Aucun signal négatif'}</p>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-white/10 bg-card/80 p-5 shadow-[0_24px_80px_-52px_rgba(34,211,238,.85)] backdrop-blur-xl">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-fg">Machine worker</p>
              <p className="mt-1 text-[12px] text-muted">
                Infos remontées par heartbeat. Les anciens workers afficheront plus de détails après update/redémarrage.
              </p>
            </div>
            <span className="rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-[11px] font-bold text-accent">
              {worker.runtimeBackend || 'runtime —'}
            </span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {machineRows.map((row) => (
              <div key={row.label} className="rounded-2xl border border-border/70 bg-surface/70 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{row.label}</p>
                <p className="mt-1 break-words text-[12px] font-semibold text-fg">{row.value}</p>
              </div>
            ))}
          </div>
          {Array.isArray(worker.machineInfo?.controllers) && worker.machineInfo.controllers.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-2xl border border-border/70">
              <div className="grid grid-cols-[1fr_100px_80px] bg-surface px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-muted">
                <span>GPU détecté</span><span>VRAM</span><span>Bus</span>
              </div>
              {worker.machineInfo.controllers.map((gpu, index) => (
                <div key={`${gpu.model || 'gpu'}-${index}`} className="grid grid-cols-[1fr_100px_80px] border-t border-border/60 px-3 py-2 text-[11px]">
                  <span className="truncate text-fg" title={[gpu.vendor, gpu.model].filter(Boolean).join(' ')}>
                    {[gpu.vendor, gpu.model].filter(Boolean).join(' ') || 'GPU'}
                  </span>
                  <span className="text-muted">{fmtVramMb(gpu.vramMb, worker.runtimeBackend) || '—'}</span>
                  <span className="truncate text-muted">{gpu.bus || '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-white/10 bg-card/80 p-5 shadow-[0_24px_80px_-48px_rgba(59,130,246,.8)] backdrop-blur-xl">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-fg">Contrôle distant</p>
              <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-muted">
                Les commandes sont persistées côté VPS, livrées au prochain heartbeat, puis visibles dans l’historique ci-dessous.
                Les workers en pause sont exclus du scheduler public même s’ils restent connectés.
              </p>
            </div>
            <span className={`rounded-full px-3 py-1 text-[11px] font-bold uppercase ${
              worker.desiredState && worker.desiredState !== 'active' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'
            }`}>
              désiré : {worker.desiredState || 'active'}
            </span>
          </div>

          {commandMsg && (
            <div className="mt-4 rounded-xl border border-electric/25 bg-electric/10 px-4 py-3 text-[12px] text-electric">
              {commandMsg}
            </div>
          )}

          <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_1fr]">
            <div className="rounded-2xl border border-border/70 bg-surface/70 p-4">
              <p className="text-xs font-semibold text-fg">Cycle worker</p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5 lg:grid-cols-2 xl:grid-cols-5">
                {[
                  ['pause', 'Pause'],
                  ['resume', 'Activer'],
                  ['drain', 'Drain'],
                  ['restart', 'Restart'],
                  ['update_software', 'Update'],
                  ['stop', 'Stop'],
                ].map(([action, label]) => (
                  <button
                    key={action}
                    type="button"
                    disabled={!!actionBusy}
                    onClick={() => void sendWorkerAction(action)}
                    className={`rounded-xl border px-3 py-2 text-[12px] font-semibold transition disabled:opacity-50 ${
                      action === 'stop'
                        ? 'border-alert/30 text-alert hover:bg-alert/10'
                        : action === 'update_software'
                          ? 'border-accent/35 text-accent hover:bg-accent/10'
                        : action === 'pause' || action === 'drain'
                          ? 'border-warning/30 text-warning hover:bg-warning/10'
                          : 'border-success/30 text-success hover:bg-success/10'
                    }`}
                  >
                    {actionBusy === action ? '…' : label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-border/70 bg-surface/70 p-4">
              <p className="text-xs font-semibold text-fg">Modèle chargé</p>
              <div className="mt-3 grid gap-2 xl:grid-cols-[minmax(0,1.15fr)_minmax(180px,.85fr)_auto]">
                <select
                  value={modelDraft}
                  onChange={(e) => {
                    setModelDraft(e.target.value)
                    setLoadModeDraft('auto')
                  }}
                  className="min-w-0 rounded-xl border border-border bg-card px-3 py-2 text-[12px] text-fg outline-none focus:border-accent"
                >
                  <option value="">Choisir un modèle disponible…</option>
                  {modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {(model.label || model.id)} · {model.workersOnline ?? 0}/{model.requiredWorkers ?? 1} worker(s){model.runnable ? ' · prêt' : ''}
                    </option>
                  ))}
                </select>
                <select
                  value={loadModeDraft}
                  onChange={(e) => setLoadModeDraft(e.target.value as 'auto' | 'full' | 'shard')}
                  className="min-w-0 rounded-xl border border-border bg-card px-3 py-2 text-[12px] text-fg outline-none focus:border-accent"
                >
                  {modelLoadModes.map((mode) => (
                    <option key={mode.id} value={mode.id} disabled={mode.disabled}>
                      {mode.label}{mode.disabled ? ' · non supporté' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!!actionBusy}
                  onClick={applyModelChange}
                  className="rounded-xl bg-accent px-3 py-2 text-[12px] font-bold text-white disabled:opacity-50"
                >
                  Charger
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                Liste auto depuis le catalogue VRYX, les modèles détectés sur le VPS et les heartbeats workers.
                {selectedModel?.id === 'Qwen/Qwen3.6-35B-A3B'
                  ? ' Qwen3.6 peut tourner en solo Q4 si la mémoire suffit, ou en multi-worker avec répartition des couches.'
                  : ''}
              </p>
              <div className="mt-3 grid gap-2 text-[11px] text-muted sm:grid-cols-3">
                <span>Mode : <strong className="text-fg">{modelLoadModes.find((mode) => mode.id === loadModeDraft)?.label || 'Auto'}</strong></span>
                <span>Workers requis : <strong className="text-fg">{loadModeDraft === 'shard' ? Math.max(2, selectedModel?.requiredWorkers || 2) : selectedModel?.requiredWorkers || 1}</strong></span>
                <span>Mémoire conseillée : <strong className="text-success">{selectedModel?.recommendedMemoryGb ? `${selectedModel.recommendedMemoryGb} Go` : 'auto'}</strong></span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                {modelLoadModes.find((mode) => mode.id === loadModeDraft)?.description}
              </p>
              {worker.desiredModel && worker.desiredModel !== worker.model && (
                <p className="mt-2 text-[11px] text-warning">En attente : {worker.desiredModel}</p>
              )}
              {modelPlan && (
                <div className="mt-4 rounded-2xl border border-border/70 bg-card/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] font-bold text-fg">Plan scheduler · {modelPlan.mode}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${modelPlan.ready ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                      {modelPlan.ready ? 'prêt' : 'incomplet'} · {modelPlan.assignments.length}/{modelPlan.requiredWorkers} worker(s)
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-muted">
                    {modelPlan.totalLayers} couches · {modelPlan.effectiveModelGb} Go effectifs · {modelPlan.availableWorkers} worker(s) disponibles.
                  </p>
                  {modelPlan.assignments.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {modelPlan.assignments.slice(0, 5).map((assignment) => (
                        <div key={`${assignment.peerId}-${assignment.layerStart}`} className="grid grid-cols-[1fr_auto_auto] gap-2 rounded-xl border border-border/60 bg-surface/70 px-3 py-2 text-[10px]">
                          <span className="truncate font-mono text-fg">{assignment.peerId}</span>
                          <span className="text-muted">L{assignment.layerStart}-{assignment.layerEnd}</span>
                          <span className="font-bold text-success">{assignment.healthScore}/100</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {modelPlan.blockers?.length ? (
                    <p className="mt-2 text-[11px] text-warning">{modelPlan.blockers.join(' · ')}</p>
                  ) : null}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-border/70 bg-surface/70 p-4 lg:col-span-2">
              <p className="text-xs font-semibold text-fg">Allocation mémoire</p>
              <div className="mt-2 grid gap-2 text-[11px] text-muted sm:grid-cols-3">
                <span>Max détecté : <strong className="text-fg">{fmtVramMb(mem.maxMb, worker.runtimeBackend) || '—'}</strong></span>
                <span>Conseillé : <strong className="text-success">{fmtVramMb(mem.recommendedMb, worker.runtimeBackend) || '—'}</strong></span>
                <span>Actuel : <strong className="text-fg">{fmtVramMb(mem.currentMb, worker.runtimeBackend) || '—'}{mem.currentPercent ? ` · ${mem.currentPercent}%` : ''}</strong></span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                <select
                  value={memoryPreset}
                  onChange={(e) => selectMemoryPreset(e.target.value)}
                  className="rounded-xl border border-border bg-card px-3 py-2 text-[12px] text-fg outline-none focus:border-accent"
                >
                  <option value="">Choisir une allocation…</option>
                  {memOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label} · {option.pct}%
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!!actionBusy}
                  onClick={applyMemoryChange}
                  className="rounded-xl border border-accent/35 px-4 py-2 text-[12px] font-bold text-accent hover:bg-accent/10 disabled:opacity-50"
                >
                  Appliquer
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                La recommandation garde une réserve système, surtout sur les Mac à mémoire unifiée.
              </p>
            </div>
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-border/70">
            <div className="grid grid-cols-[90px_1fr_110px_120px_80px] bg-surface px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-muted">
              <span>Action</span><span>Payload</span><span>Statut</span><span>Date</span><span></span>
            </div>
            {commands.length === 0 ? (
              <p className="px-3 py-4 text-[12px] text-muted">Aucune commande distante.</p>
            ) : commands.slice(0, 8).map((cmd) => (
              <div key={cmd.id} className="grid grid-cols-[90px_1fr_110px_120px_80px] items-center border-t border-border/60 px-3 py-2 text-[11px]">
                <span className="font-mono text-fg">{cmd.action}</span>
                <span className="truncate text-muted" title={JSON.stringify(cmd.payload || {})}>
                  {cmd.payload?.model || cmd.payload?.allocatedVramMb || cmd.payload?.memoryPercent
                    ? JSON.stringify(cmd.payload)
                    : '—'}
                </span>
                <span className={cmd.status === 'failed' ? 'text-alert' : cmd.status === 'acknowledged' ? 'text-success' : 'text-warning'}>
                  {cmd.status}
                </span>
                <span className="text-muted">{cmd.createdAt ? new Date(cmd.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                <span className="text-right">
                  {['pending', 'delivered'].includes(cmd.status) ? (
                    <button
                      type="button"
                      disabled={actionBusy === `cancel-${cmd.id}`}
                      onClick={() => void cancelCommand(cmd.id)}
                      className="rounded-lg border border-alert/30 px-2 py-1 text-[10px] font-bold text-alert hover:bg-alert/10 disabled:opacity-50"
                    >
                      Annuler
                    </button>
                  ) : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Status + tokens */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Statut', value: worker.online ? 'En ligne' : 'Hors ligne', ok: worker.online },
            { label: 'Tokens générés', value: fmt(worker.tokensGenerated) },
            { label: 'Tokens in', value: fmt(worker.tokensIn) },
            { label: 'Tokens out', value: fmt(worker.tokensOut) },
          ].map((s) => (
            <div key={s.label} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
              <p className="text-xs text-muted">{s.label}</p>
              <p className={`mt-1 font-display text-xl font-bold ${s.ok === false ? 'text-warning' : s.ok === true ? 'text-success' : 'text-fg'}`}>
                {s.value}
              </p>
            </div>
          ))}
        </div>

        {/* Ratio tokens */}
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
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
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
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
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
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
