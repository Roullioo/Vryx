const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const si = require('systeminformation');

const isDev = process.env.NODE_ENV === 'development';
const isPackaged = app.isPackaged;
const bundledNodeAndWorkerDir = isPackaged
  ? path.join(process.resourcesPath, 'nodeAndWorker')
  : path.resolve(__dirname, '../../nodeAndWorker');
let nodeAndWorkerDir = bundledNodeAndWorkerDir;

const DEFAULT_BOOTSTRAP = '/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz';
const DEFAULT_API_URL = 'https://vryx.eu';
const RUNTIME_COPY_REVISION = '2026-05-16-live-auth-stats-v24';

const MODEL_CATALOG = [
  {
    id: 'Qwen/Qwen2-0.5B-Instruct',
    label: 'Qwen2 0.5B Instruct',
    family: 'Qwen',
    paramsB: 0.5,
    diskGb: 1.3,
    totalModelGb: 1.3,
    localDownloadMode: 'direct_or_shard',
    directAllowed: true,
    distributedOnly: false,
    recommendedMemoryGb: 3,
    minMemoryGb: 2,
    shardMinGb: 1,
    quality: 'Basique',
    speed: 'Tres rapide',
    useCase: 'Benchmark TPS, smoke tests, machines modestes',
  },
  {
    id: 'Qwen/Qwen3.5-9B',
    label: 'Qwen3.5 9B',
    family: 'Qwen',
    paramsB: 9,
    diskGb: 18,
    totalModelGb: 18,
    localDownloadMode: 'direct_or_shard',
    directAllowed: true,
    distributedOnly: false,
    recommendedMemoryGb: 24,
    minMemoryGb: 14,
    shardMinGb: 8,
    quality: 'Production',
    speed: 'Rapide sur MLX / GPU dedie',
    useCase: 'Chat produit VRYX actuel',
  },
  {
    id: 'Qwen/Qwen3.6-35B-A3B',
    label: 'Qwen3.6 35B A3B',
    family: 'Qwen',
    paramsB: 35,
    activeParamsB: 3,
    architecture: 'MoE',
    diskGb: 70,
    totalModelGb: 70,
    effectiveModelGb: 19,
    fullLoadMinGb: 24,
    fullLoadInt8Gb: 38,
    fullLoadFp16Gb: 72,
    totalLayers: 40,
    contextTokens: 262144,
    mlxFullLoadModelId: 'mlx-community/Qwen3.6-35B-A3B-4bit',
    mlxInt8LoadModelId: 'mlx-community/Qwen3.6-35B-A3B-8bit',
    mlxDwqLoadModelId: 'mlx-community/Qwen3.6-35B-A3B-4bit-DWQ',
    hfFp8ModelId: 'Qwen/Qwen3.6-35B-A3B-FP8',
    localDownloadMode: 'direct_or_shard',
    localShardTypicalGb: 12,
    directAllowed: true,
    distributedOnly: true,
    recommendedMemoryGb: 32,
    minMemoryGb: 10,
    shardMinGb: 8,
    quality: 'Production MoE',
    speed: 'Rapide en Q4 MLX / vLLM, shard MoE sinon',
    useCase: 'MoE 35B total / 3B actifs: full Q4 si la mémoire suffit, sinon couches shardées par worker',
    quantizedVariants: [
      { quantization: 'q4', backend: 'mlx_lm', modelId: 'mlx-community/Qwen3.6-35B-A3B-4bit', diskGb: 19, minMemoryGb: 24 },
      { quantization: 'q4-dwq', backend: 'mlx_lm', modelId: 'mlx-community/Qwen3.6-35B-A3B-4bit-DWQ', diskGb: 19.3, minMemoryGb: 24 },
      { quantization: 'int8', backend: 'mlx_lm', modelId: 'mlx-community/Qwen3.6-35B-A3B-8bit', diskGb: 35.2, minMemoryGb: 38 },
      { quantization: 'fp8', backend: 'vllm', modelId: 'Qwen/Qwen3.6-35B-A3B-FP8', diskGb: 35, minMemoryGb: 40 },
    ],
  },
  {
    id: 'meta-llama/Llama-2-70b-hf',
    label: 'Llama 2 70B',
    family: 'Llama',
    paramsB: 70,
    diskGb: 140,
    totalModelGb: 140,
    localDownloadMode: 'shard_only',
    localShardTypicalGb: 24,
    directAllowed: false,
    distributedOnly: true,
    recommendedMemoryGb: 96,
    minMemoryGb: 48,
    shardMinGb: 24,
    quality: 'Tres haute',
    speed: 'Necessite gros shard ou multi-workers',
    useCase: 'Shards assignes: chaque worker ne telecharge que ses couches',
    gated: true,
  },
];

const DEFAULT_CONFIG = {
  apiUrl: DEFAULT_API_URL,
  bootstrapNode: DEFAULT_BOOTSTRAP,
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
};

let mainWindow = null;
let workerProcess = null;
let workerState = { state: 'stopped', progress: 0, message: 'Worker arrete' };
let workerStartedAt = 0;
let metricsInterval = null;
let startupWatchdog = null;
let activeTpsState = {
  lastTokensGenerated: 0,
  lastSampleMs: 0,
  activeSamples: [],
  lastActiveAtMs: 0,
  sessionTokens: 0,
  sessionStartedAtMs: 0,
};
let workerHealthCache = {
  onlineLastSeenMs: 0,
  p2pLastSeenMs: 0,
  remoteHeartbeatLastSeenMs: 0,
};
const MAX_REASONABLE_COUNTER_TPS = 160;
const BURST_COMPLETION_WINDOW_SEC = 120;
const WORKER_ONLINE_GRACE_MS = 180_000;
const WORKER_P2P_GRACE_MS = 300_000;
const WORKER_ACTIVE_GRACE_MS = 180_000;
let lastWorkerMetrics = {
  online: false,
  p2pReady: false,
  peerId: '',
  activeConnections: 0,
  tokensGenerated: 0,
  tokensIn: 0,
  tokensOut: 0,
  pingMs: 0,
  localLatencyMs: 0,
  remoteLatencyMs: 0,
  tps: 0,
  activeTps: 0,
  activeTpsAverage: 0,
  activeSessionTokens: 0,
  activeSessionSec: 0,
  lastActiveAt: '',
  jobs: 0,
  uptimeSec: 0,
  estimatedToday: 0,
  lastHeartbeatAt: '',
  lastHeartbeatStatus: 0,
  lastHeartbeatError: '',
  apiUrl: DEFAULT_API_URL,
  workerSecretPresent: false,
  lastError: '',
};

function configPath() {
  return path.join(app.getPath('userData'), 'worker-config.json');
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(config) {
  const next = { ...DEFAULT_CONFIG, ...(config || {}) };
  next.apiUrl = DEFAULT_API_URL;
  next.bootstrapNode = DEFAULT_BOOTSTRAP;
  next.grpcPort = DEFAULT_CONFIG.grpcPort;
  next.apiPort = DEFAULT_CONFIG.apiPort;
  next.p2pPort = DEFAULT_CONFIG.p2pPort;
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}

function workerAuthHeaders(config = readConfig()) {
  const secret = String(
    config?.workerSecret || process.env.VRYX_WORKER_SECRET || process.env.WORKER_SECRET || ''
  ).trim();
  return secret ? { Authorization: `Bearer ${secret}`, 'x-worker-secret': secret } : {};
}

function handleProtocolUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const token = url.protocol === 'vryx:' && url.hostname === 'auth'
      ? url.searchParams.get('token')
      : '';
    if (!token) return;
    fetchJsonPost(`${DEFAULT_API_URL}/api/auth/desktop-callback`, { token }, {}, 8000)
      .then((out) => {
        if (!out.ok || !out.data?.user?.id || !out.data?.token) return;
        const cfg = writeConfig({
          ...readConfig(),
          authToken: out.data.token,
          userId: String(out.data.user.id),
          userEmail: String(out.data.user.email || ''),
        });
        send('auth-updated', { user: { id: cfg.userId, email: cfg.userEmail }, config: cfg });
      })
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

function runtimeDir() {
  return path.join(app.getPath('userData'), 'runtime', 'nodeAndWorker');
}

function copyRuntimeIfNeeded() {
  if (!isPackaged) {
    nodeAndWorkerDir = bundledNodeAndWorkerDir;
    return nodeAndWorkerDir;
  }
  const target = runtimeDir();
  const marker = path.join(target, '.vryx-runtime-version');
  const version = `${app.getVersion()}-${process.platform}-${process.arch}-${RUNTIME_COPY_REVISION}`;
  let current = '';
  try {
    current = fs.readFileSync(marker, 'utf8').trim();
  } catch {
    current = '';
  }
  if (current !== version || !fs.existsSync(path.join(target, 'start-worker.sh'))) {
    const preserved = path.join(app.getPath('userData'), 'runtime-preserved');
    fs.rmSync(preserved, { recursive: true, force: true });
    fs.mkdirSync(preserved, { recursive: true });
    const preservePairs = [
      ['.vryx-keys', '.vryx-keys'],
      ['python-inference/venv', 'python-venv'],
    ];
    for (const [rel, name] of preservePairs) {
      const src = path.join(target, rel);
      if (fs.existsSync(src)) {
        fs.cpSync(src, path.join(preserved, name), { recursive: true });
      }
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(bundledNodeAndWorkerDir, target, {
      recursive: true,
      filter(src) {
        const rel = path.relative(bundledNodeAndWorkerDir, src);
        if (!rel) return true;
        if (rel.includes(`${path.sep}.vryx-keys`)) return false;
        if (rel.includes(`${path.sep}.vryx-keys-mac`)) return false;
        if (rel.includes(`${path.sep}logs`)) return false;
        if (rel.includes(`${path.sep}__pycache__`)) return false;
        if (rel.includes(`${path.sep}.pytest_cache`)) return false;
        if (rel.endsWith('.log')) return false;
        return true;
      },
    });
    for (const [rel, name] of preservePairs) {
      const src = path.join(preserved, name);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
        fs.cpSync(src, path.join(target, rel), { recursive: true });
      }
    }
    fs.rmSync(preserved, { recursive: true, force: true });
    fs.writeFileSync(marker, version);
  }
  nodeAndWorkerDir = target;
  return target;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function setWorkerState(patch) {
  workerState = { ...workerState, ...patch };
  send('worker-status', workerState);
}

function statusUrl(config) {
  return `http://127.0.0.1:${Number(config.apiPort || DEFAULT_CONFIG.apiPort)}/api/status`;
}

function normalizeMetricNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function rewardPerTokenForModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (id.includes('70b')) return 0.0000009;
  if (id.includes('0.5b')) return 0.00000005;
  return 0.00000024;
}

function computeActiveTps(tokensGenerated) {
  const now = Date.now();
  const tokens = Number(tokensGenerated || 0);
  if (!activeTpsState.lastSampleMs) {
    activeTpsState.lastSampleMs = now;
    activeTpsState.lastTokensGenerated = tokens;
    return { activeTps: 0, activeTpsAverage: 0, activeSessionTokens: 0, activeSessionSec: 0, lastActiveAt: '' };
  }

  if (tokens < activeTpsState.lastTokensGenerated) {
    activeTpsState.lastSampleMs = now;
    activeTpsState.lastTokensGenerated = tokens;
    activeTpsState.activeSamples = [];
    activeTpsState.lastActiveAtMs = 0;
    activeTpsState.sessionTokens = 0;
    activeTpsState.sessionStartedAtMs = 0;
    return { activeTps: 0, activeTpsAverage: 0, activeSessionTokens: 0, activeSessionSec: 0, lastActiveAt: '' };
  }

  const deltaTokens = Math.max(0, tokens - activeTpsState.lastTokensGenerated);
  const deltaSec = Math.max(0.001, (now - activeTpsState.lastSampleMs) / 1000);
  activeTpsState.lastSampleMs = now;
  activeTpsState.lastTokensGenerated = tokens;

  let activeTps = 0;
  if (deltaTokens > 0) {
    const rawTps = deltaTokens / deltaSec;
    const normalizedSec = deltaTokens >= 128 && rawTps > MAX_REASONABLE_COUNTER_TPS
      ? BURST_COMPLETION_WINDOW_SEC
      : deltaSec;
    activeTps = Math.round((deltaTokens / normalizedSec) * 100) / 100;
    activeTpsState.lastActiveAtMs = now;
    if (!activeTpsState.sessionStartedAtMs || now - activeTpsState.sessionStartedAtMs > 120_000) {
      activeTpsState.sessionStartedAtMs = now;
      activeTpsState.sessionTokens = 0;
      activeTpsState.activeSamples = [];
    }
    activeTpsState.sessionTokens += deltaTokens;
    activeTpsState.activeSamples.push(activeTps);
    activeTpsState.activeSamples = activeTpsState.activeSamples.slice(-120);
  }

  const recentActive = activeTpsState.lastActiveAtMs > 0 && now - activeTpsState.lastActiveAtMs < WORKER_ACTIVE_GRACE_MS;
  if (!recentActive) activeTps = 0;
  const activeSamples = activeTpsState.activeSamples;
  const activeTpsAverage = activeSamples.length
    ? Math.round((activeSamples.reduce((sum, sample) => sum + sample, 0) / activeSamples.length) * 100) / 100
    : 0;
  const activeSessionSec = activeTpsState.sessionStartedAtMs && recentActive
    ? Math.max(1, Math.round((now - activeTpsState.sessionStartedAtMs) / 1000))
    : 0;

  return {
    activeTps,
    activeTpsAverage,
    activeSessionTokens: recentActive ? activeTpsState.sessionTokens : 0,
    activeSessionSec,
    lastActiveAt: activeTpsState.lastActiveAtMs ? new Date(activeTpsState.lastActiveAtMs).toISOString() : '',
  };
}

async function readWorkerMetrics() {
  const config = readConfig();
  const local = await fetchJson(statusUrl(config), {}, 1200);
  const localData = local.ok ? (local.data || {}) : {};
  const peerId = String(localData.peer_id || '');
  const remoteStatusUrl = `${config.apiUrl || DEFAULT_API_URL}/api/workers/status${peerId ? `?peer_id=${encodeURIComponent(peerId)}` : ''}`;
  const remote = await fetchJson(remoteStatusUrl, workerAuthHeaders(config), 1800);
  const workers = Array.isArray(remote.data?.workers) ? remote.data.workers : [];
  const remoteWorker = peerId
    ? workers.find((w) => w.peerId === peerId)
    : workers.find((w) => w.mode === 'worker' && Number(w.grpcPort) === Number(config.grpcPort));
  const remoteHeartbeatFresh = remoteWorker && Number(remoteWorker.secondsSinceHeartbeat || 9999) < 180;
  const localOnline = Boolean(local.ok && peerId);
  const nowMs = Date.now();
  if (localOnline || remoteHeartbeatFresh) workerHealthCache.onlineLastSeenMs = nowMs;
  if (remoteHeartbeatFresh) workerHealthCache.remoteHeartbeatLastSeenMs = nowMs;
  if (workerStartedAt === 0 && localOnline) {
    const remoteStartedMs = Date.parse(String(remoteWorker?.firstSeenAt || ''));
    workerStartedAt = Number.isFinite(remoteStartedMs) ? remoteStartedMs : nowMs;
  }

  const tokensGenerated = normalizeMetricNumber(localData.tokens_generated, remoteWorker?.tokensGenerated);
  const tokensIn = normalizeMetricNumber(localData.tokens_in, remoteWorker?.tokensIn);
  const tokensOut = normalizeMetricNumber(localData.tokens_out, remoteWorker?.tokensOut);
  const activeConnections = normalizeMetricNumber(localData.active_connections, remoteWorker?.p2pPeers);
  const localLatencyMs = normalizeMetricNumber(local.elapsedMs);
  const remoteLatencyMs = normalizeMetricNumber(remote.elapsedMs);
  const pingMs = remote.ok ? remoteLatencyMs : localLatencyMs;
  const uptimeSec = workerStartedAt > 0 ? Math.max(0, Math.floor((Date.now() - workerStartedAt) / 1000)) : 0;
  const remoteSeesP2p = Boolean(remoteWorker && Number(remoteWorker.p2pPeers || 0) > 0 && remoteHeartbeatFresh);
  const p2pReadyNow = Boolean((localOnline && activeConnections > 0 && (!remoteWorker || remoteHeartbeatFresh)) || remoteSeesP2p);
  if (p2pReadyNow) workerHealthCache.p2pLastSeenMs = nowMs;
  const onlineGrace = nowMs - workerHealthCache.onlineLastSeenMs < WORKER_ONLINE_GRACE_MS;
  const p2pGrace = localOnline && nowMs - workerHealthCache.p2pLastSeenMs < WORKER_P2P_GRACE_MS;
  const p2pReady = Boolean(p2pReadyNow || p2pGrace);
  const activeTps = computeActiveTps(tokensGenerated);
  const rewardPerToken = rewardPerTokenForModel(config.modelId);

  lastWorkerMetrics = {
    online: Boolean(localOnline || remoteHeartbeatFresh || onlineGrace),
    p2pReady,
    peerId,
    activeConnections,
    tokensGenerated,
    tokensIn,
    tokensOut,
    pingMs,
    localLatencyMs,
    remoteLatencyMs,
    tps: activeTps.activeTpsAverage,
    ...activeTps,
    jobs: Math.max(tokensGenerated > 0 ? 1 : 0, normalizeMetricNumber(remoteWorker?.jobsAccepted, remoteWorker?.jobs)),
    uptimeSec,
    estimatedToday: tokensGenerated * rewardPerToken,
    lastHeartbeatAt: String(remoteWorker?.lastHeartbeatAt || ''),
    lastHeartbeatStatus: remote.status || 0,
    lastHeartbeatError: remote.ok ? '' : String(remote.data?.error || remote.error || ''),
    apiUrl: config.apiUrl || DEFAULT_API_URL,
    workerSecretPresent: Boolean(String(config.workerSecret || '').trim()),
    lastError: local.ok || onlineGrace ? '' : String(local.error || remote.data?.error || remote.error || ''),
  };

  if (lastWorkerMetrics.p2pReady && workerState.state !== 'working') {
    setWorkerState({ state: 'working', progress: 100, message: 'Worker P2P pret et visible sur VRYX' });
  } else if (localOnline && ['starting', 'stopped'].includes(workerState.state)) {
    setWorkerState({ state: 'connecting', progress: 75, message: 'Worker local demarre, connexion P2P en cours' });
  }

  return lastWorkerMetrics;
}

function startMetricsPoll() {
  if (metricsInterval) return;
  metricsInterval = setInterval(async () => {
    try {
      const metrics = await readWorkerMetrics();
      send('worker-metrics', metrics);
    } catch (error) {
      lastWorkerMetrics = {
        ...lastWorkerMetrics,
        online: false,
        p2pReady: false,
        lastError: String(error?.message || error || 'metrics_poll_failed'),
      };
      send('worker-metrics', lastWorkerMetrics);
    }
  }, 1000);
}

function stopMetricsPoll() {
  if (!metricsInterval) return;
  clearInterval(metricsInterval);
  metricsInterval = null;
}

function clearStartupWatchdog() {
  if (!startupWatchdog) return;
  clearTimeout(startupWatchdog);
  startupWatchdog = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 680,
    title: 'Vryx Worker',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#08111f',
    show: false,
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function normalizeVramMb(controller) {
  const raw = Number(controller?.vram || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1024 ? Math.round(raw) : Math.round(raw * 1024);
}

function backendCandidates(platform, controllers) {
  const names = controllers.map((c) => String(c.model || c.vendor || '').toLowerCase()).join(' ');
  if (platform === 'darwin') return ['mlx_lm', 'mlx', 'auto'];
  const out = ['auto'];
  if (names.includes('nvidia')) out.unshift('vllm', 'cuda');
  if (names.includes('amd')) out.push('rocm');
  if (names.includes('intel')) out.push('openvino');
  out.push('cpu');
  return Array.from(new Set(out));
}

async function getHardwareStats() {
  const [graphics, cpu, mem, osInfo] = await Promise.all([
    si.graphics().catch(() => ({ controllers: [] })),
    si.cpu().catch(() => ({})),
    si.mem().catch(() => ({ total: os.totalmem(), available: 0 })),
    si.osInfo().catch(() => ({})),
  ]);
  const controllers = Array.isArray(graphics.controllers) ? graphics.controllers : [];
  const primary = controllers[0] || {};
  const unified = process.platform === 'darwin';
  const totalMemGb = Math.max(1, Math.round(Number(mem.total || os.totalmem()) / 1024 ** 3));
  const availableMemGb = Math.max(0, Math.round(Number(mem.available || 0) / 1024 ** 3));
  const vramMb = unified ? totalMemGb * 1024 : normalizeVramMb(primary);
  const gpuName = primary.model || (unified ? `${cpu.manufacturer || 'Apple'} ${cpu.brand || 'Apple Silicon'}` : 'GPU non detecte');
  const gpuVendor = primary.vendor || (unified ? 'Apple' : 'Inconnu');
  return {
    platform: process.platform,
    arch: process.arch,
    os: osInfo.distro || os.type(),
    cpu: cpu.brand || os.cpus()?.[0]?.model || 'CPU inconnu',
    gpuName,
    gpuVendor,
    controllers: controllers.map((c) => ({
      model: c.model || 'GPU',
      vendor: c.vendor || '',
      vramMb: unified ? vramMb : normalizeVramMb(c),
      bus: c.bus || '',
    })),
    unifiedMemory: unified,
    totalMemoryGb: totalMemGb,
    availableMemoryGb: availableMemGb,
    vramGb: Math.round((vramMb / 1024) * 10) / 10,
    backendCandidates: backendCandidates(process.platform, controllers),
  };
}

function chooseBackend(config, hardware, model) {
  if (config.backend && config.backend !== 'auto') return config.backend;
  if (process.platform === 'darwin') return model?.distributedOnly ? 'mlx' : 'mlx_lm';
  const names = (hardware.controllers || []).map((c) => `${c.vendor} ${c.model}`.toLowerCase()).join(' ');
  if (names.includes('nvidia')) return 'vllm';
  if (names.includes('amd')) return 'rocm';
  if (names.includes('intel')) return 'openvino';
  return 'cpu';
}

function validateConfig(config, hardware) {
  const model = MODEL_CATALOG.find((m) => m.id === config.modelId) || MODEL_CATALOG[0];
  const memoryGb = Number(config.memoryGb || 0);
  const issues = [];
  if (memoryGb < model.shardMinGb) {
    issues.push(`Memoire allouee trop basse pour un shard ${model.label}: ${memoryGb} Go < ${model.shardMinGb} Go.`);
  }
  if (memoryGb > Number(hardware.vramGb || hardware.totalMemoryGb || 0)) {
    issues.push('Memoire allouee superieure a la memoire detectee.');
  }
  let backend = chooseBackend(config, hardware, model);
  if (model.directAllowed === false && backend === 'mlx_lm') {
    backend = 'mlx';
    issues.push(`${model.label} est force en mode shard-only: mlx_lm direct est desactive pour eviter le telechargement complet.`);
  }
  if (backend === 'cpu') {
    issues.push('Backend CPU: autorise mais non recommande pour participer au reseau.');
  }
  return { ok: issues.length === 0, issues, model, backend };
}

function killPortUnix(port) {
  if (process.platform === 'win32') return;
  try {
    const p = spawn('bash', ['-lc', `lsof -ti:${Number(port)} | xargs kill -9 2>/dev/null || true`]);
    p.unref();
  } catch {
    /* ignore */
  }
}

function killPortUnixSync(port) {
  if (process.platform === 'win32') return;
  const safePort = Number(port);
  if (!Number.isFinite(safePort) || safePort <= 0) return;
  const script = `
    for _ in 1 2 3 4 5; do
      pids="$(lsof -tiTCP:${safePort} -sTCP:LISTEN 2>/dev/null || true)"
      [ -z "$pids" ] && exit 0
      kill -9 $pids 2>/dev/null || true
      sleep 0.2
    done
    pids="$(lsof -tiTCP:${safePort} -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$pids" ]
  `;
  try {
    execFileSync('bash', ['-lc', script], { stdio: 'ignore' });
  } catch {
    /* ignore: the worker startup script performs a second cleanup pass */
  }
}

function stopWorker() {
  clearStartupWatchdog();
  if (workerProcess) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(workerProcess.pid), '/f', '/t']);
      } else {
        workerProcess.kill('SIGINT');
      }
    } catch {
      /* ignore */
    }
    workerProcess = null;
  }
  workerStartedAt = 0;
  stopMetricsPoll();
  setWorkerState({ state: 'stopped', progress: 0, message: 'Worker arrete' });
}

function spawnWorker(config, hardware) {
  if (workerProcess) return { ok: true, alreadyRunning: true };
  copyRuntimeIfNeeded();
  const validation = validateConfig(config, hardware);
  if (!validation.ok && !config.allowUnstableGpu) {
    return { ok: false, error: validation.issues.join(' ') };
  }

  killPortUnixSync(config.grpcPort);
  killPortUnixSync(config.apiPort);
  killPortUnixSync(config.p2pPort);
  const env = { ...process.env };
  env.VELOCITY_ROLE = 'worker';
  env.VRYX_API_URL = config.apiUrl || DEFAULT_API_URL;
  env.VRYX_AUTH_TOKEN = String(config.authToken || '');
  env.VRYX_USER_ID = String(config.userId || '');
  env.VRYX_WORKER_OS = process.platform === 'win32' ? 'win32' : process.platform;
  if (config.workerSecret) env.VRYX_WORKER_SECRET = String(config.workerSecret);
  env.VRYX_RUNTIME_BACKEND = validation.backend;
  env.VRYX_WORKER_MODEL = config.modelId;
  env.VRYX_WORKER_MODEL_TOTAL_GB = String(validation.model.totalModelGb || validation.model.diskGb || '');
  env.VRYX_WORKER_SHARD_ONLY = validation.model.distributedOnly ? '1' : '0';
  env.VRYX_EXPECT_MODEL_SHARDS_ONLY = validation.model.distributedOnly ? '1' : '0';
  env.VRYX_DISABLE_MLX_LM_DIRECT = validation.model.directAllowed === false ? '1' : '0';
  env.VRYX_WORKER_MEMORY_LIMIT_GB = String(config.memoryGb);
  env.VRYX_WORKER_MEMORY_LIMIT_PERCENT = String(config.memoryPercent);
  env.VRYX_MODEL_CACHE_DIR = config.cacheDir || path.join(app.getPath('userData'), 'model-cache');
  env.VRYX_HIDDEN_TRANSPORT = config.quantization || 'fp16';
  env.VRYX_SUPPORTS_MLX = validation.backend.includes('mlx') ? '1' : '0';
  env.VRYX_SUPPORTS_VLLM = validation.backend === 'vllm' ? '1' : '0';
  env.VRYX_SUPPORTS_Q4_WEIGHTS = ['q4', 'int4'].includes(config.quantization) || Boolean(validation.model.mlxFullLoadModelId) ? '1' : '0';
  env.PATH = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.cargo/bin'),
    env.PATH || '',
  ].join(path.delimiter);

  const commonArgs = [
    '--model', config.modelId,
    '--grpc-port', String(config.grpcPort),
    '--api-port', String(config.apiPort),
    '--p2p-port', String(config.p2pPort),
    '--bootstrap-node', config.bootstrapNode,
    '--api-url', config.apiUrl,
  ];
  if (config.userId) commonArgs.push('--user-id', String(config.userId));

  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', path.join(nodeAndWorkerDir, 'start-worker.bat'), ...commonArgs];
  } else {
    command = 'bash';
    args = [path.join(nodeAndWorkerDir, 'start-worker.sh'), ...commonArgs];
  }

  setWorkerState({ state: 'starting', progress: 15, message: 'Preparation du worker' });
  workerStartedAt = Date.now();
  startMetricsPoll();
  clearStartupWatchdog();
  workerProcess = spawn(command, args, { cwd: nodeAndWorkerDir, env });
  startupWatchdog = setTimeout(async () => {
    if (!workerProcess || !['starting', 'connecting'].includes(workerState.state)) return;
    const metrics = await readWorkerMetrics();
    if (!metrics.p2pReady && !metrics.peerId) {
      setWorkerState({
        state: 'error',
        progress: 0,
        message: `API locale indisponible sur 127.0.0.1:${config.apiPort}. Consultez les logs worker.`,
      });
    }
  }, 180_000);

  workerProcess.stdout.on('data', (data) => {
    const output = data.toString('utf8').replace(/[^\x09\x0A\x0D\x20-\x7E\u00C0-\u017F]/g, '');
    send('worker-log', { level: 'info', line: output });
    const lower = output.toLowerCase();
    if (lower.includes('environnement python') && workerState.state !== 'working') setWorkerState({ state: 'starting', progress: 30, message: 'Environnement pret' });
    if ((lower.includes('grpc') || lower.includes('inférence')) && workerState.state !== 'working') setWorkerState({ state: 'connecting', progress: 55, message: 'Inference locale demarree' });
    if (lower.includes('heartbeat ok') || lower.includes('p2p_ready') || lower.includes('en ligne')) {
      if (workerState.state !== 'working') {
        setWorkerState({ state: 'connecting', progress: 85, message: 'Heartbeat recu, verification P2P' });
      }
    }
  });

  workerProcess.stderr.on('data', (data) => {
    send('worker-log', { level: 'error', line: data.toString('utf8') });
  });

  workerProcess.on('error', (error) => {
    clearStartupWatchdog();
    workerProcess = null;
    setWorkerState({ state: 'error', progress: 0, message: `Impossible de lancer le worker: ${error.message}` });
    send('worker-log', { level: 'error', line: error.stack || error.message });
  });

  workerProcess.on('close', (code) => {
    clearStartupWatchdog();
  workerProcess = null;
  workerStartedAt = 0;
  activeTpsState = {
    lastTokensGenerated: 0,
    lastSampleMs: 0,
    activeSamples: [],
    lastActiveAtMs: 0,
    sessionTokens: 0,
    sessionStartedAtMs: 0,
  };
  workerHealthCache = {
    onlineLastSeenMs: 0,
    p2pLastSeenMs: 0,
    remoteHeartbeatLastSeenMs: 0,
  };
  stopMetricsPoll();
    setWorkerState({
      state: 'stopped',
      progress: 0,
      message: code === 0 || code == null ? 'Worker arrete' : `Worker arrete avec code ${code}`,
    });
  });

  return { ok: true, warnings: validation.issues };
}

function fetchJson(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const done = (payload) => resolve({ ...payload, elapsedMs: Date.now() - startedAt });
    const lib = url.startsWith('https:') ? require('https') : require('http');
    const req = lib.get(url, { headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          done({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(body) });
        } catch {
          done({ ok: false, status: res.statusCode, error: body.slice(0, 400) });
        }
      });
    });
    req.on('error', (error) => done({ ok: false, error: error.message }));
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, error: 'timeout' });
    });
  });
}

function fetchJsonPost(url, body = {}, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const done = (payload) => resolve({ ...payload, elapsedMs: Date.now() - startedAt });
    const lib = url.startsWith('https:') ? require('https') : require('http');
    const payload = JSON.stringify(body || {});
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          done({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: raw ? JSON.parse(raw) : {} });
        } catch {
          done({ ok: false, status: res.statusCode, error: raw.slice(0, 400) });
        }
      });
    });
    req.on('error', (error) => done({ ok: false, error: error.message }));
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, error: 'timeout' });
    });
    req.write(payload);
    req.end();
  });
}

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient('vryx');
  copyRuntimeIfNeeded();
  ipcMain.handle('get-hardware-stats', () => getHardwareStats());
  ipcMain.handle('get-config', () => readConfig());
  ipcMain.handle('save-config', (_event, config) => writeConfig(config));
  ipcMain.handle('get-model-catalog', () => MODEL_CATALOG);
  ipcMain.handle('validate-config', async (_event, config) => validateConfig({ ...readConfig(), ...config }, await getHardwareStats()));
  ipcMain.handle('get-worker-state', () => workerState);
  ipcMain.handle('get-worker-metrics', () => readWorkerMetrics());
  ipcMain.handle('start-worker', async (_event, configPatch) => {
    const config = writeConfig({ ...readConfig(), ...(configPatch || {}) });
    if (!config.authToken || !config.userId) {
      return { ok: false, error: 'Connexion VRYX requise avant de lancer le worker.' };
    }
    return spawnWorker(config, await getHardwareStats());
  });
  ipcMain.handle('stop-worker', () => {
    stopWorker();
    return { ok: true };
  });
  ipcMain.handle('open-cache-dir', () => {
    const cfg = readConfig();
    const dir = cfg.cacheDir || path.join(app.getPath('userData'), 'model-cache');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
  ipcMain.handle('get-earnings', async (_event, token) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const out = await fetchJson(`${DEFAULT_API_URL}/api/auth/me`, headers);
    return out;
  });
  ipcMain.handle('auth-login', async (_event, credentials) => {
    const out = await fetchJsonPost(`${DEFAULT_API_URL}/api/auth/login`, credentials || {}, {}, 8000);
    if (out.ok && out.data?.token && out.data?.user?.id) {
      writeConfig({ ...readConfig(), authToken: out.data.token, userId: String(out.data.user.id), userEmail: String(out.data.user.email || '') });
    }
    return out.data || out;
  });
  ipcMain.handle('auth-register', async (_event, credentials) => {
    const out = await fetchJsonPost(`${DEFAULT_API_URL}/api/auth/register`, credentials || {}, {}, 8000);
    if (out.ok && out.data?.token && out.data?.user?.id) {
      writeConfig({ ...readConfig(), authToken: out.data.token, userId: String(out.data.user.id), userEmail: String(out.data.user.email || '') });
    }
    return out.data || out;
  });
  ipcMain.handle('auth-logout', async () => {
    stopWorker();
    writeConfig({ ...readConfig(), authToken: '', userId: '', userEmail: '', autoStart: false });
    return { ok: true };
  });
  ipcMain.handle('auth-google', async () => {
    await shell.openExternal(`${DEFAULT_API_URL}/api/auth/google/start?desktop=1`);
    return { ok: true };
  });
  ipcMain.handle('get-network-stats', async () => {
    try {
      return await fetchJson(`${DEFAULT_API_URL}/api/workers/network-stats`, {}, 2500);
    } catch {
      return {
        ok: false,
        onlineCount: 0,
        registeredWorkers: 0,
        activeWorkers30d: 0,
        totalTokensGenerated: 0,
        totalTokens1h: 0,
        totalTokens24h: 0,
        totalTokens30d: 0,
        avgTokensPerActiveWorker30d: 0,
      };
    }
  });
  ipcMain.handle('probe-dependency', (_event, name) => new Promise((resolve) => {
    execFile(name, ['--version'], { timeout: 5000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: String(stdout || stderr || error?.message || '').slice(0, 500) });
    });
  }));
  startMetricsPoll();

  createWindow();
  const initialConfig = readConfig();
  if (initialConfig.autoStart) {
    setTimeout(async () => {
      if (!workerProcess) {
        spawnWorker(initialConfig, await getHardwareStats());
      }
    }, 500);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

app.on('window-all-closed', () => {
  stopWorker();
  if (process.platform !== 'darwin') app.quit();
});
