#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import mysql from 'mysql2/promise'

const rootDir = process.env.VRYX_ROOT_DIR || '/var/www/vryx'
const model = process.env.VRYX_GOLDEN_BENCH_MODEL || 'gemma4:31b'
const quant = process.env.VRYX_GOLDEN_BENCH_QUANT || 'q4'
const poolPreference = process.env.VRYX_GOLDEN_BENCH_POOL || 'auto'
const targetTps = Number(process.env.VRYX_GOLDEN_BENCH_TARGET_TPS || 10)
const tokenCounts = process.env.VRYX_GOLDEN_BENCH_TOKENS || '128,256'
const prompt =
  process.env.VRYX_GOLDEN_BENCH_PROMPT ||
  'Écris une longue liste de mots français simples séparés par des virgules. Ne conclus pas. Continue jusqu’à atteindre la limite de génération.'

function dbConfig() {
  if (process.env.DATABASE_URL) return { uri: process.env.DATABASE_URL, namedPlaceholders: true }
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    namedPlaceholders: true,
  }
}

function runBench() {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn('python3', ['nodeAndWorker/scripts/bench_vps_chat_tps.py'], {
      cwd: rootDir,
      env: {
        ...process.env,
        VRYX_BENCH_MODEL: model,
        VRYX_BENCH_QUANT: quant,
        VRYX_BENCH_POOL: poolPreference,
        VRYX_BENCH_TARGET_TPS: String(targetTps),
        VRYX_BENCH_TOKENS: tokenCounts,
        VRYX_BENCH_PROMPT: prompt,
      },
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
    child.on('close', (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt }))
  })
}

function parseOutput(stdout) {
  const parsed = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return {
    runs: parsed.filter((item) => item.tokens_requested),
    summary: parsed.find((item) => Object.prototype.hasOwnProperty.call(item, 'target_reached')) || null,
    raw: parsed,
  }
}

async function insertBenchmark(conn, bench, parsed) {
  const summary = parsed.summary || {}
  const bestRun = parsed.runs
    .slice()
    .sort((a, b) => Number(b.decode_tps || b.tps_wall || 0) - Number(a.decode_tps || a.tps_wall || 0))[0]
  const status = bench.code === 0 && summary.ok !== false && Number(summary.empty_responses || 0) === 0 ? 'ok' : 'failed'
  const tps = Number(summary.median_decode_tps || summary.best_decode_tps || bestRun?.decode_tps || bestRun?.tps_wall || 0)
  const latencyMs = Number(bestRun?.client_wall_ms || bestRun?.server_latency_ms || bench.elapsedMs || 0)
  const ttftMs = Number(bestRun?.ttft_ms || 0)
  const promptTokens = Number(bestRun?.prompt_tokens || 0)
  const completionTokens = Number(bestRun?.completion_tokens || 0)
  const totalTokens = promptTokens + completionTokens
  const error =
    status === 'ok'
      ? null
      : (bench.stderr || `Benchmark failed code=${bench.code} empty=${summary.empty_responses || 0}`).slice(0, 500)
  await conn.query(
    `INSERT INTO worker_benchmark_runs
       (job_id, model, mode, status, worker_count, latency_ms, ttft_ms, tps,
        prompt_tokens, completion_tokens, total_tokens, cost_per_million_eur, plan_json, error)
     VALUES
       (:jobId, :model, :mode, :status, :workerCount, :latencyMs, :ttftMs, :tps,
        :promptTokens, :completionTokens, :totalTokens, :costPerMillion, :plan, :error)`,
    {
      jobId: `golden-${Date.now().toString(36)}`,
      model,
      mode: poolPreference,
      status,
      workerCount: Number(bestRun?.worker_count || 1),
      latencyMs,
      ttftMs,
      tps,
      promptTokens,
      completionTokens,
      totalTokens,
      costPerMillion: Number(process.env.VRYX_EUR_PER_MILLION || 0.3),
      plan: JSON.stringify({
        type: 'golden_path_cron',
        quant,
        tokenCounts,
        targetTps,
        summary,
        runs: parsed.runs,
      }),
      error,
    },
  )
}

const bench = await runBench()
const parsed = parseOutput(bench.stdout)
const conn = await mysql.createConnection(dbConfig())
try {
  await insertBenchmark(conn, bench, parsed)
} finally {
  await conn.end()
}

console.log(JSON.stringify({
  ok: bench.code === 0,
  code: bench.code,
  model,
  quant,
  targetTps,
  elapsedMs: bench.elapsedMs,
  summary: parsed.summary,
  runs: parsed.runs.length,
  stderr: bench.stderr.trim(),
}, null, 2))

process.exit(bench.code === 0 ? 0 : 2)
