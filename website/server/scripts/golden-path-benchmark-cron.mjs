#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

const rootDir = process.env.VRYX_ROOT_DIR || '/var/www/vryx'
const model = process.env.VRYX_GOLDEN_BENCH_MODEL || 'gemma4:31b'
const quant = process.env.VRYX_GOLDEN_BENCH_QUANT || 'q4'
const poolPreference = process.env.VRYX_GOLDEN_BENCH_POOL || 'auto'
const targetTps = Number(process.env.VRYX_GOLDEN_BENCH_TARGET_TPS || 10)
const baseTokenCounts = parseTokenCounts(process.env.VRYX_GOLDEN_BENCH_TOKENS || '128,256')
const repeat = Math.max(1, Math.floor(Number(process.env.VRYX_GOLDEN_BENCH_REPEAT || 1)))
const expandedTokenCounts = Array.from({ length: repeat }, () => baseTokenCounts).flat()
const tokenCounts = expandedTokenCounts.join(',')
const requestedRuns = expandedTokenCounts.length
const artifactDir = process.env.VRYX_GOLDEN_BENCH_ARTIFACT_DIR || path.join(rootDir, 'var', 'golden-path')
const thresholds = {
  minRequests: Math.max(1, Math.floor(Number(process.env.VRYX_GOLDEN_BENCH_MIN_REQUESTS || 2))),
  minSuccessRate: Math.max(0, Math.min(100, Number(process.env.VRYX_GOLDEN_BENCH_MIN_SUCCESS_RATE || 99))),
  maxEmptyResponses: Math.max(0, Math.floor(Number(process.env.VRYX_GOLDEN_BENCH_MAX_EMPTY_RESPONSES || 0))),
  minTpsP50: Math.max(0, Number(process.env.VRYX_GOLDEN_BENCH_MIN_TPS_P50 || targetTps)),
  maxTtftP95Ms: Math.max(1, Number(process.env.VRYX_GOLDEN_BENCH_MAX_TTFT_P95_MS || 10_000)),
}
const prompt =
  process.env.VRYX_GOLDEN_BENCH_PROMPT ||
  'Écris une longue liste de mots français simples séparés par des virgules. Ne conclus pas. Continue jusqu’à atteindre la limite de génération.'

function parseTokenCounts(raw) {
  const counts = String(raw || '')
    .replace(/;/g, ',')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value))
  return counts.length > 0 ? counts : [128, 256]
}

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

function percentile(values, p) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  if (clean.length === 0) return 0
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1))
  return clean[index]
}

function evaluateGoldenPath(bench, parsed) {
  const runs = parsed.runs || []
  const summary = parsed.summary || {}
  const failedRuns = runs.filter((run) => run.ok === false || run.error || Number(run.empty_response || 0) > 0)
  const summaryEmpty = Number(summary.empty_responses || 0)
  const emptyResponses =
    Number.isFinite(summaryEmpty) && summaryEmpty > 0
      ? summaryEmpty
      : runs.filter((run) => {
          const completionTokens = Number(run.completion_tokens || run.tokens_generated || 0)
          const textLength = Number(run.response_chars || run.text_chars || 0)
          return completionTokens <= 0 && textLength <= 0
        }).length
  const successCount = Math.max(0, runs.length - failedRuns.length - emptyResponses)
  const successRate = runs.length > 0 ? (successCount / runs.length) * 100 : 0
  const tpsValues = runs
    .map((run) => Number(run.decode_tps || run.tps_wall || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
  const ttftValues = runs
    .map((run) => Number(run.ttft_ms || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
  const metrics = {
    requestCount: runs.length,
    successCount,
    failedRuns: failedRuns.length,
    emptyResponses,
    successRate,
    tpsP50: Number(summary.median_decode_tps || percentile(tpsValues, 50) || 0),
    tpsP95: Number(summary.p95_decode_tps || percentile(tpsValues, 95) || 0),
    ttftP50Ms: Number(summary.ttft_p50_ms || percentile(ttftValues, 50) || 0),
    ttftP95Ms: Number(summary.ttft_p95_ms || percentile(ttftValues, 95) || 0),
  }
  const failures = []
  if (bench.code !== 0) failures.push(`bench_exit_code=${bench.code}`)
  if (metrics.requestCount < thresholds.minRequests) failures.push(`requests ${metrics.requestCount} < ${thresholds.minRequests}`)
  if (metrics.successRate < thresholds.minSuccessRate) failures.push(`success_rate ${metrics.successRate.toFixed(2)} < ${thresholds.minSuccessRate}`)
  if (metrics.emptyResponses > thresholds.maxEmptyResponses) failures.push(`empty_responses ${metrics.emptyResponses} > ${thresholds.maxEmptyResponses}`)
  if (metrics.tpsP50 < thresholds.minTpsP50) failures.push(`tps_p50 ${metrics.tpsP50.toFixed(2)} < ${thresholds.minTpsP50}`)
  if (metrics.ttftP95Ms > thresholds.maxTtftP95Ms) failures.push(`ttft_p95_ms ${metrics.ttftP95Ms.toFixed(0)} > ${thresholds.maxTtftP95Ms}`)
  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? 'ok' : 'failed',
    failures,
    metrics,
    thresholds,
  }
}

async function writeArtifact(bench, parsed, verdict) {
  await fs.mkdir(artifactDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `golden-path-${stamp}.json`
  const artifactPath = path.join(artifactDir, fileName)
  const artifact = {
    ok: verdict.ok,
    sampledAt: new Date().toISOString(),
    model,
    quant,
    poolPreference,
    targetTps,
    baseTokenCounts,
    repeat,
    tokenCounts,
    requestedRuns,
    elapsedMs: bench.elapsedMs,
    metrics: verdict.metrics,
    thresholds: verdict.thresholds,
    failures: verdict.failures,
    summary: parsed.summary,
    runs: parsed.runs,
    stderr: bench.stderr.trim(),
  }
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  await fs.writeFile(path.join(artifactDir, 'latest.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  return artifactPath
}

async function insertBenchmark(conn, bench, parsed, verdict, artifactPath) {
  const summary = parsed.summary || {}
  const bestRun = parsed.runs
    .slice()
    .sort((a, b) => Number(b.decode_tps || b.tps_wall || 0) - Number(a.decode_tps || a.tps_wall || 0))[0]
  const status = verdict.status
  const tps = Number(verdict.metrics.tpsP50 || summary.median_decode_tps || summary.best_decode_tps || bestRun?.decode_tps || bestRun?.tps_wall || 0)
  const latencyMs = Number(bestRun?.client_wall_ms || bestRun?.server_latency_ms || bench.elapsedMs || 0)
  const ttftMs = Number(verdict.metrics.ttftP95Ms || bestRun?.ttft_ms || 0)
  const promptTokens = Number(bestRun?.prompt_tokens || 0)
  const completionTokens = Number(bestRun?.completion_tokens || 0)
  const totalTokens = promptTokens + completionTokens
  const error =
    status === 'ok'
      ? null
      : (bench.stderr || verdict.failures.join('; ') || `Benchmark failed code=${bench.code}`).slice(0, 500)
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
        baseTokenCounts,
        repeat,
        tokenCounts,
        requestedRuns,
        targetTps,
        artifactPath,
        verdict,
        summary,
        runs: parsed.runs,
      }),
      error,
    },
  )
}

const bench = await runBench()
const parsed = parseOutput(bench.stdout)
const verdict = evaluateGoldenPath(bench, parsed)
const artifactPath = await writeArtifact(bench, parsed, verdict)
const conn = await mysql.createConnection(dbConfig())
try {
  await insertBenchmark(conn, bench, parsed, verdict, artifactPath)
} finally {
  await conn.end()
}

console.log(JSON.stringify({
  ok: verdict.ok,
  code: bench.code,
  model,
  quant,
  targetTps,
  baseTokenCounts,
  repeat,
  requestedRuns,
  elapsedMs: bench.elapsedMs,
  artifactPath,
  metrics: verdict.metrics,
  thresholds: verdict.thresholds,
  failures: verdict.failures,
  summary: parsed.summary,
  runs: parsed.runs.length,
  stderr: bench.stderr.trim(),
}, null, 2))

process.exit(verdict.ok ? 0 : 2)
