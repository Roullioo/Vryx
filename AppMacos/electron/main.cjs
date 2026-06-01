const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
const RUNTIME_COPY_REVISION = '2026-05-21-p2p-shard-runtime-v34';
let updateCheckInterval = null;

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
    effectiveModelGb: 5.9,
    mlxFullLoadModelId: 'mlx-community/Qwen3.5-9B-4bit',
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
    // The 4-bit weights are around 19 GB on disk, but mlx-lm needs a large
    // unified-memory headroom for model buffers, tokenizer state, prefill and
    // KV cache. Below this, macOS can kill the worker during warmup.
    fullLoadMinGb: 44,
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
    recommendedMemoryGb: 48,
    minMemoryGb: 10,
    shardMinGb: 8,
    quality: 'Production MoE',
    speed: 'Rapide en Q4 MLX / vLLM, shard MoE sinon',
    useCase: 'MoE 35B total / 3B actifs: full Q4 si la mémoire suffit, sinon couches shardées par worker',
    quantizedVariants: [
      { quantization: 'q4', backend: 'mlx_lm', modelId: 'mlx-community/Qwen3.6-35B-A3B-4bit', diskGb: 19, minMemoryGb: 44 },
      { quantization: 'q4-dwq', backend: 'mlx_lm', modelId: 'mlx-community/Qwen3.6-35B-A3B-4bit-DWQ', diskGb: 19.3, minMemoryGb: 44 },
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
    effectiveModelGb: 39.2,
    fullLoadMinGb: 40,
    mlxFullLoadModelId: 'mlx-community/llama2-70b-qnt4bit',
    localDownloadMode: 'direct_or_shard',
    localShardTypicalGb: 24,
    directAllowed: true,
    distributedOnly: true,
    totalLayers: 80,
    recommendedMemoryGb: 96,
    minMemoryGb: 48,
    shardMinGb: 24,
    quality: 'Tres haute',
    speed: 'Full local si la VRAM suffit, sinon shards multi-workers',
    useCase: 'Charge le modèle complet si la mémoire allouée suffit, sinon seulement les couches du shard',
    gated: true,
  },
  {
    id: 'gemma4:31b',
    label: 'Gemma 31B GGUF',
    family: 'Gemma',
    paramsB: 31,
    diskGb: 21,
    totalModelGb: 21,
    effectiveModelGb: 21,
    fullLoadMinGb: 24,
    localDownloadMode: 'direct_or_shard',
    directAllowed: true,
    distributedOnly: false,
    totalLayers: 48,
    recommendedMemoryGb: 32,
    minMemoryGb: 24,
    shardMinGb: 16,
    quality: 'Production dense',
    speed: 'Rapide en GGUF Q4/Metal si Ollama est résident',
    useCase: 'Benchmark GGUF local via llama.cpp/Ollama',
    llamaCppModelId: 'gemma4:31b',
  },
];

const DEFAULT_CONFIG = {
  apiUrl: DEFAULT_API_URL,
  bootstrapNode: DEFAULT_BOOTSTRAP,
  modelId: 'Qwen/Qwen3.5-9B',
  loadMode: 'auto',
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
  runtimeVersion: '',
  workerSecret: '',
  electricityPriceKwh: 0.22,
};

let mainWindow = null;
let workerProcess = null;
let workerState = { state: 'stopped', progress: 0, message: 'Worker arrete' };
let workerStartedAt = 0;
let metricsInterval = null;
let startupWatchdog = null;
let lastShardRuntimeRestartAt = 0;
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
  shardCount: 0,
  shardLayers: 0,
  shardLayerStart: null,
  shardLayerEnd: null,
  shardModelGb: 0,
  shardModelId: '',
  shardSessionId: '',
  shardWeightLoadMode: '',
  shardReady: false,
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

function runtimeMarkerVersion(version = app.getVersion()) {
  return `${version}-${process.platform}-${process.arch}-${RUNTIME_COPY_REVISION}`;
}

function currentWorkerVersion(config = readConfig()) {
  const runtimeVersion = String(config?.runtimeVersion || '').trim();
  return runtimeVersion || app.getVersion();
}

function runtimePreservePairs() {
  return [
    ['.vryx-keys', '.vryx-keys'],
    ['python-inference/venv', 'python-venv'],
  ];
}

function copyRuntimeTree(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    filter(src) {
      const rel = path.relative(source, src);
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
}

function installRuntimeFromDirectory(source, markerVersion = runtimeMarkerVersion()) {
  const target = runtimeDir();
  const marker = path.join(target, '.vryx-runtime-version');
  const preserved = path.join(app.getPath('userData'), 'runtime-preserved');
  fs.rmSync(preserved, { recursive: true, force: true });
  fs.mkdirSync(preserved, { recursive: true });
  for (const [rel, name] of runtimePreservePairs()) {
    const src = path.join(target, rel);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(preserved, name), { recursive: true });
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  copyRuntimeTree(source, target);
  for (const [rel, name] of runtimePreservePairs()) {
    const src = path.join(preserved, name);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
      fs.cpSync(src, path.join(target, rel), { recursive: true });
    }
  }
  fs.rmSync(preserved, { recursive: true, force: true });
  fs.writeFileSync(marker, markerVersion);
  nodeAndWorkerDir = target;
  return target;
}

function copyRuntimeIfNeeded() {
  if (!isPackaged) {
    nodeAndWorkerDir = bundledNodeAndWorkerDir;
    return nodeAndWorkerDir;
  }
  const target = runtimeDir();
  const marker = path.join(target, '.vryx-runtime-version');
  const version = runtimeMarkerVersion();
  let current = '';
  try {
    current = fs.readFileSync(marker, 'utf8').trim();
  } catch {
    current = '';
  }
  if (current !== version || !fs.existsSync(path.join(target, 'start-worker.sh'))) {
    installRuntimeFromDirectory(bundledNodeAndWorkerDir, version);
  }
  nodeAndWorkerDir = target;
  return target;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function compareVersionLike(a, b) {
  const pa = String(a || '').split(/[^0-9A-Za-z]+/).filter(Boolean);
  const pb = String(b || '').split(/[^0-9A-Za-z]+/).filter(Boolean);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const xa = pa[i] || '0';
    const xb = pb[i] || '0';
    const na = Number(xa);
    const nb = Number(xb);
    const cmp = Number.isFinite(na) && Number.isFinite(nb) ? na - nb : xa.localeCompare(xb);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function releaseAssetForPlatform(release = {}) {
  if (process.platform === 'win32') {
    return process.arch === 'arm64'
      ? { url: release.winArm64Url, sha256: release.winArm64Sha256 }
      : { url: release.winX64Url, sha256: release.winX64Sha256 };
  }
  if (process.platform === 'darwin') return { url: release.macUrl, sha256: release.macSha256 };
  return { url: release.runtimeUrl, sha256: release.runtimeSha256 };
}

function absoluteVryxUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return raw.startsWith('http://') || raw.startsWith('https://') ? raw : `${DEFAULT_API_URL}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function safeDownloadName(url, fallback = 'Vryx-Worker-Update') {
  try {
    const parsed = new URL(absoluteVryxUrl(url));
    const base = path.basename(parsed.pathname || fallback).replace(/[^\w.\-() ]+/g, '-');
    return base || fallback;
  } catch {
    return fallback;
  }
}

function downloadFile(url, destination, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const finalUrl = absoluteVryxUrl(url);
    const lib = finalUrl.startsWith('https:') ? require('https') : require('http');
    const file = fs.createWriteStream(destination);
    const fail = (error) => {
      file.destroy();
      fs.rm(destination, { force: true }, () => reject(error));
    };
    const request = lib.get(finalUrl, { timeout: timeoutMs }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        file.close(() => fs.rm(destination, { force: true }, () => {
          downloadFile(response.headers.location, destination, timeoutMs).then(resolve).catch(reject);
        }));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        fail(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(destination)));
    });
    request.on('error', fail);
    request.on('timeout', () => {
      request.destroy();
      fail(new Error('timeout'));
    });
    file.on('error', fail);
  });
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function extractZipArchive(archivePath, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === 'darwin') {
    await execFilePromise('ditto', ['-x', '-k', archivePath, destination], { timeout: 10 * 60 * 1000 });
    return;
  }
  await execFilePromise('unzip', ['-q', archivePath, '-d', destination], { timeout: 10 * 60 * 1000 });
}

function findBundledRuntimeRoot(root, depth = 8) {
  if (!root || depth < 0) return '';
  const startScript = process.platform === 'win32' ? 'start-worker.bat' : 'start-worker.sh';
  if (
    fs.existsSync(path.join(root, startScript)) &&
    fs.existsSync(path.join(root, 'python-inference')) &&
    fs.existsSync(path.join(root, 'rust-daemon'))
  ) {
    return root;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findBundledRuntimeRoot(path.join(root, entry.name), depth - 1);
    if (found) return found;
  }
  return '';
}

async function applyDownloadedWorkerUpdate(installerPath, release = {}) {
  if (!installerPath || !/\.zip$/i.test(installerPath)) {
    return { applied: false, reason: 'archive_zip_requise' };
  }
  const extractRoot = path.join(app.getPath('userData'), 'updates', `extract-${Date.now()}`);
  try {
    await extractZipArchive(installerPath, extractRoot);
    const runtimeSource = findBundledRuntimeRoot(extractRoot);
    if (!runtimeSource) {
      return { applied: false, reason: 'runtime_nodeAndWorker_introuvable' };
    }
    const targetVersion = String(release.version || '').trim() || app.getVersion();
    stopWorker();
    installRuntimeFromDirectory(runtimeSource, runtimeMarkerVersion());
    const nextConfig = writeConfig({ ...readConfig(), runtimeVersion: targetVersion });
    appendWorkerLog('info', `[update] Runtime ${targetVersion} appliqué depuis ${path.basename(installerPath)}.`);
    setTimeout(async () => spawnWorker(readConfig(), await getHardwareStats()), 2000);
    return { applied: true, version: currentWorkerVersion(nextConfig), runtimeSource };
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function downloadWorkerUpdate(release, reason = 'manual') {
  const asset = releaseAssetForPlatform(release);
  const url = absoluteVryxUrl(asset.url);
  if (!url) throw new Error('Aucun paquet de mise à jour pour cette plateforme.');
  if (reason === 'remote-command' && !asset.sha256) {
    throw new Error('Hash SHA-256 requis pour une mise à jour distante.');
  }
  const updateDir = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(updateDir, { recursive: true });
  const target = path.join(updateDir, safeDownloadName(url));
  appendWorkerLog('info', `[update] Téléchargement ${release.version || ''} (${reason})...`);
  await downloadFile(url, target);
  if (asset.sha256) {
    const actual = await sha256File(target);
    if (actual.toLowerCase() !== String(asset.sha256).toLowerCase()) {
      fs.rmSync(target, { force: true });
      throw new Error('Hash SHA-256 invalide pour la mise à jour.');
    }
    appendWorkerLog('info', '[update] Hash SHA-256 vérifié.');
  } else {
    appendWorkerLog('info', '[update] Aucun hash SHA-256 fourni par le manifeste.');
  }
  return target;
}

async function checkWorkerSoftwareUpdate(reason = 'periodic') {
  const out = await fetchJson(`${DEFAULT_API_URL}/api/worker/releases/current`, {}, 6000);
  if (!out.ok || !out.data?.release?.version) return { ok: false, error: out.error || 'Release indisponible.' };
  const release = out.data.release;
  const current = currentWorkerVersion();
  const available = compareVersionLike(current, release.version) < 0;
  const result = { ok: true, currentVersion: current, available, release, reason };
  send('worker-update-status', result);
  if (available) {
    appendWorkerLog('info', `[update] Version worker disponible ${release.version} (actuelle ${current}).`);
    if (release.mandatory && !workerProcess) {
      const installerPath = await downloadWorkerUpdate(release, reason);
      const applied = await applyDownloadedWorkerUpdate(installerPath, release);
      if (!applied.applied) {
        appendWorkerLog('error', `[update] Application automatique impossible: ${applied.reason}`);
        await shell.openPath(installerPath);
      }
    }
  }
  return result;
}

function getReleaseReadiness() {
  const macSigning = Boolean(process.env.CSC_LINK || process.env.CSC_NAME || process.env.APPLE_DEVELOPER_ID);
  const macNotarization = Boolean(
    process.env.APPLE_ID &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD &&
    process.env.APPLE_TEAM_ID
  );
  const windowsSigning = Boolean(
    process.env.WIN_CSC_LINK ||
    process.env.WINDOWS_CERTIFICATE_FILE ||
    process.env.CSC_LINK
  );
  return {
    appVersion: app.getVersion(),
    runtimeVersion: currentWorkerVersion(),
    updateFeedUrl: `${DEFAULT_API_URL}/api/worker/releases/current`,
    checks: [
      {
        id: 'runtime-updates',
        label: 'Update runtime worker',
        ok: true,
        detail: 'Manifest signé par hash SHA-256 côté commande distante, vérifié avant application.',
      },
      {
        id: 'mac-signing',
        label: 'Signature macOS',
        ok: macSigning,
        detail: macSigning ? 'Identité de signature disponible dans l’environnement de build.' : 'Configurer CSC_LINK/CSC_NAME ou APPLE_DEVELOPER_ID dans CI.',
      },
      {
        id: 'mac-notarization',
        label: 'Notarisation macOS',
        ok: macNotarization,
        detail: macNotarization ? 'Identifiants Apple présents pour le hook notarize.' : 'Configurer APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD et APPLE_TEAM_ID.',
      },
      {
        id: 'windows-signing',
        label: 'Signature Windows',
        ok: windowsSigning,
        detail: windowsSigning ? 'Certificat Windows disponible dans l’environnement de build.' : 'Configurer WIN_CSC_LINK ou WINDOWS_CERTIFICATE_FILE.',
      },
    ],
  };
}

async function acknowledgeRemoteCommand(config, command, status = 'acknowledged', error = null, peerId = null) {
  if (!command?.id) return;
  await fetchJsonPost(`${DEFAULT_API_URL}/api/workers/heartbeat`, {
    peer_id: peerId || lastWorkerMetrics.peerId || 'desktop-app',
    mode: 'worker',
    version: currentWorkerVersion(config),
    model: config.modelId,
    user_id: Number(config.userId || 0),
    command_ack: { id: command.id, status, error },
  }, workerAuthHeaders(config), 6000);
}

function workerAuthHeaders(config = readConfig()) {
  const secret = String(config?.workerSecret || '').trim();
  return secret ? { Authorization: `Bearer ${secret}`, 'x-worker-secret': secret } : {};
}

async function handleRemoteWorkerCommand(commandEvent) {
  const command = commandEvent?.command;
  if (!command?.action) return;
  const peerId = commandEvent?.peer_id || lastWorkerMetrics.peerId || 'desktop-app';
  const config = readConfig();
  appendWorkerLog('info', `[remote] Commande reçue: ${command.action}`);
  try {
    if (command.action === 'update_software') {
      const release = command.payload?.release || command.payload || {};
      const status = await checkWorkerSoftwareUpdate('remote-command');
      if (!status.ok) throw new Error(status.error || 'Release indisponible.');
      const mergedRelease = { ...status.release, ...release };
      const installerPath = await downloadWorkerUpdate(mergedRelease, 'remote-command');
      const applied = await applyDownloadedWorkerUpdate(installerPath, mergedRelease);
      if (!applied.applied) {
        await shell.openPath(installerPath);
        throw new Error(`Mise à jour téléchargée mais application automatique impossible: ${applied.reason}`);
      }
      appendWorkerLog('info', `[remote] Update appliquée localement; ACK différé jusqu'au heartbeat version ${mergedRelease.version || mergedRelease.targetVersion || 'cible'}.`);
      await fetchJsonPost(`${DEFAULT_API_URL}/api/workers/heartbeat`, {
        peer_id: peerId,
        mode: 'worker',
        version: currentWorkerVersion(readConfig()),
        model: readConfig().modelId,
        user_id: Number(readConfig().userId || 0),
      }, workerAuthHeaders(readConfig()), 6000).catch(() => {});
      return;
    }
    if (command.action === 'rotate_secret') {
      const nextSecret = String(command.payload?.workerSecret || command.payload?.secret || '').trim();
      if (nextSecret.length < 32) throw new Error('Nouveau secret worker invalide.');
      writeConfig({ ...config, workerSecret: nextSecret });
      await acknowledgeRemoteCommand(readConfig(), command, 'acknowledged', null, peerId);
      stopWorker();
      setTimeout(async () => spawnWorker(readConfig(), await getHardwareStats()), 2000);
      return;
    }
    if (command.action === 'pause' || command.action === 'drain' || command.action === 'stop') {
      await acknowledgeRemoteCommand(config, command, 'acknowledged', null, peerId);
      stopWorker();
      return;
    }
    if (command.action === 'restart') {
      await acknowledgeRemoteCommand(config, command, 'acknowledged', null, peerId);
      stopWorker();
      setTimeout(async () => spawnWorker(readConfig(), await getHardwareStats()), 2000);
      return;
    }
    if (command.action === 'set_model') {
      const model = String(command.payload?.model || '').trim();
      const loadMode = String(command.payload?.loadMode || 'auto').trim();
      const quantization = String(command.payload?.quantization || config.quantization || 'q4').trim();
      if (!model) throw new Error('model manquant');
      writeConfig({
        ...config,
        modelId: model,
        loadMode: ['auto', 'full', 'shard'].includes(loadMode) ? loadMode : 'auto',
        quantization,
      });
      await acknowledgeRemoteCommand(config, command, 'acknowledged', null, peerId);
      stopWorker();
      setTimeout(async () => spawnWorker(readConfig(), await getHardwareStats()), 2000);
      return;
    }
    if (command.action === 'set_memory') {
      const gb = Number(command.payload?.allocatedVramMb || 0) / 1024;
      const pct = Number(command.payload?.memoryPercent || 0);
      writeConfig({
        ...config,
        ...(gb > 0 ? { memoryGb: Math.round(gb) } : {}),
        ...(pct > 0 ? { memoryPercent: Math.round(pct) } : {}),
      });
      await acknowledgeRemoteCommand(config, command, 'acknowledged', null, peerId);
      stopWorker();
      setTimeout(async () => spawnWorker(readConfig(), await getHardwareStats()), 2000);
      return;
    }
    await acknowledgeRemoteCommand(config, command, 'failed', 'Action inconnue côté app.', peerId);
  } catch (error) {
    appendWorkerLog('error', `[remote] ${error.message}`);
    await acknowledgeRemoteCommand(config, command, 'failed', error.message, peerId);
  }
}

function setWorkerState(patch) {
  workerState = { ...workerState, ...patch };
  send('worker-status', workerState);
}

function statusUrl(config) {
  return `http://127.0.0.1:${Number(config.apiPort || DEFAULT_CONFIG.apiPort)}/api/status`;
}

function shardsUrl(config) {
  return `http://127.0.0.1:${Number(config.apiPort || DEFAULT_CONFIG.apiPort)}/api/shards`;
}

function normalizeMetricNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function summarizeShardStatus(payload) {
  const shards = Array.isArray(payload?.shards) ? payload.shards.filter((item) => item && typeof item === 'object') : [];
  if (shards.length === 0) {
    return {
      shardCount: 0,
      shardLayers: 0,
      shardLayerStart: null,
      shardLayerEnd: null,
      shardModelGb: 0,
      shardModelId: '',
      shardSessionId: '',
      shardWeightLoadMode: '',
      shardReady: false,
      shardLoading: false,
      shardLoadError: '',
      shardMaxAgeSec: 0,
    };
  }
  const layers = shards.reduce((sum, shard) => {
    const explicit = Number(shard.num_layers);
    if (Number.isFinite(explicit) && explicit > 0) return sum + explicit;
    const start = Number(shard.layer_start);
    const end = Number(shard.layer_end);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? sum + (end - start + 1) : sum;
  }, 0);
  const starts = shards.map((shard) => Number(shard.layer_start)).filter((n) => Number.isFinite(n) && n >= 0);
  const ends = shards.map((shard) => Number(shard.layer_end)).filter((n) => Number.isFinite(n) && n >= 0);
  const bytes = shards.reduce((sum, shard) => (
    sum + normalizeMetricNumber(shard.resident_weight_bytes, shard.weight_bytes, shard.binary_total_bytes)
  ), 0);
  const primary = shards.find((shard) => shard.ready || shard.resident_vram || Number(shard.weights_loaded || 0) > 0) || shards[0];
  return {
    shardCount: shards.length,
    shardLayers: layers,
    shardLayerStart: starts.length ? Math.min(...starts) : null,
    shardLayerEnd: ends.length ? Math.max(...ends) : null,
    shardModelGb: Math.round((bytes / 1024 ** 3) * 100) / 100,
    shardModelId: String(primary.model_id || ''),
    shardSessionId: String(primary.session_id || ''),
    shardWeightLoadMode: String(primary.weight_load_mode || ''),
    shardReady: shards.some((shard) => Boolean(shard.ready || shard.resident_vram || shard.build_ready)),
    shardLoading: shards.some((shard) => Boolean(shard.loading)),
    shardLoadError: String(shards.find((shard) => shard.load_error)?.load_error || ''),
    shardMaxAgeSec: Math.max(0, ...shards.map((shard) => normalizeMetricNumber(shard.age_sec))),
  };
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
  const activeSamples = recentActive ? activeTpsState.activeSamples : [];
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
  const [local, shardStatus] = await Promise.all([
    fetchJson(statusUrl(config), {}, 1200),
    fetchJson(shardsUrl(config), {}, 1200),
  ]);
  const localData = local.ok ? (local.data || {}) : {};
  const shardSummary = summarizeShardStatus(shardStatus.ok ? shardStatus.data : null);
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
    ...shardSummary,
  };

  if (lastWorkerMetrics.p2pReady && workerState.state !== 'working') {
    setWorkerState({ state: 'working', progress: 100, message: 'Worker P2P pret et visible sur VRYX' });
  } else if (localOnline && ['starting', 'stopped'].includes(workerState.state)) {
    setWorkerState({ state: 'connecting', progress: 75, message: 'Worker local demarre, connexion P2P en cours' });
  }
  if (lastWorkerMetrics.shardLoadError) {
    restartWorkerForStuckShard(`shard load error: ${lastWorkerMetrics.shardLoadError}`);
  } else if (lastWorkerMetrics.shardLoading && Number(lastWorkerMetrics.shardMaxAgeSec || 0) > 20 * 60) {
    restartWorkerForStuckShard(`shard loading bloqué depuis ${lastWorkerMetrics.shardMaxAgeSec}s`);
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
  if (model?.llamaCppModelId || model?.family === 'Gemma') return 'llama_cpp';
  if (process.platform === 'darwin') return canFullLoadModel(config, hardware, model) ? 'mlx_lm' : 'mlx';
  const names = (hardware.controllers || []).map((c) => `${c.vendor} ${c.model}`.toLowerCase()).join(' ');
  if (names.includes('nvidia')) return 'vllm';
  if (names.includes('amd')) return 'rocm';
  if (names.includes('intel')) return 'openvino';
  return 'cpu';
}

function fullLoadMemoryGb(model, config) {
  if (!model) return Infinity;
  const quant = String(config?.quantization || '').toLowerCase();
  if (quant.includes('q4') || quant.includes('int4') || model.mlxFullLoadModelId) {
    return Number(model.fullLoadMinGb || model.effectiveModelGb || model.totalModelGb || model.diskGb || Infinity);
  }
  if (quant.includes('8')) {
    return Number(model.fullLoadInt8Gb || model.effectiveModelGb || model.totalModelGb || model.diskGb || Infinity);
  }
  return Number(model.fullLoadFp16Gb || model.totalModelGb || model.diskGb || Infinity);
}

function mlxLoadModelIdForConfig(model, config) {
  if (!model) return '';
  const quant = String(config?.quantization || '').toLowerCase();
  if ((quant.includes('dwq') || quant.includes('q4-dwq')) && model.mlxDwqLoadModelId) return model.mlxDwqLoadModelId;
  if ((quant.includes('8') || quant.includes('int8')) && model.mlxInt8LoadModelId) return model.mlxInt8LoadModelId;
  return model.mlxFullLoadModelId || '';
}

function canFullLoadModel(config, hardware, model) {
  if (!model || model.directAllowed === false) return false;
  const allocated = Number(config?.memoryGb || 0);
  const detected = Number(hardware?.vramGb || hardware?.totalMemoryGb || 0);
  if (allocated <= 0 || detected <= 0 || allocated > detected + 0.25) return false;
  const required = fullLoadMemoryGb(model, config);
  return Number.isFinite(required) && allocated >= required;
}

function validateConfig(config, hardware) {
  const model = MODEL_CATALOG.find((m) => m.id === config.modelId) || MODEL_CATALOG[0];
  const memoryGb = Number(config.memoryGb || 0);
  const issues = [];
  const hardIssues = [];
  const fullLoad = canFullLoadModel(config, hardware, model);
  const requestedLoadMode = ['auto', 'full', 'shard'].includes(String(config.loadMode || ''))
    ? String(config.loadMode || 'auto')
    : 'auto';
  if (!fullLoad && memoryGb < model.shardMinGb) {
    issues.push(`Memoire allouee trop basse pour un shard ${model.label}: ${memoryGb} Go < ${model.shardMinGb} Go.`);
  }
  if (requestedLoadMode === 'full' && !fullLoad) {
    hardIssues.push(`Mode solo complet impossible pour ${model.label}: augmente la memoire allouee ou repasse en auto/multi-worker.`);
  }
  if (memoryGb > Number(hardware.vramGb || hardware.totalMemoryGb || 0)) {
    issues.push('Memoire allouee superieure a la memoire detectee.');
  }
  let backend = chooseBackend(config, hardware, model);
  const workerMode =
    requestedLoadMode === 'shard'
      ? 'shard'
      : requestedLoadMode === 'full' && fullLoad
        ? 'full'
        : fullLoad
          ? 'full'
          : (model.distributedOnly ? 'shard' : 'direct');
  if (workerMode === 'shard' && backend === 'mlx_lm') {
    backend = 'mlx';
  }
  if (backend === 'cpu') {
    issues.push('Backend CPU: autorise mais non recommande pour participer au reseau.');
  }
  return {
    ok: issues.length === 0 && hardIssues.length === 0,
    issues,
    hardIssues,
    model,
    backend,
    workerMode,
    fullLoad: workerMode === 'full',
    fullLoadMemoryGb: fullLoadMemoryGb(model, config),
  };
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

function cleanupLegacyWorkerLaunchAgentsSync() {
  if (process.platform !== 'darwin') return;
  const script = `
    set +e
    uid="$(id -u)"
    for label in \
      com.vryx.gemma.worker1.python \
      com.vryx.gemma.worker1.rust \
      com.vryx.gemma.worker2.python \
      com.vryx.gemma.worker2.rust \
      com.vryx.m4.python.manual \
      com.vryx.m4.python.llama70b-shard \
      com.vryx.m4.mlx-lm-server.manual \
      com.vryx.m4.rust.manual; do
      launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || launchctl remove "$label" >/dev/null 2>&1 || true
      launchctl disable "gui/$uid/$label" >/dev/null 2>&1 || true
    done
    for file in "$HOME"/Library/LaunchAgents/com.vryx.gemma.worker*.plist "$HOME"/Library/LaunchAgents/com.vryx.m4.*.plist; do
      [ -f "$file" ] || continue
      mv "$file" "$file.disabled-legacy" >/dev/null 2>&1 || true
    done
  `;
  try {
    execFileSync('bash', ['-lc', script], { stdio: 'ignore' });
  } catch {
    /* ignore: cleanup is best-effort and the port cleanup below remains authoritative */
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

function restartWorkerForStuckShard(reason) {
  const now = Date.now();
  if (!workerProcess || now - lastShardRuntimeRestartAt < 10 * 60 * 1000) return;
  lastShardRuntimeRestartAt = now;
  appendWorkerLog('error', `[watchdog] Redémarrage runtime worker: ${reason}`);
  stopWorker();
  setTimeout(async () => spawnWorker(readConfig(), await getHardwareStats()), 2500);
}

function appendWorkerLog(level, line) {
  send('worker-log', { level, line });
}

function prepareModelResidency(config, validation) {
  if (process.platform === 'win32') return;
  const script = path.join(nodeAndWorkerDir, 'scripts', 'prepare_local_residency.py');
  if (!fs.existsSync(script)) return;
  const python = path.join(nodeAndWorkerDir, 'python-inference', 'venv', 'bin', 'python3');
  const command = fs.existsSync(python) ? python : 'python3';
  const mode = validation?.backend === 'mlx_lm' ? 'full' : 'shard';
  const args = [
    script,
    '--mode', mode,
    '--grpc-port', String(config.grpcPort),
    '--model-id', config.modelId,
    '--allocated-gb', String(config.memoryGb),
    '--quantization', config.quantization || 'q4',
    '--api-url', config.apiUrl || DEFAULT_API_URL,
  ];
  const env = { ...process.env };
  const residencyLoadModelId = mlxLoadModelIdForConfig(validation.model, config);
  if (residencyLoadModelId) env.VRYX_MLX_LM_MODEL_ID = residencyLoadModelId;
  appendWorkerLog('info', `[residency] Préparation ${mode === 'full' ? 'mode résident MLX' : 'shard local'} pour ${config.modelId}`);
  const child = spawn(command, args, { cwd: nodeAndWorkerDir, env });
  child.stdout.on('data', (data) => {
    data.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((line) => appendWorkerLog('info', line));
  });
  child.stderr.on('data', (data) => {
    data.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((line) => appendWorkerLog('error', line));
  });
  child.on('exit', (code) => {
    appendWorkerLog(code === 0 ? 'info' : 'error', `[residency] terminé avec code ${code}`);
  });
}

function spawnWorker(config, hardware) {
  if (workerProcess) return { ok: true, alreadyRunning: true };
  copyRuntimeIfNeeded();
  cleanupLegacyWorkerLaunchAgentsSync();
  const validation = validateConfig(config, hardware);
  if (validation.hardIssues?.length) {
    return { ok: false, error: validation.hardIssues.join(' ') };
  }
  if (!validation.ok && !config.allowUnstableGpu) {
    return { ok: false, error: validation.issues.join(' ') };
  }

  killPortUnixSync(config.grpcPort);
  killPortUnixSync(config.apiPort);
  killPortUnixSync(config.p2pPort);
  const env = { ...process.env };
  env.VELOCITY_ROLE = 'worker';
  env.VRYX_WORKER_VERSION = currentWorkerVersion(config);
  env.VRYX_API_URL = config.apiUrl || DEFAULT_API_URL;
  env.VRYX_AUTH_TOKEN = String(config.authToken || '');
  env.VRYX_USER_ID = String(config.userId || '');
  env.VRYX_WORKER_OS = process.platform === 'win32' ? 'win32' : process.platform;
  if (config.workerSecret) env.VRYX_WORKER_SECRET = String(config.workerSecret);
  env.VRYX_RUNTIME_BACKEND = validation.backend;
  env.VRYX_WORKER_MODEL = config.modelId;
  env.VRYX_WORKER_MODEL_TOTAL_GB = String(validation.model.totalModelGb || validation.model.diskGb || '');
  env.VRYX_WORKER_MODEL_EFFECTIVE_GB = String(validation.model.effectiveModelGb || validation.model.totalModelGb || validation.model.diskGb || '');
  env.VRYX_WORKER_MODEL_TOTAL_LAYERS = String(validation.model.totalLayers || '');
  env.VRYX_WORKER_LOAD_MODE = validation.workerMode;
  env.VRYX_WORKER_SHARD_ONLY = validation.workerMode === 'shard' ? '1' : '0';
  env.VRYX_EXPECT_MODEL_SHARDS_ONLY = validation.workerMode === 'shard' ? '1' : '0';
  env.VRYX_DISABLE_MLX_LM_DIRECT = validation.workerMode === 'shard' ? '1' : '0';
  const mlxLoadModelId = mlxLoadModelIdForConfig(validation.model, config);
  if (validation.workerMode === 'full' && mlxLoadModelId) {
    env.VRYX_MLX_LM_MODEL_ID = mlxLoadModelId;
  }
  env.VRYX_MLX_PREWARM = validation.workerMode === 'full' && Number(config.memoryGb || 0) >= validation.fullLoadMemoryGb
    ? '1'
    : '0';
  env.VRYX_WORKER_MEMORY_LIMIT_GB = String(config.memoryGb);
  env.VRYX_WORKER_MEMORY_LIMIT_PERCENT = String(config.memoryPercent);
  env.VRYX_MODEL_CACHE_DIR = config.cacheDir || path.join(app.getPath('userData'), 'model-cache');
  env.VRYX_WORKER_SHARD_CACHE_DIR = path.join(env.VRYX_MODEL_CACHE_DIR, 'shards');
  const effectiveQuantization = validation.backend === 'llama_cpp' && !String(config.quantization || '').toLowerCase().includes('q4')
    ? 'q4'
    : config.quantization || 'fp16';
  const hiddenTransport = validation.workerMode === 'shard' && validation.backend === 'mlx'
    ? 'int8'
    : effectiveQuantization;
  env.VRYX_HIDDEN_TRANSPORT = hiddenTransport;
  env.VRYX_WEIGHT_QUANTIZATION = effectiveQuantization;
  if (validation.backend === 'llama_cpp') {
    env.VRYX_LLAMA_CPP_DIRECT = '1';
    env.VRYX_LLAMA_CPP_MODEL = validation.model.llamaCppModelId || config.modelId;
    env.VRYX_LLAMA_CPP_NUM_GPU = '999';
    env.VRYX_LLAMA_CPP_NUM_CTX = env.VRYX_LLAMA_CPP_NUM_CTX || '4096';
    env.VRYX_LLAMA_CPP_NUM_BATCH = env.VRYX_LLAMA_CPP_NUM_BATCH || '1024';
    env.VRYX_LLAMA_CPP_KEEP_ALIVE = env.VRYX_LLAMA_CPP_KEEP_ALIVE || '24h';
    env.VRYX_LLAMA_CPP_PREWARM = env.VRYX_LLAMA_CPP_PREWARM || '1';
  }
  env.VRYX_SUPPORTS_MLX = validation.backend.includes('mlx') ? '1' : '0';
  env.VRYX_SUPPORTS_VLLM = validation.backend === 'vllm' ? '1' : '0';
  env.VRYX_SUPPORTS_Q4_WEIGHTS = (
    String(effectiveQuantization || '').toLowerCase().includes('q4') ||
    ['int4'].includes(String(effectiveQuantization || '').toLowerCase()) ||
    validation.backend === 'llama_cpp' ||
    Boolean(validation.model.mlxFullLoadModelId)
  ) ? '1' : '0';
  env.VRYX_MACHINE_INFO = JSON.stringify({
    platform: hardware.platform,
    arch: hardware.arch,
    os: hardware.os,
    cpu: hardware.cpu,
    gpuName: hardware.gpuName,
    gpuVendor: hardware.gpuVendor,
    controllers: hardware.controllers,
    unifiedMemory: hardware.unifiedMemory,
    totalMemoryGb: hardware.totalMemoryGb,
    availableMemoryGb: hardware.availableMemoryGb,
    vramGb: hardware.vramGb,
    backendCandidates: hardware.backendCandidates,
  });
  if (validation.backend.includes('mlx')) {
    env.VRYX_ENABLE_MLX_RUNTIME = '1';
    env.VRYX_ENABLE_MLX_KERNELS = '1';
    env.VRYX_MLX_SCAN_BACKEND = 'metal';
    env.VRYX_MLX_COMPUTE_DTYPE = 'fp16';
  }
  if (validation.workerMode === 'shard' && validation.backend === 'mlx') {
    env.VRYX_ENABLE_GGUF_MLX_SHARD = '1';
    env.VRYX_ENABLE_LLAMA_MLX_SHARD = validation.model.family === 'Llama' ? '1' : (env.VRYX_ENABLE_LLAMA_MLX_SHARD || '0');
    env.VRYX_GGUF_MLX_CACHE_GB = String(Math.max(2, Math.min(8, Math.floor(Number(config.memoryGb || 8) * 0.25))));
    env.VRYX_MLX_PREFETCH_SHARD_WEIGHTS = env.VRYX_MLX_PREFETCH_SHARD_WEIGHTS || '1';
    env.VRYX_MLX_PREFETCH_ON_BUILD = env.VRYX_MLX_PREFETCH_ON_BUILD || '1';
    env.VRYX_MLX_LOCAL_GGUF_CACHE = env.VRYX_MLX_LOCAL_GGUF_CACHE || '1';
    env.VRYX_GGUF_LOCAL_CACHE_DIR = env.VRYX_GGUF_LOCAL_CACHE_DIR || path.join(env.VRYX_WORKER_SHARD_CACHE_DIR, 'gguf-cache');
    const localQwen36Gguf = path.join(env.VRYX_MODEL_CACHE_DIR, 'gguf', 'qwen36-35b-iq4-xs.gguf');
    if (!env.VRYX_GGUF_LOCAL_SOURCE_PATH && fs.existsSync(localQwen36Gguf)) {
      env.VRYX_GGUF_LOCAL_SOURCE_PATH = localQwen36Gguf;
      env.VRYX_GGUF_PERF_MODE = env.VRYX_GGUF_PERF_MODE || '1';
    }
    env.VRYX_MLX_STRICT = '1';
    env.VRYX_DISABLE_PYTORCH_FALLBACK = '1';
  }
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
  let residencyPrepared = false;
  setTimeout(() => {
    if (!workerProcess || residencyPrepared) return;
    residencyPrepared = true;
    prepareModelResidency(config, validation);
  }, 3_000);
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
    for (const line of output.split(/\r?\n/)) {
      const marker = '[VRYX_REMOTE_COMMAND]';
      const idx = line.indexOf(marker);
      if (idx >= 0) {
        try {
          const payload = JSON.parse(line.slice(idx + marker.length).trim());
          void handleRemoteWorkerCommand(payload);
        } catch (error) {
          appendWorkerLog('error', `[remote] Commande invalide: ${error.message}`);
        }
      }
    }
    const lower = output.toLowerCase();
    if (lower.includes('environnement python') && workerState.state !== 'working') setWorkerState({ state: 'starting', progress: 30, message: 'Environnement pret' });
    if ((lower.includes('grpc') || lower.includes('inférence')) && workerState.state !== 'working') setWorkerState({ state: 'connecting', progress: 55, message: 'Inference locale demarree' });
    if (lower.includes('heartbeat ok') || lower.includes('p2p_ready') || lower.includes('en ligne')) {
      if (workerState.state !== 'working') {
        setWorkerState({ state: 'connecting', progress: 85, message: 'Heartbeat recu, verification P2P' });
      }
      if (!residencyPrepared) {
        residencyPrepared = true;
        setTimeout(() => prepareModelResidency(config, validation), 1500);
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
  cleanupLegacyWorkerLaunchAgentsSync();
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
  ipcMain.handle('get-release-readiness', () => getReleaseReadiness());
  ipcMain.handle('check-worker-update', async () => checkWorkerSoftwareUpdate('manual'));
  ipcMain.handle('probe-dependency', (_event, name) => new Promise((resolve) => {
    execFile(name, ['--version'], { timeout: 5000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: String(stdout || stderr || error?.message || '').slice(0, 500) });
    });
  }));
  startMetricsPoll();
  void checkWorkerSoftwareUpdate('startup');
  updateCheckInterval = setInterval(() => void checkWorkerSoftwareUpdate('interval'), 60 * 60 * 1000);

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
  if (updateCheckInterval) clearInterval(updateCheckInterval);
  stopWorker();
  if (process.platform !== 'darwin') app.quit();
});
