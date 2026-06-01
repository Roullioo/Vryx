import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clipboard,
  Cpu,
  Database,
  ExternalLink,
  FolderOpen,
  Gauge,
  Globe2,
  Layers,
  LogOut,
  MemoryStick,
  Network,
  Power,
  RefreshCw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal,
  Timer,
  TrendingUp,
  Wallet,
} from 'lucide-react'

type WorkerConfig = {
  apiUrl: string
  bootstrapNode: string
  modelId: string
  memoryGb: number
  memoryPercent: number
  backend: string
  quantization: string
  cacheDir: string
  grpcPort: number
  apiPort: number
  p2pPort: number
  autoStart: boolean
  allowUnstableGpu: boolean
  userId: string
  language?: string
  authToken?: string
  userEmail?: string
  electricityPriceKwh?: number
}

type HardwareStats = {
  platform: string
  arch: string
  os: string
  cpu: string
  gpuName: string
  gpuVendor: string
  unifiedMemory: boolean
  totalMemoryGb: number
  availableMemoryGb: number
  vramGb: number
  backendCandidates: string[]
  controllers: Array<{ model: string; vendor: string; vramMb: number; bus: string }>
}

type ModelInfo = {
  id: string
  label: string
  family: string
  paramsB: number
  activeParamsB?: number
  architecture?: string
  diskGb: number
  totalModelGb?: number
  effectiveModelGb?: number
  fullLoadMinGb?: number
  fullLoadInt8Gb?: number
  fullLoadFp16Gb?: number
  mlxFullLoadModelId?: string
  mlxInt8LoadModelId?: string
  mlxDwqLoadModelId?: string
  hfFp8ModelId?: string
  localShardTypicalGb?: number
  localDownloadMode?: 'direct_or_shard' | 'shard_only'
  directAllowed?: boolean
  distributedOnly?: boolean
  totalLayers?: number
  contextTokens?: number
  recommendedMemoryGb: number
  minMemoryGb: number
  shardMinGb: number
  quality: string
  speed: string
  useCase: string
  gated?: boolean
  quantizedVariants?: Array<{
    quantization: string
    backend: string
    modelId: string
    diskGb: number
    minMemoryGb: number
  }>
}

type WorkerState = {
  state: 'stopped' | 'starting' | 'connecting' | 'working' | 'error'
  progress: number
  message: string
}

type LogLine = { level: 'info' | 'error'; line: string; at: string }

type SessionPoint = {
  at: number
  tps: number
  tokens: number
  sessionTokens?: number
  tokensPerSec: number
  connections: number
  pingMs: number
}

type WorkerSession = {
  id: string
  startedAt: number
  endedAt?: number
  startTokens: number
  lastTokens: number
  avgTps: number
  peakTps: number
  points: SessionPoint[]
}

type WorkerMetrics = {
  online: boolean
  p2pReady: boolean
  peerId: string
  activeConnections: number
  tokensGenerated: number
  tokensIn: number
  tokensOut: number
  pingMs: number
  localLatencyMs: number
  remoteLatencyMs: number
  tps: number
  activeTps: number
  activeTpsAverage: number
  activeSessionTokens: number
  activeSessionSec: number
  lastActiveAt: string
  jobs: number
  uptimeSec: number
  estimatedToday: number
  lastHeartbeatAt: string
  lastHeartbeatStatus: number
  lastHeartbeatError: string
  apiUrl: string
  workerSecretPresent: boolean
  lastError: string
  shardCount: number
  shardLayers: number
  shardLayerStart: number | null
  shardLayerEnd: number | null
  shardModelGb: number
  shardModelId: string
  shardSessionId: string
  shardWeightLoadMode: string
  shardReady: boolean
}

type NetworkStats = {
  ok?: boolean
  sampledAt?: string
  onlineCount: number
  registeredWorkers: number
  activeWorkers30d: number
  totalTokensGenerated: number
  totalTokens1h: number
  totalTokens24h: number
  totalTokens30d: number
  avgTokensPerActiveWorker30d: number
}

type WorkerUpdateStatus = {
  ok: boolean
  currentVersion?: string
  available?: boolean
  release?: { version?: string }
  error?: string
}

type ReleaseReadiness = {
  appVersion: string
  runtimeVersion: string
  updateFeedUrl: string
  checks: Array<{ id: string; label: string; ok: boolean; detail: string }>
}

declare global {
  interface Window {
    electron?: {
      getHardwareStats: () => Promise<HardwareStats>
      getConfig: () => Promise<WorkerConfig>
      saveConfig: (config: WorkerConfig) => Promise<WorkerConfig>
      validateConfig: (config: WorkerConfig) => Promise<{ ok: boolean; issues: string[]; backend: string; model: ModelInfo }>
      getModelCatalog: () => Promise<ModelInfo[]>
      getWorkerState: () => Promise<WorkerState>
      getWorkerMetrics: () => Promise<WorkerMetrics>
      startWorker: (config: WorkerConfig) => Promise<{ ok: boolean; error?: string; warnings?: string[] }>
      stopWorker: () => Promise<{ ok: boolean }>
      openCacheDir: () => Promise<string>
      getEarnings: (token?: string) => Promise<any>
      getNetworkStats: () => Promise<NetworkStats>
      getReleaseReadiness: () => Promise<ReleaseReadiness>
      checkWorkerUpdate: () => Promise<WorkerUpdateStatus>
      authLogin: (credentials: { email: string; password: string }) => Promise<any>
      authRegister: (credentials: { email: string; password: string }) => Promise<any>
      authLogout: () => Promise<{ ok: boolean }>
      authGoogle: () => Promise<{ ok: boolean }>
      probeDependency: (name: string) => Promise<{ ok: boolean; output: string }>
      onWorkerStatus: (callback: (value: WorkerState) => void) => void
      onWorkerLog: (callback: (value: { level: 'info' | 'error'; line: string }) => void) => void
      onWorkerMetrics: (callback: (value: WorkerMetrics) => void) => void
      onAuthUpdated: (callback: (value: { config: WorkerConfig; user: { id: string; email: string } }) => void) => void
      onWorkerUpdateStatus: (callback: (value: WorkerUpdateStatus) => void) => void
    }
  }
}

const DEFAULT_CONFIG: WorkerConfig = {
  apiUrl: 'https://vryx.eu',
  bootstrapNode: '/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz',
  modelId: 'Qwen/Qwen3.5-9B',
  memoryGb: 16,
  memoryPercent: 70,
  backend: 'auto',
  quantization: 'fp16',
  cacheDir: '',
  grpcPort: 50052,
  apiPort: 3031,
  p2pPort: 4021,
  autoStart: false,
  allowUnstableGpu: true,
  userId: '',
  language: 'auto',
  authToken: '',
  userEmail: '',
  electricityPriceKwh: 0.22,
}

const tabs = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity, color: '#c026d3' },
  { id: 'sessions', label: 'Sessions', icon: BarChart3, color: '#38bdf8' },
  { id: 'hardware', label: 'Matériel', icon: Cpu, color: '#34d399' },
  { id: 'models', label: 'Modèles', icon: Layers, color: '#f59e0b' },
  { id: 'allocation', label: 'Allocation', icon: MemoryStick, color: '#a78bfa' },
  { id: 'earnings', label: 'Stats & gains', icon: Wallet, color: '#22c55e' },
  { id: 'logs', label: 'Logs', icon: Database, color: '#fb7185' },
] as const

type TabId = (typeof tabs)[number]['id']
type ViewId = TabId | 'settings'

const i18n = {
  fr: {
    dashboard: 'Dashboard',
    sessions: 'Sessions',
    hardware: 'Matériel',
    models: 'Modèles',
    allocation: 'Allocation',
    earnings: 'Stats & gains',
    logs: 'Logs',
    settings: 'Paramètres',
    loginTitle: 'Connexion VRYX',
    registerTitle: 'Créer un compte VRYX',
    accountRequired: 'Compte worker requis',
    loginCopy: 'Connecte ton compte vryx.eu pour lier les gains, les sessions et autoriser le lancement du worker.',
    login: 'Se connecter',
    create: 'Créer le compte',
    google: 'Continuer avec Google',
    logout: 'Déconnexion',
  },
  en: {
    dashboard: 'Dashboard',
    sessions: 'Sessions',
    hardware: 'Hardware',
    models: 'Models',
    allocation: 'Allocation',
    earnings: 'Stats & earnings',
    logs: 'Logs',
    settings: 'Settings',
    loginTitle: 'VRYX login',
    registerTitle: 'Create a VRYX account',
    accountRequired: 'Worker account required',
    loginCopy: 'Connect your vryx.eu account to link earnings, sessions, and authorize this worker.',
    login: 'Log in',
    create: 'Create account',
    google: 'Continue with Google',
    logout: 'Log out',
  },
} as const

type I18nKey = keyof typeof i18n.fr

function DockGlyph({ id }: { id: TabId }) {
  return (
    <svg className="dock-glyph" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      {id === 'dashboard' && (
        <>
          <path d="M6 17.5C7.8 11 11 7.75 14 7.75s6.2 3.25 8 9.75" />
          <path d="M10.2 17.4 14 12.2l3.8 5.2" />
          <circle cx="14" cy="19.8" r="2.2" />
        </>
      )}
      {id === 'sessions' && (
        <>
          <path d="M5.5 19.5h17" />
          <path d="M7 17.2l3.4-5 3.5 2.8 3.2-6.5 4 8.7" />
          <circle cx="10.4" cy="12.2" r="1.2" />
          <circle cx="17.1" cy="8.5" r="1.2" />
        </>
      )}
      {id === 'hardware' && (
        <>
          <rect x="8" y="8" width="12" height="12" rx="3" />
          <path d="M11.5 4.8v3.1M16.5 4.8v3.1M11.5 20.1v3.1M16.5 20.1v3.1M4.8 11.5h3.1M4.8 16.5h3.1M20.1 11.5h3.1M20.1 16.5h3.1" />
          <path d="M11.8 14h4.4" />
        </>
      )}
      {id === 'models' && (
        <>
          <path d="M14 4.8 22 9.2v9.6l-8 4.4-8-4.4V9.2l8-4.4Z" />
          <path d="M6.5 9.5 14 13.8l7.5-4.3M14 13.8v8.5" />
          <path d="M10.5 7.2 18 11.5" />
        </>
      )}
      {id === 'allocation' && (
        <>
          <rect x="5.5" y="8" width="17" height="12" rx="3" />
          <path d="M9 11.5v5M12.4 11.5v5M15.8 11.5v5M19.2 11.5v5" />
          <path d="M8 5.2v2.6M20 20.2v2.6" />
        </>
      )}
      {id === 'earnings' && (
        <>
          <path d="M6 10.5h16v9.2a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3v-9.2Z" />
          <path d="M8.2 10.2 16.8 5.6a2.2 2.2 0 0 1 3 1l1.2 2.2" />
          <path d="M17.5 16h4.2" />
          <circle cx="14" cy="16.2" r="2.6" />
        </>
      )}
      {id === 'logs' && (
        <>
          <path d="M8 5.5h9.4L21 9.1v13.4H8V5.5Z" />
          <path d="M17.2 5.8v3.8h3.5M11 13h6M11 16.6h7M11 20.2h4.5" />
        </>
      )}
    </svg>
  )
}

function OldVryxLogo({ title, compact = false }: { title?: string; compact?: boolean }) {
  return (
    <img
      className={`old-vryx-logo ${compact ? 'is-compact' : ''}`}
      src="./logo.svg"
      alt={title || ''}
      aria-hidden={title ? undefined : true}
    />
  )
}

function money(value: number) {
  return `${value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

function moneyPrecise(value: number) {
  return `${value.toLocaleString('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} €`
}

function number(value: number) {
  return Math.round(value || 0).toLocaleString('fr-FR')
}

function modelGb(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 Go'
  return `${value.toLocaleString('fr-FR', { minimumFractionDigits: value < 10 ? 2 : 1, maximumFractionDigits: 2 })} Go`
}

function formatUptime(seconds: number) {
  if (!seconds) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h} h ${m} min`
  if (m > 0) return `${m} min ${s} s`
  return `${s} s`
}

function platformName(platform?: string) {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  return platform || 'Desktop'
}

function statusTone(state: WorkerState['state']) {
  if (state === 'working') return 'text-success'
  if (state === 'error') return 'text-alert'
  if (state === 'starting' || state === 'connecting') return 'text-warning'
  return 'text-muted'
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  )
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value))}
      className="control"
    />
  )
}

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: React.ElementType }) {
  return (
    <div className="metric-card">
      <div className="flex items-center gap-2 text-muted">
        <span className="metric-icon"><Icon size={15} /></span>
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 break-words font-display text-xl font-bold text-fg">{value}</p>
    </div>
  )
}

function modelBrand(model: ModelInfo) {
  const id = model.id.toLowerCase()
  if (id.includes('llama')) return { short: 'L2', name: 'Llama', color: '#f59e0b', mark: 'llama' as const }
  if (id.includes('qwen')) return { short: 'Q', name: 'Qwen', color: '#38bdf8', mark: 'qwen' as const }
  return { short: model.family.slice(0, 2).toUpperCase(), name: model.family, color: '#a78bfa', mark: 'generic' as const }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function modelRewardPerToken(model?: ModelInfo) {
  const id = model?.id.toLowerCase() || ''
  if (id.includes('70b')) return 0.0000009
  if (id.includes('35b')) return 0.00000042
  if (id.includes('0.5b')) return 0.00000005
  return 0.00000024
}

function modelBaseTps(model?: ModelInfo) {
  const params = Number(model?.activeParamsB || model?.paramsB || 9)
  if (params <= 1) return 58
  if (model?.architecture?.toLowerCase() === 'moe') return 24
  if (params <= 10) return 18
  if (params >= 60) return 6.5
  return Math.max(4, 36 / Math.sqrt(params))
}

function backendFactor(backend: string) {
  const key = (backend || 'auto').toLowerCase()
  if (key.includes('vllm') || key.includes('cuda')) return 1.16
  if (key.includes('mlx_lm')) return 1.05
  if (key === 'mlx') return 0.92
  if (key.includes('rocm')) return 0.88
  if (key.includes('openvino')) return 0.58
  if (key.includes('cpu')) return 0.1
  return 1
}

function quantizationFactor(quantization: string) {
  const key = (quantization || 'fp16').toLowerCase()
  if (key.includes('q4') || key.includes('int4')) return 1.22
  if (key.includes('8')) return 1.08
  if (key.includes('auto')) return 1.04
  return 0.94
}

function workerCapacityFactor(model: ModelInfo, config: WorkerConfig, hardware?: HardwareStats | null) {
  const hardwareMemory = Math.max(1, Number(hardware?.vramGb || hardware?.totalMemoryGb || config.memoryGb || 1))
  const allocated = clamp(Number(config.memoryGb || 0), 1, hardwareMemory)
  const shardRatio = allocated / Math.max(1, Number(model.shardMinGb || model.recommendedMemoryGb || 1))
  const recommendationRatio = allocated / Math.max(1, Number(model.recommendedMemoryGb || model.shardMinGb || 1))

  if (model.distributedOnly) {
    return clamp(0.62 + Math.min(1.25, shardRatio) * 0.24 + Math.min(0.5, recommendationRatio) * 0.16, 0.58, 1.06)
  }

  return clamp(0.44 + Math.min(1.35, recommendationRatio) * 0.44, 0.42, 1.08)
}

function effectiveModelGb(model: ModelInfo) {
  return Number(model.effectiveModelGb || model.totalModelGb || model.diskGb || 0)
}

function canFullLoadModel(model: ModelInfo, config: WorkerConfig, hardware?: HardwareStats | null) {
  if (model.directAllowed === false) return false
  const hardwareMemory = Math.max(1, Number(hardware?.vramGb || hardware?.totalMemoryGb || config.memoryGb || 1))
  const allocated = clamp(Number(config.memoryGb || 0), 1, hardwareMemory)
  const required = Number(model.fullLoadMinGb || model.effectiveModelGb || model.totalModelGb || model.diskGb || Infinity)
  return Number.isFinite(required) && allocated >= required
}

function estimateShardPlan(model: ModelInfo, config: WorkerConfig, hardware?: HardwareStats | null) {
  if (!model.distributedOnly) return null
  const totalLayers = Number(model.totalLayers || 0)
  const totalGb = effectiveModelGb(model)
  if (!totalLayers || !totalGb) return null
  if (canFullLoadModel(model, config, hardware)) {
    return {
      layers: totalLayers,
      gb: totalGb,
      full: true,
    }
  }
  const hardwareMemory = Math.max(1, Number(hardware?.vramGb || hardware?.totalMemoryGb || config.memoryGb || 1))
  const allocated = clamp(Number(config.memoryGb || 0), 1, hardwareMemory)
  const safetyGb = Math.min(1.5, Math.max(0.75, allocated * 0.06))
  const usableGb = Math.max(0.25, (allocated - safetyGb) * 0.92)
  const shardBudgetGb = Math.min(usableGb, Number(model.localShardTypicalGb || usableGb))
  const avgLayerGb = totalGb / totalLayers
  const layers = clamp(Math.floor(shardBudgetGb / Math.max(0.01, avgLayerGb)), 1, Math.max(1, totalLayers - 1))
  return {
    layers,
    gb: Math.min(totalGb, layers * avgLayerGb),
    full: false,
  }
}

function estimateConfigTps(model: ModelInfo, config: WorkerConfig, hardware?: HardwareStats | null, backend = 'auto') {
  const hardwareMemory = Math.max(1, Number(hardware?.vramGb || hardware?.totalMemoryGb || config.memoryGb || 1))
  const allocated = clamp(Number(config.memoryGb || 0), 1, hardwareMemory)
  const memoryRatio = clamp(allocated / Math.max(1, Number(model.recommendedMemoryGb || model.shardMinGb || 1)), 0.2, 1.18)
  const vendor = `${hardware?.gpuVendor || ''} ${hardware?.gpuName || ''}`.toLowerCase()
  const gpuFactor = vendor.includes('apple') ? 1.04 : vendor.includes('nvidia') ? 1.12 : vendor.includes('amd') ? 0.92 : vendor.includes('intel') ? 0.62 : 0.82
  const distributedPenalty = model.distributedOnly ? 0.72 : 1
  return modelBaseTps(model) * memoryRatio * backendFactor(backend) * quantizationFactor(config.quantization) * gpuFactor * distributedPenalty
}

function estimateWorkerRevenue(
  model: ModelInfo,
  config: WorkerConfig,
  hardware?: HardwareStats | null,
  backend = 'auto',
  metrics?: WorkerMetrics | null,
) {
  const measuredTps = Number(metrics?.activeTpsAverage || metrics?.activeTps || metrics?.tps || 0)
  const configTps = estimateConfigTps(model, config, hardware, backend)
  const tpsBasis = measuredTps > 0 ? measuredTps : configTps
  const availabilityFactor = metrics?.p2pReady ? 0.78 : metrics?.online ? 0.48 : 0.3
  const capacityFactor = workerCapacityFactor(model, config, hardware)
  const rewardPerToken = modelRewardPerToken(model)
  const hourly = tpsBasis * 3600 * rewardPerToken * availabilityFactor * capacityFactor

  return {
    hourly,
    daily: hourly * 24,
    monthly: hourly * 24 * 30,
    tpsBasis,
    configTps,
    measuredTps,
    rewardPerToken,
    availabilityFactor,
    capacityFactor,
    source: measuredTps > 0 ? 'mesuré actif' : 'config worker',
  }
}

function recommendedMemoryGb(model: ModelInfo, hardware?: HardwareStats | null) {
  const maxMemory = Math.max(1, Math.round(hardware?.vramGb || hardware?.totalMemoryGb || 64))
  const target = model.distributedOnly
    ? Math.max(model.shardMinGb, Math.min(model.recommendedMemoryGb, Math.round(maxMemory * 0.72)))
    : Math.min(model.recommendedMemoryGb, Math.round(maxMemory * 0.7))
  return clamp(target, Math.min(maxMemory, model.shardMinGb), maxMemory)
}

function sessionGeneratedTokens(session?: WorkerSession | null) {
  if (!session) return 0
  const delta = Math.max(0, Number(session.lastTokens || 0) - Number(session.startTokens || 0))
  const pointMax = Math.max(0, ...session.points.map((point) => Number(point.sessionTokens ?? point.tokens ?? 0)))
  return Math.max(delta, pointMax)
}

function aggregateSessionPoints(sessions: WorkerSession[]) {
  const points = sessions.flatMap((session) => session.points).slice(-240)
  if (points.length > 0) return points
  return []
}

function networkRevenue30d(
  network: NetworkStats | null,
  model: ModelInfo,
  config: WorkerConfig,
  hardware?: HardwareStats | null,
) {
  const avgTokens = Number(network?.avgTokensPerActiveWorker30d || 0)
  const rewardPerToken = modelRewardPerToken(model)
  const capacity = workerCapacityFactor(model, config, hardware)
  return {
    observedTokens: avgTokens,
    monthly: avgTokens * rewardPerToken * capacity,
    dailyAverage: (avgTokens / 30) * rewardPerToken * capacity,
    capacity,
    source: avgTokens > 0 ? 'réseau 30j' : 'projection config',
  }
}

function scoreTone(score: number): 'ok' | 'warn' | 'bad' {
  if (score >= 82) return 'ok'
  if (score >= 58) return 'warn'
  return 'bad'
}

function healthToneClass(tone: 'ok' | 'warn' | 'bad') {
  if (tone === 'ok') return 'is-ok'
  if (tone === 'bad') return 'is-bad'
  return 'is-warn'
}

function recentIso(value?: string, maxAgeMs = 120_000) {
  if (!value) return false
  const ts = Date.parse(value)
  return Number.isFinite(ts) && Date.now() - ts < maxAgeMs
}

function computeWorkerHealth(
  config: WorkerConfig,
  hardware: HardwareStats,
  model: ModelInfo,
  workerState: WorkerState,
  metrics: WorkerMetrics | null,
  issues: string[],
) {
  const checks = [
    { label: 'Compte VRYX', ok: Boolean(config.authToken && config.userId), detail: config.userEmail || `Utilisateur #${config.userId || '—'}` },
    { label: 'Hardware détecté', ok: Boolean(hardware.cpu && hardware.gpuName), detail: `${hardware.gpuName} · ${hardware.vramGb || hardware.totalMemoryGb} Go` },
    { label: 'Mémoire modèle', ok: config.memoryGb >= model.shardMinGb, detail: `${config.memoryGb} Go alloués · min shard ${model.shardMinGb} Go` },
    { label: 'Worker local', ok: workerState.state === 'working' || Boolean(metrics?.online), detail: workerState.message },
    { label: 'P2P réseau', ok: Boolean(metrics?.p2pReady), detail: `${Number(metrics?.activeConnections || 0)} connexion(s)` },
    { label: 'Heartbeat', ok: recentIso(metrics?.lastHeartbeatAt), detail: metrics?.lastHeartbeatAt || 'en attente' },
  ]
  const blockingIssues = issues.filter((issue) => !issue.includes('gated')).length
  const okCount = checks.filter((check) => check.ok).length
  const score = clamp(Math.round((okCount / checks.length) * 100) - blockingIssues * 8, 0, 100)
  return {
    score,
    tone: scoreTone(score),
    label: score >= 82 ? 'Vert' : score >= 58 ? 'Orange' : 'Rouge',
    checks,
  }
}

function computeWorkerReputation(metrics: WorkerMetrics | null, revenue: ReturnType<typeof estimateWorkerRevenue>) {
  const uptimeScore = clamp((Number(metrics?.uptimeSec || 0) / (8 * 3600)) * 32, 0, 32)
  const tokenScore = clamp(Math.log10(Number(metrics?.tokensGenerated || 0) + 1) * 13, 0, 26)
  const jobScore = clamp(Number(metrics?.jobs || 0) * 5, 0, 20)
  const networkScore = metrics?.p2pReady ? 14 : metrics?.online ? 7 : 0
  const errorPenalty = metrics?.lastError ? 18 : 0
  const score = clamp(Math.round(8 + uptimeScore + tokenScore + jobScore + networkScore - errorPenalty), 0, 100)
  const grade = score >= 90 ? 'A' : score >= 76 ? 'B' : score >= 58 ? 'C' : 'D'
  return {
    score,
    grade,
    tone: scoreTone(score),
    expectedMonthly: revenue.monthly,
  }
}

function networkDiagnostics(config: WorkerConfig, metrics: WorkerMetrics | null, networkStats: NetworkStats | null) {
  return [
    {
      label: 'API URL',
      value: metrics?.apiUrl || config.apiUrl,
      ok: Boolean(metrics?.apiUrl || config.apiUrl),
    },
    {
      label: 'Secret worker',
      value: metrics?.workerSecretPresent ? 'présent' : 'absent',
      ok: Boolean(metrics?.workerSecretPresent),
    },
    {
      label: 'Heartbeat API',
      value: metrics?.lastHeartbeatStatus ? `HTTP ${metrics.lastHeartbeatStatus}` : 'en attente',
      ok: Boolean(recentIso(metrics?.lastHeartbeatAt)),
    },
    {
      label: 'Erreur heartbeat',
      value: metrics?.lastHeartbeatError || 'aucune',
      ok: !metrics?.lastHeartbeatError,
    },
    {
      label: 'TCP local',
      value: `127.0.0.1:${config.apiPort}`,
      ok: Boolean(metrics?.online || metrics?.p2pReady),
    },
    {
      label: 'P2P public',
      value: metrics?.p2pReady ? 'connecté' : 'en attente',
      ok: Boolean(metrics?.p2pReady),
    },
    {
      label: 'Relay fallback',
      value: config.bootstrapNode ? 'bootstrap configuré' : 'bootstrap manquant',
      ok: Boolean(config.bootstrapNode),
    },
    {
      label: 'Latence API',
      value: metrics?.pingMs ? `${Math.round(metrics.pingMs)} ms` : networkStats?.sampledAt ? 'réseau joignable' : 'à mesurer',
      ok: Boolean(metrics?.pingMs || networkStats?.ok),
    },
  ]
}

function estimatePowerWatts(hardware?: HardwareStats | null) {
  const name = `${hardware?.gpuVendor || ''} ${hardware?.gpuName || ''}`.toLowerCase()
  const mem = Number(hardware?.vramGb || hardware?.totalMemoryGb || 0)
  if (name.includes('apple')) return mem >= 64 ? 95 : mem >= 32 ? 70 : 45
  if (name.includes('nvidia')) return mem >= 40 ? 320 : mem >= 20 ? 240 : 160
  if (name.includes('amd')) return mem >= 20 ? 230 : 150
  if (name.includes('intel')) return 85
  return 90
}

function periodHours(period: '1h' | '24h' | '7d' | '30d' | '1y') {
  if (period === '1h') return 1
  if (period === '24h') return 24
  if (period === '7d') return 24 * 7
  if (period === '30d') return 24 * 30
  return 24 * 365
}

function RevenueCurve({
  hourlyRevenue,
  hourlyElectricity,
  period,
}: {
  hourlyRevenue: number
  hourlyElectricity: number
  period: '1h' | '24h' | '7d' | '30d' | '1y'
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const hours = periodHours(period)
  const count = period === '1h' ? 12 : period === '24h' ? 24 : period === '7d' ? 28 : period === '30d' ? 30 : 52
  const stepHours = hours / count
  const points = Array.from({ length: count + 1 }).map((_, index) => ({
    index,
    label: period === '1h' ? `${Math.round(index * stepHours * 60)} min` : `${Math.round(index * stepHours)} h`,
    gross: hourlyRevenue * index * stepHours,
    net: Math.max(0, (hourlyRevenue - hourlyElectricity) * index * stepHours),
  }))
  const width = 640
  const height = 190
  const padX = 22
  const padY = 22
  const maxValue = Math.max(0.01, ...points.map((point) => point.gross))
  const pathFor = (key: 'gross' | 'net') => points.map((point, idx) => {
    const x = padX + (idx / Math.max(1, points.length - 1)) * (width - padX * 2)
    const y = height - padY - (point[key] / maxValue) * (height - padY * 2)
    return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
  const active = points[hoverIndex ?? points.length - 1]
  return (
    <div className="graph-panel revenue-chart p-4">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-fg">Revenus vs électricité</span>
        <span className="text-muted">Net <b className="text-fg">{moneyPrecise(active.net)}</b></span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-3 h-56 w-full overflow-visible"
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const pct = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
          setHoverIndex(Math.round(pct * (points.length - 1)))
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line key={ratio} x1={padX} x2={width - padX} y1={padY + ratio * (height - padY * 2)} y2={padY + ratio * (height - padY * 2)} stroke="rgba(255,255,255,.12)" />
        ))}
        <path d={pathFor('gross')} fill="none" stroke="#7ddcff" strokeWidth="3" strokeLinecap="round" />
        <path d={pathFor('net')} fill="none" stroke="#7dffbc" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <div className="graph-tooltip">
        <b>{active.label}</b>
        <span>Brut {moneyPrecise(active.gross)} · Net {moneyPrecise(active.net)}</span>
      </div>
    </div>
  )
}

function ModelLogo({ model }: { model: ModelInfo }) {
  const brand = modelBrand(model)
  const src = brand.mark === 'qwen' ? './qwen.png' : brand.mark === 'llama' ? './llama.png' : ''
  return (
    <span className={`model-logo mark-${brand.mark}`} aria-label={`${brand.name} logo`}>
      {src && <img src={src} alt="" />}
      {brand.mark === 'generic' && <span>{brand.short}</span>}
    </span>
  )
}

function WorkerVisual({
  state,
  progress,
  tps,
  tokens,
  tokensEarned,
  tpsHourly,
  onPrimaryClick,
  canStart,
}: {
  state: WorkerState['state']
  progress: number
  tps: number
  tokens: number
  tokensEarned: number
  tpsHourly: number
  onPrimaryClick: () => void
  canStart: boolean
}) {
  const active = state === 'working'
  const pending = state === 'starting' || state === 'connecting'
  const progressValue = pending ? Math.max(8, Math.min(100, progress || 0)) : active ? 100 : 0
  const centerLabel = pending ? 'Démarrage' : active ? 'Live' : 'Démarrer'
  const centerHint = pending ? 'Préparation du worker' : active ? 'Calcul distribué' : 'Lancer le worker'
  return (
    <div className={`compute-visual ${active ? 'is-working' : ''} ${pending ? 'is-pending' : ''}`}>
      <div className="compute-aura" />
      <div className="compute-stream stream-a" />
      <div className="compute-stream stream-b" />
      <div className="compute-stream stream-c" />
      <div className="compute-particles">
        {Array.from({ length: 18 }).map((_, index) => (
          <span key={index} style={{ '--i': index } as React.CSSProperties} />
        ))}
      </div>
      <div className="token-comets" aria-hidden="true">
        {Array.from({ length: 10 }).map((_, index) => (
          <i key={index} style={{ '--i': index } as React.CSSProperties} />
        ))}
      </div>
      <button
        type="button"
        className="compute-core-button no-drag"
        onClick={onPrimaryClick}
        disabled={pending || (!canStart && !active)}
        aria-label={active ? 'Arrêter le worker' : 'Démarrer le worker'}
      >
        <svg className="compute-progress" viewBox="0 0 240 240" aria-hidden="true">
          <circle className="progress-track" cx="120" cy="120" r="104" />
          <circle
            className="progress-value"
            cx="120"
            cy="120"
            r="104"
            pathLength="100"
            style={{ strokeDasharray: `${progressValue} 100` }}
          />
        </svg>
        <span className="compute-glass" />
        <span className="compute-logo">
          <OldVryxLogo compact />
        </span>
        <span className="compute-state">
          <b className="core-action-label">{centerLabel}</b>
          {active && <b className="core-action-hover"><Square size={15} /> Arrêter</b>}
          <small>{centerHint}</small>
        </span>
      </button>
      <div className="compute-stat stat-tokens">
        <span>Tokens générés</span>
        <b>{number(tokens)}</b>
        <small>{moneyPrecise(tokensEarned)} gagnés</small>
      </div>
      <div className="compute-stat stat-tps">
        <span>TPS</span>
        <b>{tps.toFixed(1)}</b>
        <small>{money(tpsHourly)}/h estimé</small>
      </div>
    </div>
  )
}

function compactPeer(peerId?: string) {
  if (!peerId) return '—'
  if (peerId.length <= 18) return peerId
  return `${peerId.slice(0, 10)}…${peerId.slice(-6)}`
}

function formatClock(ms: number) {
  return new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function sessionDurationAt(session: WorkerSession, now: number) {
  return Math.max(0, Math.round(((session.endedAt || now) - session.startedAt) / 1000))
}

function liveSessionPoints(
  session: WorkerSession | null,
  points: SessionPoint[],
  metrics: WorkerMetrics | null,
  now: number,
) {
  if (!session || session.endedAt || points.length === 0) return points
  const last = points[points.length - 1]
  if (now - last.at < 900) return points
  const liveTps = Math.max(0, Number(metrics?.activeTps || 0))
  return [
    ...points,
    {
      ...last,
      at: now,
      tps: liveTps,
      tokensPerSec: liveTps,
      connections: Number(metrics?.activeConnections || last.connections || 0),
      pingMs: Number(metrics?.pingMs || metrics?.remoteLatencyMs || metrics?.localLatencyMs || last.pingMs || 0),
    },
  ]
}

function LineGraph({
  points,
  metric,
  color,
  label,
  unit,
}: {
  points: SessionPoint[]
  metric: 'tokensPerSec' | 'pingMs'
  color: string
  label: string
  unit: string
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const slice = points.slice(-80)
  const renderSlice = slice.length === 1
    ? [
        { ...slice[0], at: slice[0].at - 1000 },
        slice[0],
      ]
    : slice
  const values = renderSlice.map((p) => Number(p[metric] || 0))
  const maxValue = Math.max(1, ...values)
  const minValue = Math.min(0, ...values)
  const span = Math.max(1, maxValue - minValue)
  const latest = values[values.length - 1] || 0
  const activeIndex = hoverIndex == null ? renderSlice.length - 1 : clamp(hoverIndex, 0, Math.max(0, renderSlice.length - 1))
  const activePoint = renderSlice[activeIndex]
  const activeValue = activePoint ? Number(activePoint[metric] || 0) : latest
  if (slice.length === 0) {
    return (
      <div className="h-48 rounded-lg border border-border bg-bg/35 p-4">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-fg">{label}</span>
          <span className="text-muted">—</span>
        </div>
      </div>
    )
  }
  const width = 640
  const height = 180
  const padX = 18
  const padY = 20
  const path = renderSlice.map((point, idx) => {
    const x = padX + (idx / Math.max(1, renderSlice.length - 1)) * (width - padX * 2)
    const y = height - padY - ((Number(point[metric] || 0) - minValue) / span) * (height - padY * 2)
    return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
  const activeX = padX + (activeIndex / Math.max(1, renderSlice.length - 1)) * (width - padX * 2)
  const activeY = height - padY - ((activeValue - minValue) / span) * (height - padY * 2)
  return (
    <div className="graph-panel interactive-graph p-4">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-fg">{label}</span>
        <span className="text-muted">
          {hoverIndex == null ? 'Live' : activePoint ? formatClock(activePoint.at) : '—'} <b className="text-fg">{activeValue.toFixed(metric === 'pingMs' ? 0 : 2)} {unit}</b>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-3 h-48 w-full overflow-visible"
        role="img"
        aria-label={label}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const pct = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
          setHoverIndex(Math.round(pct * Math.max(0, renderSlice.length - 1)))
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={`fill-${metric}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={padX}
            x2={width - padX}
            y1={padY + ratio * (height - padY * 2)}
            y2={padY + ratio * (height - padY * 2)}
            stroke="rgba(148, 163, 184, 0.14)"
            strokeWidth="1"
          />
        ))}
        <path d={`${path} L ${width - padX} ${height - padY} L ${padX} ${height - padY} Z`} fill={`url(#fill-${metric})`} />
        <path d={path} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {activePoint && (
          <>
            <line x1={activeX} x2={activeX} y1={padY} y2={height - padY} stroke={color} strokeOpacity="0.32" strokeWidth="1.5" />
            <circle cx={activeX} cy={activeY} r="7" fill={color} opacity="0.16" />
            <circle cx={activeX} cy={activeY} r="4" fill={color} />
          </>
        )}
        {renderSlice.map((point, idx) => {
          if (idx !== renderSlice.length - 1 && idx % 12 !== 0) return null
          const x = padX + (idx / Math.max(1, renderSlice.length - 1)) * (width - padX * 2)
          const y = height - padY - ((Number(point[metric] || 0) - minValue) / span) * (height - padY * 2)
          return <circle key={`${point.at}-${metric}`} cx={x} cy={y} r={idx === slice.length - 1 ? 4 : 2.5} fill={color} />
        })}
      </svg>
      {activePoint && (
        <div className="graph-tooltip">
          <b>{activeValue.toFixed(metric === 'pingMs' ? 0 : 2)} {unit}</b>
          <span>{formatClock(activePoint.at)} · {number(activePoint.sessionTokens || activePoint.tokens || 0)} tokens</span>
        </div>
      )}
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{formatClock(slice[0].at)}</span>
        <span>max {maxValue.toFixed(metric === 'pingMs' ? 0 : 2)} {unit}</span>
        <span>{formatClock(slice[slice.length - 1].at)}</span>
      </div>
    </div>
  )
}

function downloadModeLabel(model: ModelInfo) {
  return model.distributedOnly ? 'Full si possible, sinon shard' : 'Direct ou shard'
}

function shardLayerLabel(metrics: WorkerMetrics | null, model: ModelInfo, config: WorkerConfig, hardware?: HardwareStats | null) {
  const layers = Number(metrics?.shardLayers || 0)
  if (layers > 0) {
    const start = metrics?.shardLayerStart
    const end = metrics?.shardLayerEnd
    const range = typeof start === 'number' && typeof end === 'number' ? ` · ${start}-${end}` : ''
    return `${layers} couche${layers > 1 ? 's' : ''}${range}`
  }
  const plan = estimateShardPlan(model, config, hardware)
  if (plan) return plan.full ? `${plan.layers} couches · full local prévu` : `~${plan.layers} couches prévues`
  if (model.distributedOnly) return 'En attente du shard'
  if (model.totalLayers) return `${model.totalLayers} couches · direct`
  return 'Mode direct'
}

function shardModelGbLabel(metrics: WorkerMetrics | null, model: ModelInfo, config: WorkerConfig, hardware?: HardwareStats | null) {
  const residentGb = Number(metrics?.shardModelGb || 0)
  if (residentGb > 0) return modelGb(residentGb)
  const plan = estimateShardPlan(model, config, hardware)
  if (plan) return plan.full ? `~${modelGb(plan.gb)} full local prévu` : `~${modelGb(plan.gb)} prévus`
  if (model.distributedOnly) return '0 Go chargé'
  return `${modelGb(Number(model.totalModelGb ?? model.diskGb ?? 0))} · direct`
}

function App() {
  const [activeTab, setActiveTab] = useState<ViewId>('dashboard')
  const [hardware, setHardware] = useState<HardwareStats | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [config, setConfig] = useState<WorkerConfig>(DEFAULT_CONFIG)
  const [workerState, setWorkerState] = useState<WorkerState>({ state: 'stopped', progress: 0, message: 'Worker arrêté' })
  const [issues, setIssues] = useState<string[]>([])
  const [resolvedBackend, setResolvedBackend] = useState('auto')
  const [logs, setLogs] = useState<LogLine[]>([])
  const [metrics, setMetrics] = useState<WorkerMetrics | null>(null)
  const [saveLabel, setSaveLabel] = useState('Sauvegarder')
  const [copyLabel, setCopyLabel] = useState('Copier')
  const [sessions, setSessions] = useState<WorkerSession[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [networkStats, setNetworkStats] = useState<NetworkStats | null>(null)
  const [displayTokens, setDisplayTokens] = useState(0)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [earningsPeriod, setEarningsPeriod] = useState<'1h' | '24h' | '7d' | '30d' | '1y'>('24h')
  const [liveNow, setLiveNow] = useState(Date.now())
  const [releaseReadiness, setReleaseReadiness] = useState<ReleaseReadiness | null>(null)
  const [updateStatus, setUpdateStatus] = useState<WorkerUpdateStatus | null>(null)
  const lastMetricTokensRef = useRef(0)

  const selectedModel = useMemo(
    () => models.find((m) => m.id === config.modelId) || models[0],
    [models, config.modelId],
  )
  const activeTabMeta = tabs.find((tab) => tab.id === activeTab) || { id: 'settings', label: 'Paramètres', icon: Settings2, color: '#a78bfa' }
  const selectedRevenue = selectedModel
    ? estimateWorkerRevenue(selectedModel, config, hardware, resolvedBackend, metrics)
    : null
  const languageCode = (config.language && config.language !== 'auto' ? config.language : navigator.language || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr'
  const t = (key: I18nKey) => i18n[languageCode][key] || i18n.fr[key]
  const tabLabel = (id: ViewId) => id === 'settings' ? t('settings') : t(id as I18nKey)

  const memoryMax = Math.max(1, Math.round(hardware?.vramGb || hardware?.totalMemoryGb || 64))
  const memoryPercentFromGb = Math.round((config.memoryGb / memoryMax) * 100)
  const canStart = issues.filter((i) => !i.includes('gated')).length === 0 || config.allowUnstableGpu

  const refreshAll = async () => {
    if (!window.electron) return
    const [hw, cfg, catalog, state, liveMetrics] = await Promise.all([
      window.electron.getHardwareStats(),
      window.electron.getConfig(),
      window.electron.getModelCatalog(),
      window.electron.getWorkerState(),
      window.electron.getWorkerMetrics().catch(() => null),
    ])
    setHardware(hw)
    setConfig(cfg)
    setModels(catalog)
    setWorkerState(state)
    if (liveMetrics) {
      setMetrics(liveMetrics)
      setDisplayTokens(liveMetrics.tokensGenerated || 0)
      lastMetricTokensRef.current = liveMetrics.tokensGenerated || 0
    }
    window.electron.getNetworkStats()
      .then(setNetworkStats)
      .catch(() => setNetworkStats(null))
    window.electron.getReleaseReadiness()
      .then(setReleaseReadiness)
      .catch(() => setReleaseReadiness(null))
  }

  useEffect(() => {
    void refreshAll()
    window.electron?.onWorkerStatus((value) => setWorkerState(value))
    window.electron?.onWorkerLog((value) => {
      setLogs((prev) => [
        { ...value, at: new Date().toLocaleTimeString('fr-FR') },
        ...prev,
      ].slice(0, 240))
    })
    window.electron?.onWorkerMetrics((value) => {
      setMetrics(value)
      const nextTokens = Number(value.tokensGenerated || 0)
      const previousTokens = Number(lastMetricTokensRef.current || 0)
      setDisplayTokens((current) => (nextTokens < previousTokens ? nextTokens : Math.max(current, nextTokens)))
      setSessions((prev) => updateSessions(prev, value, lastMetricTokensRef.current))
      lastMetricTokensRef.current = nextTokens
    })
    window.electron?.onAuthUpdated((value) => {
      if (value?.config) {
        setConfig(value.config)
        setAuthError('')
      }
    })
    window.electron?.onWorkerUpdateStatus((value) => setUpdateStatus(value))
    const networkTimer = window.setInterval(() => {
      window.electron?.getNetworkStats().then(setNetworkStats).catch(() => undefined)
    }, 60_000)
    return () => window.clearInterval(networkTimer)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setLiveNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDisplayTokens((current) => {
        const real = Number(metrics?.tokensGenerated || 0)
        const previousReal = Number(lastMetricTokensRef.current || 0)
        if (real < previousReal) return real
        if (real > current) return real
        const lastActiveMs = metrics?.lastActiveAt ? Date.parse(metrics.lastActiveAt) : 0
        const recentWorkerActivity = Number.isFinite(lastActiveMs) && Date.now() - lastActiveMs < 180_000
        const activeSessionLive = Number(metrics?.activeSessionSec || 0) > 0
        const liveTps = recentWorkerActivity && activeSessionLive ? Number(metrics?.activeTps || 0) : 0
        if (liveTps > 0) {
          return current + liveTps / 4
        }
        return Math.max(current, real)
      })
    }, 250)
    return () => window.clearInterval(timer)
  }, [metrics?.tokensGenerated, metrics?.activeTps, metrics?.activeTpsAverage, metrics?.tps, metrics?.lastActiveAt, metrics?.p2pReady, metrics?.online, workerState.state])

  const updateSessions = (prev: WorkerSession[], value: WorkerMetrics, previousTokens: number) => {
    const now = Date.now()
    const tokens = Number(value.tokensGenerated || 0)
    if (tokens < Number(previousTokens || 0)) {
      const current = prev[0]
      return current && !current.endedAt ? [{ ...current, endedAt: now }, ...prev.slice(1)] : prev
    }
    const deltaTokens = Math.max(0, tokens - Number(previousTokens || 0))
    const liveTps = Number(value.activeTps || 0)
    const current = prev[0]
    const previousSessionTokens = sessionGeneratedTokens(current)
    const activeSessionTokens = Math.max(0, Number(value.activeSessionTokens || 0))
    const plausibleSessionTokens = activeSessionTokens >= 1024 && liveTps <= 0 ? 0 : activeSessionTokens
    const absoluteSessionTokens = current ? Math.max(0, tokens - Number(current.startTokens || 0)) : deltaTokens
    const sessionTokens = Math.max(plausibleSessionTokens, absoluteSessionTokens, deltaTokens)
    const deltaSessionTokens = Math.max(0, sessionTokens - previousSessionTokens)
    const sessionStillLive = Boolean(current && !current.endedAt && Number(value.activeSessionSec || 0) > 0)
    const active = deltaTokens > 0 || deltaSessionTokens > 0 || liveTps > 0 || sessionStillLive
    if (!active) {
      if (current && !current.endedAt && now - current.startedAt > 180_000) {
        return [{ ...current, endedAt: now }, ...prev.slice(1)]
      }
      return prev
    }
    const pointTps = Math.min(160, Math.max(liveTps, deltaTokens, deltaSessionTokens, Number(value.activeTpsAverage || 0)))
    const point: SessionPoint = {
      at: now,
      tps: pointTps,
      tokensPerSec: pointTps,
      tokens: sessionTokens,
      sessionTokens,
      connections: Number(value.activeConnections || 0),
      pingMs: Number(value.pingMs || value.remoteLatencyMs || value.localLatencyMs || 0),
    }
    if (!current || current.endedAt || now - current.startedAt > 45 * 60_000) {
      return [{
        id: `session-${now}`,
        startedAt: now,
        startTokens: tokens > 0 ? Math.max(0, tokens - sessionTokens) : 0,
        lastTokens: tokens > 0 ? tokens : sessionTokens,
        avgTps: point.tps,
        peakTps: point.tps,
        points: [point],
      }, ...prev].slice(0, 20)
    }
    const points = [...current.points, point].slice(-240)
    const activePoints = points.filter((p) => p.tps > 0)
    const avgTps = activePoints.length
      ? activePoints.reduce((sum, p) => sum + p.tps, 0) / activePoints.length
      : 0
    return [{
      ...current,
      lastTokens: tokens > 0 ? tokens : sessionTokens,
      avgTps,
      peakTps: Math.max(current.peakTps || 0, point.tps),
      points,
    }, ...prev.slice(1)]
  }

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!window.electron || !hardware || models.length === 0) return
      const result = await window.electron.validateConfig(config)
      if (cancelled) return
      setIssues(result.issues || [])
      setResolvedBackend(result.backend || 'auto')
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [config, hardware, models.length])

  const updateConfig = (patch: Partial<WorkerConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }))
  }

  const saveConfig = async () => {
    if (!window.electron) return
    const saved = await window.electron.saveConfig(config)
    setConfig(saved)
    setSaveLabel('Sauvegardé')
    window.setTimeout(() => setSaveLabel('Sauvegarder'), 1200)
  }

  const startWorker = async () => {
    if (workerState.state === 'starting' || workerState.state === 'connecting') return
    if (!config.authToken || !config.userId) {
      setAuthError('Connecte ton compte VRYX avant de lancer le worker.')
      return
    }
    await saveConfig()
    const out = await window.electron?.startWorker(config)
    if (out && !out.ok) {
      setIssues([out.error || 'Impossible de lancer le worker'])
    }
  }

  const stopWorker = async () => {
    await window.electron?.stopWorker()
  }

  const copyLogs = async () => {
    const text = logs
      .slice()
      .reverse()
      .map((log) => `[${log.at}] ${log.level.toUpperCase()} ${log.line.trim()}`)
      .join('\n')
    await navigator.clipboard.writeText(text || 'Aucun log pour le moment.')
    setCopyLabel('Copié')
    window.setTimeout(() => setCopyLabel('Copier'), 1200)
  }

  const copyPeerId = async () => {
    await navigator.clipboard.writeText(metrics?.peerId || '')
  }

  const checkWorkerUpdate = async () => {
    const out = await window.electron?.checkWorkerUpdate()
    if (out) setUpdateStatus(out)
  }

  const logoutWorker = async () => {
    await window.electron?.authLogout()
    const next = await window.electron?.getConfig()
    if (next) setConfig(next)
    setWorkerState({ state: 'stopped', progress: 0, message: 'Worker déconnecté' })
    setActiveTab('dashboard')
  }

  const submitAuth = async () => {
    setAuthError('')
    const fn = authMode === 'login' ? window.electron?.authLogin : window.electron?.authRegister
    const out = await fn?.({ email: authEmail, password: authPassword })
    if (out?.user?.id && out?.token) {
      const next = await window.electron?.getConfig()
      if (next) setConfig(next)
      setAuthPassword('')
      return
    }
    setAuthError(out?.error || 'Connexion impossible.')
  }

  const setMemoryGb = (gb: number) => {
    const clamped = Math.max(1, Math.min(memoryMax, Math.round(gb)))
    updateConfig({ memoryGb: clamped, memoryPercent: Math.round((clamped / memoryMax) * 100) })
  }

  const setMemoryPercent = (pct: number) => {
    const clamped = Math.max(1, Math.min(100, Math.round(pct)))
    updateConfig({ memoryPercent: clamped, memoryGb: Math.max(1, Math.round((memoryMax * clamped) / 100)) })
  }

  const renderTab = () => {
    if (!hardware || !selectedModel) {
      return <div className="surface p-8 text-sm text-muted">Chargement de la configuration worker…</div>
    }

    if (activeTab === 'settings') {
      const osLanguage = navigator.language || 'fr-FR'
      const effectiveLanguage = config.language && config.language !== 'auto' ? config.language : osLanguage
      const languageOptions = [
        { value: 'auto', label: `Automatique OS (${osLanguage})` },
        { value: 'fr-FR', label: 'Français' },
        { value: 'en-US', label: 'English' },
        { value: 'es-ES', label: 'Español' },
        { value: 'de-DE', label: 'Deutsch' },
        { value: 'it-IT', label: 'Italiano' },
        { value: 'pt-PT', label: 'Português' },
      ]
      return (
        <div className="settings-layout">
          <div className="settings-hero">
            <div>
              <p className="eyebrow">Préférences worker</p>
              <h2>Paramètres</h2>
              <p>Langue active : {effectiveLanguage}. La structure est prête pour ajouter une langue en ajoutant simplement un dictionnaire de chaînes.</p>
            </div>
            <Globe2 size={48} />
          </div>
          <div className="surface p-5">
            <h2 className="section-title">Internationalisation</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Langue">
                <select className="control" value={config.language || 'auto'} onChange={(e) => updateConfig({ language: e.target.value })}>
                  {languageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </Field>
              <div className="settings-card">
                <b><SlidersHorizontal size={15} /> Système de traduction</b>
                <p>Les labels peuvent être branchés via des clés stables, avec fallback français. L’option auto suit `navigator.language` au démarrage.</p>
              </div>
            </div>
          </div>
          <div className="surface p-5">
            <h2 className="section-title">Comportement</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="settings-toggle">
                <input type="checkbox" checked={config.autoStart} onChange={(e) => updateConfig({ autoStart: e.target.checked })} />
                <span>Démarrer automatiquement le worker</span>
              </label>
              <label className="settings-toggle">
                <input type="checkbox" checked={config.allowUnstableGpu} onChange={(e) => updateConfig({ allowUnstableGpu: e.target.checked })} />
                <span>Autoriser GPU AMD / Intel expérimental</span>
              </label>
              <Field label="Backend préféré">
                <select className="control" value={config.backend} onChange={(e) => updateConfig({ backend: e.target.value })}>
                  <option value="auto">auto</option>
                  <option value="mlx_lm">mlx_lm</option>
                  <option value="vllm">vLLM / CUDA</option>
                  <option value="rocm">ROCm</option>
                  <option value="openvino">OpenVINO</option>
                  <option value="cpu">CPU fallback</option>
                </select>
              </Field>
              <div className="settings-card">
                <b>Compte lié</b>
                <p>{config.userEmail || `Utilisateur #${config.userId}`} · API et ports verrouillés sur l’infrastructure VRYX officielle.</p>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <button className="btn primary" onClick={saveConfig}><Save size={16} /> Sauvegarder</button>
              <button className="btn secondary" onClick={() => window.electron?.openCacheDir()}><FolderOpen size={16} /> Cache local</button>
              <button className="btn danger" onClick={logoutWorker}><LogOut size={16} /> Déconnexion</button>
            </div>
          </div>
          <div className="surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="section-title">Release investisseur</h2>
              <button className="btn secondary" onClick={checkWorkerUpdate}><RefreshCw size={16} /> Vérifier update</button>
            </div>
            <div className="release-grid mt-4">
              <div className="settings-card">
                <b>App {releaseReadiness?.appVersion || '—'}</b>
                <p>Runtime worker {releaseReadiness?.runtimeVersion || '—'} · feed {releaseReadiness?.updateFeedUrl || '—'}</p>
                <p>
                  {updateStatus?.ok
                    ? updateStatus.available
                      ? `Update disponible ${updateStatus.release?.version || ''}`
                      : `À jour (${updateStatus.currentVersion || releaseReadiness?.runtimeVersion || 'runtime'})`
                    : updateStatus?.error || 'Vérification manuelle disponible.'}
                </p>
              </div>
              {(releaseReadiness?.checks || []).map((check) => (
                <div key={check.id} className={`readiness-card ${check.ok ? 'is-ok' : 'is-warn'}`}>
                  <span>{check.ok ? 'prêt' : 'à configurer'}</span>
                  <b>{check.label}</b>
                  <p>{check.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )
    }

    if (activeTab === 'hardware') {
      const revenue = estimateWorkerRevenue(selectedModel, config, hardware, resolvedBackend, metrics)
      const observed = networkRevenue30d(networkStats, selectedModel, config, hardware)
      const monthlyValue = observed.observedTokens > 0 ? observed.monthly : revenue.monthly
      return (
        <div className="hardware-layout">
          <div className="hardware-hero">
            <div>
              <p className="eyebrow">Configuration locale</p>
              <h2>{hardware.gpuName}</h2>
              <p>{platformName(hardware.platform)} {hardware.arch} · {resolvedBackend} · {config.memoryGb} Go alloués</p>
            </div>
            <div className="hardware-revenue">
              <span>Revenu mensuel moyen estimé</span>
              <b>{money(monthlyValue)}</b>
              <small>
                {observed.observedTokens > 0
                  ? `Basé réseau 30j · ${number(observed.observedTokens)} tok/worker`
                  : `Projection config · ${revenue.tpsBasis.toFixed(2)} tok/s`}
              </small>
            </div>
          </div>
          <div className="surface p-5">
            <h2 className="section-title">GPU détecté</h2>
            <div className="mt-4 grid gap-3">
              {hardware.controllers.length > 0 ? hardware.controllers.map((gpu, idx) => (
                <div key={`${gpu.model}-${idx}`} className="hardware-card">
                  <p className="font-display text-lg font-bold text-fg">{gpu.model}</p>
                  <p className="mt-1 text-xs text-muted">{gpu.vendor || 'Vendor inconnu'} · {gpu.vramMb ? `${Math.round(gpu.vramMb / 102.4) / 10} Go` : 'VRAM non déclarée'}{gpu.bus ? ` · ${gpu.bus}` : ''}</p>
                </div>
              )) : (
                <p className="text-sm text-muted">Aucun GPU dédié déclaré par le système.</p>
              )}
            </div>
          </div>
          <div className="surface p-5">
            <h2 className="section-title">Compatibilité</h2>
            <div className="mt-4 grid gap-3">
              <Stat label="OS" value={`${platformName(hardware.platform)} ${hardware.arch}`} icon={Server} />
              <Stat label="Mémoire disponible" value={`${hardware.availableMemoryGb} Go / ${hardware.totalMemoryGb} Go`} icon={MemoryStick} />
              <Stat label="Backends possibles" value={hardware.backendCandidates.join(', ')} icon={Settings2} />
              <Stat label="Tokens réseau 30j" value={networkStats ? number(networkStats.totalTokens30d) : '—'} icon={Activity} />
            </div>
          </div>
        </div>
      )
    }

    if (activeTab === 'models') {
      return (
        <div className="models-layout">
          {models.map((model) => {
            const selected = model.id === config.modelId
            const compatible = config.memoryGb >= model.shardMinGb
            const brand = modelBrand(model)
            const revenue = estimateWorkerRevenue(model, config, hardware, resolvedBackend, metrics)
            return (
              <button
                key={model.id}
                onClick={() => updateConfig({ modelId: model.id })}
                className={`model-card ${selected ? 'is-selected' : ''}`}
                style={{ '--model-color': brand.color } as React.CSSProperties}
              >
                <div className="model-card-top">
                  <ModelLogo model={model} />
                  <div className="min-w-0">
                    <p className="model-title">{model.label}</p>
                    <p className="model-id">
                      {brand.name} · {model.paramsB}B{model.activeParamsB ? ` / ${model.activeParamsB}B actifs` : ''}
                    </p>
                  </div>
                  <span className={`model-pill ${compatible ? 'ok' : 'warn'}`}>
                    {compatible ? 'Compatible' : 'Shard lourd'}
                  </span>
                </div>
                <div className="model-performance">
                  <div>
                    <span>TPS estimé worker</span>
                    <b>{revenue.tpsBasis.toFixed(2)}</b>
                  </div>
                  <div>
                    <span>Revenu config</span>
                    <b>{money(revenue.hourly)}/h</b>
                  </div>
                </div>
                <p className="revenue-basis">
                  Base {revenue.source} · tarif {money(revenue.rewardPerToken * 1_000_000)} / M tok · disponibilité {(revenue.availabilityFactor * 100).toFixed(0)}%
                </p>
                <div className="model-specs">
                  <span>Poids <b>{model.totalModelGb ?? model.diskGb} Go</b></span>
                  {model.effectiveModelGb ? <span>Q4 <b>{model.effectiveModelGb} Go</b></span> : null}
                  <span>Shard min <b>{model.shardMinGb} Go</b></span>
                  <span>Recommandé <b>{model.recommendedMemoryGb} Go</b></span>
                  <span>Mode <b>{downloadModeLabel(model)}</b></span>
                </div>
                <p className="model-use">{model.useCase}</p>
              </button>
            )
          })}
        </div>
      )
    }

    if (activeTab === 'allocation') {
      const recommendedGb = recommendedMemoryGb(selectedModel, hardware)
      const rangePct = ((config.memoryGb - 1) / Math.max(1, memoryMax - 1)) * 100
      const percentPct = memoryPercentFromGb
      return (
        <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
          <div className="surface allocation-panel p-5">
            <h2 className="section-title">Mémoire allouée au worker</h2>
            <div className="mt-6">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="font-display text-4xl font-bold text-fg">{config.memoryGb} Go</p>
                  <p className="mt-1 text-sm text-muted">{config.memoryPercent}% de la mémoire détectée ({memoryMax} Go)</p>
                </div>
                <div className="w-32">
                  <NumberInput value={config.memoryGb} min={1} max={memoryMax} onChange={setMemoryGb} />
                </div>
              </div>
              <input
                type="range"
                min={1}
                max={memoryMax}
                value={config.memoryGb}
                onChange={(e) => setMemoryGb(Number(e.target.value))}
                className="range-liquid mt-6 w-full"
                style={{ '--range': `${rangePct}%` } as React.CSSProperties}
              />
              <div className="memory-recommendation">
                <div>
                  <span>Recommandation VRYX</span>
                  <b>{recommendedGb} Go</b>
                  <small>{selectedModel.distributedOnly ? 'Shard distribué stable' : 'Bon équilibre vitesse / marge OS'}</small>
                </div>
                <button className="btn secondary" onClick={() => setMemoryGb(recommendedGb)}>Appliquer</button>
              </div>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <Field label="Pourcentage">
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={memoryPercentFromGb}
                    onChange={(e) => setMemoryPercent(Number(e.target.value))}
                    className="range-liquid w-full"
                    style={{ '--range': `${percentPct}%` } as React.CSSProperties}
                  />
                </Field>
                <Field label="Quantization">
                  <select className="control" value={config.quantization} onChange={(e) => updateConfig({ quantization: e.target.value })}>
                    <option value="fp16">fp16</option>
                    <option value="q4">q4 / int4</option>
                    <option value="auto">auto</option>
                  </select>
                </Field>
              </div>
            </div>
          </div>
          <div className="surface p-5">
            <h2 className="section-title">Validation modèle</h2>
            <div className="mt-4 space-y-3 text-sm">
              <p className="text-muted">Le worker ne doit télécharger que son shard. L’allocation sert à refuser les shards trop lourds avant lancement.</p>
              <p className="text-fg">Modèle : <b>{selectedModel.label}</b></p>
              <p className="text-fg">Téléchargement local : <b>{downloadModeLabel(selectedModel)}</b></p>
              {selectedModel.distributedOnly && (
                <p className="rounded-lg border border-accent/30 bg-accent/8 p-3 text-xs leading-relaxed text-fg">
                  Llama 2 70B est verrouillé en shards : pas de chargement MLX-LM direct, pas de téléchargement complet du 70B sur ce worker.
                </p>
              )}
              <p className="text-fg">Shard minimum : <b>{selectedModel.shardMinGb} Go</b></p>
              <p className="text-fg">Backend résolu : <b>{resolvedBackend}</b></p>
              {issues.length === 0 ? (
                <p className="flex items-center gap-2 text-success"><ShieldCheck size={15} /> Configuration prête.</p>
              ) : (
                <div className="space-y-2">
                  {issues.map((issue) => (
                    <p key={issue} className="flex items-start gap-2 text-warning"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {issue}</p>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )
    }

    if (activeTab === 'earnings') {
      const revenue = estimateWorkerRevenue(selectedModel, config, hardware, resolvedBackend, metrics)
      const generated = Math.floor(Math.max(displayTokens, Number(metrics?.tokensGenerated || 0)))
      const realEarned = generated * revenue.rewardPerToken
      const networkObserved = networkRevenue30d(networkStats, selectedModel, config, hardware)
      const activeMinutes = (metrics?.activeSessionSec || 0) / 60
      const watts = estimatePowerWatts(hardware)
      const hourlyElectricity = (watts / 1000) * Number(config.electricityPriceKwh || 0)
      return (
        <div className="earnings-layout">
          <div className="kpi-hero">
            <div>
              <p className="eyebrow">Gains réels worker</p>
              <h2>{moneyPrecise(realEarned)}</h2>
              <p>{number(generated)} tokens générés · tarif {money(revenue.rewardPerToken * 1_000_000)} / M tok</p>
            </div>
            <div className="kpi-ring">
              <b>{(metrics?.activeTpsAverage || metrics?.activeTps || 0).toFixed(1)}</b>
              <span>TPS actif</span>
            </div>
          </div>
          <div className="surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="section-title">Courbes revenus</h2>
              <div className="period-tabs">
                {(['1h', '24h', '7d', '30d', '1y'] as const).map((period) => (
                  <button key={period} className={earningsPeriod === period ? 'is-active' : ''} onClick={() => setEarningsPeriod(period)}>{period}</button>
                ))}
              </div>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_280px]">
              <RevenueCurve hourlyRevenue={revenue.hourly} hourlyElectricity={hourlyElectricity} period={earningsPeriod} />
              <div className="settings-card">
                <b>Électricité réelle estimée</b>
                <p>Consommation estimée : {watts} W selon GPU détecté.</p>
                <div className="mt-3">
                  <Field label="Prix kWh (€)">
                    <NumberInput value={Number(config.electricityPriceKwh || 0)} min={0} max={2} onChange={(electricityPriceKwh) => updateConfig({ electricityPriceKwh })} />
                  </Field>
                </div>
                <p>Coût : {moneyPrecise(hourlyElectricity)}/h · net estimé {moneyPrecise(Math.max(0, revenue.hourly - hourlyElectricity))}/h.</p>
              </div>
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-4">
          <Stat label="Revenu / h actif" value={money(revenue.hourly)} icon={Wallet} />
          <Stat label="Projection mensuelle" value={money(networkObserved.observedTokens > 0 ? networkObserved.monthly : revenue.monthly)} icon={Gauge} />
          <Stat label="Tokens générés" value={number(generated)} icon={Activity} />
          <Stat label="Uptime" value={formatUptime(metrics?.uptimeSec || 0)} icon={Power} />
          <div className="surface p-5 lg:col-span-4">
            <h2 className="section-title">KPI réseau & worker</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Tokens entrée" value={number(metrics?.tokensIn || 0)} icon={Database} />
              <Stat label="Tokens sortie" value={number(metrics?.tokensOut || 0)} icon={Activity} />
              <Stat label="TPS moyen actif" value={`${(metrics?.activeTpsAverage || metrics?.tps || 0).toLocaleString('fr-FR')} tok/s`} icon={Gauge} />
              <Stat label="TPS instantané" value={`${(metrics?.activeTps || 0).toLocaleString('fr-FR')} tok/s`} icon={Activity} />
              <Stat label="TPS base revenu" value={`${revenue.tpsBasis.toFixed(2)} tok/s`} icon={TrendingUp} />
              <Stat label="Tarif modèle" value={`${money(revenue.rewardPerToken * 1_000_000)} / M tok`} icon={Wallet} />
              <Stat label="Jobs vus" value={number(metrics?.jobs || 0)} icon={Server} />
              <Stat label="Temps actif session" value={`${activeMinutes.toFixed(1)} min`} icon={Timer} />
              <Stat label="Réseau 24h" value={networkStats ? number(networkStats.totalTokens24h) : '—'} icon={Network} />
              <Stat label="Réseau 30j" value={networkStats ? number(networkStats.totalTokens30d) : '—'} icon={BarChart3} />
              <Stat label="Workers actifs 30j" value={networkStats ? number(networkStats.activeWorkers30d) : '—'} icon={Server} />
            </div>
            <p className="mt-4 text-xs text-muted">
              Les gains affichés en haut sont calculés sur les tokens réellement déclarés par ce worker. Les projections utilisent {networkObserved.observedTokens > 0 ? 'les deltas réseau des 30 derniers jours' : revenue.source}, {config.memoryGb} Go alloués, {resolvedBackend}, {config.quantization}, capacité worker {(revenue.capacityFactor * 100).toFixed(0)}% et disponibilité {(revenue.availabilityFactor * 100).toFixed(0)}%.
            </p>
            <p className="mt-4 break-all text-xs text-muted">
              Peer: {metrics?.peerId || '—'} · Heartbeat: {metrics?.lastHeartbeatAt || '—'}
            </p>
          </div>
          </div>
        </div>
      )
    }

    if (activeTab === 'sessions') {
      const selectedSession = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : null
      const rawGraphPoints = selectedSession ? selectedSession.points : aggregateSessionPoints(sessions)
      const graphPoints = selectedSession
        ? liveSessionPoints(selectedSession, rawGraphPoints, metrics, liveNow)
        : liveSessionPoints(sessions[0] && !sessions[0].endedAt ? sessions[0] : null, rawGraphPoints, metrics, liveNow)
      const latestPoint = graphPoints[graphPoints.length - 1]
      const totalSessionTokens = selectedSession
        ? Math.max(sessionGeneratedTokens(selectedSession), Number(latestPoint?.sessionTokens || latestPoint?.tokens || 0))
        : sessions.reduce((sum, session) => sum + sessionGeneratedTokens(session), 0)
      const avgPing = graphPoints.length
        ? graphPoints.reduce((sum, point) => sum + point.pingMs, 0) / graphPoints.length
        : 0
      const activeGraphPoints = graphPoints.filter((point) => point.tokensPerSec > 0)
      const globalAvgTps = activeGraphPoints.length
        ? activeGraphPoints.reduce((sum, point) => sum + point.tokensPerSec, 0) / activeGraphPoints.length
        : 0
      const peakTps = graphPoints.reduce((max, point) => Math.max(max, point.tokensPerSec || 0), 0)
      return (
        <div className="sessions-layout">
          <div className="surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="section-title">{selectedSession ? 'Détail de session' : 'Moyenne globale sessions'}</h2>
                <p className="mt-1 text-xs text-muted">{selectedSession ? 'Courbes détaillées de la session sélectionnée.' : 'Vue agrégée par défaut sur toutes les sessions locales.'}</p>
              </div>
              {selectedSession && <button className="btn secondary" onClick={() => setSelectedSessionId(null)}>Vue globale</button>}
            </div>
            <div className="mt-4 grid gap-4">
              <LineGraph
                points={graphPoints}
                metric="tokensPerSec"
                color="#38bdf8"
                label="Tokens générés / seconde"
                unit="tok/s"
              />
              <LineGraph
                points={graphPoints}
                metric="pingMs"
                color="#10b981"
                label="Ping API VRYX"
                unit="ms"
              />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Tokens/s moyen" value={`${(selectedSession ? selectedSession.avgTps : globalAvgTps).toFixed(2)} tok/s`} icon={Gauge} />
              <Stat label="Pic tokens/s" value={`${(selectedSession ? selectedSession.peakTps : peakTps).toFixed(2)} tok/s`} icon={TrendingUp} />
              <Stat label="Ping moyen" value={`${avgPing.toFixed(0)} ms`} icon={Network} />
              <Stat label="Tokens session" value={number(totalSessionTokens)} icon={Activity} />
              <Stat label="Durée" value={selectedSession ? formatUptime(sessionDurationAt(selectedSession, liveNow)) : 'Global'} icon={Timer} />
              <Stat label="Ping live" value={`${(latestPoint?.pingMs || metrics?.pingMs || 0).toFixed(0)} ms`} icon={Network} />
            </div>
          </div>
          <div className="surface p-5">
            <h2 className="section-title">Sessions récentes</h2>
            <div className="mt-4 space-y-3">
              {sessions.length === 0 ? (
                <p className="rounded-lg border border-border bg-bg/35 p-4 text-sm text-muted">
                  Lance une génération P2P depuis le panel admin : la session apparaîtra ici avec son TPS moyen, son pic et ses points de mesure.
                </p>
              ) : sessions.map((session) => {
                const generated = sessionGeneratedTokens(session)
                return (
                  <button key={session.id} className={`session-card ${selectedSessionId === session.id ? 'is-selected' : ''}`} onClick={() => setSelectedSessionId(session.id)}>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-fg">{formatClock(session.startedAt)}</p>
                      <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${session.endedAt ? 'bg-card text-muted' : 'bg-success/10 text-success'}`}>
                        {session.endedAt ? 'terminée' : 'live'}
                      </span>
                    </div>
	                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted">
	                      <p>Tok/s moy. <b className="text-fg">{session.avgTps.toFixed(2)}</b></p>
	                      <p>Pic tok/s <b className="text-fg">{session.peakTps.toFixed(2)}</b></p>
	                      <p>Ping moy. <b className="text-fg">{(session.points.reduce((sum, point) => sum + point.pingMs, 0) / Math.max(1, session.points.length)).toFixed(0)} ms</b></p>
	                      <p>Tokens <b className="text-fg">{number(generated)}</b></p>
	                      <p>Durée <b className="text-fg">{formatUptime(sessionDurationAt(session, liveNow))}</b></p>
	                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )
    }

    if (activeTab === 'logs') {
      return (
        <div className="surface overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
            <h2 className="section-title">Logs worker</h2>
            <div className="flex gap-2">
              <button className="btn secondary" onClick={copyLogs}><Clipboard size={16} /> {copyLabel}</button>
              <button className="btn secondary" onClick={() => setLogs([])}>Vider</button>
            </div>
          </div>
          <div className="logs-console h-[470px] overflow-y-auto bg-black/25 p-4 font-mono text-xs">
            {logs.length === 0 ? (
              <p className="text-muted">Aucun log pour le moment.</p>
            ) : logs.map((log, idx) => (
              <pre key={`${log.at}-${idx}`} className={`mb-2 whitespace-pre-wrap ${log.level === 'error' ? 'text-alert' : 'text-fg'}`}>
                <span className="text-muted">{log.at}</span> {log.line.trim()}
              </pre>
            ))}
          </div>
        </div>
      )
    }

    const liveTps = Number(metrics?.activeTps || metrics?.activeTpsAverage || metrics?.tps || 0)
    const dashboardRevenue = selectedRevenue || estimateWorkerRevenue(selectedModel, config, hardware, resolvedBackend, metrics)
    const generatedTokens = Math.floor(Math.max(displayTokens, Number(metrics?.tokensGenerated || 0)))
    const generatedEarned = generatedTokens * modelRewardPerToken(selectedModel)
    const dashboardShardLayers = shardLayerLabel(metrics, selectedModel, config, hardware)
    const dashboardShardGb = shardModelGbLabel(metrics, selectedModel, config, hardware)
    const health = computeWorkerHealth(config, hardware, selectedModel, workerState, metrics, issues)
    const reputation = computeWorkerReputation(metrics, dashboardRevenue)
    const diagnostics = networkDiagnostics(config, metrics, networkStats)
    const onboardingSteps = [
      {
        label: '1. Compte',
        title: config.userEmail || `Worker #${config.userId || 'non lié'}`,
        ok: Boolean(config.authToken && config.userId),
        action: 'Connecté',
      },
      {
        label: '2. Machine',
        title: `${hardware.gpuName} · ${config.memoryGb} Go`,
        ok: config.memoryGb >= selectedModel.shardMinGb && issues.length === 0,
        action: issues.length ? 'À régler' : 'Prête',
      },
      {
        label: '3. Start',
        title: workerState.state === 'working' ? 'Worker visible réseau' : 'Lancement en un clic',
        ok: workerState.state === 'working',
        action: workerState.state === 'working' ? 'Live' : 'Démarrer',
      },
    ]
    return (
      <div className="dashboard-grid">
        <div className="hero-panel">
          <div className="hero-copy">
            <p className={`hero-status ${statusTone(workerState.state)}`}>{workerState.message}</p>
            <div className="hero-live-summary">
              <span>{selectedModel.label}</span>
              <b>{metrics?.p2pReady ? 'Réseau connecté' : 'En attente réseau'}</b>
            </div>
            <div className="hero-shard-summary">
              <span><Layers size={15} /> Couches <b>{dashboardShardLayers}</b></span>
              <span><Database size={15} /> Modèle local <b>{dashboardShardGb}</b></span>
            </div>
          </div>
          <WorkerVisual
            state={workerState.state}
            progress={workerState.progress || 0}
            tps={liveTps}
            tokens={generatedTokens}
            tokensEarned={generatedEarned}
            tpsHourly={dashboardRevenue.hourly}
            canStart={canStart}
            onPrimaryClick={workerState.state === 'working' ? stopWorker : startWorker}
          />
        </div>

        <div className="metrics-grid">
          <Stat label="GPU" value={hardware.gpuName} icon={Cpu} />
          <Stat label={hardware.unifiedMemory ? 'Mémoire unifiée' : 'VRAM'} value={`${hardware.vramGb} Go`} icon={MemoryStick} />
          <Stat label="Modèle" value={selectedModel.label} icon={Layers} />
          <Stat label="Couches chargées" value={dashboardShardLayers} icon={Layers} />
          <Stat label="Go modèle local" value={dashboardShardGb} icon={Database} />
          <Stat label="Backend" value={resolvedBackend} icon={Gauge} />
          <Stat label="P2P" value={metrics?.p2pReady ? 'Connecté' : 'Connexion…'} icon={Network} />
          <Stat label="Connexions" value={number(metrics?.activeConnections || 0)} icon={Server} />
          <Stat label="Tokens générés total" value={number(generatedTokens)} icon={Activity} />
          <Stat label="Tokens session active" value={number(metrics?.activeSessionTokens || 0)} icon={BarChart3} />
          <Stat label="Tokens/s actif" value={`${liveTps.toLocaleString('fr-FR')} tok/s`} icon={Gauge} />
        </div>

        <div className="investor-worker-grid">
          <div className="surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="section-title">Onboarding 3 clics</h2>
              <span className={`state-pill ${workerState.state === 'working' ? 'is-live' : ''}`}>{workerState.state === 'working' ? 'démo live' : 'prêt démo'}</span>
            </div>
            <div className="onboarding-steps mt-4">
              {onboardingSteps.map((step) => (
                <div key={step.label} className={`onboarding-step ${step.ok ? 'is-ok' : ''}`}>
                  <span>{step.label}</span>
                  <b>{step.title}</b>
                  <small>{step.action}</small>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn primary" onClick={workerState.state === 'working' ? stopWorker : startWorker}>
                <Power size={16} /> {workerState.state === 'working' ? 'Stop worker' : 'Start worker'}
              </button>
              <button className="btn secondary" onClick={() => setActiveTab('allocation')}><MemoryStick size={16} /> Ajuster mémoire</button>
            </div>
          </div>

          <div className="surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="section-title">Health check</h2>
              <span className={`health-badge ${healthToneClass(health.tone)}`}>{health.label} · {health.score}/100</span>
            </div>
            <div className="health-list mt-4">
              {health.checks.map((check) => (
                <div key={check.label} className={check.ok ? 'is-ok' : 'is-warn'}>
                  <span>{check.label}</span>
                  <b>{check.ok ? 'OK' : 'À vérifier'}</b>
                  <small>{check.detail}</small>
                </div>
              ))}
            </div>
          </div>

          <div className="surface p-5">
            <h2 className="section-title">Diagnostic réseau</h2>
            <div className="diagnostic-grid mt-4">
              {diagnostics.map((item) => (
                <div key={item.label} className={item.ok ? 'is-ok' : 'is-warn'}>
                  <span>{item.label}</span>
                  <b>{item.value}</b>
                </div>
              ))}
            </div>
          </div>

          <div className="surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="section-title">Réputation worker</h2>
              <span className={`health-badge ${healthToneClass(reputation.tone)}`}>Grade {reputation.grade}</span>
            </div>
            <div className="reputation-score mt-4">
              <b>{reputation.score}</b>
              <span>/100</span>
            </div>
            <div className="mt-3 grid gap-2 text-xs text-muted">
              <p>Projection mensuelle: <b className="text-fg">{money(reputation.expectedMonthly)}</b></p>
              <p>Uptime: <b className="text-fg">{formatUptime(metrics?.uptimeSec || 0)}</b> · Jobs: <b className="text-fg">{number(metrics?.jobs || 0)}</b></p>
              <p>Tokens: <b className="text-fg">{number(metrics?.tokensGenerated || 0)}</b> · Erreurs: <b className={metrics?.lastError ? 'text-alert' : 'text-fg'}>{metrics?.lastError ? '1 active' : '0 active'}</b></p>
            </div>
          </div>
        </div>

        <div className="side-stack">
          <div className="surface worker-tools p-5">
            <h2 className="section-title">Outils worker</h2>
            <div className="tool-grid mt-4">
              <button className="tool-card" onClick={saveConfig}><Save size={17} /><span>{saveLabel}</span><small>Config locale</small></button>
              <button className="tool-card" onClick={() => window.electron?.openCacheDir()}><FolderOpen size={17} /><span>Cache</span><small>Shards modèles</small></button>
              <button className="tool-card" onClick={copyPeerId}><Clipboard size={17} /><span>Peer ID</span><small>{compactPeer(metrics?.peerId)}</small></button>
              <button className="tool-card" onClick={() => setActiveTab('logs')}><Terminal size={17} /><span>Logs</span><small>Temps réel</small></button>
              <button className="tool-card wide" onClick={() => window.open(`${config.apiUrl}/admin/p2p`, '_blank')}><ExternalLink size={17} /><span>Panel P2P</span><small>Ouvrir vryx.eu/admin</small></button>
            </div>
          </div>

          <div className="surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="section-title">Temps réel</h2>
              <span className={`state-pill ${metrics?.p2pReady ? 'is-live' : ''}`}>
                {metrics?.p2pReady ? 'P2P prêt' : 'en attente'}
              </span>
            </div>
            <div className="mt-4 grid gap-2 text-xs text-muted">
              <p>Uptime: <b className="text-fg">{formatUptime(metrics?.uptimeSec || 0)}</b></p>
              <p>Revenu config: <b className="text-fg">{money(dashboardRevenue.hourly)}/h</b></p>
              <p>Base revenu: <b className="text-fg">{dashboardRevenue.tpsBasis.toFixed(2)} tok/s · {dashboardRevenue.source}</b></p>
              <p>Activité: <b className="text-fg">{number(metrics?.activeSessionTokens || 0)} tok · {formatUptime(metrics?.activeSessionSec || 0)}</b></p>
              <p>Shard: <b className="text-fg">{dashboardShardLayers} · {dashboardShardGb}</b></p>
              <p>Chargement: <b className="text-fg">{metrics?.shardReady ? 'résident' : metrics?.shardCount ? 'chargé partiel' : 'aucun shard actif'}</b>{metrics?.shardWeightLoadMode ? ` · ${metrics.shardWeightLoadMode}` : ''}</p>
              <p>Dernier calcul: <b className="text-fg">{metrics?.lastActiveAt ? new Date(metrics.lastActiveAt).toLocaleTimeString('fr-FR') : '—'}</b></p>
              <p className="truncate">Peer: <b className="text-fg">{compactPeer(metrics?.peerId)}</b></p>
              {metrics?.lastError && <p className="text-alert">{metrics.lastError}</p>}
            </div>
          </div>
          {issues.length > 0 && (
            <div className="notice-panel">
              <p className="text-xs font-semibold uppercase text-warning">Points à vérifier</p>
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {issues.map((issue) => <li key={issue}>{issue}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!config.authToken || !config.userId) {
    return (
      <div className="auth-shell text-fg">
        <div className="auth-card">
          <OldVryxLogo title="Vryx" />
          <p className="eyebrow">{t('accountRequired')}</p>
          <h1>{authMode === 'login' ? t('loginTitle') : t('registerTitle')}</h1>
          <p className="auth-copy">{t('loginCopy')}</p>
          <div className="mt-5 grid gap-3">
            <Field label="Email">
              <input className="control" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} placeholder="toi@exemple.com" />
            </Field>
            <Field label="Mot de passe">
              <input className="control" type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} placeholder={authMode === 'register' ? '10 caractères, majuscule, chiffre' : 'Mot de passe'} />
            </Field>
            {authError && <p className="auth-error">{authError}</p>}
            <button className="btn primary w-full" onClick={submitAuth}>
              {authMode === 'login' ? t('login') : t('create')}
            </button>
            <button className="btn secondary w-full" onClick={() => window.electron?.authGoogle()}>
              <span className="auth-google-icon">G</span> {t('google')}
            </button>
            <button className="auth-switch" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>
              {authMode === 'login' ? 'Créer un compte' : 'J’ai déjà un compte'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell text-fg" style={{ '--section-color': activeTabMeta.color } as React.CSSProperties}>
      <aside className="dock drag-region">
        <div className="brand-lockup">
          <div className="brand-tile">
            <OldVryxLogo title="Vryx" compact />
          </div>
          <div className="brand-text">
            <h1>VRYX</h1>
            <p>Worker</p>
          </div>
        </div>
        <nav className="dock-nav no-drag">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              title={tabLabel(tab.id)}
              onClick={() => setActiveTab(tab.id)}
              className={`dock-item ${activeTab === tab.id ? 'is-active' : ''}`}
              style={{ '--item-color': tab.color } as React.CSSProperties}
            >
              <DockGlyph id={tab.id} />
              <span>{tabLabel(tab.id)}</span>
            </button>
          ))}
        </nav>
        <div className="dock-footer no-drag">
          <button className={`dock-mini ${activeTab === 'settings' ? 'is-active' : ''}`} title="Paramètres" onClick={() => setActiveTab('settings')}>
            <Settings2 size={17} />
          </button>
          <button className="dock-mini is-danger" title="Déconnexion" onClick={logoutWorker}>
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar drag-region">
          <div>
            <p className="top-kicker">{platformName(hardware?.platform)} · {hardware?.arch || '...'}</p>
            <h2>{tabLabel(activeTab)}</h2>
          </div>
          <div className="no-drag flex items-center gap-3">
            <span className={`state-pill ${workerState.state === 'working' ? 'is-live' : ''}`}>
              {workerState.state}
            </span>
            <button className="btn secondary" onClick={saveConfig}><Save size={16} /> {saveLabel}</button>
          </div>
        </header>
        <section key={activeTab} className="view-stage">
          {renderTab()}
        </section>
      </main>
    </div>
  )
}

export default App
