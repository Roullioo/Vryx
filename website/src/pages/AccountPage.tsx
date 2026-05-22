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

type PageId = 'overview' | 'chat' | 'api' | 'usage' | 'workers' | 'billing' | 'security' | 'settings'
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
    <div className={`liquid-card rounded-[1.6rem] text-neutral-950 dark:text-zinc-50 ${className}`}>
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
    cyan: 'from-cyan-400/24 via-sky-400/8 text-cyan-500',
    emerald: 'from-emerald-400/24 via-teal-400/8 text-emerald-500',
    violet: 'from-violet-400/24 via-fuchsia-400/8 text-violet-500',
    amber: 'from-amber-400/24 via-orange-400/8 text-amber-500',
  }
  return (
    <Panel className="overflow-hidden">
      <div className={`h-1.5 bg-gradient-to-r ${tones[tone]}`} />
      <div className="p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">{title}</p>
        <p className="mt-3 font-display text-3xl font-bold tracking-tight text-fg">{value}</p>
        <p className="mt-2 text-sm text-muted">{detail}</p>
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
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-accent">{eyebrow}</p>
        <h1 className="mt-3 max-w-4xl font-display text-4xl font-bold tracking-tight text-fg sm:text-5xl">{title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted sm:text-base">{subtitle}</p>
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

  const activePage = currentPage(location.pathname)
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
    if (modelsResult.ok) {
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
    ;(async () => {
      setGoogleStatus('processing')
      const r = await apiJson<{ token?: string; desktop?: boolean; next?: string }>('/api/auth/google/finish', {
        method: 'POST',
        body: JSON.stringify({ code: params.get('code') || '', state: params.get('state') || '' }),
      })
      if (!r.ok) {
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
      const payloadMessages = nextMessages.slice(-12).map((message) => ({ role: message.role, content: message.content }))
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
    [activeConversationId, chatAttachments, chatInput, chatLoading, chatMessages, modelId, refreshData],
  )

  const onChatKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      void sendChat()
    },
    [sendChat],
  )

  if (googleStatus === 'processing' || loading || accountLoading) {
    return (
      <div className="vryx-loading-scene min-h-dvh px-4">
        <div className="vryx-loading-orb">
          <span className="vryx-loading-bubble vryx-loading-bubble-a" />
          <span className="vryx-loading-bubble vryx-loading-bubble-b" />
          <span className="vryx-loading-bubble vryx-loading-bubble-c" />
          <div className="vryx-loading-ring">
            <div className="vryx-loading-core" aria-label="Chargement Vryx" />
          </div>
        </div>
      </div>
    )
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
    <div className="liquid-page min-h-dvh bg-[radial-gradient(circle_at_18%_0%,rgba(14,165,233,0.18),transparent_32%),radial-gradient(circle_at_88%_10%,rgba(168,85,247,0.14),transparent_34%),linear-gradient(135deg,#f8fafc,#eef2ff)] text-neutral-950 dark:bg-[radial-gradient(circle_at_18%_0%,rgba(34,211,238,0.13),transparent_32%),radial-gradient(circle_at_88%_10%,rgba(168,85,247,0.16),transparent_34%),linear-gradient(135deg,#05070d,#0b1020)] dark:text-zinc-50">
      <aside className="liquid-card fixed inset-y-0 left-0 z-40 hidden w-72 rounded-none border-y-0 border-l-0 px-4 py-5 xl:flex xl:flex-col">
        <div className="flex items-center gap-3 px-2">
          <VryxLogo to="/" markSize="sm" />
        </div>
        <nav className="mt-8 flex flex-1 flex-col gap-2" aria-label="Compte">
          {pages.map((page) => {
            const Icon = page.icon
            const active = page.id === activePage.id
            return (
              <Link
                key={page.id}
                to={page.path}
                className={`group flex items-center gap-3 rounded-2xl px-3 py-3 transition ${
                  active
                    ? 'liquid-lens text-white'
                    : 'text-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/10'
                }`}
              >
                <span className="liquid-chip flex h-10 w-10 items-center justify-center rounded-xl">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{page.label}</span>
                  <span className={`block text-xs ${active ? 'text-white/75' : 'text-muted'}`}>{page.hint}</span>
                </span>
              </Link>
            )
          })}
        </nav>
        <div className="space-y-3">
          <div className="liquid-chip rounded-2xl p-3">
            <p className="truncate font-mono text-xs text-muted">{user.email}</p>
            <p className="mt-1 text-xs font-semibold text-accent">{overview?.plan ?? 'Scale'}</p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle menuPlacement="up" menuAlign="left" />
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl border border-alert/20 text-sm font-semibold text-alert transition hover:bg-alert/10"
            >
              <IconLock className="h-4 w-4" aria-hidden />
              Déconnexion
            </button>
          </div>
        </div>
      </aside>

      <main className="xl:pl-72">
        <div className="mx-auto min-h-dvh max-w-7xl px-4 py-4 sm:px-6 lg:px-8 lg:py-7">
          <div className="sticky top-3 z-30 mb-5 xl:hidden">
            <div className="liquid-card flex items-center justify-between gap-4 rounded-[1.45rem] px-3 py-2.5">
              <VryxLogo to="/" markSize="sm" />
              <div className="flex items-center gap-2">
                <span className="hidden max-w-[12rem] truncate font-mono text-xs text-muted sm:block">{activePage.label}</span>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen((open) => !open)}
                  className="liquid-chip flex h-11 w-11 items-center justify-center rounded-2xl text-fg"
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
              <div className="liquid-mobile-menu mt-3 rounded-[1.7rem] p-3">
                <div className="grid gap-2">
                  {pages.map((page) => {
                    const Icon = page.icon
                    const active = page.id === activePage.id
                    return (
                      <Link
                        key={page.id}
                        to={page.path}
                        className={`flex items-center gap-3 rounded-2xl px-3 py-3 text-sm font-semibold transition ${
                          active ? 'liquid-lens text-white' : 'liquid-chip text-muted hover:text-fg'
                        }`}
                      >
                        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10">
                          <Icon className="h-4.5 w-4.5" aria-hidden />
                        </span>
                        <span className="flex-1">
                          <span className="block">{page.label}</span>
                          <span className={`block text-xs font-medium ${active ? 'text-white/75' : 'text-muted'}`}>{page.hint}</span>
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
                    className="flex h-12 items-center justify-center gap-2 rounded-2xl border border-alert/20 text-sm font-semibold text-alert transition hover:bg-alert/10"
                  >
                    <IconLock className="h-4 w-4" aria-hidden />
                    Déconnexion
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {(accountError || actionError) && <div className="mb-5 space-y-2">{alerts}</div>}

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
                    className="rounded-2xl border border-border bg-surface px-5 py-3 text-sm font-semibold text-fg transition hover:border-accent/50 disabled:opacity-60"
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
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-display text-2xl font-bold text-fg">Forfait {overview?.plan ?? 'Scale'}</p>
                      <p className="mt-1 text-sm text-muted">Usage mensuel, clés actives et endpoint prêt pour Cursor.</p>
                    </div>
                    <Link to="/compte/chat" className="btn-primary rounded-2xl px-5 py-3 text-sm font-semibold">
                      Ouvrir le chat
                    </Link>
                  </div>
                  <div className="mt-6 h-4 overflow-hidden rounded-full bg-border">
                    <div className="h-full rounded-full bg-gradient-to-r from-sky-400 via-cyan-300 to-emerald-300" style={{ width: `${usagePercent}%` }} />
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl bg-surface p-4"><p className="text-sm text-muted">Usage</p><p className="mt-1 font-mono text-lg font-semibold">{Math.round(usagePercent)}%</p></div>
                    <div className="rounded-2xl bg-surface p-4"><p className="text-sm text-muted">Clés</p><p className="mt-1 font-mono text-lg font-semibold">{apiKeys.length}</p></div>
                    <div className="rounded-2xl bg-surface p-4"><p className="text-sm text-muted">Requêtes</p><p className="mt-1 font-mono text-lg font-semibold">{integer(overview?.requestsThisMonth ?? 0)}</p></div>
                  </div>
                </Panel>
                <Panel className="p-6">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Configuration rapide</p>
                  <button type="button" onClick={() => void copyWithFeedback('overview-api-base', apiBase)} className="mt-4 block w-full rounded-2xl bg-surface p-4 text-left">
                    <span className="block text-xs text-muted">Base URL</span>
                    <span className="mt-1 block break-all font-mono text-sm text-accent">{copiedKey === 'overview-api-base' ? 'Copié' : apiBase}</span>
                  </button>
                  <div className="mt-3 rounded-2xl bg-surface p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-muted">Modèle</span>
                      <button type="button" onClick={() => void copyWithFeedback('overview-model', modelId)} className="copy-feedback text-xs font-semibold text-accent disabled:opacity-40" disabled={!modelId}>
                        {copiedKey === 'overview-model' ? 'Copié' : 'Copier'}
                      </button>
                    </div>
                    <select
                      value={modelId}
                      onChange={(event) => setSelectedModel(event.target.value)}
                      className="liquid-chip mt-2 h-12 w-full rounded-2xl px-3 font-mono text-sm text-fg outline-none"
                    >
                      {models.length === 0 ? <option value="">Aucun modèle détecté</option> : null}
                      {models.map((model) => {
                        const required = Math.max(1, Number(model.requiredWorkers || 1))
                        const runnable = Boolean(model.runnable) || Number(model.workersOnline || 0) >= required
                        return (
                        <option key={model.id} value={model.id} disabled={!runnable}>
                          {model.id}{runnable ? '' : ` — attente ${model.workersOnline}/${required} worker(s)`}
                        </option>
                        )
                      })}
                    </select>
                    <p className="mt-2 text-xs text-muted">
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
            <section className="liquid-chat-shell flex flex-col">
              <div className="mx-auto grid w-full max-w-7xl flex-1 gap-5 lg:grid-cols-[18rem_1fr]">
                <aside className="chat-history-panel liquid-card liquid-static order-1 overflow-hidden rounded-[1.7rem] p-3 lg:sticky lg:top-7 lg:max-h-[calc(100dvh-3.5rem)]">
                  <div className="flex items-center justify-between gap-2 px-2 py-2">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Historique</p>
                      <p className="mt-1 text-xs text-muted">{chatThreads.length} conversation(s)</p>
                    </div>
                    <button type="button" onClick={startNewConversation} className="liquid-lens rounded-2xl px-3 py-2 text-xs font-semibold text-white">
                      Nouveau
                    </button>
                  </div>
                  <div className="chat-history-list mt-2 flex gap-2 overflow-x-auto pb-1 lg:max-h-[calc(100dvh-10rem)] lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto lg:pr-1">
                    {chatThreads.length === 0 ? (
                      <p className="min-w-64 rounded-2xl border border-white/10 px-3 py-4 text-sm text-muted lg:min-w-0">Aucune conversation sauvegardée pour le moment.</p>
                    ) : (
                      chatThreads.map((thread) => (
                        <button
                          key={thread.id}
                          type="button"
                          onClick={() => openConversation(thread)}
                          className={`chat-history-item min-w-[15rem] text-left transition lg:min-w-0 ${
                            thread.id === activeConversationId ? 'chat-history-item-active' : ''
                          }`}
                        >
                          <span className="chat-history-title">{thread.title}</span>
                          <span className={`mt-2 block font-mono text-[11px] ${thread.id === activeConversationId ? 'text-white/75' : 'text-muted'}`}>
                            {thread.turns} tour(s) · {compact(thread.totalTokens)} tokens
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </aside>
                <div className="order-2 flex min-w-0 flex-col">
                <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.28em] text-sky-600 dark:text-sky-300">Chat Vryx</p>
                    <h1 className="mt-3 font-display text-4xl font-bold tracking-tight text-fg sm:text-5xl">Vryx.</h1>
                  </div>
                  <div className="liquid-card flex flex-wrap items-center gap-2 rounded-3xl px-3 py-2 font-mono text-xs">
                    <span className="liquid-chip rounded-full px-3 py-1.5 text-sky-600 dark:text-sky-300">
                      {chatLiveStats ? `${chatLiveStats.tps.toFixed(2)} TPS` : 'stream prêt'}
                    </span>
                    <span className="liquid-chip rounded-full px-3 py-1.5 text-emerald-600 dark:text-emerald-300">
                      {chatLiveStats ? `${integer(chatLiveStats.tokens)} tokens` : '0 token'}
                    </span>
                  </div>
                </div>

                <Panel className="liquid-chat-stream flex min-h-[68dvh] flex-1 flex-col overflow-hidden rounded-[2rem]">
                <div className="border-b border-white/20 px-4 py-3 sm:px-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-fg">Vryx Assistant</p>
                    <p className="truncate font-mono text-xs text-muted">{modelId || 'Modèle auto'}</p>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-6">
                  <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
                  {chatMessages.map((message) => (
                    <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'} animate-[fadeIn_.28s_ease-out]`}>
                      <div
                        className={`max-w-[min(42rem,92%)] px-5 py-4 text-[15px] leading-7 ${
                          message.role === 'user'
                            ? 'liquid-lens rounded-[1.6rem] rounded-br-md text-white'
                            : 'liquid-card rounded-[1.6rem] rounded-bl-md'
                        }`}
                      >
                        <ChatMarkdown text={message.content} tone={message.role === 'user' ? 'self' : 'default'} />
                        {message.role === 'assistant' && (message.tps || message.totalTokens) ? (
                          <span className="mt-3 block border-t border-black/8 pt-2 font-mono text-[11px] text-muted dark:border-white/10">
                            {message.tps ? `${message.tps.toFixed(2)} TPS` : 'TPS —'} · {integer(message.totalTokens ?? 0)} tokens · {integer(message.latencyMs ?? 0)} ms
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {chatLoading ? (
                    <div className="flex justify-start">
                      <div className="liquid-card rounded-[1.35rem] px-5 py-4 text-sm text-muted">
                        <span className="inline-flex items-center gap-2">
                          <span className="vryx-mini-loader shrink-0" aria-hidden />
                          Génération en cours...
                        </span>
                      </div>
                    </div>
                  ) : null}
                  <div ref={chatEndRef} />
                  </div>
                </div>
                <div className="border-t border-white/20 p-3 sm:p-4">
                  <div className="mx-auto max-w-3xl">
                  <div className="mb-3 flex gap-2 overflow-x-auto">
                    {['Qui es-tu ?', 'Résume mes dernières sessions', 'Donne-moi un test court pour Cursor'].map((suggestion) => (
                      <button
	                        key={suggestion}
	                        type="button"
	                        onClick={() => void sendChat(suggestion)}
	                        disabled={chatLoading || !modelId}
	                        className="liquid-chip whitespace-nowrap rounded-full px-3 py-2 text-xs font-semibold text-muted transition hover:-translate-y-0.5 hover:text-fg"
	                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                  <div className="liquid-card flex items-end gap-3 rounded-[1.6rem] p-2">
                    <input ref={uploadInputRef} type="file" multiple accept={uploadAccept} onChange={handleUploadFiles} className="hidden" />
                    <button
                      type="button"
                      onClick={() => uploadInputRef.current?.click()}
                      disabled={chatLoading || chatAttachments.length >= 6}
                      className="liquid-chip mb-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-lg font-semibold text-fg disabled:cursor-not-allowed disabled:opacity-40"
                      title={selectedModelSupportsVision ? 'Joindre images et fichiers texte' : 'Joindre fichiers texte seulement'}
                    >
                      +
                    </button>
                    <textarea
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      onKeyDown={onChatKeyDown}
                      rows={1}
                      placeholder="Message Vryx..."
                      className="max-h-40 min-h-12 flex-1 resize-none bg-transparent px-3 py-3 text-sm text-neutral-950 outline-none placeholder:text-muted dark:text-zinc-50"
                    />
                    <button
	                      type="button"
	                      onClick={() => void sendChat()}
	                      disabled={chatLoading || !modelId || (!chatInput.trim() && chatAttachments.length === 0)}
                      className="liquid-lens h-12 rounded-2xl px-5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Envoyer
                    </button>
                  </div>
                  {chatAttachments.length > 0 || !selectedModelSupportsVision ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {chatAttachments.map((attachment) => (
                        <button
                          key={attachment.id}
                          type="button"
                          onClick={() => removeAttachment(attachment.id)}
                          className="liquid-chip rounded-full px-3 py-2 text-xs font-semibold text-muted hover:text-fg"
                          title="Cliquer pour retirer"
                        >
                          {attachment.kind === 'image' ? 'Image' : 'Fichier'} · {attachment.name} · {Math.max(1, Math.round(attachment.size / 1024))} Ko
                        </button>
                      ))}
                      <span className="rounded-full border border-white/12 px-3 py-2 text-xs text-muted">
                        {selectedModelSupportsVision ? 'Images autorisées par ce modèle.' : 'Modèle texte: fichiers texte uniquement.'}
                      </span>
                    </div>
                  ) : null}
                  </div>
                </div>
              </Panel>
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
                      <span className="text-sm font-semibold text-fg">Nom de la clé</span>
                      <input
                        id={`${formId}-key-name`}
                        value={newKeyName}
                        onChange={(event) => setNewKeyName(event.target.value)}
                        className="mt-2 h-12 w-full rounded-2xl border border-border bg-surface px-4 font-mono text-sm text-fg outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/15"
                        autoComplete="off"
                      />
                    </label>
                    <button type="submit" disabled={creatingKey} className="btn-primary h-12 rounded-2xl px-5 text-sm font-semibold disabled:opacity-60">
                      {creatingKey ? 'Création...' : 'Générer'}
                    </button>
                  </form>
                  {generatedKey ? (
                    <div className="mt-5 rounded-3xl border border-emerald-400/30 bg-emerald-400/10 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-emerald-500">Clé générée</p>
                          <p className="mt-1 text-xs text-muted">Elle ne sera plus affichée après fermeture/rechargement.</p>
                        </div>
                        <button type="button" onClick={() => void copyWithFeedback('generated-key', generatedKey)} className="copy-feedback rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white">
                          {copiedKey === 'generated-key' ? 'Clé copiée' : 'Copier la clé'}
                        </button>
                      </div>
                      <input ref={newKeyRef} value={generatedKey} readOnly onFocus={(event) => event.currentTarget.select()} className="mt-4 w-full select-all rounded-2xl border border-emerald-400/30 bg-bg px-4 py-3 font-mono text-xs text-fg outline-none" />
                    </div>
                  ) : null}
                  <div className="mt-6 grid gap-3 md:grid-cols-2">
                    <button type="button" onClick={() => void copyWithFeedback('api-base', apiBase)} className="rounded-2xl border border-border bg-surface p-4 text-left">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Base URL</p>
                      <p className="mt-2 break-all font-mono text-sm text-accent">{copiedKey === 'api-base' ? 'Copié' : apiBase}</p>
                    </button>
                    <div className="rounded-2xl border border-border bg-surface p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Modèle</p>
                        <button type="button" onClick={() => void copyWithFeedback('api-model', modelId)} className="copy-feedback text-xs font-semibold text-accent disabled:opacity-40" disabled={!modelId}>
                          {copiedKey === 'api-model' ? 'Copié' : 'Copier'}
                        </button>
                      </div>
                      <select
                        value={modelId}
                        onChange={(event) => setSelectedModel(event.target.value)}
                        className="liquid-chip mt-2 h-11 w-full rounded-2xl px-3 font-mono text-sm text-fg outline-none"
                      >
                        {models.length === 0 ? <option value="">Aucun modèle détecté</option> : null}
                        {models.map((model) => {
                          const required = Math.max(1, Number(model.requiredWorkers || 1))
                          const runnable = Boolean(model.runnable) || Number(model.workersOnline || 0) >= required
                          return (
                          <option key={model.id} value={model.id} disabled={!runnable}>
                            {model.id}{runnable ? '' : ` — attente ${model.workersOnline}/${required} worker(s)`}
                          </option>
                          )
                        })}
                      </select>
                    </div>
                  </div>
                </Panel>
                <Panel className="bg-neutral-950 p-5 text-slate-100">
                  <p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">Exemple OpenAI-compatible</p>
                  <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-slate-300">{`curl ${apiBase}/chat/completions \\
  -H "Authorization: Bearer vel_sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${modelId || 'MODEL_ID'}","messages":[{"role":"user","content":"Salut"}]}'`}</pre>
                </Panel>
              </div>
              <Panel className="mt-5 overflow-hidden">
                <div className="grid grid-cols-[1fr_auto] gap-3 border-b border-border bg-surface px-5 py-4 text-xs font-semibold uppercase tracking-wide text-muted">
                  <span>Clés actives</span>
                  <span>{apiKeys.length}</span>
                </div>
                {apiKeys.length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-muted">Aucune clé active.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {apiKeys.map((key) => (
                      <div key={key.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
                        <div>
                          <p className="font-semibold text-fg">{key.name}</p>
                          <p className="mt-1 font-mono text-xs text-muted">{key.keyPrefix}</p>
                          <p className="mt-1 text-xs text-muted">Créée {dateTime(key.createdAt)} · Dernier usage {dateTime(key.lastUsedAt)}</p>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-right font-mono text-xs sm:min-w-72">
                          <span><span className="block text-muted">req</span>{integer(key.requestCount ?? 0)}</span>
                          <span><span className="block text-muted">tokens</span>{compact(key.totalTokens ?? 0)}</span>
                          <span><span className="block text-muted">€</span>{money(key.costEur ?? 0, 6)}</span>
                        </div>
                        <button type="button" onClick={() => void revokeKey(key.id)} className="rounded-xl border border-alert/30 px-3 py-2 text-xs font-semibold text-alert transition hover:bg-alert/10">
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
              <Panel className="liquid-static mt-5 overflow-hidden">
                {sessions.length === 0 ? (
                  <p className="px-5 py-10 text-center text-sm text-muted">Aucune session enregistrée.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {visibleSessions.map((session) => {
                      const latency = session.latencyMs || session.computeTimeMs || 0
                      const tps = session.completionTokens > 0 && latency > 0 ? session.completionTokens / (latency / 1000) : 0
                      return (
                        <div key={session.id} className="grid gap-3 px-5 py-4 transition hover:bg-white/16 dark:hover:bg-white/[.045] lg:grid-cols-[1fr_auto_auto_auto] lg:items-center">
                          <div>
                            <p className="font-mono text-xs text-muted">{dateTime(session.createdAt)}</p>
                            <p className="mt-1 truncate text-sm font-semibold text-fg">{session.model ?? 'Modèle inconnu'}</p>
                          </div>
                          <span className="font-mono text-sm text-fg">{integer(session.totalTokens)} tok</span>
                          <span className="font-mono text-sm text-accent">{tps.toFixed(2)} TPS</span>
                          <span className="font-mono text-sm text-muted">{Math.round(latency)} ms</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Panel>
              {sessions.length > usagePageSize ? (
                <div className="mt-5 flex flex-col gap-3 rounded-[1.4rem] border border-white/12 bg-white/10 p-3 backdrop-blur-xl dark:bg-white/[.035] sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted">
                    Page {usagePage} / {usageTotalPages} · {integer(sessions.length)} sessions
                  </p>
                  <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setUsagePage((page) => Math.max(1, page - 1))}
                      disabled={usagePage <= 1}
                      className="liquid-chip rounded-2xl px-4 py-2 text-sm font-semibold text-fg disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Précédent
                    </button>
                    {usagePagination.map((item) =>
                      typeof item === 'number' ? (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setUsagePage(item)}
                          className={`h-10 min-w-10 rounded-2xl px-3 font-mono text-sm font-semibold ${item === usagePage ? 'liquid-lens text-white' : 'liquid-chip text-muted'}`}
                        >
                          {item}
                        </button>
                      ) : (
                        <span key={item} className="px-1 font-mono text-sm text-muted">...</span>
                      ),
                    )}
                    <button
                      type="button"
                      onClick={() => setUsagePage((page) => Math.min(usageTotalPages, page + 1))}
                      disabled={usagePage >= usageTotalPages}
                      className="liquid-chip rounded-2xl px-4 py-2 text-sm font-semibold text-fg disabled:cursor-not-allowed disabled:opacity-40"
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
                    <p className="font-semibold text-fg">Aucun worker lié à ce compte.</p>
                    <p className="mt-2 text-sm text-muted">Connectez-vous dans l’application worker avec ce compte pour voir apparaître vos machines ici.</p>
                  </Panel>
                ) : (
                  visibleWorkers.map((worker) => (
                    <Panel key={worker.peerId} className="overflow-hidden">
                      <div className="grid gap-5 p-5 lg:grid-cols-[1fr_auto] lg:items-center">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`h-2.5 w-2.5 rounded-full ${worker.online ? 'bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,.8)]' : 'bg-zinc-400'}`} />
                            <p className="font-display text-xl font-bold text-fg">{worker.gpuName || 'GPU inconnu'}</p>
                            <span className="rounded-full bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-600 dark:text-sky-300">{worker.runtimeBackend || 'runtime ?'}</span>
                          </div>
                          <p className="mt-2 break-all font-mono text-xs text-muted">{worker.peerId}</p>
                          <p className="mt-2 text-sm text-muted">{worker.model || 'Aucun modèle déclaré'} · heartbeat {worker.secondsSinceHeartbeat}s</p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-4 lg:min-w-[34rem]">
                          <div className="rounded-2xl bg-black/5 p-3 dark:bg-white/6"><p className="text-xs text-muted">VRAM</p><p className="mt-1 font-mono font-semibold">{money(worker.allocatedVramMb / 1024, 1)} / {money(worker.gpuVramMb / 1024, 1)} Go</p></div>
                          <div className="rounded-2xl bg-black/5 p-3 dark:bg-white/6"><p className="text-xs text-muted">Allocation</p><p className="mt-1 font-mono font-semibold">{worker.memoryLimitPercent || 0}%</p></div>
                          <div className="rounded-2xl bg-black/5 p-3 dark:bg-white/6"><p className="text-xs text-muted">Tokens</p><p className="mt-1 font-mono font-semibold">{compact(worker.tokensGenerated)}</p></div>
                          <div className="rounded-2xl bg-black/5 p-3 dark:bg-white/6"><p className="text-xs text-muted">Quant</p><p className="mt-1 font-mono font-semibold">{worker.weightQuantization || '—'}</p></div>
                        </div>
                      </div>
                    </Panel>
                  ))
                )}
              </div>
              {workers.length > workerPageSize ? (
                <div className="mt-5 flex flex-col gap-3 rounded-[1.4rem] border border-white/12 bg-white/10 p-3 backdrop-blur-xl dark:bg-white/[.035] sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted">
                    Page {workersPage} / {workersTotalPages} · {integer(workers.length)} workers
                  </p>
                  <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setWorkersPage((page) => Math.max(1, page - 1))}
                      disabled={workersPage <= 1}
                      className="liquid-chip rounded-2xl px-4 py-2 text-sm font-semibold text-fg disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Précédent
                    </button>
                    {workersPagination.map((item) =>
                      typeof item === 'number' ? (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setWorkersPage(item)}
                          className={`h-10 min-w-10 rounded-2xl px-3 font-mono text-sm font-semibold ${item === workersPage ? 'liquid-lens text-white' : 'liquid-chip text-muted'}`}
                        >
                          {item}
                        </button>
                      ) : (
                        <span key={item} className="px-1 font-mono text-sm text-muted">...</span>
                      ),
                    )}
                    <button
                      type="button"
                      onClick={() => setWorkersPage((page) => Math.min(workersTotalPages, page + 1))}
                      disabled={workersPage >= workersTotalPages}
                      className="liquid-chip rounded-2xl px-4 py-2 text-sm font-semibold text-fg disabled:cursor-not-allowed disabled:opacity-40"
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
                      <p className="font-display text-2xl font-bold text-fg">Recharger des crédits</p>
                      <p className="mt-1 text-sm text-muted">Packs prépayés utilisables par les clés API. Les factures Stripe apparaissent après paiement.</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${billing?.checkoutEnabled ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-600 dark:text-amber-300'}`}>
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
                        className="rounded-2xl border border-border bg-surface p-4 text-left transition hover:border-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="block text-xs font-semibold uppercase tracking-wide text-muted">Pack crédits</span>
                        <span className="mt-2 block font-display text-3xl font-bold text-fg">{money(amount, 0)} €</span>
                        <span className="mt-2 block text-xs text-muted">{checkoutLoadingAmount === amount ? 'Ouverture...' : 'Paiement carte'}</span>
                      </button>
                    ))}
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl bg-black/5 p-4 dark:bg-white/6"><p className="text-xs text-muted">Projection</p><p className="mt-1 font-mono font-semibold">{money(estimatedMonthly)} € / mois</p></div>
                    <div className="rounded-2xl bg-black/5 p-4 dark:bg-white/6">
                      <p className="text-xs text-muted">Prix actuel</p>
                      <p className="mt-1 font-mono font-semibold">
                        {billing?.pricing?.minInputEurPerMillion != null && billing?.pricing?.minOutputEurPerMillion != null
                          ? `${money(billing.pricing.minInputEurPerMillion, 4)} / ${money(billing.pricing.minOutputEurPerMillion, 4)} €/M`
                          : 'Sur devis'}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-black/5 p-4 dark:bg-white/6"><p className="text-xs text-muted">Marge estimée</p><p className="mt-1 font-mono font-semibold">{money(investor?.estimatedGrossMarginPercent ?? 0, 0)}%</p></div>
                  </div>
                </Panel>
                <Panel className="p-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-fg">Ledger crédits</p>
                    <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-semibold text-muted">{billing?.ledger.length ?? 0}</span>
                  </div>
                  <div className="mt-4 space-y-3">
                    {billing?.ledger.length ? (
                      billing.ledger.slice(0, 8).map((entry) => (
                        <div key={entry.id} className="rounded-2xl bg-black/5 p-3 dark:bg-white/6">
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-semibold text-fg">{entry.description || entry.type}</p>
                            <span className={`font-mono text-sm font-semibold ${entry.amountEur >= 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-fg'}`}>
                              {entry.amountEur >= 0 ? '+' : ''}{money(entry.amountEur, 6)} €
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted">
                            {dateTime(entry.createdAt)} · {entry.type}
                            {entry.pricing?.rates?.inputEurPerMillion != null && entry.pricing?.rates?.outputEurPerMillion != null
                              ? ` · ${money(entry.pricing.rates.inputEurPerMillion, 4)}/${money(entry.pricing.rates.outputEurPerMillion, 4)} €/M`
                              : ''}
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="rounded-2xl bg-black/5 p-4 text-sm text-muted dark:bg-white/6">Aucun mouvement de crédits pour le moment.</p>
                    )}
                  </div>
                </Panel>
              </div>
              {billing?.invoices?.length ? (
                <Panel className="mt-5 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-fg">Paiements et factures Stripe</p>
                    <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-semibold text-muted">{billing.invoices.length}</span>
                  </div>
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    {billing.invoices.slice(0, 6).map((invoice) => (
                      <div key={`${invoice.provider}:${invoice.providerSessionId}`} className="rounded-2xl bg-black/5 p-4 dark:bg-white/6">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-mono text-xs text-muted">{invoice.providerSessionId || invoice.provider}</p>
                          <p className="font-mono text-sm font-semibold text-fg">{money(invoice.amountEur, 2)} €</p>
                        </div>
                        <p className="mt-1 text-xs text-muted">{dateTime(invoice.createdAt)} · {invoice.status}</p>
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
                <Panel className="p-5"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Compte</p><p className="mt-3 break-all font-mono text-sm text-fg">{user.email}</p></Panel>
                <Panel className="p-5"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Dernière connexion</p><p className="mt-3 text-sm text-fg">{dateTime(overview?.lastLoginAt)}</p></Panel>
                <Panel className="p-5"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Clés actives</p><p className="mt-3 font-display text-3xl font-bold text-fg">{apiKeys.length}</p></Panel>
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
                      <p className="font-semibold text-fg">Apparence</p>
                      <p className="mt-2 text-sm text-muted">Choisissez clair, sombre ou suivez le thème de l’OS.</p>
                    </div>
                    <ThemeToggle menuPlacement="up" />
                  </div>
                </Panel>
                <Panel className="p-5">
                  <p className="font-semibold text-fg">Historique</p>
                  <p className="mt-2 text-sm text-muted">Supprimer les sessions stockées sur votre compte.</p>
                  <button type="button" onClick={() => void clearSessions()} className="mt-4 rounded-2xl border border-alert/30 px-4 py-2 text-sm font-semibold text-alert hover:bg-alert/10">
                    Vider l'historique
                  </button>
                </Panel>
                <Panel className="p-5">
                  <p className="font-semibold text-fg">Streaming</p>
                  <p className="mt-2 text-sm text-muted">Le chat utilise le flux distribué quand il est disponible, avec rendu caractère par caractère côté interface.</p>
                  <div className="mt-4 rounded-2xl bg-emerald-500/10 p-4 text-sm font-semibold text-emerald-600 dark:text-emerald-300">Activé par défaut</div>
                </Panel>
                <Panel className="p-5">
                  <p className="font-semibold text-fg">Limites API</p>
                  <p className="mt-2 text-sm text-muted">Plafond de génération actuel côté serveur.</p>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-2xl bg-black/5 p-4 dark:bg-white/6"><p className="text-xs text-muted">Max tokens</p><p className="mt-1 font-mono font-semibold">32 768</p></div>
                    <div className="rounded-2xl bg-black/5 p-4 dark:bg-white/6"><p className="text-xs text-muted">Modèle</p><p className="mt-1 truncate font-mono text-xs font-semibold">{modelId || 'Auto VPS'}</p></div>
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
