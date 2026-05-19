#!/usr/bin/env node
import mysql from 'mysql2/promise'

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

const staleSec = Number(process.env.VRYX_MULTIWORKER_GATE_STALE_SEC || 45)
const minWorkers = Number(process.env.VRYX_MULTIWORKER_GATE_MIN_WORKERS || 2)
const minTps = Number(process.env.VRYX_MULTIWORKER_GATE_MIN_TPS || 10)
const hours = Number(process.env.VRYX_MULTIWORKER_GATE_HOURS || 24)
const modelNeedle = String(process.env.VRYX_MULTIWORKER_GATE_MODEL || 'gemma4:31b').toLowerCase()

const conn = await mysql.createConnection(dbConfig())
try {
  const [workers] = await conn.query(
    `SELECT peer_id AS peerId, model, desired_model AS desiredModel, runtime_backend AS runtimeBackend,
            weight_quantization AS weightQuantization,
            TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
     FROM workers
     WHERE mode = 'worker'
       AND TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) <= ?
       AND LOWER(COALESCE(model, desired_model, '')) LIKE ?
     ORDER BY last_heartbeat_at DESC`,
    [staleSec, `%${modelNeedle}%`],
  )
  const [benchmarks] = await conn.query(
    `SELECT model, status, worker_count AS workerCount, tps, ttft_ms AS ttftMs,
            latency_ms AS latencyMs, error, created_at AS createdAt
     FROM worker_benchmark_runs
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND worker_count >= ?
       AND status = 'ok'
       AND tps >= ?
     ORDER BY created_at DESC
     LIMIT 5`,
    [hours, minWorkers, minTps],
  )
  const ok = workers.length >= minWorkers && benchmarks.length > 0
  const result = {
    ok,
    required: { minWorkers, minTps, hours, staleSec, modelNeedle },
    liveWorkers: workers.length,
    validBenchmarks: benchmarks.length,
    workers,
    latestBenchmark: benchmarks[0] || null,
    blocker: ok
      ? null
      : workers.length < minWorkers
        ? `Need ${minWorkers} live workers for ${modelNeedle}; got ${workers.length}.`
        : `Need a recent multi-worker benchmark >= ${minTps} TPS.`,
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(ok ? 0 : 2)
} finally {
  await conn.end()
}
