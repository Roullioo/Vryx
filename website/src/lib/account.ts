import { apiJson } from './api'

export type AccountOverview = {
  plan: string
  monthlyTokenBudget: number
  tokensUsed: number
  tokensQuota: number
  usagePercent: number
  requestsThisMonth: number
  activeApiKeys: number
  balanceCurrency: string
  balanceCredits: number
  spendThisMonth: number
  nextInvoiceEstimate: number
  investorMetrics?: {
    latencyP50Ms: number
    latencyP95Ms: number
    tpsP50: number
    tpsP95: number
    pingP50Ms: number
    pingP95Ms: number
    costPerMillionTokens: number
    estimatedGrossMarginPercent: number
    estimatedGrossMarginEur: number
    estimatedWorkerRewardsEur: number
    completionTokens: number
    liveWorkers: number
    totalWorkers: number
    avgWorkerUptimePercent: number
    sampleSize: number
  }
  lastLoginAt?: string | null
}

export type AccountApiKey = {
  id: string
  name: string
  keyPrefix: string
  createdAt: string | null
  lastUsedAt: string | null
  requestCount?: number
  totalTokens?: number
  promptTokens?: number
  completionTokens?: number
  costEur?: number
  avgLatencyMs?: number
}

export type AccountApiKeyCreatePayload = {
  name: string
}

export type AccountApiKeyCreateResult = {
  key: {
    id: string
    name: string
    keyPrefix: string
    createdAt: string
    lastUsedAt: string | null
  }
  plainKey: string
}

export type BillingLedgerEntry = {
  id: string
  type: 'credit_purchase' | 'usage_debit' | 'admin_adjustment' | 'refund' | string
  amountEur: number
  currency: string
  description: string
  referenceType: string | null
  referenceId: string | null
  pricing?: {
    billingMode?: string
    rates?: {
      inputEurPerMillion?: number
      outputEurPerMillion?: number
      blendedEurPerMillion?: number
    }
    inputCostEur?: number
    outputCostEur?: number
    volumeDiscountPercent?: number
  } | null
  createdAt: string | null
}

export type BillingInvoice = {
  provider: string
  providerSessionId: string | null
  amountEur: number
  currency: string
  status: string
  checkoutUrl: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type AccountBilling = {
  ok: boolean
  currency: string
  balanceEur: number
  enforceCredits: boolean
  checkoutEnabled: boolean
  packages: number[]
  monthUsage: {
    requestCount: number
    totalTokens: number
    costEur: number
    averageEurPerMillion: number | null
  }
  ledger: BillingLedgerEntry[]
  invoices?: BillingInvoice[]
  pricing?: {
    published: boolean
    minInputEurPerMillion: number | null
    minOutputEurPerMillion: number | null
    eurPerMillionTokens: number | null
    workerRewardSharePercent: number
    volumeDiscounts: { minMonthlyMillions: number; discountPercent: number }[]
  }
}

export type AccountSessionSummary = {
  id: string
  conversationId: string
  conversationTitle: string
  timestamp: number
  createdAt: string | null
  model: string | null
  prompt: string
  response: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  vpsDelegateMs: number
  workerComputeMs: number
  computeTimeMs?: number
  pingMs?: number
  avgMsPerToken?: number
  hotPathTps?: number
  mode: string
  routingPath: string[]
  pipelineLayout: string
  pipelineOk: boolean
}

function asNumber(raw: unknown, fallback = 0): number {
  if (raw === null || raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function toAccountSession(row: unknown): AccountSessionSummary {
  const item = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {}
  return {
    id: String(item.id ?? ''),
    conversationId: String(item.conversationId ?? item.id ?? ''),
    conversationTitle: String(item.conversationTitle ?? item.prompt ?? 'Nouvelle conversation'),
    timestamp: asNumber(item.timestamp, 0),
    createdAt: item.createdAt == null ? null : String(item.createdAt),
    model: item.model == null ? null : String(item.model),
    prompt: String(item.prompt ?? ''),
    response: String(item.response ?? ''),
    promptTokens: asNumber(item.promptTokens),
    completionTokens: asNumber(item.completionTokens),
    totalTokens: asNumber(item.totalTokens),
    latencyMs: asNumber(item.latencyMs),
    vpsDelegateMs: asNumber(item.vpsDelegateMs),
    workerComputeMs: asNumber(item.workerComputeMs),
    computeTimeMs: item.computeTimeMs == null ? undefined : asNumber(item.computeTimeMs),
    pingMs: item.pingMs == null ? undefined : asNumber(item.pingMs),
    avgMsPerToken: item.avgMsPerToken == null ? undefined : asNumber(item.avgMsPerToken),
    hotPathTps: item.hotPathTps == null ? undefined : asNumber(item.hotPathTps),
    mode: String(item.mode ?? ''),
    routingPath: Array.isArray(item.routingPath) ? item.routingPath.filter((entry): entry is string => typeof entry === 'string') : [],
    pipelineLayout: String(item.pipelineLayout ?? ''),
    pipelineOk: Boolean(item.pipelineOk),
  }
}

export async function fetchAccountOverview(): Promise<
  { ok: true; data: AccountOverview } | { ok: false; error: string; status: number }
> {
  const r = await apiJson<AccountOverview>('/api/account/overview')
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  return { ok: true, data: r.data }
}

export async function fetchAccountApiKeys(): Promise<
  { ok: true; keys: AccountApiKey[] } | { ok: false; error: string; status: number }
> {
  const r = await apiJson<{ keys: AccountApiKey[] }>('/api/account/api-keys')
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  return { ok: true, keys: Array.isArray(r.data.keys) ? r.data.keys : [] }
}

export async function createAccountApiKey(name: string): Promise<
  { ok: true; payload: AccountApiKeyCreateResult } | { ok: false; error: string; status: number }
> {
  const r = await apiJson<AccountApiKeyCreateResult>('/api/account/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim() }),
  })
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  return { ok: true, payload: r.data }
}

export async function revokeAccountApiKey(id: string): Promise<
  { ok: true } | { ok: false; error: string; status: number }
> {
  const r = await apiJson(`/api/account/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  return { ok: true }
}

export async function fetchAccountBilling(): Promise<
  { ok: true; billing: AccountBilling } | { ok: false; error: string; status: number }
> {
  const r = await apiJson<AccountBilling>('/api/account/billing')
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  return { ok: true, billing: r.data }
}

export async function createBillingCheckout(amountEur: number): Promise<
  { ok: true; url: string; sessionId: string } | { ok: false; error: string; status: number }
> {
  const r = await apiJson<{ url: string; sessionId: string }>('/api/account/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ amountEur }),
  })
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  return { ok: true, url: r.data.url, sessionId: r.data.sessionId }
}

export async function fetchAccountSessions(limit = 75): Promise<
  { ok: true; sessions: AccountSessionSummary[] } | { ok: false; error: string; status: number }
> {
  const r = await apiJson<{ sessions: unknown[] }>(`/api/account/sessions?limit=${limit}`)
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  const sessions = Array.isArray(r.data.sessions) ? r.data.sessions.map(toAccountSession) : []
  return { ok: true, sessions }
}
