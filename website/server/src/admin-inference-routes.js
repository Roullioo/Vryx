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
}
