import { useCallback, useEffect, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'
import { apiJson } from '../../lib/api'

export type PoolGraphNode = {
  id: string
  group: string
  /** Identifiant métier de la pool (aligné sur `pool.id` côté API). */
  poolId?: string | null
  val: number
  hardware?: string | null
  vram?: number | null
  shards?: string | null
  status?: string | null
  pingMs?: number | null
  vramMbTotal?: number | null
  vramMbUsed?: number | null
  publicIp?: string | null
  model?: string | null
  x?: number
  y?: number
  z?: number
  vx?: number
  vy?: number
  vz?: number
  fx?: number
  fy?: number
  fz?: number
}

export type PoolGraphLink = {
  source: string | PoolGraphNode
  target: string | PoolGraphNode
  is_active?: boolean
}

type Props = {
  nodes: PoolGraphNode[]
  links: PoolGraphLink[]
  pipelineActive: boolean
}

const ORCH_ID = 'vps-core'

function hueFromString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

function convexHull(points: [number, number][]): [number, number][] {
  if (points.length <= 1) return points
  if (points.length === 2) return points
  const sorted = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]))
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: [number, number][] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

function truncatePeer(id: string, n = 14) {
  return id.length > n ? `${id.slice(0, n)}…` : id
}

export function PoolNetworkGraph({ nodes: incomingNodes, links: incomingLinks, pipelineActive }: Props) {
  const fgRef = useRef<any>(null)
  const mouseRef = useRef({ x: 0, y: 0 })
  const posRef = useRef<Map<string, { x: number; y: number; vx?: number; vy?: number }>>(new Map())
  const [mode2d, setMode2d] = useState(true)
  const [graphData, setGraphData] = useState<{ nodes: PoolGraphNode[]; links: PoolGraphLink[] }>({
    nodes: [],
    links: [],
  })
  const [hover, setHover] = useState<{
    id: string
    screenX: number
    screenY: number
    hardware: string
    poolLabel: string
    pingLabel: string
  } | null>(null)
  const [selected, setSelected] = useState<PoolGraphNode | null>(null)
  const [confirmAction, setConfirmAction] = useState<'disconnect' | 'change_pool' | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  useEffect(() => {
    const prev = posRef.current
    const incomingIds = new Set(incomingNodes.map((n) => n.id))
    for (const id of [...prev.keys()]) {
      if (!incomingIds.has(id)) prev.delete(id)
    }

    const byGroup = new Map<string, PoolGraphNode[]>()
    for (const n of incomingNodes) {
      if (n.id === ORCH_ID) continue
      const g = n.group || 'pool'
      if (!byGroup.has(g)) byGroup.set(g, [])
      byGroup.get(g)!.push(n)
    }
    const groupKeys = [...byGroup.keys()]
    const nSectors = Math.max(groupKeys.length, 1)
    const sectorSpan = (2 * Math.PI) / nSectors
    const groupIndex = new Map(groupKeys.map((g, i) => [g, i]))

    const nodes = incomingNodes.map((n) => {
      const old = prev.get(n.id)
      const base: PoolGraphNode = { ...n }
      if (old && typeof old.x === 'number' && typeof old.y === 'number') {
        base.x = old.x
        base.y = old.y
        base.vx = old.vx
        base.vy = old.vy
      } else if (n.id === ORCH_ID) {
        base.fx = 0
        base.fy = 0
        base.x = 0
        base.y = 0
      } else {
        const g = n.group || 'pool'
        const gi = groupIndex.get(g) ?? 0
        const members = byGroup.get(g) || []
        const idxInGroup = Math.max(0, members.findIndex((m) => m.id === n.id))
        const sectorStart = gi * sectorSpan
        const mid = sectorStart + sectorSpan / 2
        const spread = sectorSpan * 0.82
        const angle = mid - spread / 2 + (idxInGroup / Math.max(members.length, 1)) * spread
        const r = 140 + (idxInGroup % 3) * 26
        base.x = Math.cos(angle) * r
        base.y = Math.sin(angle) * r
      }
      return base
    })

    const links = incomingLinks.map((l) => ({ ...l }))
    setGraphData({ nodes, links })
  }, [incomingNodes, incomingLinks])

  const backgroundPaint = useCallback(
    (ctx: CanvasRenderingContext2D, globalScale: number) => {
      const data = fgRef.current?.graphData?.()
      if (!data?.nodes?.length) return
      const byGroup = new Map<string, PoolGraphNode[]>()
      for (const n of data.nodes as PoolGraphNode[]) {
        if (n.id === ORCH_ID || n.x == null || n.y == null) continue
        const g = n.group || 'pool'
        if (!byGroup.has(g)) byGroup.set(g, [])
        byGroup.get(g)!.push(n)
      }
      for (const [g, members] of byGroup) {
        const pts: [number, number][] = members
          .filter((m) => m.x != null && m.y != null)
          .map((m) => [m.x as number, m.y as number])
        if (pts.length < 2) continue
        const hull = convexHull(pts)
        if (hull.length < 2) continue
        const hue = hueFromString(g)
        ctx.beginPath()
        hull.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p[0], p[1])
          else ctx.lineTo(p[0], p[1])
        })
        ctx.closePath()
        ctx.fillStyle = `hsla(${hue}, 55%, 52%, 0.14)`
        ctx.fill()
        ctx.strokeStyle = `hsla(${hue}, 60%, 45%, 0.35)`
        ctx.lineWidth = 1.5 / globalScale
        ctx.stroke()
      }
    },
    [],
  )

  const nodeRelSize = useCallback((n: PoolGraphNode) => Math.max(2.5, Math.sqrt(Number(n.val) || 1) * 2.2), [])

  const handleClick = useCallback(
    (node: PoolGraphNode) => {
      setSelected(node)
      const fg = fgRef.current
      if (fg && node.x != null && node.y != null) {
        fg.centerAt(node.x, node.y, 400)
        fg.zoom(2.2, 400)
      }
    },
    [],
  )

  const pingLabel = useCallback((n: PoolGraphNode) => {
    if (n.id === ORCH_ID) return 'Orchestrateur (fixe)'
    if (n.pingMs == null) return 'Latence : —'
    if (n.pingMs >= 60_000) return `Dernière activité : ${Math.round(n.pingMs / 1000)} s`
    return `Dernière activité : ${Math.round(n.pingMs)} ms`
  }, [])

  const runAction = useCallback(
    async (action: 'disconnect' | 'change_pool') => {
      if (!selected || selected.id === ORCH_ID) return
      setActionBusy(true)
      setActionMessage(null)
      const r = await apiJson<{ ok?: boolean; error?: string }>(
        `/api/admin/workers/${encodeURIComponent(selected.id)}/actions`,
        {
          method: 'POST',
          body: JSON.stringify({ action }),
        },
      )
      setActionBusy(false)
      setConfirmAction(null)
      if (r.ok === true) {
        setActionMessage('Action envoyée.')
      } else {
        setActionMessage(r.error || 'Action impossible.')
      }
    },
    [selected],
  )

  const linkParticlesCb = useCallback(
    (l: PoolGraphLink) => ((l as PoolGraphLink).is_active && pipelineActive ? 4 : 0),
    [pipelineActive],
  )

  const persistPositions = useCallback(() => {
    try {
      fgRef.current?.graphData()?.nodes?.forEach((n: PoolGraphNode) => {
        if (typeof n.x === 'number' && typeof n.y === 'number') {
          posRef.current.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy })
        }
      })
    } catch {
      /* ignore */
    }
  }, [])

  const commonProps = {
    ref: fgRef,
    graphData,
    backgroundColor: 'rgba(15, 17, 28, 0.92)',
    linkDirectionalParticles: linkParticlesCb,
    linkDirectionalParticleSpeed: 0.008,
    linkDirectionalParticleWidth: 2,
    linkWidth: (l: PoolGraphLink) => ((l as { is_active?: boolean }).is_active ? 2.4 : 0.9),
    linkColor: (l: PoolGraphLink) =>
      (l as { is_active?: boolean }).is_active ? 'rgba(94, 234, 212, 0.85)' : 'rgba(148, 163, 184, 0.35)',
    cooldownTicks: 120,
    onNodeHover: (node: PoolGraphNode | null) => {
      if (!node) {
        setHover(null)
        return
      }
      const { x, y } = mouseRef.current
      setHover({
        id: node.id,
        screenX: x,
        screenY: y,
        hardware: node.hardware || '—',
        poolLabel: node.poolId ? `Pool : ${truncatePeer(node.poolId, 28)}` : 'Pool : —',
        pingLabel: pingLabel(node),
      })
    },
    onNodeClick: (node: PoolGraphNode) => handleClick(node),
  }

  const fg2d = (
    <ForceGraph2D<PoolGraphNode, PoolGraphLink>
      {...commonProps}
      nodeRelSize={6}
      nodeVal={nodeRelSize as any}
      nodeLabel={() => ''}
      nodeCanvasObjectMode={() => 'replace'}
      onRenderFramePre={backgroundPaint}
      nodeCanvasObject={(node: PoolGraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
        if (node.x == null || node.y == null) return
        const r = nodeRelSize(node) * 1.2
        const isSel = selected?.id === node.id
        const hue = hueFromString(node.group || '')
        ctx.beginPath()
        ctx.arc(node.x, node.y, r / globalScale, 0, 2 * Math.PI)
        ctx.fillStyle =
          node.status === 'timeout'
            ? 'rgba(251, 146, 60, 0.85)'
            : node.status === 'computing'
              ? 'rgba(94, 234, 212, 0.92)'
              : `hsla(${hue}, 65%, 58%, 0.92)`
        ctx.fill()
        if (isSel) {
          ctx.strokeStyle = 'rgba(255,255,255,0.95)'
          ctx.lineWidth = 2 / globalScale
          ctx.stroke()
        }
      }}
      onEngineStop={persistPositions}
    />
  )

  const fg3d = (
    <ForceGraph3D<PoolGraphNode, PoolGraphLink>
      {...commonProps}
      nodeThreeObject={(node: PoolGraphNode) => {
        const hue = hueFromString(node.group || '')
        const size = Math.max(3, Math.cbrt(Number(node.val) || 1) * 2.5)
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(size, 18, 18),
          new THREE.MeshLambertMaterial({
            color:
              node.status === 'timeout'
                ? 0xf97316
                : node.status === 'computing'
                  ? 0x5eead4
                  : new THREE.Color().setHSL(((hue % 360) / 360 + 1) % 1, 0.65, 0.55),
            transparent: true,
            opacity: 0.92,
          }),
        )
        return mesh
      }}
      nodeThreeObjectExtend={false}
      linkOpacity={0.35}
      onEngineStop={persistPositions}
    />
  )

  return (
    <div className="relative isolate w-full">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3 sm:mb-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg sm:text-base">Nerve Center — topologie P2P</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted sm:text-xs">
            Mise à jour par événements (SSE). Groupes par pool, orchestrateur au centre, flux animé pendant une inférence.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
              pipelineActive ? 'bg-accent/15 text-accent' : 'bg-border/60 text-muted'
            }`}
          >
            {pipelineActive ? 'Pipeline actif' : 'Au repos'}
          </span>
          <button
            type="button"
            onClick={() => setMode2d((v) => !v)}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-fg shadow-sm hover:bg-surface"
          >
            {mode2d ? 'Vue 3D' : 'Vue 2D'}
          </button>
        </div>
      </div>

      <div
        className="relative min-h-[300px] h-[min(88vh,880px)] w-full overflow-hidden rounded-2xl border border-border bg-[#0b0d14] shadow-inner sm:min-h-[380px] sm:h-[min(90vh,920px)]"
        onMouseMove={(e) => {
          mouseRef.current = { x: e.clientX, y: e.clientY }
        }}
      >
        {mode2d ? fg2d : fg3d}

        {hover && (
          <div
            className="pointer-events-none fixed z-[110] max-w-xs rounded-lg border border-border bg-card px-3 py-2 text-[11px] shadow-lg"
            style={{
              left: Math.min(typeof window !== 'undefined' ? window.innerWidth - 240 : hover.screenX, hover.screenX + 12),
              top: hover.screenY + 12,
            }}
          >
            <p className="font-mono text-[10px] text-fg">{truncatePeer(hover.id, 22)}</p>
            <p className="mt-1 font-mono text-[10px] text-accent">{hover.poolLabel}</p>
            <p className="mt-0.5 text-muted">{hover.hardware}</p>
            <p className="text-muted">{hover.pingLabel}</p>
          </div>
        )}
      </div>

      {/* Panneau diagnostic (au-dessus de tout le shell admin) */}
      <aside
        className={`fixed inset-y-0 right-0 z-[100] w-full max-w-md transform border-l border-border bg-card shadow-2xl transition-transform duration-300 ease-out sm:max-w-lg ${
          selected ? 'translate-x-0' : 'translate-x-full'
        }`}
        aria-hidden={!selected}
      >
        {selected && (
          <div className="flex h-full flex-col overflow-y-auto overscroll-contain p-5 pt-16 sm:pt-14">
            <button
              type="button"
              className="absolute right-4 top-4 z-[1] rounded-lg border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-muted hover:bg-surface hover:text-fg"
              onClick={() => setSelected(null)}
            >
              Fermer
            </button>
            <h4 className="pr-16 font-mono text-xs font-semibold leading-snug text-fg">{truncatePeer(selected.id, 36)}</h4>
            <p className="mt-1 text-[11px] text-muted">{selected.hardware || '—'}</p>

            <dl className="mt-6 space-y-3 text-[12px]">
              {selected.poolId && (
                <div className="flex justify-between gap-4 border-b border-border/50 pb-2">
                  <dt className="text-muted">Pool</dt>
                  <dd className="max-w-[62%] break-all text-right font-mono text-[10px] text-accent">
                    {selected.poolId}
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-4 border-b border-border/50 pb-2">
                <dt className="text-muted">Statut</dt>
                <dd className="text-right font-medium text-fg">
                  {selected.status === 'computing'
                    ? 'Calcul'
                    : selected.status === 'timeout'
                      ? 'Timeout / hors ligne'
                      : selected.id === ORCH_ID
                        ? 'Orchestrateur'
                        : 'Inactif'}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-border/50 pb-2">
                <dt className="text-muted">VRAM</dt>
                <dd className="text-right text-fg">
                  {selected.vramMbUsed != null && selected.vramMbTotal != null
                    ? `${Math.round(selected.vramMbUsed)} / ${Math.round(selected.vramMbTotal)} Mo`
                    : selected.vram != null
                      ? `${selected.vram} Go (total déclaré)`
                      : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-border/50 pb-2">
                <dt className="text-muted">Shards (estimation)</dt>
                <dd className="max-w-[55%] text-right font-mono text-[11px] text-fg">{selected.shards || '—'}</dd>
              </div>
              {selected.publicIp && (
                <div className="flex justify-between gap-4 border-b border-border/50 pb-2">
                  <dt className="text-muted">IP</dt>
                  <dd className="font-mono text-[11px] text-fg">{selected.publicIp}</dd>
                </div>
              )}
            </dl>

            {selected.id !== ORCH_ID && (
              <div className="mt-8 flex flex-col gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-border bg-surface px-4 py-2.5 text-left text-[12px] font-medium text-fg hover:bg-border/30"
                  onClick={() => setConfirmAction('disconnect')}
                >
                  Forcer la déconnexion
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-border bg-surface px-4 py-2.5 text-left text-[12px] font-medium text-fg hover:bg-border/30"
                  onClick={() => setConfirmAction('change_pool')}
                >
                  Changer de pool
                </button>
              </div>
            )}

            {actionMessage && (
              <p className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-muted">{actionMessage}</p>
            )}
          </div>
        )}
      </aside>

      {selected && (
        <button
          type="button"
          className="fixed inset-0 z-[95] bg-black/45 backdrop-blur-[2px] sm:hidden"
          aria-label="Fermer le panneau"
          onClick={() => setSelected(null)}
        />
      )}

      {confirmAction && selected && selected.id !== ORCH_ID && (
        <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/55 p-4 backdrop-blur-sm sm:items-center">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl">
            <p className="text-sm font-semibold text-fg">
              {confirmAction === 'disconnect' ? 'Forcer la déconnexion ?' : 'Changer de pool ?'}
            </p>
            <p className="mt-2 text-[12px] text-muted">
              {confirmAction === 'disconnect'
                ? 'Cette action est expérimentale : le worker distant ne peut pas toujours être coupé depuis le VPS.'
                : 'Le placement dynamique entre pools sera disponible via l’orchestrateur dans une prochaine version.'}
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-border px-4 py-2 text-[12px] font-medium text-fg hover:bg-surface"
                onClick={() => setConfirmAction(null)}
                disabled={actionBusy}
              >
                Annuler
              </button>
              <button
                type="button"
                className="rounded-lg bg-accent px-4 py-2 text-[12px] font-semibold text-[var(--accent-fg,#0b0d14)] hover:opacity-90 disabled:opacity-50"
                disabled={actionBusy}
                onClick={() => void runAction(confirmAction)}
              >
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
