import { type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { apiJson, apiUrl } from '../lib/api'
import {
  createBillingCheckout,
  createAccountApiKey,
  fetchAccountApiKeys,
  fetchAccountBilling,
  fetchAccountOverview,
  fetchAccountSessions,
  revokeAccountApiKey,
} from '../lib/account'
import type { AccountApiKey, AccountBilling, AccountOverview, AccountSessionSummary } from '../lib/account'
import {
  IconBolt,
  IconCode,
  IconCredit,
  IconGpu,
  IconLayoutGrid,
  IconLock,
  IconShield,
  IconTerminal,
} from '../components/icons/Icons'
import { ThemeToggle } from '../components/layout/ThemeToggle'
import { VryxLogo } from '../components/brand/VryxLogo'
import { ChatMarkdown } from '../components/admin/ChatMarkdown'

type ParticlePoint = { x: number; y: number }
type ParticleEdge = [ParticlePoint, ParticlePoint]
type ParticleShape = {
  x: number
  y: number
  vx: number
  vy: number
  base: ParticlePoint
  phase: number
  size: number
  isChaotic?: boolean
}

export type PageId = 'overview' | 'chat' | 'api' | 'usage' | 'workers' | 'billing' | 'security' | 'settings'

export const pageColors: Record<PageId, string> = {
  overview: '#38bdf8', // Light blue / Sky cyan
  chat: '#a78bfa',     // Cosmic lavender purple
  api: '#34d399',      // Bright mint emerald
  usage: '#fbbf24',    // Radiant sun amber
  workers: '#f472b6',  // Neon hot pink
  billing: '#f87171',  // Warm vermilion red
  security: '#22d3ee', // Cool cyan/teal
  settings: '#94a3b8', // Sleek metallic slate
}

// Custom mathematical target shapes for the Account Navigation Tabs
function makeAccountIconTargets(kind: PageId | 'toggle', width: number, height: number) {
  const pts: ParticlePoint[] = []
  const edges: ParticleEdge[] = []
  const center = { x: width * 0.5, y: height * 0.5 }
  const unit = Math.min(width, height)

  function addLine(x1: number, y1: number, x2: number, y2: number, steps = 10) {
    let prev: ParticlePoint | null = null
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const p = { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t }
      pts.push(p)
      if (prev) edges.push([prev, p])
      prev = p
    }
  }

  function addCircle(cx: number, cy: number, r: number, steps = 20, start = 0, end = Math.PI * 2) {
    let prev: ParticlePoint | null = null
    let first: ParticlePoint | null = null
    for (let i = 0; i <= steps; i++) {
      const angle = start + ((end - start) * i) / steps
      const p = { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }
      pts.push(p)
      if (prev) edges.push([prev, p])
      else first = p
      prev = p
    }
    if (first && prev && end - start >= Math.PI * 2 - 0.01) edges.push([prev, first])
  }

  if (kind === 'overview') {
    // Elegant 2x2 grid quadrants representing global system overview
    const s = unit * 0.22
    const g = unit * 0.04 // gap
    // Quad 1: Top-Left
    addLine(center.x - s, center.y - s, center.x - g, center.y - s, 4)
    addLine(center.x - g, center.y - s, center.x - g, center.y - g, 4)
    addLine(center.x - g, center.y - g, center.x - s, center.y - g, 4)
    addLine(center.x - s, center.y - g, center.x - s, center.y - s, 4)
    // Quad 2: Top-Right
    addLine(center.x + g, center.y - s, center.x + s, center.y - s, 4)
    addLine(center.x + s, center.y - s, center.x + s, center.y - g, 4)
    addLine(center.x + s, center.y - g, center.x + g, center.y - g, 4)
    addLine(center.x + g, center.y - g, center.x + g, center.y - s, 4)
    // Quad 3: Bottom-Left
    addLine(center.x - s, center.y + g, center.x - g, center.y + g, 4)
    addLine(center.x - g, center.y + g, center.x - g, center.y + s, 4)
    addLine(center.x - g, center.y + s, center.x - s, center.y + s, 4)
    addLine(center.x - s, center.y + s, center.x - s, center.y + g, 4)
    // Quad 4: Bottom-Right
    addLine(center.x + g, center.y + g, center.x + s, center.y + g, 4)
    addLine(center.x + s, center.y + g, center.x + s, center.y + s, 4)
    addLine(center.x + s, center.y + s, center.x + g, center.y + s, 4)
    addLine(center.x + g, center.y + s, center.x + g, center.y + g, 4)
  } else if (kind === 'chat') {
    // Beautiful conversation bubble with inner message lines
    const r = unit * 0.24
    addCircle(center.x, center.y - unit * 0.03, r, 24)
    // Speech bubble tail
    addLine(center.x - r * 0.4, center.y + r * 0.7, center.x - r * 0.8, center.y + r * 1.1, 5)
    addLine(center.x - r * 0.8, center.y + r * 1.1, center.x - r * 0.05, center.y + r * 0.85, 5)
    // Inner chat text indicators
    addLine(center.x - r * 0.4, center.y - unit * 0.04, center.x + r * 0.4, center.y - unit * 0.04, 4)
    addLine(center.x - r * 0.4, center.y + unit * 0.03, center.x + r * 0.2, center.y + unit * 0.03, 4)
  } else if (kind === 'api') {
    // High-tech terminal chevron prompt >_
    const s = unit * 0.20
    // Chevron '>'
    addLine(center.x - s * 1.1, center.y - s * 0.9, center.x - s * 0.1, center.y, 6)
    addLine(center.x - s * 0.1, center.y, center.x - s * 1.1, center.y + s * 0.9, 6)
    // Flashing prompt cursor '_'
    addLine(center.x + s * 0.1, center.y + s * 0.8, center.x + s * 1.2, center.y + s * 0.8, 6)
  } else if (kind === 'usage') {
    // Energetic high-voltage lightning bolt
    const w = unit * 0.16
    const h = unit * 0.34
    addLine(center.x + w * 0.9, center.y - h, center.x - w * 0.5, center.y + w * 0.1, 8)
    addLine(center.x - w * 0.5, center.y + w * 0.1, center.x + w * 0.5, center.y + w * 0.1, 5)
    addLine(center.x + w * 0.5, center.y + w * 0.1, center.x - w * 0.9, center.y + h, 8)
  } else if (kind === 'workers') {
    // Awesome GPU chipset processor circuit core
    const s = unit * 0.22
    // Chip central core
    addLine(center.x - s, center.y - s, center.x + s, center.y - s, 6)
    addLine(center.x + s, center.y - s, center.x + s, center.y + s, 6)
    addLine(center.x + s, center.y + s, center.x - s, center.y + s, 6)
    addLine(center.x - s, center.y + s, center.x - s, center.y - s, 6)
    // Silicon inner die
    addCircle(center.x, center.y, s * 0.45, 12)
    // Connector pins
    for (let offset = -s * 0.6; offset <= s * 0.61; offset += s * 0.6) {
      addLine(center.x + offset, center.y - s, center.x + offset, center.y - s - unit * 0.08, 3)
      addLine(center.x + offset, center.y + s, center.x + offset, center.y + s + unit * 0.08, 3)
      addLine(center.x - s, center.y + offset, center.x - s - unit * 0.08, center.y + offset, 3)
      addLine(center.x + s, center.y + offset, center.x + s + unit * 0.08, center.y + offset, 3)
    }
  } else if (kind === 'billing') {
    // Gorgeous credit card with magnetic strip & chip details
    const w = unit * 0.28
    const h = unit * 0.19
    // Outer card edge
    addLine(center.x - w, center.y - h, center.x + w, center.y - h, 6)
    addLine(center.x + w, center.y - h, center.x + w, center.y + h, 5)
    addLine(center.x + w, center.y + h, center.x - w, center.y + h, 6)
    addLine(center.x - w, center.y + h, center.x - w, center.y - h, 5)
    // Magnetic swipe strip
    addLine(center.x - w, center.y - h * 0.4, center.x + w, center.y - h * 0.4, 6)
    // Small EMV chip box
    const cs = unit * 0.06
    const cx = center.x - w * 0.6
    const cy = center.y + h * 0.2
    addLine(cx - cs, cy - cs, cx + cs, cy - cs, 2)
    addLine(cx + cs, cy - cs, cx + cs, cy + cs, 2)
    addLine(cx + cs, cy + cs, cx - cs, cy + cs, 2)
    addLine(cx - cs, cy + cs, cx - cs, cy - cs, 2)
  } else if (kind === 'security') {
    // High-tech rounded padlock
    const w = unit * 0.20
    const h = unit * 0.17
    const topY = center.y + unit * 0.02
    // Bottom lock box
    addLine(center.x - w, topY - h, center.x + w, topY - h, 5)
    addLine(center.x + w, topY - h, center.x + w, topY + h, 4)
    addLine(center.x + w, topY + h, center.x - w, topY + h, 5)
    addLine(center.x - w, topY + h, center.x - w, topY - h, 4)
    // Padlock U-shackle arch
    addCircle(center.x, topY - h, w * 0.72, 14, Math.PI, Math.PI * 2)
    // Symmetrical keyhole dot
    addCircle(center.x, topY, unit * 0.035, 8)
  } else if (kind === 'settings') {
    // Beautiful settings mechanics gear cogwheel
    const rInner = unit * 0.10
    const rOuter = unit * 0.22
    addCircle(center.x, center.y, rInner, 12)
    // 8 gear cog teeth
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI * 2) / 8
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      // Tooth root to tip
      addLine(center.x + cos * rInner, center.y + sin * rInner, center.x + cos * rOuter, center.y + sin * rOuter, 3)
      // Small horizontal tip notch
      const notchW = unit * 0.04
      const nx = -sin * notchW
      const ny = cos * notchW
      const tx = center.x + cos * rOuter
      const ty = center.y + sin * rOuter
      addLine(tx - nx, ty - ny, tx + nx, ty + ny, 2)
    }
  } else {
    // kind === 'toggle'
    // Beautiful double-chevron collapse/expand toggle indicator pointing left (<)
    const s = unit * 0.18
    addLine(center.x + s * 0.5, center.y - s, center.x - s * 0.5, center.y, 4)
    addLine(center.x - s * 0.5, center.y, center.x + s * 0.5, center.y + s, 4)
    addLine(center.x + s * 1.0, center.y - s, center.x, center.y, 4)
    addLine(center.x, center.y, center.x + s * 1.0, center.y + s, 4)
  }

  return { pts, edges }
}

export function AccountIconCanvas({ kind, color }: { kind: PageId | 'toggle'; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d', { alpha: true })
    if (!canvas || !ctx) return
    const canvasEl: HTMLCanvasElement = canvas
    const context: CanvasRenderingContext2D = ctx

    let width = 1
    let height = 1
    let points: ParticlePoint[] = []
    let edges: ParticleEdge[] = []
    let particles: ParticleShape[] = []
    let hovering = false
    let frame = 0
    const pointer = { x: -9999, y: -9999, active: false }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    function fit() {
      const rect = canvasEl.getBoundingClientRect()
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvasEl.width = Math.round(width * ratio)
      canvasEl.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }

    function build() {
      const count = Math.min(125, Math.max(76, Math.round((width * height) / 13)))
      particles = []
      for (let i = 0; i < count; i++) {
        const target = points[i % Math.max(points.length, 1)] || { x: width / 2, y: height / 2 }
        particles.push({
          x: target.x + (Math.random() - 0.5) * 1.5,
          y: target.y + (Math.random() - 0.5) * 1.5,
          vx: 0,
          vy: 0,
          base: target,
          phase: Math.random() * Math.PI * 2,
          size: Math.random() * 0.9 + 0.6,
          isChaotic: Math.random() > 0.98,
        })
      }
    }

    function resize() {
      fit()
      const shape = makeAccountIconTargets(kind, width, height)
      points = shape.pts
      edges = shape.edges
      build()
    }

    function animate(t: number) {
      context.clearRect(0, 0, width, height)
      const active = hovering || pointer.active

      // The vector lines are ALWAYS drawn (DA is pre-drawn as requested)
      if (edges.length) {
        context.save()
        context.strokeStyle = color
        context.lineCap = 'round'

        // Background soft blur line glow
        context.globalAlpha = active ? 0.26 : 0.12
        context.lineWidth = 3.6
        context.beginPath()
        edges.forEach(([a, b]) => {
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
        })
        context.stroke()

        // Crisp vector wireframe core
        context.globalAlpha = active ? 0.76 : 0.38
        context.lineWidth = 1.2
        context.beginPath()
        edges.forEach(([a, b]) => {
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
        })
        context.stroke()
        context.restore()

        // Running laser spark signals
        const every = Math.max(2, Math.floor(edges.length / 5))
        for (let i = 0; i < edges.length; i += every) {
          const [a, b] = edges[i]
          const progress = (t * 0.00035 + i * 0.15) % 1
          const x = a.x + (b.x - a.x) * progress
          const y = a.y + (b.y - a.y) * progress
          context.globalAlpha = active ? 0.95 : 0.55
          context.fillStyle = '#ffffff'
          context.beginPath()
          context.arc(x, y, active ? 1.6 : 1.1, 0, Math.PI * 2)
          context.fill()
        }
      }

      for (const p of particles) {
        let ax = 0
        let ay = 0

        // Assembled target pulling is active by default to lock in shapes
        if (p.isChaotic) {
          ax = (Math.random() - 0.5) * 0.02
          ay = (Math.random() - 0.5) * 0.02
          p.vx = (p.vx + ax) * 0.98
          p.vy = (p.vy + ay) * 0.98
        } else {
          // Slow organic breathing frequency
          const tx = p.base.x + Math.cos(t * 0.0016 + p.phase) * (active ? 0.9 : 0.4)
          const ty = p.base.y + Math.sin(t * 0.0016 + p.phase) * (active ? 0.9 : 0.4)
          const stiffness = active ? 0.076 : 0.046
          ax = (tx - p.x) * stiffness
          ay = (ty - p.y) * stiffness

          if (active && pointer.active) {
            const dx = p.x - pointer.x
            const dy = p.y - pointer.y
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist < 42) {
              const force = (1 - dist / 42) * 0.38
              ax += (dx / (dist || 1)) * force * 1.5
              ay += (dy / (dist || 1)) * force * 1.5
            }
          }
          p.vx = (p.vx + ax) * 0.82
          p.vy = (p.vy + ay) * 0.82
        }

        if (p.x < 0) p.x = width
        if (p.x > width) p.x = 0
        if (p.y < 0) p.y = height
        if (p.y > height) p.y = 0

        p.x += p.vx
        p.y += p.vy

        // High contrast dot core (always visible and dynamic)
        context.globalAlpha = active ? 0.98 : 0.52
        context.fillStyle = color
        context.beginPath()
        context.arc(p.x, p.y, p.size * (active ? 1.25 : 0.9), 0, Math.PI * 2)
        context.fill()
      }

      context.globalAlpha = 1
      if (!reducedMotion) frame = window.requestAnimationFrame(animate)
    }

    const card = canvasEl.closest('a') || canvasEl.closest('button')
    const onEnter = () => { hovering = true }
    const onMove = (e: Event) => {
      const pe = e as PointerEvent
      const rect = canvasEl.getBoundingClientRect()
      pointer.x = pe.clientX - rect.left
      pointer.y = pe.clientY - rect.top
      pointer.active = pointer.x >= 0 && pointer.x <= rect.width && pointer.y >= 0 && pointer.y <= rect.height
    }
    const onLeave = () => {
      hovering = false
      pointer.active = false
      pointer.x = -9999
      pointer.y = -9999
    }

    const obs = new ResizeObserver(resize)
    obs.observe(canvasEl)
    card?.addEventListener('pointerenter', onEnter)
    card?.addEventListener('pointermove', onMove, { passive: true })
    card?.addEventListener('pointerleave', onLeave)
    resize()
    frame = window.requestAnimationFrame(animate)

    return () => {
      obs.disconnect()
      card?.removeEventListener('pointerenter', onEnter)
      card?.removeEventListener('pointermove', onMove)
      card?.removeEventListener('pointerleave', onLeave)
      window.cancelAnimationFrame(frame)
    }
  }, [kind, color])

  return <canvas ref={canvasRef} className="h-full w-full block bg-transparent" />
}

type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  content: string
  createdAt: number
  tps?: number
  totalTokens?: number
  latencyMs?: number
}
type ChatUsage = { totalTokens?: number; completionTokens?: number; latencyMs?: number; tps?: number; conversationId?: string }
type AccountWorker = {
  peerId: string
  mode: string
  model: string | null
  gpuName: string | null
  gpuVramMb: number
  allocatedVramMb: number
  memoryLimitPercent: number
  runtimeBackend: string | null
  weightQuantization: string | null
  tokensGenerated: number
  tokensIn: number
  tokensOut: number
  p2pPeers: number
  lastHeartbeatAt: string | null
  secondsSinceHeartbeat: number
  online: boolean
}
type AccountModel = {
  id: string
  label: string
  family: string
  source: string
  workersOnline: number
  workersTotal: number
  requiredWorkers?: number
  lastSeenAt: string | null
  local: boolean
  ready: boolean
  runnable?: boolean
}
type ChatThread = {
  id: string
  title: string
  updatedAt: number
  turns: number
  totalTokens: number
  sessions: AccountSessionSummary[]
}
type ChatAttachment = {
  id: string
  name: string
  type: string
  size: number
  kind: 'image' | 'file'
  text?: string
  dataUrl?: string
}

const pages: Array<{ id: PageId; path: string; label: string; hint: string; icon: typeof IconLayoutGrid }> = [
  { id: 'overview', path: '/compte', label: 'Vue', hint: 'Résumé', icon: IconLayoutGrid },
  { id: 'chat', path: '/compte/chat', label: 'Chat', hint: 'Assistant Vryx', icon: IconCode },
  { id: 'api', path: '/compte/api', label: 'API', hint: 'Clés & crédits', icon: IconTerminal },
  { id: 'usage', path: '/compte/usage', label: 'Usage', hint: 'Sessions', icon: IconBolt },
  { id: 'workers', path: '/compte/workers', label: 'Workers', hint: 'GPU liés', icon: IconGpu },
  { id: 'billing', path: '/compte/facturation', label: 'Billing', hint: 'Coûts', icon: IconCredit },
  { id: 'security', path: '/compte/securite', label: 'Sécurité', hint: 'Accès', icon: IconShield },
  { id: 'settings', path: '/compte/reglages', label: 'Réglages', hint: 'Préférences', icon: IconGpu },
]

const pageByPath = new Map(pages.map((page) => [page.path, page]))

type Digest = {
  completedSessions: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  totalLatencyMs: number
  avgTps: number
  avgPingMs: number | null
  avgMsPerToken: number | null
}

function money(value: number, digits = 2) {
  return value.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function integer(value: number) {
  return Math.round(value || 0).toLocaleString('fr-FR')
}

function compact(value: number) {
  return Math.round(value || 0).toLocaleString('fr-FR', { notation: Math.abs(value) >= 100_000 ? 'compact' : 'standard' })
}

function paginationItems(current: number, total: number) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
  const items: Array<number | 'ellipsis-left' | 'ellipsis-right'> = [1]
  if (current > 4) items.push('ellipsis-left')
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  for (let page = start; page <= end; page += 1) items.push(page)
  if (current < total - 3) items.push('ellipsis-right')
  items.push(total)
  return items
}

function dateTime(value: string | null | undefined) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
}

function digestSessions(sessions: AccountSessionSummary[]): Digest {
  const completed = sessions.filter((s) => s.totalTokens > 0 || s.completionTokens > 0)
  const totalPromptTokens = completed.reduce((sum, s) => sum + s.promptTokens, 0)
  const totalCompletionTokens = completed.reduce((sum, s) => sum + s.completionTokens, 0)
  const totalTokens = completed.reduce((sum, s) => sum + s.totalTokens, 0)
  const totalLatencyMs = completed.reduce((sum, s) => sum + Math.max(0, s.latencyMs || s.computeTimeMs || 0), 0)
  const pingSamples = completed.map((s) => s.pingMs).filter((v): v is number => Number.isFinite(v))
  return {
    completedSessions: completed.length,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    totalLatencyMs,
    avgTps: totalLatencyMs > 0 && totalCompletionTokens > 0 ? totalCompletionTokens / (totalLatencyMs / 1000) : 0,
    avgPingMs: pingSamples.length ? pingSamples.reduce((sum, v) => sum + v, 0) / pingSamples.length : null,
    avgMsPerToken: totalCompletionTokens > 0 && totalLatencyMs > 0 ? totalLatencyMs / totalCompletionTokens : null,
  }
}

function currentPage(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '') || '/compte'
  return pageByPath.get(normalized) ?? pages.find((page) => normalized.startsWith(`${page.path}/`)) ?? pages[0]
}

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-[var(--landing-line)] bg-[var(--landing-card)] shadow-sm backdrop-blur-xl transition-all duration-300 hover:border-[rgba(99,102,241,0.32)] hover:shadow-md hover:shadow-blue-100/60 dark:hover:shadow-none text-[var(--landing-ink)] ${className}`}>
      {children}
    </div>
  )
}

function Kpi({
  title,
  value,
  detail,
  tone = 'cyan',
}: {
  title: string
  value: string
  detail: string
  tone?: 'cyan' | 'emerald' | 'violet' | 'amber'
}) {
  const tones = {
    cyan: { bar: 'from-sky-400  via-cyan-400  to-blue-400', val: 'text-sky-600    dark:text-sky-400' },
    emerald: { bar: 'from-emerald-400 via-teal-400 to-green-400', val: 'text-emerald-600 dark:text-emerald-400' },
    violet: { bar: 'from-violet-400 via-purple-400 to-fuchsia-400', val: 'text-violet-600 dark:text-violet-400' },
    amber: { bar: 'from-amber-400  via-orange-400 to-yellow-400', val: 'text-amber-600   dark:text-amber-400' },
  }
  const { bar, val } = tones[tone]
  return (
    <Panel className="overflow-hidden">
      <div className={`h-1 bg-gradient-to-r ${bar} opacity-90`} />
      <div className="p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--landing-muted)]">{title}</p>
        <p className={`mt-3 font-display text-3xl font-bold tracking-tight ${val}`}>{value}</p>
        <p className="mt-2 text-sm text-[var(--landing-muted)]">{detail}</p>
      </div>
    </Panel>
  )
}

function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow: string
  title: string
  subtitle: string
  action?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--landing-accent)]">{eyebrow}</p>
        <h1 className="mt-3 max-w-4xl font-display text-4xl font-bold tracking-tight text-[var(--landing-ink)] sm:text-5xl">{title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--landing-muted)] sm:text-base">{subtitle}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

function parseSseEvents(buffer: string) {
  const blocks = buffer.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events = blocks
    .map((block) =>
      block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n'),
    )
    .filter(Boolean)
  return { events, rest }
}

function lastUserPrompt(prompt: string) {
  const matches = [...String(prompt || '').matchAll(/(?:^|\n)user:\s*([\s\S]*?)(?=\n(?:assistant|system|user):|$)/gi)]
  const last = matches.at(-1)?.[1]?.trim()
  return (last || prompt || '')
    .replace(/\n\nContexte des pièces jointes:[\s\S]*$/i, '')
    .replace(/^user:\s*/i, '')
    .replace(/\n\nPièces jointes:[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function sessionDisplayTitle(session: AccountSessionSummary | undefined) {
  if (!session) return 'Nouvelle conversation'
  const raw = session.conversationTitle || lastUserPrompt(session.prompt) || 'Nouvelle conversation'
  return raw.length > 58 ? `${raw.slice(0, 58).trim()}...` : raw
}

function modelSupportsVisionClient(model: string) {
  return /(vision|vl|v-l|llava|pixtral|qwen.*vl|mllama|multi[-_]?modal)/i.test(model)
}

function isTextUpload(file: File) {
  const name = file.name.toLowerCase()
  return (
    file.type.startsWith('text/') ||
    /(\.txt|\.md|\.markdown|\.json|\.jsonl|\.csv|\.tsv|\.log|\.yaml|\.yml|\.xml|\.html|\.css|\.js|\.jsx|\.ts|\.tsx|\.py|\.rs|\.go|\.java|\.c|\.cpp|\.h|\.sql|\.sh|\.env)$/i.test(name)
  )
}

function readFileText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(`Lecture impossible: ${file.name}`))
    reader.readAsText(file)
  })
}

function readFileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(`Lecture impossible: ${file.name}`))
    reader.readAsDataURL(file)
  })
}

export function AccountPage() {
  const { user, loading, refresh, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const formId = useId()
  const googleHandledRef = useRef(false)
  const accountLoadedRef = useRef(false)
  const newKeyRef = useRef<HTMLInputElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const hasGoogleCode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('code')

  const [googleStatus, setGoogleStatus] = useState<'idle' | 'processing' | 'error'>(hasGoogleCode ? 'processing' : 'idle')
  const [googleError, setGoogleError] = useState('')
  const [overview, setOverview] = useState<AccountOverview | null>(null)
  const [billing, setBilling] = useState<AccountBilling | null>(null)
  const [apiKeys, setApiKeys] = useState<AccountApiKey[]>([])
  const [sessions, setSessions] = useState<AccountSessionSummary[]>([])
  const [workers, setWorkers] = useState<AccountWorker[]>([])
  const [models, setModels] = useState<AccountModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [workersPage, setWorkersPage] = useState(1)
  const [usagePage, setUsagePage] = useState(1)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [accountLoading, setAccountLoading] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [newKeyName, setNewKeyName] = useState('Cursor Vryx')
  const [creatingKey, setCreatingKey] = useState(false)
  const [generatedKey, setGeneratedKey] = useState('')
  const [copiedKey, setCopiedKey] = useState('')
  const [actionError, setActionError] = useState('')
  const [checkoutLoadingAmount, setCheckoutLoadingAmount] = useState<number | null>(null)
  const [reloading, setReloading] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatLiveStats, setChatLiveStats] = useState<{ tokens: number; tps: number; startedAt: number } | null>(null)
  const [activeConversationId, setActiveConversationId] = useState(`account-conv-${crypto.randomUUID()}`)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [chatSystemContext, setChatSystemContext] = useState(() => {
    try { return localStorage.getItem('vryx-chat-context') || '' } catch { return '' }
  })
  const [chatContextPanelOpen, setChatContextPanelOpen] = useState(false)
  const [chatContextDraft, setChatContextDraft] = useState('')

  const activePage = currentPage(location.pathname)
  const activeColor = pageColors[activePage.id] || '#38bdf8'
  const digest = useMemo(() => digestSessions(sessions), [sessions])
  const usagePercent = overview ? Math.max(0, Math.min(100, overview.usagePercent || 0)) : 0
  const estimatedMonthly = overview ? (overview.spendThisMonth / Math.max(1, new Date().getDate())) * 30 : 0
  const eurPerMillion = overview && overview.tokensUsed > 0 ? overview.spendThisMonth / (overview.tokensUsed / 1_000_000) : 0.3
  const investor = overview?.investorMetrics
  const apiBase = 'https://vryx.eu/v1'
  const runnableModels = useMemo(
    () =>
      models.filter((model) => {
        const required = Math.max(1, Number(model.requiredWorkers || 1))
        return Boolean(model.runnable) || Number(model.workersOnline || 0) >= required
      }),
    [models],
  )
  const modelId = selectedModel || runnableModels[0]?.id || ''
  const selectedModelInfo = models.find((model) => model.id === modelId) || runnableModels[0] || null
  const selectedModelSupportsVision = modelSupportsVisionClient(modelId)
  const uploadAccept = selectedModelSupportsVision
    ? 'image/png,image/jpeg,image/webp,image/gif,text/*,.txt,.md,.json,.csv,.log,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.go,.java,.sql,.sh'
    : 'text/*,.txt,.md,.json,.csv,.log,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.go,.java,.sql,.sh'
  const workerPageSize = 5
  const workersTotalPages = Math.max(1, Math.ceil(workers.length / workerPageSize))
  const visibleWorkers = workers.slice((workersPage - 1) * workerPageSize, workersPage * workerPageSize)
  const usagePageSize = 5
  const usageTotalPages = Math.max(1, Math.ceil(sessions.length / usagePageSize))
  const visibleSessions = sessions.slice((usagePage - 1) * usagePageSize, usagePage * usagePageSize)
  const usagePagination = useMemo(() => paginationItems(usagePage, usageTotalPages), [usagePage, usageTotalPages])
  const workersPagination = useMemo(() => paginationItems(workersPage, workersTotalPages), [workersPage, workersTotalPages])
  const chatThreads = useMemo<ChatThread[]>(() => {
    const grouped = new Map<string, AccountSessionSummary[]>()
    for (const session of sessions) {
      const id = session.conversationId || session.id
      grouped.set(id, [...(grouped.get(id) || []), session])
    }
    return Array.from(grouped.entries())
      .map(([id, rows]) => {
        const sorted = [...rows].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        const first = sorted[0]
        const latest = sorted.at(-1)
        return {
          id,
          title: sessionDisplayTitle(first || latest),
          updatedAt: latest?.timestamp || 0,
          turns: sorted.length,
          totalTokens: sorted.reduce((sum, item) => sum + (item.totalTokens || 0), 0),
          sessions: sorted,
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions])

  const loadAccountData = useCallback(async () => {
    if (!user) return
    if (!accountLoadedRef.current) setAccountLoading(true)
    setAccountError('')
    const [overviewResult, billingResult, keysResult, sessionsResult, workersResult, modelsResult] = await Promise.all([
      fetchAccountOverview(),
      fetchAccountBilling(),
      fetchAccountApiKeys(),
      fetchAccountSessions(120),
      apiJson<{ workers: AccountWorker[] }>('/api/account/workers'),
      apiJson<{ models: AccountModel[]; defaultModel?: string | null }>('/api/account/models'),
    ])
    const errors: string[] = []
    if (overviewResult.ok) setOverview(overviewResult.data)
    else errors.push(`Résumé: ${overviewResult.error}`)
    if (billingResult.ok) setBilling(billingResult.billing)
    else errors.push(`Facturation: ${billingResult.error}`)
    if (keysResult.ok) setApiKeys(keysResult.keys)
    else errors.push(`Clés API: ${keysResult.error}`)
    if (sessionsResult.ok) setSessions(sessionsResult.sessions)
    else errors.push(`Sessions: ${sessionsResult.error}`)
    if (workersResult.ok) setWorkers(Array.isArray(workersResult.data.workers) ? workersResult.data.workers : [])
    else errors.push(`Workers: ${workersResult.error}`)
    if (modelsResult.ok === true) {
      const nextModels = Array.isArray(modelsResult.data.models) ? modelsResult.data.models : []
      setModels(nextModels)
      setSelectedModel((current) => {
        if (current && nextModels.some((model) => model.id === current)) return current
        return (
          modelsResult.data.defaultModel ||
          nextModels.find((model) => {
            const required = Math.max(1, Number(model.requiredWorkers || 1))
            return Boolean(model.runnable) || Number(model.workersOnline || 0) >= required
          })?.id ||
          ''
        )
      })
    } else {
      errors.push(`Modèles: ${modelsResult.error}`)
    }
    setAccountError(errors.join(' | '))
    accountLoadedRef.current = true
    setAccountLoading(false)
  }, [user])

  const refreshData = useCallback(async () => {
    setReloading(true)
    try {
      await loadAccountData()
    } finally {
      setReloading(false)
    }
  }, [loadAccountData])

  useEffect(() => {
    if (!hasGoogleCode || googleHandledRef.current) return
    googleHandledRef.current = true
    const params = new URLSearchParams(window.location.search)
      ; (async () => {
        setGoogleStatus('processing')
        const r = await apiJson<{ token?: string; desktop?: boolean; next?: string }>('/api/auth/google/finish', {
          method: 'POST',
          body: JSON.stringify({ code: params.get('code') || '', state: params.get('state') || '' }),
        })
        if (r.ok === false) {
          setGoogleError(r.error)
          setGoogleStatus('error')
          return
        }
        await refresh()
        if (r.data.desktop && r.data.token) {
          window.location.href = `vryx://auth?token=${encodeURIComponent(r.data.token)}`
        }
        window.history.replaceState({}, '', r.data.next && r.data.next.startsWith('/') ? r.data.next : '/compte')
        setGoogleStatus('idle')
      })()
  }, [hasGoogleCode, refresh])

  useEffect(() => {
    if (!loading && user) void refreshData()
  }, [loading, user, refreshData])

  useEffect(() => {
    if (workersPage > workersTotalPages) setWorkersPage(workersTotalPages)
  }, [workersPage, workersTotalPages])

  useEffect(() => {
    if (usagePage > usageTotalPages) setUsagePage(usageTotalPages)
  }, [usagePage, usageTotalPages])

  useEffect(() => {
    if (selectedModelSupportsVision) return
    setChatAttachments((prev) => prev.filter((attachment) => attachment.kind !== 'image'))
  }, [selectedModelSupportsVision])

  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (loading || !user) return
    const id = window.setInterval(() => {
      if (!accountLoading) void refreshData()
    }, 45_000)
    return () => window.clearInterval(id)
  }, [accountLoading, loading, refreshData, user])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chatMessages, chatLoading])

  const copyText = useCallback(async (text: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      newKeyRef.current?.select()
      setActionError('Sélectionné. Appuyez sur Cmd+C.')
    }
  }, [])

  const copyWithFeedback = useCallback(
    async (key: string, text: string) => {
      await copyText(text)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((current) => (current === key ? '' : current)), 1500)
    },
    [copyText],
  )

  const createKey = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      const name = newKeyName.trim()
      if (!name || creatingKey) return
      setActionError('')
      setCreatingKey(true)
      const r = await createAccountApiKey(name)
      setCreatingKey(false)
      if (!r.ok) {
        setActionError(r.error)
        return
      }
      setApiKeys((prev) => [{ ...r.payload.key, lastUsedAt: r.payload.key.lastUsedAt ?? null }, ...prev])
      setGeneratedKey(r.payload.plainKey)
      window.setTimeout(() => {
        newKeyRef.current?.focus()
        newKeyRef.current?.select()
      }, 80)
      void refreshData()
    },
    [creatingKey, newKeyName, refreshData],
  )

  const revokeKey = useCallback(async (id: string) => {
    const r = await revokeAccountApiKey(id)
    if (!r.ok) {
      setActionError(r.error)
      return
    }
    setApiKeys((prev) => prev.filter((k) => k.id !== id))
  }, [])

  const startCheckout = useCallback(async (amountEur: number) => {
    if (checkoutLoadingAmount != null) return
    setActionError('')
    setCheckoutLoadingAmount(amountEur)
    const r = await createBillingCheckout(amountEur)
    setCheckoutLoadingAmount(null)
    if (!r.ok) {
      setActionError(r.error)
      return
    }
    window.location.href = r.url
  }, [checkoutLoadingAmount])

  const clearSessions = useCallback(async () => {
    const r = await apiJson<{ ok: true }>('/api/account/sessions', { method: 'DELETE' })
    if (!r.ok) {
      setActionError(r.error)
      return
    }
    setActiveConversationId(`account-conv-${crypto.randomUUID()}`)
    setChatMessages([])
    await refreshData()
  }, [refreshData])

  const startNewConversation = useCallback(() => {
    setActiveConversationId(`account-conv-${crypto.randomUUID()}`)
    setChatMessages([])
    setChatLiveStats(null)
  }, [])

  const deleteThread = useCallback(async (threadId: string) => {
    setSessions((prev) => prev.filter((s) => (s.conversationId || s.id) !== threadId))
    if (threadId === activeConversationId) {
      setActiveConversationId(`account-conv-${crypto.randomUUID()}`)
      setChatMessages([])
      setChatLiveStats(null)
    }
    // Fire-and-forget: best-effort server delete
    void apiJson<{ ok: true }>(`/api/account/sessions?conversationId=${encodeURIComponent(threadId)}`, { method: 'DELETE' }).catch(() => null)
  }, [activeConversationId])

  const saveContext = useCallback((ctx: string) => {
    setChatSystemContext(ctx)
    try { localStorage.setItem('vryx-chat-context', ctx) } catch { /* noop */ }
    setChatContextPanelOpen(false)
  }, [])

  const openConversation = useCallback((thread: ChatThread) => {
    const messages: ChatMessage[] = []
    for (const session of thread.sessions) {
      const userContent = lastUserPrompt(session.prompt)
      if (userContent) {
        messages.push({
          id: `${session.id}-user`,
          role: 'user',
          content: userContent,
          createdAt: session.timestamp || Date.now(),
        })
      }
      if (session.response) {
        messages.push({
          id: `${session.id}-assistant`,
          role: 'assistant',
          content: session.response,
          createdAt: (session.timestamp || Date.now()) + 1,
          totalTokens: session.totalTokens,
          latencyMs: session.latencyMs || session.computeTimeMs,
          tps:
            session.completionTokens > 0 && (session.latencyMs || session.computeTimeMs || 0) > 0
              ? session.completionTokens / ((session.latencyMs || session.computeTimeMs || 1) / 1000)
              : undefined,
        })
      }
    }
    setActiveConversationId(thread.id)
    setChatMessages(messages)
    setChatLiveStats(null)
  }, [])

  const handleUploadFiles = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files || [])
      event.currentTarget.value = ''
      if (files.length === 0) return
      setActionError('')
      const remainingSlots = Math.max(0, 6 - chatAttachments.length)
      if (remainingSlots <= 0) {
        setActionError('Limite atteinte: 6 pièces jointes maximum par message.')
        return
      }
      const accepted: ChatAttachment[] = []
      for (const file of files.slice(0, remainingSlots)) {
        try {
          if (file.type.startsWith('image/')) {
            if (!selectedModelSupportsVision) {
              setActionError(`Images désactivées pour ${modelId || 'ce modèle'}: choisissez un modèle Vision/VL.`)
              continue
            }
            if (file.size > 2_500_000) {
              setActionError(`Image trop lourde: ${file.name}. Limite: 2,5 Mo.`)
              continue
            }
            accepted.push({
              id: crypto.randomUUID(),
              name: file.name,
              type: file.type || 'image',
              size: file.size,
              kind: 'image',
              dataUrl: await readFileDataUrl(file),
            })
            continue
          }
          if (!isTextUpload(file)) {
            setActionError(`Fichier non lisible en texte: ${file.name}. Utilise un fichier texte/code, ou un modèle vision pour les images.`)
            continue
          }
          if (file.size > 400_000) {
            setActionError(`Fichier trop lourd: ${file.name}. Limite texte: 400 Ko.`)
            continue
          }
          accepted.push({
            id: crypto.randomUUID(),
            name: file.name,
            type: file.type || 'text/plain',
            size: file.size,
            kind: 'file',
            text: (await readFileText(file)).slice(0, 80_000),
          })
        } catch (e) {
          setActionError(e instanceof Error ? e.message : `Lecture impossible: ${file.name}`)
        }
      }
      if (accepted.length > 0) setChatAttachments((prev) => [...prev, ...accepted])
    },
    [chatAttachments.length, modelId, selectedModelSupportsVision],
  )

  const removeAttachment = useCallback((id: string) => {
    setChatAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
  }, [])

  const handleLogout = useCallback(async () => {
    await logout()
    navigate('/connexion')
  }, [logout, navigate])

  const sendChat = useCallback(
    async (text?: string) => {
      const content = (text ?? chatInput).trim()
      if ((!content && chatAttachments.length === 0) || chatLoading) return
      if (!modelId) {
        setActionError('Aucun modèle exécutable pour le moment. Llama2 70B demande 2 workers compatibles en ligne ; relance le second worker ou choisis un modèle avec assez de workers.')
        return
      }
      setActionError('')
      setChatInput('')
      const outgoingAttachments = [...chatAttachments]
      setChatAttachments([])
      const attachmentLabel = outgoingAttachments.length
        ? `\n\nPièces jointes: ${outgoingAttachments.map((attachment) => attachment.name).join(', ')}`
        : ''
      const messageContent = `${content || 'Analyse les pièces jointes.'}${attachmentLabel}`
      const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: messageContent, createdAt: Date.now() }
      const nextMessages = [...chatMessages, userMessage]
      const assistantId = crypto.randomUUID()
      setChatMessages([
        ...nextMessages,
        { id: assistantId, role: 'assistant', content: '', createdAt: Date.now() },
      ])
      setChatLoading(true)
      const startedAt = Date.now()
      setChatLiveStats({ tokens: 0, tps: 0, startedAt })
      const payloadMessages = [
        ...(chatSystemContext.trim() ? [{ role: 'system' as const, content: chatSystemContext.trim() }] : []),
        ...nextMessages.slice(-12).map((message) => ({ role: message.role, content: message.content }))
      ]
      let queued = ''
      let rendered = ''
      let tokenFragments = 0
      let finalUsage: ChatUsage = {}
      const updateAssistant = (patch: Partial<ChatMessage>) => {
        setChatMessages((prev) => prev.map((message) => (message.id === assistantId ? { ...message, ...patch } : message)))
      }
      const flush = window.setInterval(() => {
        if (!queued) return
        const take = Math.max(1, Math.min(queued.length, queued.length > 80 ? 8 : 3))
        rendered += queued.slice(0, take)
        queued = queued.slice(take)
        updateAssistant({ content: rendered })
      }, 14)
      try {
        const response = await fetch(apiUrl('/api/account/chat/stream'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId || undefined,
            max_tokens: 192,
            quantization: 'q4',
            conversation_id: activeConversationId,
            attachments: outgoingAttachments.map((attachment) => ({
              name: attachment.name,
              type: attachment.type,
              size: attachment.size,
              kind: attachment.kind,
              text: attachment.text,
              dataUrl: attachment.dataUrl,
            })),
            messages: payloadMessages,
          }),
        })
        if (!response.ok || !response.body) {
          const raw = await response.text().catch(() => '')
          throw new Error(raw || `Erreur HTTP ${response.status}`)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = parseSseEvents(buffer)
          buffer = parsed.rest
          for (const raw of parsed.events) {
            let event: { token?: string; error?: string; done?: boolean; usage?: typeof finalUsage; status?: string } | null = null
            try {
              event = JSON.parse(raw)
            } catch {
              event = null
            }
            if (!event) continue
            if (event.error) throw new Error(event.error)
            if (typeof event.token === 'string' && event.token) {
              queued += event.token
              tokenFragments += 1
              const elapsed = Math.max(0.25, (Date.now() - startedAt) / 1000)
              setChatLiveStats({ tokens: tokenFragments, tps: tokenFragments / elapsed, startedAt })
            }
            if (event.done) finalUsage = event.usage ?? {}
          }
        }
        while (queued) {
          await new Promise((resolve) => window.setTimeout(resolve, 12))
        }
        const totalTokens = finalUsage.totalTokens ?? tokenFragments
        const latencyMs = finalUsage.latencyMs ?? Date.now() - startedAt
        const tps = finalUsage.tps ?? (tokenFragments > 0 ? tokenFragments / Math.max(0.25, latencyMs / 1000) : 0)
        updateAssistant({ totalTokens, latencyMs, tps, content: rendered || 'Réponse vide.' })
        if (finalUsage.conversationId) setActiveConversationId(finalUsage.conversationId)
        setChatLiveStats({ tokens: totalTokens, tps, startedAt })
        void refreshData()
      } catch (e) {
        updateAssistant({ content: `Erreur Vryx: ${e instanceof Error ? e.message : 'stream interrompu.'}` })
      } finally {
        window.clearInterval(flush)
        if (queued) {
          rendered += queued
          updateAssistant({ content: rendered })
        }
        setChatLoading(false)
      }
    },
    [activeConversationId, chatAttachments, chatInput, chatLoading, chatMessages, chatSystemContext, modelId, refreshData],
  )

  const onChatKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      void sendChat()
    },
    [sendChat],
  )

function VryxLoadingScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationFrameId: number
    let width = (canvas.width = window.innerWidth)
    let height = (canvas.height = window.innerHeight)

    class Particle {
      x: number
      y: number
      vx: number
      vy: number
      radius: number
      color: string
      alpha: number

      constructor() {
        this.x = Math.random() * width
        this.y = Math.random() * height
        this.vx = (Math.random() - 0.5) * 0.4
        this.vy = (Math.random() - 0.5) * 0.4
        this.radius = Math.random() * 2 + 0.5
        this.color = Math.random() > 0.5 ? '167, 139, 250' : '56, 189, 248'
        this.alpha = Math.random() * 0.5 + 0.2
      }

      update() {
        this.x += this.vx
        this.y += this.vy

        if (this.x < 0) this.x = width
        if (this.x > width) this.x = 0
        if (this.y < 0) this.y = height
        if (this.y > height) this.y = 0

        this.alpha = Math.max(0.1, Math.min(0.8, this.alpha + (Math.random() - 0.5) * 0.02))
      }

      draw(c: CanvasRenderingContext2D) {
        c.beginPath()
        c.arc(this.x, this.y, this.radius, 0, Math.PI * 2)
        c.fillStyle = `rgba(${this.color}, ${this.alpha})`
        c.fill()
      }
    }

    const particles: Particle[] = Array.from({ length: 80 }, () => new Particle())

    const handleResize = () => {
      if (!canvas) return
      width = canvas.width = window.innerWidth
      height = canvas.height = window.innerHeight
    }
    window.addEventListener('resize', handleResize)

    const animate = () => {
      ctx.clearRect(0, 0, width, height)

      const grad = ctx.createRadialGradient(width * 0.5, height * 0.5, 0, width * 0.5, height * 0.5, Math.max(width, height))
      grad.addColorStop(0, '#060a17')
      grad.addColorStop(0.5, '#04060f')
      grad.addColorStop(1, '#020307')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, width, height)

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const p1 = particles[i]
          const p2 = particles[j]
          const dx = p1.x - p2.x
          const dy = p1.y - p2.y
          const dist = Math.hypot(dx, dy)

          if (dist < 130) {
            const alpha = (1 - dist / 130) * 0.14
            ctx.beginPath()
            ctx.moveTo(p1.x, p1.y)
            ctx.lineTo(p2.x, p2.y)
            ctx.strokeStyle = `rgba(99, 102, 241, ${alpha})`
            ctx.lineWidth = 0.8
            ctx.stroke()
          }
        }
      }

      particles.forEach((p) => {
        p.update()
        p.draw(ctx)
      })

      animationFrameId = requestAnimationFrame(animate)
    }

    animate()

    return () => {
      cancelAnimationFrame(animationFrameId)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return (
    <div className="relative w-full h-dvh flex flex-col items-center justify-center overflow-hidden bg-[#020307]">
      <canvas ref={canvasRef} className="absolute inset-0 block w-full h-full pointer-events-none" />
      <div className="relative z-10 flex flex-col items-center justify-center animate-[fadeIn_.8s_ease-out]">
        <div className="relative flex items-center justify-center">
          <div className="absolute w-56 h-56 rounded-full bg-gradient-to-tr from-sky-400 via-indigo-500 to-purple-600 blur-[80px] opacity-25 animate-pulse" />
          
          <div className="relative w-44 h-44 rounded-full border border-white/10 bg-white/[0.02] backdrop-blur-xl shadow-[0_0_50px_rgba(99,102,241,0.25)] flex items-center justify-center hover:scale-105 transition-transform duration-500">
            <div className="absolute inset-2 rounded-full border border-white/5 bg-gradient-to-tr from-cyan-500/10 via-transparent to-purple-500/10 animate-[spin_8s_linear_infinite]" />
            <div className="absolute inset-4 rounded-full border border-white/5 animate-[spin_12s_linear_infinite_reverse]" />
            
            <VryxLogo variant="mark" tone="light" markSize="lg" className="scale-110 drop-shadow-[0_0_24px_rgba(168,85,247,0.6)]" />
          </div>
        </div>
        
        <div className="mt-8 flex flex-col items-center gap-2">
          <h2 className="font-display text-xl font-bold tracking-[0.2em] uppercase text-white bg-clip-text text-transparent bg-gradient-to-r from-sky-400 via-indigo-300 to-purple-400">
            VryxAI
          </h2>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400 animate-ping" />
            <span className="text-[11px] font-semibold tracking-[0.3em] uppercase text-sky-400/80 font-mono">
              Initialisation du DePIN
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

  if (googleStatus === 'processing' || loading || accountLoading) {
    return <VryxLoadingScreen />
  }

  if (googleStatus === 'error') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
        <Panel className="w-full max-w-md border-alert/30 p-8 text-center">
          <h1 className="font-display text-2xl font-bold text-fg">Connexion impossible</h1>
          <p className="mt-3 text-sm text-muted">{googleError || 'Relancez la connexion depuis Vryx.'}</p>
        </Panel>
      </div>
    )
  }

  if (!user) return <Navigate to="/connexion" replace state={{ from: location.pathname || '/compte' }} />

  const alerts = (
    <>
      {accountError ? <p className="rounded-2xl border border-alert/30 bg-alert/10 px-4 py-3 text-sm text-alert">{accountError}</p> : null}
      {actionError ? <p className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">{actionError}</p> : null}
    </>
  )

  return (
    <div
      className="vryx-landing min-h-dvh text-[var(--landing-ink)] relative overflow-hidden transition-all duration-700 ease-out"
      style={{
        marginTop: 0,
        background: `
          radial-gradient(circle at 15% 15%, ${activeColor}24, transparent 48rem),
          radial-gradient(circle at 85% 30%, ${activeColor}1a, transparent 42rem),
          radial-gradient(circle at 50% 55%, ${activeColor}12, transparent 45rem),
          linear-gradient(180deg, var(--landing-bg) 0%, var(--landing-bg-soft) 44%, var(--landing-bg) 100%)
        `
      }}
    >
      {/* Dynamic Galactic Active Tab Glow backdrop */}
      <div
        className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -z-10 h-[600px] w-full max-w-[1400px] rounded-full blur-[140px] opacity-[0.12] dark:opacity-[0.11] transition-all duration-700 ease-out"
        style={{
          background: `radial-gradient(circle, ${activeColor} 0%, transparent 70%)`
        }}
      />

      <aside className={`fixed inset-y-0 left-0 z-40 hidden rounded-none border-y-0 border-r border-[var(--landing-line)] bg-[var(--landing-card-strong)] py-5 xl:flex xl:flex-col backdrop-blur-xl transition-all duration-300 shadow-[1px_0_24px_rgba(147,197,253,0.18)] dark:shadow-none ${sidebarCollapsed ? 'w-20 px-2' : 'w-72 px-4'}`}>
        <div className={`flex transition-all duration-300 ${sidebarCollapsed ? 'flex-col items-center gap-4 px-0' : 'items-center justify-between gap-3 px-2'}`}>
          {!sidebarCollapsed ? <VryxLogo to="/" markSize="sm" /> : <VryxLogo variant="mark" to="/" markSize="sm" />}
          <button
            type="button"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className={`hidden xl:flex items-center justify-center rounded-lg border border-[var(--landing-line)] bg-white/5 hover:bg-white/10 text-[var(--landing-muted)] hover:text-[var(--landing-ink)] transition-all relative overflow-hidden ${sidebarCollapsed ? 'h-11 w-11' : 'h-9 w-9'
              }`}
            title={sidebarCollapsed ? "Agrandir la sidebar" : "Replier la sidebar"}
          >
            <span className={`w-7 h-7 transition-transform duration-300 ${sidebarCollapsed ? 'rotate-180' : 'rotate-0'}`}>
              <AccountIconCanvas kind="toggle" color="#94a3b8" />
            </span>
          </button>
        </div>
        <nav className="mt-8 flex flex-1 flex-col gap-2" aria-label="Compte">
          {pages.map((page) => {
            const active = page.id === activePage.id
            const pageColor = pageColors[page.id]
            return (
              <Link
                key={page.id}
                to={page.path}
                className={`group flex items-center gap-3 rounded-xl transition-all duration-300 border ${sidebarCollapsed ? 'justify-center px-0 py-3' : 'px-3 py-3'
                  } ${active
                    ? 'text-[var(--landing-ink)] font-semibold shadow-md shadow-black/5'
                    : 'text-[var(--landing-muted)] hover:bg-blue-50/70 dark:hover:bg-white/[0.04] hover:text-[var(--landing-ink)] border-transparent hover:border-blue-100/80 dark:hover:border-transparent'
                  }`}
                style={
                  active
                    ? {
                      backgroundColor: `${pageColor}22`,
                      borderColor: `${pageColor}55`,
                      boxShadow: `0 2px 16px -2px ${pageColor}2e`,
                    }
                    : {}
                }
              >
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg overflow-hidden relative border bg-white/5"
                  style={{
                    borderColor: active ? `${pageColor}44` : 'var(--landing-line)',
                    boxShadow: active ? `0 0 12px -2px ${pageColor}33, inset 0 1px 0 rgba(255,255,255,0.1)` : 'inset 0 1px 0 rgba(255,255,255,0.05)'
                  }}
                >
                  <AccountIconCanvas
                    kind={page.id}
                    color={pageColor}
                  />
                </span>
                {!sidebarCollapsed && (
                  <span className="truncate">
                    <span className="block text-sm font-semibold">{page.label}</span>
                    <span className="block text-xs text-[var(--landing-muted)] group-hover:text-[var(--landing-ink)] transition-colors">{page.hint}</span>
                  </span>
                )}
              </Link>
            )
          })}
        </nav>
        <div className="space-y-3">
          <div className={`rounded-xl p-3 border border-[var(--landing-line)] bg-[var(--landing-card)] backdrop-blur-sm shadow-sm transition-all ${sidebarCollapsed ? 'text-center px-1' : ''}`}>
            {!sidebarCollapsed ? (
              <>
                <p className="truncate font-mono text-xs text-[var(--landing-muted)]">{user.email}</p>
                <p className="mt-1 text-xs font-bold text-[var(--landing-accent)]">{overview?.plan ?? 'Scale'}</p>
              </>
            ) : (
              <span className="text-xs font-bold text-[var(--landing-accent)]">{overview?.plan?.slice(0, 2) ?? 'Sc'}</span>
            )}
          </div>
          <div className={`flex gap-2 transition-all ${sidebarCollapsed ? 'flex-col items-center' : 'items-center'}`}>
            <ThemeToggle menuPlacement="up" menuAlign="left" />
            <button
              type="button"
              onClick={() => void handleLogout()}
              className={`flex h-12 items-center justify-center gap-2 rounded-xl border border-red-400/25 text-sm font-semibold text-red-500 transition hover:bg-red-50 dark:hover:bg-red-500/10 ${sidebarCollapsed ? 'w-12 px-0' : 'flex-1'}`}
              title="Déconnexion"
            >
              <IconLock className="h-4 w-4" aria-hidden />
              {!sidebarCollapsed && "Déconnexion"}
            </button>
          </div>
        </div>
      </aside>

      <main className={`transition-all duration-300 ${sidebarCollapsed ? 'xl:pl-20' : 'xl:pl-72'}`}>
        <div className={`${activePage.id === 'chat' ? 'h-dvh overflow-hidden' : 'mx-auto min-h-dvh max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14'}`}>
          {activePage.id !== 'chat' && (
            <div className="sticky top-3 z-30 mb-5 xl:hidden">
              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--landing-line)] bg-[var(--landing-card-strong)] px-3 py-2.5 shadow-sm shadow-blue-100/40 dark:shadow-none backdrop-blur-xl">
                <VryxLogo to="/" markSize="sm" />
                <div className="flex items-center gap-2">
                  <span className="hidden max-w-[12rem] truncate font-mono text-xs text-[var(--landing-muted)] sm:block">{activePage.label}</span>
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen((open) => !open)}
                    className="flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--landing-line)] bg-white/5 text-[var(--landing-ink)]"
                    aria-label={mobileMenuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
                    aria-expanded={mobileMenuOpen}
                  >
                    <span className="relative block h-4 w-5">
                      <span className={`absolute left-0 h-0.5 w-5 rounded-full bg-current transition ${mobileMenuOpen ? 'top-2 rotate-45' : 'top-0'}`} />
                      <span className={`absolute left-0 top-2 h-0.5 w-5 rounded-full bg-current transition ${mobileMenuOpen ? 'opacity-0' : 'opacity-100'}`} />
                      <span className={`absolute left-0 h-0.5 w-5 rounded-full bg-current transition ${mobileMenuOpen ? 'top-2 -rotate-45' : 'top-4'}`} />
                    </span>
                  </button>
                </div>
              </div>
              {mobileMenuOpen ? (
                <div className="mt-3 rounded-xl p-3 border border-[var(--landing-line)] bg-[var(--landing-card-strong)] shadow-2xl backdrop-blur-lg animate-[fadeIn_.2s_ease-out]">
                  <div className="grid gap-2">
                    {pages.map((page) => {
                      const active = page.id === activePage.id
                      return (
                        <Link
                          key={page.id}
                          to={page.path}
                          className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition ${active
                              ? 'bg-[var(--landing-accent)] text-white shadow-lg'
                              : 'border border-[var(--landing-line)] bg-white/5 text-[var(--landing-muted)] hover:text-[var(--landing-ink)]'
                            }`}
                        >
                          <span className="flex h-9 w-9 items-center justify-center rounded-lg overflow-hidden relative border border-[var(--landing-line)] bg-white/5">
                            <AccountIconCanvas
                              kind={page.id}
                              color={pageColors[page.id]}
                            />
                          </span>
                          <span className="flex-1">
                            <span className="block">{page.label}</span>
                            <span className={`block text-xs font-medium ${active ? 'text-white/80' : 'text-[var(--landing-muted)]'}`}>{page.hint}</span>
                          </span>
                        </Link>
                      )
                    })}
                  </div>
                  <div className="mt-3 grid grid-cols-[auto_1fr] gap-2">
                    <ThemeToggle menuPlacement="down" menuAlign="right" />
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="flex h-12 items-center justify-center gap-2 rounded-xl border border-red-500/20 text-sm font-semibold text-red-500 transition hover:bg-red-500/10"
                    >
                      <IconLock className="h-4 w-4" aria-hidden />
                      Déconnexion
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {(accountError || actionError) && activePage.id !== 'chat' && <div className="mb-5 space-y-2">{alerts}</div>}


          {activePage.id === 'overview' ? (
            <section>
              <PageHeader
                eyebrow="Compte Vryx"
                title="Une console propre pour piloter l'API, les sessions et les coûts."
                subtitle={`Connecté avec ${user.email}. Chaque section est maintenant séparée pour garder un vrai espace de travail.`}
                action={
                  <button
                    type="button"
                    onClick={() => void refreshData()}
                    disabled={reloading}
                    className="rounded-xl border border-[var(--landing-line)] bg-[var(--landing-card)] px-5 py-3 text-sm font-semibold text-[var(--landing-ink)] transition hover:border-[var(--landing-accent)] disabled:opacity-60"
                  >
                    {reloading ? 'Actualisation...' : 'Actualiser'}
                  </button>
                }
              />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi title="Solde" value={`${money(overview?.balanceCredits ?? 0)} €`} detail="Crédits disponibles" tone="emerald" />
                <Kpi title="Dépense mois" value={`${money(overview?.spendThisMonth ?? 0)} €`} detail="Basée sur les sessions réelles" />
                <Kpi title="Tokens utilisés" value={compact(overview?.tokensUsed ?? digest.totalTokens)} detail={`${integer(overview?.monthlyTokenBudget ?? 0)} tokens/mois`} tone="violet" />
                <Kpi title="TPS moyen" value={digest.avgTps.toFixed(2)} detail={`${digest.completedSessions} sessions mesurées`} tone="amber" />
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi
                  title="Latence p95"
                  value={`${integer(investor?.latencyP95Ms ?? 0)} ms`}
                  detail={`p50 ${integer(investor?.latencyP50Ms ?? 0)} ms · ${integer(investor?.sampleSize ?? 0)} samples`}
                />
                <Kpi
                  title="TPS p50 / p95"
                  value={`${money(investor?.tpsP50 ?? 0, 2)} / ${money(investor?.tpsP95 ?? 0, 2)}`}
                  detail="Sessions actives uniquement"
                  tone="emerald"
                />
                <Kpi
                  title="Coût / M tokens"
                  value={`${money(investor?.costPerMillionTokens ?? eurPerMillion, 4)} €`}
                  detail={`marge estimée ${money(investor?.estimatedGrossMarginPercent ?? 0, 0)}%`}
                  tone="violet"
                />
                <Kpi
                  title="Uptime workers"
                  value={`${money(investor?.avgWorkerUptimePercent ?? 0, 1)}%`}
                  detail={`${integer(investor?.liveWorkers ?? 0)} / ${integer(investor?.totalWorkers ?? 0)} worker(s) live`}
                  tone="amber"
                />
              </div>
              <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_22rem]">
                <Panel className="p-6">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-display text-2xl font-bold text-[var(--landing-ink)]">Forfait {overview?.plan ?? 'Scale'}</p>
                      <p className="mt-1 text-sm text-[var(--landing-muted)]">Usage mensuel, clés actives et endpoint prêt pour Cursor.</p>
                    </div>
                    <Link to="/compte/chat" className="inline-flex h-12 items-center justify-center rounded-xl bg-[var(--landing-accent)] px-5 text-sm font-semibold text-white shadow-md shadow-cyan-500/10 transition hover:-translate-y-0.5">
                      Ouvrir le chat
                    </Link>
                  </div>
                  <div className="mt-6 h-4 overflow-hidden rounded-full bg-[var(--landing-line)]">
                    <div className="h-full rounded-full bg-gradient-to-r from-[var(--landing-accent)] via-cyan-400 to-emerald-400" style={{ width: `${usagePercent}%` }} />
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4"><p className="text-sm text-[var(--landing-muted)]">Usage</p><p className="mt-1 font-mono text-lg font-semibold">{Math.round(usagePercent)}%</p></div>
                    <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4"><p className="text-sm text-[var(--landing-muted)]">Clés</p><p className="mt-1 font-mono text-lg font-semibold">{apiKeys.length}</p></div>
                    <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4"><p className="text-sm text-[var(--landing-muted)]">Requêtes</p><p className="mt-1 font-mono text-lg font-semibold">{integer(overview?.requestsThisMonth ?? 0)}</p></div>
                  </div>
                </Panel>
                <Panel className="p-6">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--landing-muted)]">Configuration rapide</p>
                  <button type="button" onClick={() => void copyWithFeedback('overview-api-base', apiBase)} className="mt-4 block w-full rounded-xl border border-[var(--landing-line)] bg-white/5 p-4 text-left hover:border-[var(--landing-accent)] transition">
                    <span className="block text-xs text-[var(--landing-muted)]">Base URL</span>
                    <span className="mt-1 block break-all font-mono text-sm text-[var(--landing-accent)]">{copiedKey === 'overview-api-base' ? 'Copié' : apiBase}</span>
                  </button>
                  <div className="mt-3 rounded-xl border border-[var(--landing-line)] bg-white/5 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-[var(--landing-muted)]">Modèle</span>
                      <button type="button" onClick={() => void copyWithFeedback('overview-model', modelId)} className="text-xs font-semibold text-[var(--landing-accent)] disabled:opacity-40" disabled={!modelId}>
                        {copiedKey === 'overview-model' ? 'Copié' : 'Copier'}
                      </button>
                    </div>
                    <select
                      value={modelId}
                      onChange={(event) => setSelectedModel(event.target.value)}
                      className="mt-2 h-12 w-full rounded-xl border border-[var(--landing-line)] bg-transparent px-3 font-mono text-sm text-[var(--landing-ink)] outline-none transition focus:border-[var(--landing-accent)]"
                    >
                      {models.length === 0 ? <option value="">Aucun modèle détecté</option> : null}
                      {models.map((model) => {
                        const required = Math.max(1, Number(model.requiredWorkers || 1))
                        const runnable = Boolean(model.runnable) || Number(model.workersOnline || 0) >= required
                        return (
                          <option key={model.id} value={model.id} className="bg-[var(--landing-card-strong)]">
                            {model.id}{runnable ? '' : ` — attente ${model.workersOnline}/${required} worker(s)`}
                          </option>
                        )
                      })}
                    </select>
                    <p className="mt-2 text-xs text-[var(--landing-muted)]">
                      {selectedModelInfo
                        ? `${selectedModelInfo.family} · ${selectedModelInfo.local ? 'présent sur le VPS' : 'déclaré par worker'} · ${selectedModelInfo.workersOnline}/${selectedModelInfo.requiredWorkers || 1} worker(s) requis`
                        : 'La liste se met à jour automatiquement depuis le VPS.'}
                    </p>
                  </div>
                </Panel>
              </div>
            </section>
          ) : null}

          {activePage.id === 'chat' ? (
            <section className="flex flex-col h-full w-full">
              {/* Context Settings Panel */}
              {chatContextPanelOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-[fadeIn_.2s_ease-out]">
                  <div className="w-full max-w-lg rounded-2xl border border-[var(--landing-line)] bg-[var(--landing-card-strong)] shadow-2xl backdrop-blur-xl p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--landing-accent)]">Contexte système</p>
                        <h2 className="mt-1 font-display text-xl font-bold text-[var(--landing-ink)]">Instructions personnalisées</h2>
                      </div>
                      <button type="button" onClick={() => setChatContextPanelOpen(false)} className="h-9 w-9 flex items-center justify-center rounded-xl border border-[var(--landing-line)] bg-white/5 text-[var(--landing-muted)] hover:text-[var(--landing-ink)] transition text-lg leading-none">×</button>
                    </div>
                    <p className="mb-3 text-sm text-[var(--landing-muted)]">Ce contexte est envoyé comme message système au début de chaque conversation. Définissez un rôle, un ton, ou des règles métier.</p>
                    <textarea
                      value={chatContextDraft}
                      onChange={(e) => setChatContextDraft(e.target.value)}
                      rows={8}
                      placeholder="Ex: Tu es un assistant expert en GPU et en DePIN. Tu réponds toujours en français, de manière concise et technique..."
                      className="w-full rounded-xl border border-[var(--landing-line)] bg-[var(--landing-card)] px-4 py-3 text-sm text-[var(--landing-ink)] placeholder:text-[var(--landing-muted)] outline-none focus:border-[var(--landing-accent)] resize-none transition"
                    />
                    <div className="mt-4 flex gap-3 justify-end">
                      <button type="button" onClick={() => { setChatContextDraft(''); saveContext('') }} className="px-4 py-2 rounded-xl border border-[var(--landing-line)] text-sm font-semibold text-[var(--landing-muted)] hover:text-[var(--landing-ink)] transition">Effacer</button>
                      <button type="button" onClick={() => saveContext(chatContextDraft)} className="px-5 py-2 rounded-xl bg-[var(--landing-accent)] text-sm font-semibold text-white transition">Enregistrer</button>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex h-[calc(100dvh-0px)] min-h-0" style={{ height: 'calc(100dvh - 0px)' }}>
                {/* Sidebar Conversations */}
                <aside className="hidden lg:flex w-72 shrink-0 flex-col border-r border-[var(--landing-line)] bg-[var(--landing-card-strong)] backdrop-blur-xl overflow-hidden">
                  {/* Sidebar header */}
                  <div className="flex items-center justify-between gap-2 px-4 py-4 border-b border-[var(--landing-line)]">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--landing-muted)]">Conversations</p>
                      <p className="mt-0.5 text-xs text-[var(--landing-muted)]">{chatThreads.length} thread(s)</p>
                    </div>
                    <button
                      type="button"
                      onClick={startNewConversation}
                      className="inline-flex h-9 items-center justify-center rounded-xl bg-[var(--landing-accent)] px-3 text-xs font-semibold text-white shadow-sm transition"
                    >
                      + Nouveau
                    </button>
                  </div>
                  {/* Threads list */}
                  <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {chatThreads.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center px-4">
                        <span className="w-12 h-12 rounded-xl border border-[var(--landing-line)] flex items-center justify-center overflow-hidden">
                          <AccountIconCanvas kind="chat" color={pageColors.chat} />
                        </span>
                        <p className="text-sm text-[var(--landing-muted)]">Aucune conversation.</p>
                      </div>
                    ) : (
                      chatThreads.map((thread) => {
                        const isActive = thread.id === activeConversationId
                        return (
                          <div
                            key={thread.id}
                            className={`group relative flex items-start gap-2.5 rounded-xl p-3 transition cursor-pointer border ${isActive
                                ? 'border-[var(--landing-accent)]/40 bg-[var(--landing-accent)]/10 text-[var(--landing-ink)]'
                                : 'border-transparent hover:border-[var(--landing-line)] hover:bg-white/5 text-[var(--landing-muted)]'
                              }`}
                            onClick={() => openConversation(thread)}
                          >
                            <span className="w-8 h-8 shrink-0 rounded-lg border border-[var(--landing-line)] bg-white/5 overflow-hidden flex items-center justify-center">
                              <AccountIconCanvas kind="chat" color={isActive ? pageColors.chat : '#64748b'} />
                            </span>
                            <div className="flex-1 min-w-0 pr-6">
                              <p className="truncate text-xs font-semibold text-[var(--landing-ink)]">{thread.title}</p>
                              <p className="mt-0.5 font-mono text-[10px] text-[var(--landing-muted)]">{thread.turns} msg · {compact(thread.totalTokens)} tok</p>
                            </div>
                            {/* Delete button — visible on hover */}
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); void deleteThread(thread.id) }}
                              className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 flex items-center justify-center rounded-lg text-[var(--landing-muted)] hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all duration-150 text-base leading-none"
                              title="Supprimer cette conversation"
                            >
                              ×
                            </button>
                          </div>
                        )
                      })
                    )}
                  </div>
                </aside>

                {/* Main chat area */}
                <div className="flex flex-1 min-w-0 flex-col">
                  {/* Chat top bar */}
                  <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--landing-line)] bg-[var(--landing-card-strong)] backdrop-blur-xl shrink-0">
                    <div className="flex items-center gap-3">
                      <span className="w-8 h-8 rounded-lg border border-[var(--landing-line)] overflow-hidden flex items-center justify-center bg-white/5">
                        <AccountIconCanvas kind="chat" color={pageColors.chat} />
                      </span>
                      <div>
                        <p className="text-sm font-bold text-[var(--landing-ink)]">Vryx Assistant</p>
                        <p className="text-[11px] text-[var(--landing-muted)] font-mono">
                          {chatLiveStats ? `${chatLiveStats.tps.toFixed(1)} TPS · ${integer(chatLiveStats.tokens)} tokens` : 'Prêt'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Model selector */}
                      <select
                        value={modelId}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className="h-9 rounded-xl border border-[var(--landing-line)] bg-[var(--landing-card)] px-3 font-mono text-xs text-[var(--landing-ink)] outline-none transition focus:border-[var(--landing-accent)] max-w-[16rem] truncate"
                      >
                        {models.length === 0 && <option value="">Aucun modèle</option>}
                        {models
                          .filter((model) => {
                            const lower = model.id.toLowerCase()
                            return !lower.startsWith('vryx') &&
                                   !lower.startsWith('prefix-cache') &&
                                   !lower.includes('split') &&
                                   !lower.includes('sources') &&
                                   !lower.includes('proof-') &&
                                   !lower.includes('auto-perf') &&
                                   !lower.includes('candidate')
                          })
                          .map((model) => {
                            const required = Math.max(1, Number(model.requiredWorkers || 1))
                            const runnable = Boolean(model.runnable) || Number(model.workersOnline || 0) >= required
                            return (
                              <option key={model.id} value={model.id} className="bg-[var(--landing-card-strong)]">
                                {runnable ? '● ' : '○ '}{model.id}
                              </option>
                            )
                          })}
                      </select>
                      {/* Context settings button */}
                      <button
                        type="button"
                        onClick={() => { setChatContextDraft(chatSystemContext); setChatContextPanelOpen(true) }}
                        className={`h-9 px-3 rounded-xl border text-xs font-semibold transition flex items-center gap-1.5 ${chatSystemContext.trim()
                            ? 'border-violet-400/40 bg-violet-400/10 text-violet-500 dark:text-violet-400'
                            : 'border-[var(--landing-line)] bg-white/5 text-[var(--landing-muted)] hover:text-[var(--landing-ink)]'
                          }`}
                        title="Configurer le contexte système"
                      >
                        <span className="w-4 h-4 inline-block overflow-hidden relative">
                          <AccountIconCanvas kind="settings" color={chatSystemContext.trim() ? '#a78bfa' : '#94a3b8'} />
                        </span>
                        <span className="hidden sm:inline">Contexte</span>
                        {chatSystemContext.trim() && <span className="h-1.5 w-1.5 rounded-full bg-violet-400 shrink-0" />}
                      </button>
                      {/* New chat button (mobile) */}
                      <button
                        type="button"
                        onClick={startNewConversation}
                        className="lg:hidden h-9 px-3 rounded-xl border border-[var(--landing-line)] bg-white/5 text-xs font-semibold text-[var(--landing-muted)] hover:text-[var(--landing-ink)] transition"
                      >
                        + Nouveau
                      </button>
                    </div>
                  </div>

                  {/* Messages area */}
                  <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-6">
                    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
                      {chatMessages.length === 0 && !chatLoading && (
                        <div className="flex flex-col items-center justify-center gap-6 py-20 text-center animate-[fadeIn_.6s_ease-out]">
                          <div className="relative flex items-center justify-center mb-2">
                            {/* Glowing backdrop */}
                            <div className="absolute w-32 h-32 rounded-full bg-gradient-to-tr from-sky-400 via-indigo-500 to-purple-600 blur-[35px] opacity-20 animate-pulse" />
                            
                            {/* Glassmorphic ring */}
                            <div className="relative w-24 h-24 rounded-full border border-white/10 bg-white/[0.02] backdrop-blur-md shadow-[0_0_30px_rgba(99,102,241,0.2)] flex items-center justify-center hover:scale-105 transition-transform duration-500">
                              <div className="absolute inset-1 rounded-full border border-white/5 bg-gradient-to-tr from-cyan-500/5 via-transparent to-purple-500/5 animate-[spin_10s_linear_infinite]" />
                              <VryxLogo variant="mark" tone="light" markSize="lg" className="scale-[0.8] drop-shadow-[0_0_16px_rgba(168,85,247,0.5)]" />
                            </div>
                          </div>
                          <div>
                            <h2 className="font-display text-2xl font-bold tracking-[0.1em] text-white">Vryx</h2>
                            <p className="mt-2 text-sm text-[var(--landing-muted)]">Modèle sélectionné : <span className="font-mono text-[var(--landing-accent)]">{modelId || 'aucun'}</span></p>
                            {chatSystemContext.trim() && (
                              <p className="mt-1.5 text-xs text-violet-400 font-medium">✓ Contexte système actif</p>
                            )}
                          </div>
                        </div>
                      )}
                      {chatMessages.map((message) => {
                        const isUser = message.role === 'user'
                        return (
                          <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-[fadeIn_.28s_ease-out]`}>
                            <div
                              className={`max-w-[min(42rem,92%)] px-5 py-4 text-[15px] leading-7 rounded-2xl ${isUser
                                  ? 'bg-[var(--landing-accent)] text-white shadow-md'
                                  : 'border border-[var(--landing-line)] bg-[var(--landing-card)] shadow-sm backdrop-blur-sm'
                                }`}
                            >
                              <ChatMarkdown text={message.content} tone={isUser ? 'self' : 'default'} />
                              {message.role === 'assistant' && (message.tps || message.totalTokens) ? (
                                <span className="mt-3 block border-t border-[var(--landing-line)] pt-2 font-mono text-[11px] text-[var(--landing-muted)]">
                                  {message.tps ? `${message.tps.toFixed(2)} TPS` : '—'} · {integer(message.totalTokens ?? 0)} tokens · {integer(message.latencyMs ?? 0)} ms
                                </span>
                              ) : null}
                            </div>
                          </div>
                        )
                      })}
                      {chatLoading ? (
                        <div className="flex justify-start">
                          <div className="rounded-2xl border border-[var(--landing-line)] bg-[var(--landing-card)] px-5 py-4 text-sm text-[var(--landing-muted)] shadow-sm">
                            <span className="inline-flex items-center gap-3">
                              <VryxLogo variant="mark" tone="light" markSize="sm" className="!h-5 !w-5 animate-pulse drop-shadow-[0_0_8px_rgba(168,85,247,0.6)] shrink-0" />
                              Génération en cours...
                            </span>
                          </div>
                        </div>
                      ) : null}
                      <div ref={chatEndRef} />
                    </div>
                  </div>

                  {/* Input bar */}
                  <div className="shrink-0 border-t border-[var(--landing-line)] bg-[var(--landing-card-strong)] backdrop-blur-xl px-4 py-3 sm:px-6">
                    <div className="mx-auto max-w-3xl">
                      <div className="flex items-end gap-3 rounded-2xl border border-[var(--landing-line)] bg-[var(--landing-card)] px-3 py-2 shadow-sm transition focus-within:border-[var(--landing-accent)]/50 focus-within:shadow-md">
                        <input ref={uploadInputRef} type="file" multiple accept={uploadAccept} onChange={handleUploadFiles} className="hidden" />
                        <button
                          type="button"
                          onClick={() => uploadInputRef.current?.click()}
                          disabled={chatLoading || chatAttachments.length >= 6}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--landing-line)] bg-white/5 text-lg font-semibold text-[var(--landing-muted)] hover:text-[var(--landing-ink)] hover:bg-white/10 transition disabled:cursor-not-allowed disabled:opacity-40"
                          title={selectedModelSupportsVision ? 'Joindre images et fichiers' : 'Joindre fichiers texte'}
                        >
                          +
                        </button>
                        <textarea
                          value={chatInput}
                          onChange={(event) => setChatInput(event.target.value)}
                          onKeyDown={onChatKeyDown}
                          rows={1}
                          placeholder="Message Vryx..."
                          className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm text-[var(--landing-ink)] outline-none placeholder:text-[var(--landing-muted)]"
                        />
                        <button
                          type="button"
                          onClick={() => void sendChat()}
                          disabled={chatLoading || !modelId || (!chatInput.trim() && chatAttachments.length === 0)}
                          className="h-10 rounded-xl bg-[var(--landing-accent)] px-5 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          Envoyer
                        </button>
                      </div>
                      {chatAttachments.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {chatAttachments.map((attachment) => (
                            <button
                              key={attachment.id}
                              type="button"
                              onClick={() => removeAttachment(attachment.id)}
                              className="rounded-full border border-[var(--landing-line)] bg-white/5 px-3 py-1.5 text-xs font-semibold text-[var(--landing-muted)] hover:text-red-500 hover:border-red-500/30 transition"
                              title="Cliquer pour retirer"
                            >
                              {attachment.kind === 'image' ? '🖼' : '📄'} {attachment.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {activePage.id === 'api' ? (
            <section>
              <PageHeader eyebrow="API" title="Clés API et crédits consommés." subtitle="Gérez vos accès Vryx, suivez les tokens et le coût estimé par clé." />
              <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi title="Clés actives" value={integer(apiKeys.length)} detail="Accès non révoqués" />
                <Kpi title="Requêtes API" value={integer(apiKeys.reduce((sum, key) => sum + (key.requestCount ?? 0), 0))} detail="Historique par clé" tone="emerald" />
                <Kpi title="Tokens API" value={compact(apiKeys.reduce((sum, key) => sum + (key.totalTokens ?? 0), 0))} detail="Prompt + génération" tone="violet" />
                <Kpi title="Crédits API" value={`${money(apiKeys.reduce((sum, key) => sum + (key.costEur ?? 0), 0), 6)} €`} detail="Coût estimé utilisé" tone="amber" />
              </div>
              <div className="grid gap-5 xl:grid-cols-[1fr_24rem]">
                <Panel className="p-5 sm:p-6">
                  <form onSubmit={createKey} className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
                    <label className="block">
                      <span className="text-sm font-semibold text-[var(--landing-ink)]">Nom de la clé</span>
                      <input
                        id={`${formId}-key-name`}
                        value={newKeyName}
                        onChange={(event) => setNewKeyName(event.target.value)}
                        className="mt-2 h-12 w-full rounded-xl border border-[var(--landing-line)] bg-white/5 px-4 font-mono text-sm text-[var(--landing-ink)] outline-none transition focus:border-[var(--landing-accent)]"
                        autoComplete="off"
                      />
                    </label>
                    <button type="submit" disabled={creatingKey} className="h-12 rounded-xl bg-[var(--landing-accent)] px-5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-60">
                      {creatingKey ? 'Création...' : 'Générer'}
                    </button>
                  </form>
                  {generatedKey ? (
                    <div className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 animate-[fadeIn_.2s_ease-out]">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-emerald-400">Clé générée</p>
                          <p className="mt-1 text-xs text-[var(--landing-muted)]">Elle ne sera plus affichée après fermeture/rechargement.</p>
                        </div>
                        <button type="button" onClick={() => void copyWithFeedback('generated-key', generatedKey)} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-emerald-500/10 transition hover:-translate-y-0.5">
                          {copiedKey === 'generated-key' ? 'Clé copiée' : 'Copier la clé'}
                        </button>
                      </div>
                      <input ref={newKeyRef} value={generatedKey} readOnly onFocus={(event) => event.currentTarget.select()} className="mt-4 w-full select-all rounded-xl border border-[var(--landing-line)] bg-white/5 px-4 py-3 font-mono text-xs text-[var(--landing-ink)] outline-none" />
                    </div>
                  ) : null}
                  <div className="mt-6 grid gap-3 md:grid-cols-2">
                    <button type="button" onClick={() => void copyWithFeedback('api-base', apiBase)} className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4 text-left hover:border-[var(--landing-accent)] transition">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--landing-muted)]">Base URL</p>
                      <p className="mt-2 break-all font-mono text-sm text-[var(--landing-accent)]">{copiedKey === 'api-base' ? 'Copié' : apiBase}</p>
                    </button>
                    <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--landing-muted)]">Modèle</p>
                        <button type="button" onClick={() => void copyWithFeedback('api-model', modelId)} className="text-xs font-semibold text-[var(--landing-accent)] disabled:opacity-40" disabled={!modelId}>
                          {copiedKey === 'api-model' ? 'Copié' : 'Copier'}
                        </button>
                      </div>
                      <select
                        value={modelId}
                        onChange={(event) => setSelectedModel(event.target.value)}
                        className="mt-2 h-11 w-full rounded-xl border border-[var(--landing-line)] bg-transparent px-3 font-mono text-sm text-[var(--landing-ink)] outline-none"
                      >
                        {models.length === 0 ? <option value="">Aucun modèle détecté</option> : null}
                        {models.map((model) => {
                          const required = Math.max(1, Number(model.requiredWorkers || 1))
                          const runnable = Boolean(model.runnable) || Number(model.workersOnline || 0) >= required
                          return (
                            <option key={model.id} value={model.id} className="bg-[var(--landing-card-strong)]">
                              {model.id}{runnable ? '' : ` — attente ${model.workersOnline}/${required} worker(s)`}
                            </option>
                          )
                        })}
                      </select>
                    </div>
                  </div>
                </Panel>
                <Panel className="bg-neutral-950 p-5 text-slate-100 border-none shadow-lg">
                  <p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">Exemple OpenAI-compatible</p>
                  <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-slate-300">{`curl ${apiBase}/chat/completions \\
  -H "Authorization: Bearer vel_sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${modelId || 'MODEL_ID'}","messages":[{"role":"user","content":"Salut"}]}'`}</pre>
                </Panel>
              </div>
              <Panel className="mt-5 overflow-hidden">
                <div className="grid grid-cols-[1fr_auto] gap-3 border-b border-[var(--landing-line)] bg-white/5 px-5 py-4 text-xs font-semibold uppercase tracking-wide text-[var(--landing-muted)]">
                  <span>Clés actives</span>
                  <span>{apiKeys.length}</span>
                </div>
                {apiKeys.length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-[var(--landing-muted)]">Aucune clé active.</p>
                ) : (
                  <div className="divide-y divide-[var(--landing-line)]">
                    {apiKeys.map((key) => (
                      <div key={key.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center hover:bg-white/5 transition">
                        <div>
                          <p className="font-semibold text-[var(--landing-ink)]">{key.name}</p>
                          <p className="mt-1 font-mono text-xs text-[var(--landing-muted)]">{key.keyPrefix}</p>
                          <p className="mt-1 text-xs text-[var(--landing-muted)]">Créée {dateTime(key.createdAt)} · Dernier usage {dateTime(key.lastUsedAt)}</p>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-right font-mono text-xs sm:min-w-72">
                          <span><span className="block text-[var(--landing-muted)]">req</span>{integer(key.requestCount ?? 0)}</span>
                          <span><span className="block text-[var(--landing-muted)]">tokens</span>{compact(key.totalTokens ?? 0)}</span>
                          <span><span className="block text-[var(--landing-muted)]">€</span>{money(key.costEur ?? 0, 6)}</span>
                        </div>
                        <button type="button" onClick={() => void revokeKey(key.id)} className="rounded-xl border border-red-500/20 px-3 py-2 text-xs font-semibold text-red-500 transition hover:bg-red-500/10">
                          Révoquer
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </section>
          ) : null}

          {activePage.id === 'usage' ? (
            <section>
              <PageHeader eyebrow="Usage" title="Sessions réelles et performance réseau." subtitle="Un espace dédié pour comprendre les tokens générés, la latence et le TPS mesuré en activité." />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi title="Sessions" value={integer(sessions.length)} detail={`${digest.completedSessions} complétées`} />
                <Kpi title="Tokens générés" value={compact(digest.totalCompletionTokens)} detail={`${compact(digest.totalPromptTokens)} tokens prompt`} tone="emerald" />
                <Kpi title="Ping moyen" value={digest.avgPingMs == null ? '—' : `${Math.round(digest.avgPingMs)} ms`} detail="Sur les sessions mesurées" tone="violet" />
                <Kpi title="ms/token" value={digest.avgMsPerToken == null ? '—' : digest.avgMsPerToken.toFixed(2)} detail={`${digest.avgTps.toFixed(2)} TPS moyen`} tone="amber" />
              </div>
              <Panel className="mt-5 overflow-hidden">
                {sessions.length === 0 ? (
                  <p className="px-5 py-10 text-center text-sm text-[var(--landing-muted)]">Aucune session enregistrée.</p>
                ) : (
                  <div className="divide-y divide-[var(--landing-line)]">
                    {visibleSessions.map((session) => {
                      const latency = session.latencyMs || session.computeTimeMs || 0
                      const tps = session.completionTokens > 0 && latency > 0 ? session.completionTokens / (latency / 1000) : 0
                      return (
                        <div key={session.id} className="grid gap-3 px-5 py-4 transition hover:bg-[var(--landing-line)] lg:grid-cols-[1fr_auto_auto_auto] lg:items-center">
                          <div>
                            <p className="font-mono text-xs text-[var(--landing-muted)]">{dateTime(session.createdAt)}</p>
                            <p className="mt-1 truncate text-sm font-semibold text-[var(--landing-ink)]">{session.model ?? 'Modèle inconnu'}</p>
                          </div>
                          <span className="font-mono text-sm text-[var(--landing-ink)]">{integer(session.totalTokens)} tok</span>
                          <span className="font-mono text-sm text-[var(--landing-accent)]">{tps.toFixed(2)} TPS</span>
                          <span className="font-mono text-sm text-[var(--landing-muted)]">{Math.round(latency)} ms</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Panel>
              {sessions.length > usagePageSize ? (
                <div className="mt-5 flex flex-col gap-3 rounded-xl border border-[var(--landing-line)] bg-[var(--landing-card)] p-3 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between shadow-md">
                  <p className="text-sm text-[var(--landing-muted)]">
                    Page {usagePage} / {usageTotalPages} · {integer(sessions.length)} sessions
                  </p>
                  <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setUsagePage((page) => Math.max(1, page - 1))}
                      disabled={usagePage <= 1}
                      className="rounded-xl border border-[var(--landing-line)] bg-white/5 px-4 py-2 text-sm font-semibold text-[var(--landing-ink)] disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[var(--landing-line)] transition"
                    >
                      Précédent
                    </button>
                    {usagePagination.map((item) =>
                      typeof item === 'number' ? (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setUsagePage(item)}
                          className={`h-10 min-w-10 rounded-xl px-3 font-mono text-sm font-semibold ${item === usagePage
                              ? 'bg-[var(--landing-accent)] text-white shadow-md'
                              : 'border border-[var(--landing-line)] bg-white/5 text-[var(--landing-muted)] hover:bg-[var(--landing-line)]'
                            }`}
                        >
                          {item}
                        </button>
                      ) : (
                        <span key={item} className="px-1 font-mono text-sm text-[var(--landing-muted)]">...</span>
                      ),
                    )}
                    <button
                      type="button"
                      onClick={() => setUsagePage((page) => Math.min(usageTotalPages, page + 1))}
                      disabled={usagePage >= usageTotalPages}
                      className="rounded-xl border border-[var(--landing-line)] bg-white/5 px-4 py-2 text-sm font-semibold text-[var(--landing-ink)] disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[var(--landing-line)] transition"
                    >
                      Suivant
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {activePage.id === 'workers' ? (
            <section>
              <PageHeader eyebrow="Workers" title="Workers liés à votre compte." subtitle="Suivez les GPU déclarés par vos workers, leur mémoire allouée, le modèle chargé et les tokens générés." />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi title="Workers" value={integer(workers.length)} detail={`${workers.filter((w) => w.online).length} en ligne`} />
                <Kpi title="VRAM allouée" value={`${money(workers.reduce((sum, w) => sum + w.allocatedVramMb, 0) / 1024, 1)} Go`} detail="Somme déclarée" tone="emerald" />
                <Kpi title="Tokens générés" value={compact(workers.reduce((sum, w) => sum + w.tokensGenerated, 0))} detail="Depuis les heartbeats" tone="violet" />
                <Kpi title="Peers P2P" value={integer(workers.reduce((sum, w) => sum + w.p2pPeers, 0))} detail="Connexions déclarées" tone="amber" />
              </div>
              <div className="mt-5 grid gap-4">
                {workers.length === 0 ? (
                  <Panel className="p-8 text-center">
                    <p className="font-semibold text-[var(--landing-ink)]">Aucun worker lié à ce compte.</p>
                    <p className="mt-2 text-sm text-[var(--landing-muted)]">Connectez-vous dans l’application worker avec ce compte pour voir apparaître vos machines ici.</p>
                  </Panel>
                ) : (
                  visibleWorkers.map((worker) => (
                    <Panel key={worker.peerId} className="overflow-hidden">
                      <div className="grid gap-5 p-5 lg:grid-cols-[1fr_auto] lg:items-center">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`h-2.5 w-2.5 rounded-full ${worker.online ? 'bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,.8)]' : 'bg-zinc-400'}`} />
                            <p className="font-display text-xl font-bold text-[var(--landing-ink)]">{worker.gpuName || 'GPU inconnu'}</p>
                            <span className="rounded-full border border-[var(--landing-line)] bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-[var(--landing-accent)]">{worker.runtimeBackend || 'runtime ?'}</span>
                          </div>
                          <p className="mt-2 break-all font-mono text-xs text-[var(--landing-muted)]">{worker.peerId}</p>
                          <p className="mt-2 text-sm text-[var(--landing-muted)]">{worker.model || 'Aucun modèle déclaré'} · heartbeat {worker.secondsSinceHeartbeat}s</p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-4 lg:min-w-[34rem]">
                          <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-3"><p className="text-xs text-[var(--landing-muted)]">VRAM</p><p className="mt-1 font-mono font-semibold text-sm">{money(worker.allocatedVramMb / 1024, 1)} / {money(worker.gpuVramMb / 1024, 1)} Go</p></div>
                          <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-3"><p className="text-xs text-[var(--landing-muted)]">Allocation</p><p className="mt-1 font-mono font-semibold text-sm">{worker.memoryLimitPercent || 0}%</p></div>
                          <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-3"><p className="text-xs text-[var(--landing-muted)]">Tokens</p><p className="mt-1 font-mono font-semibold text-sm">{compact(worker.tokensGenerated)}</p></div>
                          <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-3"><p className="text-xs text-[var(--landing-muted)]">Quant</p><p className="mt-1 font-mono font-semibold text-sm">{worker.weightQuantization || '—'}</p></div>
                        </div>
                      </div>
                    </Panel>
                  ))
                )}
              </div>
              {workers.length > workerPageSize ? (
                <div className="mt-5 flex flex-col gap-3 rounded-xl border border-[var(--landing-line)] bg-[var(--landing-card)] p-3 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between shadow-md">
                  <p className="text-sm text-[var(--landing-muted)]">
                    Page {workersPage} / {workersTotalPages} · {integer(workers.length)} workers
                  </p>
                  <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setWorkersPage((page) => Math.max(1, page - 1))}
                      disabled={workersPage <= 1}
                      className="rounded-xl border border-[var(--landing-line)] bg-white/5 px-4 py-2 text-sm font-semibold text-[var(--landing-ink)] disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[var(--landing-line)] transition"
                    >
                      Précédent
                    </button>
                    {workersPagination.map((item) =>
                      typeof item === 'number' ? (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setWorkersPage(item)}
                          className={`h-10 min-w-10 rounded-xl px-3 font-mono text-sm font-semibold ${item === workersPage
                              ? 'bg-[var(--landing-accent)] text-white shadow-md'
                              : 'border border-[var(--landing-line)] bg-white/5 text-[var(--landing-muted)] hover:bg-[var(--landing-line)]'
                            }`}
                        >
                          {item}
                        </button>
                      ) : (
                        <span key={item} className="px-1 font-mono text-sm text-[var(--landing-muted)]">...</span>
                      ),
                    )}
                    <button
                      type="button"
                      onClick={() => setWorkersPage((page) => Math.min(workersTotalPages, page + 1))}
                      disabled={workersPage >= workersTotalPages}
                      className="rounded-xl border border-[var(--landing-line)] bg-white/5 px-4 py-2 text-sm font-semibold text-[var(--landing-ink)] disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[var(--landing-line)] transition"
                    >
                      Suivant
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {activePage.id === 'billing' ? (
            <section>
              <PageHeader eyebrow="Facturation" title="Crédits API et débit usage." subtitle="Le solde est tenu dans un ledger monétaire. Chaque appel API débite le coût réel calculé aux tokens." />
              <div className="grid gap-5 lg:grid-cols-3">
                <Kpi title="Solde crédits" value={`${money(billing?.balanceEur ?? overview?.balanceCredits ?? 0)} €`} detail={billing?.enforceCredits ? 'Blocage actif si solde insuffisant' : 'Débit actif, blocage désactivé'} tone="emerald" />
                <Kpi title="Usage API mois" value={`${money(billing?.monthUsage.costEur ?? 0, 6)} €`} detail={`${compact(billing?.monthUsage.totalTokens ?? 0)} tokens API`} tone="violet" />
                <Kpi
                  title="Coût moyen"
                  value={`${money(billing?.monthUsage.averageEurPerMillion ?? billing?.pricing?.eurPerMillionTokens ?? eurPerMillion, 4)} €`}
                  detail={billing?.pricing?.published === false ? 'Tarif privé / sur devis' : 'Par million de tokens'}
                />
              </div>
              <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
                <Panel className="p-5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-display text-2xl font-bold text-[var(--landing-ink)]">Recharger des crédits</p>
                      <p className="mt-1 text-sm text-[var(--landing-muted)]">Packs prépayés utilisables par les clés API. Les factures Stripe apparaissent après paiement.</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${billing?.checkoutEnabled ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'}`}>
                      {billing?.checkoutEnabled ? 'Checkout actif' : 'Stripe à configurer'}
                    </span>
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {(billing?.packages?.length ? billing.packages : [50, 100, 500, 2000]).map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        onClick={() => void startCheckout(amount)}
                        disabled={checkoutLoadingAmount != null}
                        className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4 text-left transition hover:border-[var(--landing-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="block text-xs font-semibold uppercase tracking-wide text-[var(--landing-muted)]">Pack crédits</span>
                        <span className="mt-2 block font-display text-3xl font-bold text-[var(--landing-ink)]">{money(amount, 0)} €</span>
                        <span className="mt-2 block text-xs text-[var(--landing-muted)]">{checkoutLoadingAmount === amount ? 'Ouverture...' : 'Paiement carte'}</span>
                      </button>
                    ))}
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4"><p className="text-xs text-[var(--landing-muted)]">Projection</p><p className="mt-1 font-mono font-semibold">{money(estimatedMonthly)} € / mois</p></div>
                    <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4">
                      <p className="text-xs text-[var(--landing-muted)]">Prix actuel</p>
                      <p className="mt-1 font-mono font-semibold text-sm">
                        {billing?.pricing?.minInputEurPerMillion != null && billing?.pricing?.minOutputEurPerMillion != null
                          ? `${money(billing.pricing.minInputEurPerMillion, 4)} / ${money(billing.pricing.minOutputEurPerMillion, 4)} €/M`
                          : 'Sur devis'}
                      </p>
                    </div>
                    <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4"><p className="text-xs text-[var(--landing-muted)]">Marge estimée</p><p className="mt-1 font-mono font-semibold">{money(investor?.estimatedGrossMarginPercent ?? 0, 0)}%</p></div>
                  </div>
                </Panel>
                <Panel className="p-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-[var(--landing-ink)]">Ledger crédits</p>
                    <span className="rounded-full border border-[var(--landing-line)] bg-white/5 px-2.5 py-1 text-xs font-semibold text-[var(--landing-muted)]">{billing?.ledger.length ?? 0}</span>
                  </div>
                  <div className="mt-4 space-y-3">
                    {billing?.ledger.length ? (
                      billing.ledger.slice(0, 8).map((entry) => (
                        <div key={entry.id} className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-semibold text-[var(--landing-ink)]">{entry.description || entry.type}</p>
                            <span className="font-mono text-sm font-semibold text-emerald-400">
                              {entry.amountEur >= 0 ? '+' : ''}{money(entry.amountEur, 6)} €
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-[var(--landing-muted)]">
                            {dateTime(entry.createdAt)} · {entry.type}
                            {entry.pricing?.rates?.inputEurPerMillion != null && entry.pricing?.rates?.outputEurPerMillion != null
                              ? ` · ${money(entry.pricing.rates.inputEurPerMillion, 4)}/${money(entry.pricing.rates.outputEurPerMillion, 4)} €/M`
                              : ''}
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4 text-sm text-[var(--landing-muted)]">Aucun mouvement pour le moment.</p>
                    )}
                  </div>
                </Panel>
              </div>
              {billing?.invoices?.length ? (
                <Panel className="mt-5 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-[var(--landing-ink)]">Paiements et factures Stripe</p>
                    <span className="rounded-full border border-[var(--landing-line)] bg-white/5 px-2.5 py-1 text-xs font-semibold text-[var(--landing-muted)]">{billing.invoices.length}</span>
                  </div>
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    {billing.invoices.slice(0, 6).map((invoice) => (
                      <div key={`${invoice.provider}:${invoice.providerSessionId}`} className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-mono text-xs text-[var(--landing-muted)]">{invoice.providerSessionId || invoice.provider}</p>
                          <p className="font-mono text-sm font-semibold text-[var(--landing-ink)]">{money(invoice.amountEur, 2)} €</p>
                        </div>
                        <p className="mt-1 text-xs text-[var(--landing-muted)]">{dateTime(invoice.createdAt)} · {invoice.status}</p>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}
            </section>
          ) : null}

          {activePage.id === 'security' ? (
            <section>
              <PageHeader eyebrow="Sécurité" title="Accès, session et clés actives." subtitle="Une lecture simple de ce qui protège ton compte et ton API." />
              <div className="grid gap-5 lg:grid-cols-3">
                <Panel className="p-5"><p className="text-xs font-semibold uppercase tracking-wide text-[var(--landing-muted)]">Compte</p><p className="mt-3 break-all font-mono text-sm text-[var(--landing-ink)]">{user.email}</p></Panel>
                <Panel className="p-5"><p className="text-xs font-semibold uppercase tracking-wide text-[var(--landing-muted)]">Dernière connexion</p><p className="mt-3 text-sm text-[var(--landing-ink)]">{dateTime(overview?.lastLoginAt)}</p></Panel>
                <Panel className="p-5"><p className="text-xs font-semibold uppercase tracking-wide text-[var(--landing-muted)]">Clés actives</p><p className="mt-3 font-display text-3xl font-bold text-[var(--landing-ink)]">{apiKeys.length}</p></Panel>
              </div>
            </section>
          ) : null}

          {activePage.id === 'settings' ? (
            <section>
              <PageHeader eyebrow="Réglages" title="Préférences du compte." subtitle="Apparence, confidentialité, historique et comportement API dans une page plus lisible." />
              <div className="grid gap-5 lg:grid-cols-2">
                <Panel className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold text-[var(--landing-ink)]">Apparence</p>
                      <p className="mt-2 text-sm text-[var(--landing-muted)]">Choisissez clair, sombre ou suivez le thème de l’OS.</p>
                    </div>
                    <ThemeToggle menuPlacement="up" />
                  </div>
                </Panel>
                <Panel className="p-5">
                  <p className="font-semibold text-[var(--landing-ink)]">Historique</p>
                  <p className="mt-2 text-sm text-[var(--landing-muted)]">Supprimer les sessions stockées sur votre compte.</p>
                  <button type="button" onClick={() => void clearSessions()} className="mt-4 rounded-xl border border-red-500/30 px-4 py-2 text-sm font-semibold text-red-500 hover:bg-red-500/10 transition">
                    Vider l'historique
                  </button>
                </Panel>
                <Panel className="p-5">
                  <p className="font-semibold text-[var(--landing-ink)]">Streaming</p>
                  <p className="mt-2 text-sm text-[var(--landing-muted)]">Le chat utilise le flux distribué quand il est disponible, avec rendu caractère par caractère côté interface.</p>
                  <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm font-semibold text-emerald-400">Activé par défaut</div>
                </Panel>
                <Panel className="p-5">
                  <p className="font-semibold text-[var(--landing-ink)]">Limites API</p>
                  <p className="mt-2 text-sm text-[var(--landing-muted)]">Plafond de génération actuel côté serveur.</p>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4"><p className="text-xs text-[var(--landing-muted)]">Max tokens</p><p className="mt-1 font-mono font-semibold">32 768</p></div>
                    <div className="rounded-xl border border-[var(--landing-line)] bg-white/5 p-4"><p className="text-xs text-[var(--landing-muted)]">Modèle</p><p className="mt-1 truncate font-mono text-xs font-semibold">{modelId || 'Auto VPS'}</p></div>
                  </div>
                </Panel>
              </div>
            </section>
          ) : null}
        </div>
      </main>
    </div>
  )
}
