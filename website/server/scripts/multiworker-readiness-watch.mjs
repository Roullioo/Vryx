#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import mysql from 'mysql2/promise'

const rootDir = process.env.VRYX_ROOT_DIR || '/var/www/vryx'
const reportPath = process.env.VRYX_MULTIWORKER_REPORT || '/var/log/vryx/multiworker-readiness.json'
const statePath = process.env.VRYX_MULTIWORKER_STATE || '/var/lib/vryx/multiworker-readiness-state.json'
const staleSeconds = Number(process.env.VRYX_MULTIWORKER_STALE_SEC || 90)
const cooldownSeconds = Number(process.env.VRYX_MULTIWORKER_COOLDOWN_SEC || 1800)
const targetModel = process.env.VRYX_MULTIWORKER_MODEL || 'gemma4:31b'
const targetTps = process.env.VRYX_MULTIWORKER_TARGET_TPS || '10'
const directProbeTimeoutMs = Number(process.env.VRYX_DIRECT_PROBE_TIMEOUT_MS || 2500)
const peers = (process.env.VRYX_MULTIWORKER_PEERS ||
  '12D3KooWJGeDM978MnTrHkLACeFPx5rtgbfXtrEarnzLZBHeuyPU,12D3KooWJVrRnttUnFfr4ZVcc8RwRxw9iBA75tPLknFP15Gmbbh5')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

function dbConfig() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`)
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('close', (code) => {
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        elapsedMs: Date.now() - startedAt,
      })
    })
  })
}

function parseBench(stdout) {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const parsed = lines
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return {
    runs: parsed.filter((item) => item.tokens_requested).length,
    summary: parsed.find((item) => Object.prototype.hasOwnProperty.call(item, 'target_reached')) || null,
    rawTail: lines.slice(-8),
  }
}

function probeTcp(host, port, timeoutMs = directProbeTimeoutMs) {
  return new Promise((resolve) => {
    if (!host || !port) {
      resolve({ ok: false, error: 'missing_host_or_port' })
      return
    }
    const startedAt = Date.now()
    const socket = net.createConnection({ host, port })
    let settled = false
    const done = (ok, error = null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, port, rttMs: Date.now() - startedAt, error })
    }
    socket.setTimeout(timeoutMs, () => done(false, 'timeout'))
    socket.once('connect', () => done(true))
    socket.once('error', (err) => done(false, err?.code || err?.message || 'error'))
  })
}

async function main() {
  const conn = await mysql.createConnection(dbConfig())
  try {
    const [rows] = await conn.query(
      `SELECT w.peer_id, w.mode, w.public_ip, w.model, w.desired_model,
              w.runtime_backend, w.gpu_name, w.gpu_vram_mb, w.allocated_vram_mb,
              w.memory_limit_percent, w.desired_state, w.last_command_status,
              w.last_heartbeat_at,
              TIMESTAMPDIFF(SECOND, w.last_heartbeat_at, NOW()) AS stale_sec,
              u.email
       FROM workers w
       LEFT JOIN users u ON u.id = w.user_id
       WHERE w.peer_id IN (?)
       ORDER BY FIELD(w.peer_id, ?)`,
      [peers, peers],
    )

    const workers = await Promise.all(rows.map(async (row) => {
      const tcpDirect = await probeTcp(row.public_ip, 4021)
      return {
        peerId: row.peer_id,
        email: row.email || null,
        mode: row.mode,
        publicIp: row.public_ip,
        model: row.model,
        desiredModel: row.desired_model,
        runtimeBackend: row.runtime_backend,
        gpuName: row.gpu_name,
        gpuVramMb: row.gpu_vram_mb,
        allocatedVramMb: row.allocated_vram_mb,
        memoryLimitPercent: row.memory_limit_percent,
        desiredState: row.desired_state,
        lastCommandStatus: row.last_command_status,
        lastHeartbeatAt: row.last_heartbeat_at,
        staleSec: Number(row.stale_sec ?? 999999),
        online: Number(row.stale_sec ?? 999999) <= staleSeconds,
        modelReady: row.model === targetModel,
        network: {
          directTcp4021: tcpDirect,
          directReady: Boolean(tcpDirect.ok),
          routeMode: tcpDirect.ok ? 'direct_tcp' : 'relay_required',
        },
      }
    }))

    const missingPeers = peers.filter((peer) => !workers.some((worker) => worker.peerId === peer))
    const allOnline = missingPeers.length === 0 && workers.every((worker) => worker.online)
    const allModelReady = allOnline && workers.every((worker) => worker.modelReady)
    const state = await readJson(statePath, {})
    const now = new Date()
    const lastBenchAt = state.lastBenchAt ? Date.parse(state.lastBenchAt) : 0
    const cooldownOk = !lastBenchAt || Date.now() - lastBenchAt >= cooldownSeconds * 1000

    let bench = null
    if (allOnline && cooldownOk) {
      const benchResult = await run('python3', ['nodeAndWorker/scripts/bench_vps_chat_tps.py'], {
        cwd: rootDir,
        env: {
          ...process.env,
          VRYX_BENCH_MODEL: targetModel,
          VRYX_BENCH_POOL: 'auto',
          VRYX_BENCH_QUANT: 'q4',
          VRYX_BENCH_LOAD_MODE: 'shard',
          VRYX_BENCH_FORCE_DISTRIBUTED: '1',
          VRYX_BENCH_MIN_COMPUTE_WORKERS: '2',
          VRYX_DISABLE_MLX_LM_DIRECT: '1',
          VRYX_BENCH_TARGET_TPS: targetTps,
          VRYX_BENCH_TOKENS: process.env.VRYX_MULTIWORKER_BENCH_TOKENS || '128,256',
          VRYX_BENCH_PROMPT:
            process.env.VRYX_MULTIWORKER_PROMPT ||
            'Écris une longue liste de mots français simples séparés par des virgules. Ne conclus pas.',
        },
      })
      bench = {
        ok: benchResult.code === 0,
        code: benchResult.code,
        elapsedMs: benchResult.elapsedMs,
        stderr: benchResult.stderr,
        ...parseBench(benchResult.stdout),
      }
      await writeJson(statePath, {
        lastBenchAt: now.toISOString(),
        lastBenchOk: bench.ok,
        lastBenchSummary: bench.summary,
      })
    }

    const report = {
      ok: allOnline && Boolean(bench?.ok ?? true),
      generatedAt: now.toISOString(),
      targetModel,
      targetTps: Number(targetTps),
      staleSeconds,
      cooldownSeconds,
      allOnline,
      allModelReady,
      missingPeers,
      workers,
      benchSkippedReason: allOnline ? (cooldownOk ? null : 'cooldown') : 'workers_offline',
      bench,
    }
    await writeJson(reportPath, report)
    console.log(JSON.stringify(report, null, 2))
    return process.env.VRYX_MULTIWORKER_STRICT_EXIT === '1' && !allOnline ? 2 : 0
  } finally {
    await conn.end()
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error)
  process.exit(1)
})
