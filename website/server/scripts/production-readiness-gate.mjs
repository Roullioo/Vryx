#!/usr/bin/env node
import mysql from 'mysql2/promise'
import { summarizeInferenceRows } from '../src/inference-metrics.js'
import { scoreProductionReadiness } from '../src/production-readiness.js'

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

function parseJson(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const minScore = Number(process.env.VRYX_PROD_READINESS_MIN_SCORE || 80)
const hours = Number(process.env.VRYX_PROD_READINESS_HOURS || 24)
const goldenModels = String(process.env.VRYX_GOLDEN_PATH_MODELS || 'gemma4:31b,qwen/qwen3.6-35b-a3b,qwen3.6-35b')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

const conn = await mysql.createConnection(dbConfig())
try {
  const [workers] = await conn.query(
    `SELECT peer_id AS peerId, model, desired_model AS desiredModel, runtime_backend AS runtimeBackend,
            weight_quantization AS weightQuantization, supports_q4_weights AS supportsQ4Weights,
            capabilities_json AS capabilitiesJson, machine_info AS machineInfo,
            TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
     FROM workers
     WHERE mode = 'worker'
     ORDER BY last_heartbeat_at DESC
     LIMIT 200`,
  )
  const [requests] = await conn.query(
    `SELECT status, model, runtime, worker_id AS workerId, ttft_ms AS ttftMs,
            decode_tps AS decodeTps, latency_ms AS latencyMs, total_duration_ms AS totalDurationMs,
            prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
            total_tokens AS totalTokens, cost_eur AS costEur, error
     FROM inference_request_logs
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY created_at DESC
     LIMIT 5000`,
    [hours],
  )
  const [benchmarks] = await conn.query(
    `SELECT model, status, tps, ttft_ms AS ttftMs, latency_ms AS latencyMs, worker_count AS workerCount, created_at AS createdAt
     FROM worker_benchmark_runs
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY created_at DESC
     LIMIT 500`,
    [hours],
  )
  const readiness = scoreProductionReadiness({
    workers: workers.map((row) => ({
      ...row,
      supportsQ4Weights: Boolean(row.supportsQ4Weights),
      capabilitiesJson: parseJson(row.capabilitiesJson),
      machineInfo: parseJson(row.machineInfo),
    })),
    inferenceRows: requests,
    inferenceSummary: summarizeInferenceRows(requests),
    benchmarkRows: benchmarks,
    goldenModels,
  })
  console.log(JSON.stringify({ ok: readiness.score >= minScore, minScore, hours, readiness }, null, 2))
  process.exit(readiness.score >= minScore ? 0 : 2)
} finally {
  await conn.end()
}
