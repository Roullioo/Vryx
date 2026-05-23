import { summarizeInferenceRows } from './inference-metrics.js'
import { scoreProductionReadiness } from './production-readiness.js'
import { getJsonCache, setJsonCache } from './cache.js'

function parseMaybeJsonObject(value) {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function percentile(values, p) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  if (clean.length === 0) return 0
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1))
  return clean[index]
}

export function registerAdminInferenceRoutes(adminRouter, { pool }) {
  adminRouter.get('/inference/recent', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 80))
      const [rows] = await pool.query(
        `SELECT request_id AS requestId, user_id AS userId, source, status, model, quantization,
                runtime, worker_id AS workerId, ttft_ms AS ttftMs, decode_tps AS decodeTps,
                latency_ms AS latencyMs, total_duration_ms AS totalDurationMs,
                prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
                total_tokens AS totalTokens, cost_eur AS costEur, error, created_at AS createdAt
         FROM inference_request_logs
         ORDER BY created_at DESC
         LIMIT :limit`,
        { limit },
      )
      res.json({ ok: true, requests: rows })
    } catch (e) {
      console.error('admin/inference/recent', e)
      res.status(500).json({ ok: false, error: 'Erreur lecture requêtes inference.' })
    }
  })

  adminRouter.get('/inference/summary', async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 24))
      const [rows] = await pool.query(
        `SELECT status, model, runtime, worker_id AS workerId, ttft_ms AS ttftMs,
                decode_tps AS decodeTps, latency_ms AS latencyMs, total_duration_ms AS totalDurationMs,
                prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
                total_tokens AS totalTokens, cost_eur AS costEur
         FROM inference_request_logs
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL :hours HOUR)
         ORDER BY created_at DESC
         LIMIT 5000`,
        { hours },
      )
      const byModel = new Map()
      for (const row of rows) {
        const key = row.model || 'unknown'
        if (!byModel.has(key)) byModel.set(key, [])
        byModel.get(key).push(row)
      }
      res.json({
        ok: true,
        windowHours: hours,
        summary: summarizeInferenceRows(rows),
        models: Array.from(byModel.entries()).map(([model, modelRows]) => ({
          model,
          ...summarizeInferenceRows(modelRows),
        })),
      })
    } catch (e) {
      console.error('admin/inference/summary', e)
      res.status(500).json({ ok: false, error: 'Erreur synthèse inference.' })
    }
  })

  adminRouter.get('/production-readiness', async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 24))
      const goldenModels = String(req.query.models || process.env.VRYX_GOLDEN_PATH_MODELS || 'gemma4:31b,qwen/qwen3.6-35b-a3b,qwen3.6-35b')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      const minDecodeTps = Math.max(1, Math.min(200, Number(req.query.min_tps || process.env.VRYX_GOLDEN_MIN_TPS) || 10))
      const maxTtftP95Ms = Math.max(500, Math.min(120_000, Number(req.query.max_ttft_p95_ms || process.env.VRYX_GOLDEN_MAX_TTFT_P95_MS) || 10_000))
      const cacheKey = `admin:production-readiness:v1:${hours}:${goldenModels.join(',')}:${minDecodeTps}:${maxTtftP95Ms}`
      const cached = await getJsonCache(cacheKey)
      if (cached) return res.json(cached)
      const [workerRows, inferenceRows, benchmarkRows] = await Promise.all([
        pool.query(
          `SELECT peer_id AS peerId, model, desired_model AS desiredModel, runtime_backend AS runtimeBackend,
                  weight_quantization AS weightQuantization, supports_q4_weights AS supportsQ4Weights,
                  capabilities_json AS capabilitiesJson, machine_info AS machineInfo,
                  TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
           FROM workers
           WHERE mode = 'worker'
           ORDER BY last_heartbeat_at DESC
           LIMIT 200`,
        ),
        pool.query(
          `SELECT status, model, runtime, worker_id AS workerId, ttft_ms AS ttftMs,
                  decode_tps AS decodeTps, latency_ms AS latencyMs, total_duration_ms AS totalDurationMs,
                  prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
                  total_tokens AS totalTokens, cost_eur AS costEur, error
           FROM inference_request_logs
           WHERE created_at >= DATE_SUB(NOW(), INTERVAL :hours HOUR)
           ORDER BY created_at DESC
           LIMIT 5000`,
          { hours },
        ),
        pool.query(
          `SELECT model, status, tps, ttft_ms AS ttftMs, latency_ms AS latencyMs, worker_count AS workerCount, created_at AS createdAt
           FROM worker_benchmark_runs
           WHERE created_at >= DATE_SUB(NOW(), INTERVAL :hours HOUR)
           ORDER BY created_at DESC
           LIMIT 500`,
          { hours },
        ),
      ])
      const workers = (workerRows[0] || []).map((row) => ({
        ...row,
        supportsQ4Weights: Boolean(row.supportsQ4Weights),
        capabilitiesJson: parseMaybeJsonObject(row.capabilitiesJson) || null,
        machineInfo: parseMaybeJsonObject(row.machineInfo) || null,
      }))
      const requests = inferenceRows[0] || []
      const readiness = scoreProductionReadiness({
        workers,
        inferenceRows: requests,
        inferenceSummary: summarizeInferenceRows(requests),
        benchmarkRows: benchmarkRows[0] || [],
        goldenModels,
        minDecodeTps,
        maxTtftP95Ms,
      })
      const payload = {
        ok: true,
        sampledAt: new Date().toISOString(),
        windowHours: hours,
        readiness,
      }
      await setJsonCache(cacheKey, payload, 10)
      res.json(payload)
    } catch (e) {
      console.error('admin/production-readiness', e)
      res.status(500).json({ ok: false, error: 'Erreur score production readiness.' })
    }
  })

  adminRouter.get('/production-readiness/evidence', async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 24))
      const goldenModels = String(req.query.models || process.env.VRYX_GOLDEN_PATH_MODELS || 'gemma4:31b,qwen/qwen3.6-35b-a3b,qwen3.6-35b')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      const minDecodeTps = Math.max(1, Math.min(200, Number(req.query.min_tps || process.env.VRYX_GOLDEN_MIN_TPS) || 10))
      const maxTtftP95Ms = Math.max(500, Math.min(120_000, Number(req.query.max_ttft_p95_ms || process.env.VRYX_GOLDEN_MAX_TTFT_P95_MS) || 10_000))
      const [workerRows, inferenceRows, benchmarkRows] = await Promise.all([
        pool.query(
          `SELECT peer_id AS peerId, model, desired_model AS desiredModel, runtime_backend AS runtimeBackend,
                  weight_quantization AS weightQuantization, supports_q4_weights AS supportsQ4Weights,
                  capabilities_json AS capabilitiesJson, machine_info AS machineInfo,
                  TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
           FROM workers
           WHERE mode = 'worker'
           ORDER BY last_heartbeat_at DESC
           LIMIT 200`,
        ),
        pool.query(
          `SELECT status, model, runtime, worker_id AS workerId, ttft_ms AS ttftMs,
                  decode_tps AS decodeTps, latency_ms AS latencyMs, total_duration_ms AS totalDurationMs,
                  prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
                  total_tokens AS totalTokens, cost_eur AS costEur, error, created_at AS createdAt
           FROM inference_request_logs
           WHERE created_at >= DATE_SUB(NOW(), INTERVAL :hours HOUR)
           ORDER BY created_at DESC
           LIMIT 5000`,
          { hours },
        ),
        pool.query(
          `SELECT model, mode, status, worker_count AS workerCount, latency_ms AS latencyMs,
                  ttft_ms AS ttftMs, tps, prompt_tokens AS promptTokens,
                  completion_tokens AS completionTokens, total_tokens AS totalTokens,
                  cost_per_million_eur AS costPerMillionEur, plan_json AS planJson,
                  error, created_at AS createdAt
           FROM worker_benchmark_runs
           WHERE created_at >= DATE_SUB(NOW(), INTERVAL :hours HOUR)
           ORDER BY created_at DESC
           LIMIT 500`,
          { hours },
        ),
      ])
      const workers = (workerRows[0] || []).map((row) => ({
        ...row,
        supportsQ4Weights: Boolean(row.supportsQ4Weights),
        capabilitiesJson: parseMaybeJsonObject(row.capabilitiesJson) || null,
        machineInfo: parseMaybeJsonObject(row.machineInfo) || null,
      }))
      const requests = inferenceRows[0] || []
      const benchmarks = benchmarkRows[0] || []
      const readiness = scoreProductionReadiness({
        workers,
        inferenceRows: requests,
        inferenceSummary: summarizeInferenceRows(requests),
        benchmarkRows: benchmarks,
        goldenModels,
        minDecodeTps,
        maxTtftP95Ms,
      })
      const okBenchmarks = benchmarks.filter((row) => String(row.status || '') === 'ok' && toNumber(row.tps) > 0)
      const tpsValues = okBenchmarks.map((row) => toNumber(row.tps)).filter((value) => value > 0)
      const ttftValues = okBenchmarks.map((row) => toNumber(row.ttftMs)).filter((value) => value > 0)
      const latencyValues = okBenchmarks.map((row) => toNumber(row.latencyMs)).filter((value) => value > 0)
      const costs = [
        ...benchmarks.map((row) => toNumber(row.costPerMillionEur)).filter((value) => value > 0),
        ...requests.map((row) => toNumber(row.totalTokens) > 0 ? (toNumber(row.costEur) / toNumber(row.totalTokens)) * 1_000_000 : 0).filter((value) => value > 0),
      ]
      const latestBenchmark = benchmarks[0] || null
      const proof100 = benchmarks.find((row) => {
        const plan = parseMaybeJsonObject(row.planJson) || {}
        const metrics = plan.verdict?.metrics || {}
        return (
          String(row.status || '') === 'ok' &&
          toNumber(metrics.requestCount) >= 100 &&
          toNumber(metrics.successRate) >= 99 &&
          toNumber(metrics.emptyResponses) === 0
        )
      }) || null
      const acceptance = {
        success99On100: {
          target: '99% success over 100 golden-path requests',
          pass: Boolean(proof100) || (readiness.metrics.requestCount >= 100 && readiness.metrics.successRate >= 99),
          current: proof100 ? 'benchmark_proof_100' : `${readiness.metrics.successRate}% over ${readiness.metrics.requestCount} samples`,
        },
        zeroEmptyResponses: {
          target: '0 empty responses',
          pass: readiness.metrics.recentEmptyResponses === 0 && readiness.metrics.requestCount > 0,
          current: readiness.metrics.recentEmptyResponses,
        },
        tpsKnown: {
          target: `p50 >= ${minDecodeTps} TPS and p95 known`,
          pass: readiness.metrics.tpsP50 >= minDecodeTps && tpsValues.length > 0,
          current: { p50: readiness.metrics.tpsP50, p95: Number(percentile(tpsValues, 95).toFixed(3)) },
        },
        ttftKnown: {
          target: `p95 <= ${maxTtftP95Ms} ms`,
          pass: readiness.metrics.ttftP95 > 0 && readiness.metrics.ttftP95 <= maxTtftP95Ms,
          current: readiness.metrics.ttftP95,
        },
        costKnown: {
          target: 'estimated EUR per million tokens available',
          pass: costs.length > 0,
          current: costs.length ? Number(percentile(costs, 50).toFixed(6)) : null,
        },
        goldenWorkersLive: {
          target: 'at least 2 live golden-path workers',
          pass: readiness.goldenPath.liveWorkers >= 2,
          current: readiness.goldenPath.liveWorkers,
        },
      }
      const payload = {
        ok: true,
        kind: 'vryx_investor_readiness_evidence',
        generatedAt: new Date().toISOString(),
        windowHours: hours,
        goldenPath: {
          models: goldenModels,
          minDecodeTps,
          maxTtftP95Ms,
          latestBenchmark: latestBenchmark
            ? {
                model: latestBenchmark.model,
                status: latestBenchmark.status,
                workerCount: toNumber(latestBenchmark.workerCount),
                tps: toNumber(latestBenchmark.tps),
                ttftMs: toNumber(latestBenchmark.ttftMs),
                latencyMs: toNumber(latestBenchmark.latencyMs),
                costPerMillionEur: toNumber(latestBenchmark.costPerMillionEur) || null,
                createdAt: latestBenchmark.createdAt,
                error: latestBenchmark.error ? String(latestBenchmark.error).slice(0, 500) : null,
              }
            : null,
          proof100: proof100 ? { model: proof100.model, createdAt: proof100.createdAt } : null,
        },
        readiness,
        acceptance,
        metrics: {
          requests: summarizeInferenceRows(requests),
          benchmarks: {
            runs: benchmarks.length,
            ok: okBenchmarks.length,
            tpsP50: Number(percentile(tpsValues, 50).toFixed(3)),
            tpsP95: Number(percentile(tpsValues, 95).toFixed(3)),
            ttftP95Ms: percentile(ttftValues, 95),
            latencyP95Ms: percentile(latencyValues, 95),
            costPerMillionEurP50: costs.length ? Number(percentile(costs, 50).toFixed(6)) : null,
          },
        },
        evidence: {
          adminDashboard: '/admin/production-readiness',
          publicGoldenPath: `/api/public/golden-path-status?hours=${hours}`,
          publicBenchmarks: '/api/public/benchmarks',
          downloadableJson: `/api/admin/production-readiness/evidence?hours=${hours}&download=1`,
        },
      }
      if (req.query.download === '1') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        res.setHeader('Content-Disposition', `attachment; filename="vryx-investor-readiness-${stamp}.json"`)
      }
      res.json(payload)
    } catch (e) {
      console.error('admin/production-readiness/evidence', e)
      res.status(500).json({ ok: false, error: 'Erreur génération evidence readiness.' })
    }
  })
}
