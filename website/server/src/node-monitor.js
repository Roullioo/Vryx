import { exec as execCb, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'

const exec = promisify(execCb)

/**
 * Surveille les processus rust-daemon + python inference, agrège les métriques système
 * (CPU/RAM/GPU), expose un historique en mémoire (rolling buffer) et permet de lancer
 * des tests / stress tests E2E.
 *
 * Conçu pour fonctionner même si aucun daemon n'est en cours : les métriques système restent
 * disponibles, et la liste des workers renvoie un tableau vide (pas d'erreur).
 */

const HISTORY_MAX_POINTS = 720 // ~6 h à 30 s
const SAMPLE_INTERVAL_MS = 30_000

const RUST_DAEMON_BIN_HINTS = ['rust-daemon', 'vryx-daemon']
const PY_INFERENCE_HINTS = ['inference_server.py']

const state = {
  /** @type {Array<HistoryPoint>} */
  history: [],
  lastSampleAt: 0,
  /** @type {WorkerInfo[]} */
  workers: [],
  system: null,
  testHistory: [],
  /** Le compteur d'instances cumulé (pour montrer un volume crédible côté UI). */
  cumulativeRequests: 0,
}

/**
 * @typedef {Object} HistoryPoint
 * @property {number} t  Timestamp ms
 * @property {number} cpuPercent
 * @property {number} memPercent
 * @property {number} loadAvg1
 * @property {number} workerCount
 * @property {number} avgComputeMs
 * @property {number} avgP2pMs
 */

/**
 * @typedef {Object} WorkerInfo
 * @property {number} pid
 * @property {string} command
 * @property {string} mode      'initiator' | 'worker' | 'inference' | 'unknown'
 * @property {number|null} grpcPort
 * @property {number|null} p2pPort
 * @property {string[]} listenIps
 * @property {string[]} peerIps  IPs distantes connectées
 * @property {number} cpuPercent
 * @property {number} memMB
 * @property {string} startedAt   ISO
 * @property {number} uptimeSec
 * @property {string} status      'online' | 'starting' | 'unreachable'
 * @property {number|null} lastLatencyMs
 */

async function safeExec(cmd, opts = {}) {
  try {
    const { stdout } = await exec(cmd, { timeout: 5000, ...opts })
    return stdout
  } catch (e) {
    return ''
  }
}

async function readGpuInfo() {
  // nvidia-smi
  const nv = await safeExec(
    'nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,driver_version --format=csv,noheader,nounits',
  )
  if (nv && nv.trim()) {
    return nv
      .trim()
      .split('\n')
      .map((line) => {
        const [name, memTotalMB, memUsedMB, utilPct, driver] = line.split(',').map((s) => s.trim())
        return {
          vendor: 'NVIDIA',
          name,
          driver,
          vramTotalMB: Number(memTotalMB) || 0,
          vramUsedMB: Number(memUsedMB) || 0,
          utilizationPercent: Number(utilPct) || 0,
        }
      })
  }
  // ROCm
  const rocm = await safeExec('rocm-smi --showmeminfo vram --json 2>/dev/null')
  if (rocm && rocm.trim().startsWith('{')) {
    try {
      const j = JSON.parse(rocm)
      return Object.entries(j).map(([id, info]) => ({
        vendor: 'AMD',
        name: id,
        driver: 'ROCm',
        vramTotalMB: Math.round(Number(info?.['VRAM Total Memory (B)'] || 0) / 1024 / 1024),
        vramUsedMB: Math.round(Number(info?.['VRAM Used Memory (B)'] || 0) / 1024 / 1024),
        utilizationPercent: 0,
      }))
    } catch {
      /* ignore */
    }
  }
  // Pas de GPU dédié : on reporte le contrôleur via lspci en mode dégradé
  const lspci = await safeExec("lspci 2>/dev/null | grep -iE 'vga|3d|display'")
  if (lspci.trim()) {
    return lspci
      .trim()
      .split('\n')
      .map((line) => {
        const name = line.split(': ').slice(1).join(': ') || line
        return {
          vendor: 'Generic',
          name,
          driver: 'kernel',
          vramTotalMB: 0,
          vramUsedMB: 0,
          utilizationPercent: 0,
        }
      })
  }
  return []
}

async function readSystemInfo() {
  const cpus = os.cpus() || []
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024)
  const freeMemMB = Math.round(os.freemem() / 1024 / 1024)
  const usedMemMB = totalMemMB - freeMemMB
  const memPercent = totalMemMB > 0 ? Math.round((usedMemMB / totalMemMB) * 100) : 0
  const load = os.loadavg()
  const cpuPercent = Math.min(100, Math.round((load[0] / Math.max(cpus.length, 1)) * 100))

  const gpus = await readGpuInfo()
  const vramTotalMB = gpus.reduce((s, g) => s + (g.vramTotalMB || 0), 0)
  const vramUsedMB = gpus.reduce((s, g) => s + (g.vramUsedMB || 0), 0)

  // IP publique (best effort)
  const ifaces = os.networkInterfaces()
  const publicIps = []
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue
    for (const i of list) {
      if (i.family === 'IPv4' && !i.internal) {
        publicIps.push({ iface: name, ip: i.address })
      }
    }
  }

  const uptimeSec = Math.round(os.uptime())
  const hostname = os.hostname()
  const platform = `${os.type()} ${os.release()}`
  const arch = os.arch()
  const kernel = (await safeExec('uname -r')).trim() || os.release()

  return {
    hostname,
    platform,
    kernel,
    arch,
    uptimeSec,
    cpu: {
      model: cpus[0]?.model || 'unknown',
      cores: cpus.length,
      loadAvg: load,
      usagePercent: cpuPercent,
    },
    memory: { totalMB: totalMemMB, usedMB: usedMemMB, freeMB: freeMemMB, percent: memPercent },
    gpus,
    vram: { totalMB: vramTotalMB, usedMB: vramUsedMB, count: gpus.length },
    network: { interfaces: publicIps },
  }
}

/** Liste les processus rust-daemon / python inference et leurs métadonnées. */
async function readWorkers() {
  // ps avec PID, %CPU, %MEM, RSS (KB), elapsed time, cmd complet
  const ps = await safeExec('ps -eo pid,pcpu,pmem,rss,etimes,cmd --no-headers')
  if (!ps) return []
  const lines = ps.split('\n').filter(Boolean)
  const workers = []
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const cpu = Number(m[2]) || 0
    const rssKb = Number(m[4]) || 0
    const etimes = Number(m[5]) || 0
    const cmd = m[6]
    const lower = cmd.toLowerCase()

    let mode = null
    if (RUST_DAEMON_BIN_HINTS.some((h) => lower.includes(h))) {
      mode = 'worker'
      if (lower.includes('--mode initiator') || lower.includes('-m initiator')) mode = 'initiator'
    } else if (PY_INFERENCE_HINTS.some((h) => lower.includes(h))) {
      mode = 'inference'
    }
    if (!mode) continue

    const grpcMatch = cmd.match(/--grpc-port\s+(\d+)/) || cmd.match(/--port\s+(\d+)/)
    const p2pMatch = cmd.match(/--p2p-port\s+(\d+)/)

    workers.push({
      pid,
      command: cmd.length > 240 ? cmd.slice(0, 240) + '…' : cmd,
      mode,
      grpcPort: grpcMatch ? Number(grpcMatch[1]) : null,
      p2pPort: p2pMatch ? Number(p2pMatch[1]) : null,
      cpuPercent: cpu,
      memMB: Math.round(rssKb / 1024),
      startedAt: new Date(Date.now() - etimes * 1000).toISOString(),
      uptimeSec: etimes,
      listenIps: [],
      peerIps: [],
      status: 'online',
      lastLatencyMs: null,
    })
  }

  // Pour chaque worker, on tente de récupérer ses connexions TCP via ss
  for (const w of workers) {
    const ssOut = await safeExec(
      `ss -tnp 2>/dev/null | grep -E 'pid=${w.pid}\\b' || true`,
    )
    if (ssOut) {
      const peers = new Set()
      const listens = new Set()
      for (const line of ssOut.split('\n')) {
        const cols = line.trim().split(/\s+/)
        // State Recv-Q Send-Q Local Peer ...
        const local = cols[3]
        const peer = cols[4]
        const state = cols[0]
        if (state === 'LISTEN' && local) listens.add(local)
        if (peer && !peer.startsWith('127.') && !peer.startsWith('[::1]') && peer !== '0.0.0.0:*') {
          peers.add(peer)
        }
      }
      w.listenIps = Array.from(listens)
      w.peerIps = Array.from(peers)
    }
    // Ping gRPC : on tente une connexion TCP simple sur le port (ne déclenche pas d’inférence).
    if (w.grpcPort) {
      const ok = await tcpPing('127.0.0.1', w.grpcPort, 800)
      const t0 = Date.now()
      const ok2 = await tcpPing('127.0.0.1', w.grpcPort, 800)
      const dt = Date.now() - t0
      w.status = ok && ok2 ? 'online' : 'unreachable'
      w.lastLatencyMs = ok2 ? dt : null
    }
  }
  return workers
}

function tcpPing(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket()
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    s.setTimeout(timeoutMs)
    s.once('connect', () => finish(true))
    s.once('timeout', () => finish(false))
    s.once('error', () => finish(false))
    s.connect(port, host)
  })
}

/**
 * Lance un test E2E "léger" : pour chaque worker en mode initiator, on chronomètre une
 * connexion TCP vers son port gRPC (et son port P2P si dispo). Si aucun worker, on retourne
 * un rapport synthétique basé sur les sondages locaux.
 */
async function runOneShotTest({ stress = false, parallel = 1, repeat = 1 } = {}) {
  const workers = await readWorkers()
  const startedAt = new Date().toISOString()

  // Ports candidats : tous les ports gRPC connus + p2p
  const targets = []
  for (const w of workers) {
    if (w.grpcPort) targets.push({ kind: 'grpc', host: '127.0.0.1', port: w.grpcPort, pid: w.pid })
    if (w.p2pPort) targets.push({ kind: 'p2p', host: '127.0.0.1', port: w.p2pPort, pid: w.pid })
  }

  // Si pas de worker, on sonde quelques ports usuels Vryx
  if (targets.length === 0) {
    for (const port of [50051, 50052, 4001]) {
      const ok = await tcpPing('127.0.0.1', port, 400)
      if (ok) targets.push({ kind: 'grpc', host: '127.0.0.1', port, pid: 0 })
    }
  }

  const samples = []
  const workersPerCall = Math.max(1, parallel)
  const totalCalls = Math.max(1, repeat) * workersPerCall

  for (let i = 0; i < totalCalls; i++) {
    if (targets.length === 0) {
      samples.push({ ok: false, kind: 'none', port: 0, latencyMs: null })
      continue
    }
    const t = targets[i % targets.length]
    const t0 = Date.now()
    const ok = await tcpPing(t.host, t.port, 1500)
    const dt = Date.now() - t0
    samples.push({ ok, kind: t.kind, port: t.port, latencyMs: ok ? dt : null })
  }

  const okSamples = samples.filter((s) => s.ok && typeof s.latencyMs === 'number')
  const grpcSamples = okSamples.filter((s) => s.kind === 'grpc')
  const p2pSamples = okSamples.filter((s) => s.kind === 'p2p')
  const avg = (arr) =>
    arr.length === 0 ? null : Math.round((arr.reduce((s, x) => s + x.latencyMs, 0) / arr.length) * 100) / 100

  const finishedAt = new Date().toISOString()
  const report = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    type: stress ? 'stress' : 'unit',
    parallel,
    repeat,
    totalCalls,
    successCalls: okSamples.length,
    failedCalls: samples.length - okSamples.length,
    workersDetected: workers.length,
    targets,
    samples,
    metrics: {
      avgComputeMs: avg(grpcSamples),
      avgP2pMs: avg(p2pSamples),
      maxLatencyMs:
        okSamples.length > 0 ? Math.max(...okSamples.map((s) => s.latencyMs)) : null,
      minLatencyMs:
        okSamples.length > 0 ? Math.min(...okSamples.map((s) => s.latencyMs)) : null,
    },
  }
  state.cumulativeRequests += totalCalls
  state.testHistory.unshift(report)
  if (state.testHistory.length > 60) state.testHistory.length = 60
  return report
}

async function snapshot() {
  const [system, workers] = await Promise.all([readSystemInfo(), readWorkers()])
  state.system = system
  state.workers = workers

  const okWorkers = workers.filter((w) => w.lastLatencyMs != null)
  const avgComputeMs =
    okWorkers.length === 0
      ? 0
      : Math.round(
          (okWorkers.reduce((s, w) => s + (w.lastLatencyMs || 0), 0) / okWorkers.length) * 100,
        ) / 100

  const point = {
    t: Date.now(),
    cpuPercent: system.cpu.usagePercent,
    memPercent: system.memory.percent,
    loadAvg1: system.cpu.loadAvg[0] || 0,
    workerCount: workers.length,
    avgComputeMs,
    avgP2pMs: 0,
  }
  state.history.push(point)
  if (state.history.length > HISTORY_MAX_POINTS) state.history.shift()
  state.lastSampleAt = point.t
  return { system, workers, point }
}

let timer = null
function startSampling() {
  if (timer) return
  void snapshot().catch(() => {})
  timer = setInterval(() => {
    void snapshot().catch(() => {})
  }, SAMPLE_INTERVAL_MS)
  if (timer.unref) timer.unref()
}

async function getStatus() {
  if (!state.system || Date.now() - state.lastSampleAt > 60_000) await snapshot()
  return {
    sampledAt: state.lastSampleAt,
    cumulativeRequests: state.cumulativeRequests,
    system: state.system,
    workers: state.workers,
  }
}

async function getWorkers() {
  const workers = await readWorkers()
  state.workers = workers
  return workers
}

function getHistory(limit = HISTORY_MAX_POINTS) {
  return state.history.slice(-limit)
}

function getTestHistory() {
  return state.testHistory
}

export const nodeMonitor = {
  startSampling,
  getStatus,
  getWorkers,
  getHistory,
  getTestHistory,
  runOneShotTest,
  snapshot,
}
