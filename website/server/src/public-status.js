import crypto from 'node:crypto'
import { summarizeInferenceRows } from './inference-metrics.js'
import { scoreProductionReadiness } from './production-readiness.js'
import { getJsonCache, setJsonCache } from './cache.js'

function toIsoDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
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

function parseJsonSafe(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function shortPeer(peerId) {
  const value = String(peerId || '')
  if (value.length <= 14) return value
  return `${value.slice(0, 10)}...${value.slice(-4)}`
}

function publicWorkerId(peerId, index = 0) {
  const raw = String(peerId || `anonymous-${index}`)
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10)
  return `wrk_${hash}`
}

function publicBenchmarkError(error) {
  if (!error) return null
  return 'Benchmark golden path échoué. Détails complets réservés à l’admin.'
}

function publicMetric(value, { exposeExact = false, bucket = 1000 } = {}) {
  const n = Number(value) || 0
  if (exposeExact || n <= 0) return n
  const step = Math.max(1, Number(bucket) || 1000)
  return Math.round(n / step) * step
}

function gpuClass(gpuName, runtimeBackend) {
  const value = `${gpuName || ''} ${runtimeBackend || ''}`.toLowerCase()
  if (value.includes('apple') || value.includes('mlx')) return 'Apple Silicon'
  if (value.includes('nvidia') || value.includes('rtx') || value.includes('geforce') || value.includes('cuda')) return 'NVIDIA GPU'
  if (value.includes('amd') || value.includes('radeon')) return 'AMD GPU'
  if (gpuName) return 'GPU worker'
  return 'Hardware non declare'
}

function memoryTier(gb) {
  const value = Number(gb || 0)
  if (!Number.isFinite(value) || value <= 0) return 'unknown'
  if (value < 16) return '<16GB'
  if (value < 32) return '16-32GB'
  if (value < 64) return '32-64GB'
  if (value < 96) return '64-96GB'
  return '96GB+'
}

function sessionMetrics(row) {
  const json = parseJsonSafe(row.sessionJson)
  const metrics = json?.metrics && typeof json.metrics === 'object' ? json.metrics : {}
  const completionTokens = toNumber(
    json?.completionTokens ?? json?.completion_tokens ?? metrics?.completionTokens ?? metrics?.completion_tokens,
    0,
  )
  const promptTokens = toNumber(json?.promptTokens ?? json?.prompt_tokens ?? metrics?.promptTokens ?? metrics?.prompt_tokens, 0)
  const latencyMs = toNumber(
    json?.latencyMs ??
      json?.computeTimeMs ??
      json?.workerComputeMs ??
      metrics?.latencyMs ??
      metrics?.latency_ms ??
      row.latencyMs,
    0,
  )
  const ttftMs = toNumber(
    json?.ttftMs ??
      json?.timeToFirstTokenMs ??
      json?.pipelineTrace?.benchmark?.ttft_ms ??
      json?.pipeline_trace?.benchmark?.ttft_ms,
    0,
  )
  const pingMs = toNumber(json?.pingMs ?? json?.pipelineTrace?.ping_ms ?? metrics?.pingMs, 0)
  const rawTps = toNumber(
    json?.hotPathTps ??
      json?.tps ??
      json?.pipelineTrace?.benchmark?.actual_tps ??
      json?.pipeline_trace?.benchmark?.actual_tps,
    0,
  )
  const derivedTps = completionTokens > 0 && latencyMs > 0 ? (completionTokens * 1000) / latencyMs : 0
  return {
    model: json?.model || json?.modelId || json?.pipelineTrace?.model_id || null,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    latencyMs,
    ttftMs,
    pingMs,
    tps: rawTps > 0 ? rawTps : derivedTps,
    createdAt: toIsoDate(row.createdAt),
  }
}

export function registerPublicStatusRoutes(app, options) {
  const {
    pool,
    discoverAvailableModels,
    workerLiveSec,
    workerOfflineSec,
    eurPerMillion,
    grossMarginPercent,
    workerRewardSharePercent,
    getPricingConfig,
  } = options

  app.get('/api/public/network-status', async (req, res) => {
    try {
      const requestedModel = typeof req.query.model === 'string' ? req.query.model.trim().toLowerCase() : ''
      const exposeWorkerDetails = process.env.VRYX_PUBLIC_EXPOSE_WORKER_DETAILS === '1'
      const exposeBusinessMetrics = process.env.VRYX_PUBLIC_EXPOSE_BUSINESS_METRICS === '1'
      const cacheKey = `public:network-status:v1:${requestedModel || 'all'}:${exposeWorkerDetails ? 'details' : 'redacted'}:${exposeBusinessMetrics ? 'business' : 'safe'}`
      const cached = await getJsonCache(cacheKey)
      if (cached) return res.json(cached)
      const [workerRows, ledgerRows, sessionRows, apiRows, models] = await Promise.all([
        pool.query(
          `SELECT peer_id AS peerId, mode, model, gpu_name AS gpuName,
                  gpu_vram_mb AS gpuVramMb, allocated_vram_mb AS allocatedVramMb,
                  memory_limit_percent AS memoryLimitPercent, runtime_backend AS runtimeBackend,
                  weight_quantization AS weightQuantization, supports_q4_weights AS supportsQ4Weights,
                  supports_mlx AS supportsMlx, supports_vllm AS supportsVllm,
                  tokens_generated AS tokensGenerated, tokens_in AS tokensIn, tokens_out AS tokensOut,
                  p2p_peers AS p2pPeers, last_heartbeat_at AS lastHeartbeatAt,
                  first_seen_at AS firstSeenAt,
                  TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
           FROM workers
           WHERE mode = 'worker'
           ORDER BY last_heartbeat_at DESC
           LIMIT 120`,
        ),
        pool.query(
          `SELECT
             COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR) THEN delta_tokens ELSE 0 END), 0) AS tokens1h,
             COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN delta_tokens ELSE 0 END), 0) AS tokens24h,
             COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN delta_tokens ELSE 0 END), 0) AS tokens30d,
             COUNT(DISTINCT CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN peer_id END) AS activeWorkers24h
           FROM worker_token_ledger`,
        ),
        pool.query(
          `SELECT session_json AS sessionJson, created_at AS createdAt
           FROM p2p_chat_sessions
           WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
           ORDER BY created_at DESC
           LIMIT 500`,
        ),
        pool.query(
          `SELECT
             COUNT(*) AS apiRequests24h,
             COALESCE(SUM(total_tokens), 0) AS apiTokens24h,
             COALESCE(SUM(cost_eur), 0) AS apiRevenue24h
           FROM api_key_usage
           WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
        ),
        discoverAvailableModels(),
      ])
      const pricingConfig = getPricingConfig ? await getPricingConfig() : null
      const effectiveEurPerMillion = pricingConfig?.pricingPublished
        ? Number(
            pricingConfig.eurPerMillionTokens
            ?? (pricingConfig.headline
              ? (pricingConfig.headline.minInputEurPerMillion * 0.75 + pricingConfig.headline.minOutputEurPerMillion * 0.25)
              : pricingConfig.defaultEurPerMillion)
            ?? eurPerMillion,
          )
        : Number(eurPerMillion)
      const effectiveWorkerRewardShare = Number(pricingConfig?.workerRewardSharePercent ?? workerRewardSharePercent)

      const workers = (workerRows[0] || []).map((row, index) => {
        const secondsSinceHeartbeat = toNumber(row.secondsSinceHeartbeat, 999999)
        const online = secondsSinceHeartbeat <= workerOfflineSec
        const live = secondsSinceHeartbeat <= workerLiveSec
        const uptimeSec = row.firstSeenAt ? Math.max(0, Math.floor((Date.now() - new Date(row.firstSeenAt).getTime()) / 1000)) : 0
        const gpuVramGb = row.gpuVramMb ? Number((Number(row.gpuVramMb) / 1024).toFixed(1)) : null
        const allocatedVramGb = row.allocatedVramMb ? Number((Number(row.allocatedVramMb) / 1024).toFixed(1)) : null
        const redactedId = publicWorkerId(row.peerId, index)
        return {
          peerId: exposeWorkerDetails ? row.peerId : redactedId,
          peerLabel: exposeWorkerDetails ? shortPeer(row.peerId) : redactedId,
          publicId: redactedId,
          mode: row.mode || 'worker',
          online,
          live,
          model: row.model || null,
          gpuName: exposeWorkerDetails ? row.gpuName || null : null,
          gpuClass: gpuClass(row.gpuName, row.runtimeBackend),
          gpuVramGb: exposeWorkerDetails ? gpuVramGb : null,
          allocatedVramGb: exposeWorkerDetails ? allocatedVramGb : null,
          memoryTier: memoryTier(allocatedVramGb || gpuVramGb),
          memoryLimitPercent: exposeWorkerDetails && row.memoryLimitPercent != null ? Number(row.memoryLimitPercent) : undefined,
          runtimeBackend: row.runtimeBackend || 'unknown',
          weightQuantization: row.weightQuantization || 'fp16',
          supportsQ4Weights: exposeWorkerDetails ? Boolean(row.supportsQ4Weights) : undefined,
          supportsMlx: exposeWorkerDetails ? Boolean(row.supportsMlx) : undefined,
          supportsVllm: exposeWorkerDetails ? Boolean(row.supportsVllm) : undefined,
          tokensGenerated: exposeWorkerDetails ? Number(row.tokensGenerated || 0) : undefined,
          tokensIn: exposeWorkerDetails ? Number(row.tokensIn || 0) : undefined,
          tokensOut: exposeWorkerDetails ? Number(row.tokensOut || 0) : undefined,
          p2pPeers: exposeWorkerDetails ? Number(row.p2pPeers || 0) : undefined,
          lastHeartbeatAt: exposeWorkerDetails ? toIsoDate(row.lastHeartbeatAt) : null,
          firstSeenAt: exposeWorkerDetails ? toIsoDate(row.firstSeenAt) : null,
          secondsSinceHeartbeat,
          presence: live ? 'live' : online ? 'online' : 'offline',
          uptimeSec,
          uptimeBucket: uptimeSec >= 24 * 3600 ? '24h+' : uptimeSec >= 3600 ? '1h+' : uptimeSec >= 60 ? '1m+' : '<1m',
        }
      })

      const sessions = (sessionRows[0] || [])
        .map(sessionMetrics)
        .filter((item) => item.completionTokens > 0)
        .filter((item) => !requestedModel || String(item.model || '').toLowerCase().includes(requestedModel))
      const activeTps = sessions.map((item) => item.tps).filter((value) => value > 0)
      const latencySamples = sessions.map((item) => item.latencyMs).filter((value) => value > 0)
      const ttftSamples = sessions.map((item) => item.ttftMs).filter((value) => value > 0)
      const pingSamples = sessions.map((item) => item.pingMs).filter((value) => value > 0)
      const modelCounts = new Map()
      for (const session of sessions) {
        if (!session.model) continue
        modelCounts.set(session.model, (modelCounts.get(session.model) || 0) + 1)
      }
      const benchmarkModel =
        Array.from(modelCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Qwen/Qwen3.5-9B'
      const ledger = ledgerRows[0]?.[0] || {}
      const api = apiRows[0]?.[0] || {}
      const onlineWorkers = workers.filter((worker) => worker.online).length
      const liveWorkers = workers.filter((worker) => worker.live).length
      const healthyWorkers = workers.filter((worker) => worker.live && worker.uptimeSec >= 60).length
      const uptimeSamples = workers.map((worker) => worker.uptimeSec > 0 && worker.secondsSinceHeartbeat <= workerLiveSec ? 1 : 0)
      const uptimePercent = uptimeSamples.length
        ? Number(((uptimeSamples.reduce((sum, value) => sum + value, 0) / uptimeSamples.length) * 100).toFixed(2))
        : 0
      const tokens24h = Number(ledger.tokens24h || 0)
      const revenue24h = pricingConfig?.pricingPublished
        ? Number(((tokens24h / 1_000_000) * effectiveEurPerMillion).toFixed(6))
        : 0
      const workerRewards24h = Number((revenue24h * (effectiveWorkerRewardShare / 100)).toFixed(6))
      const infraCost24h = Number(process.env.VRYX_PUBLIC_INFRA_COST_24H_EUR || '0')
      const electricityCost24h = Number(process.env.VRYX_PUBLIC_ELECTRICITY_COST_24H_EUR || '0')
      const netMargin24h = Number((revenue24h - workerRewards24h - infraCost24h - electricityCost24h).toFixed(6))
      const costPerTokenEur = tokens24h > 0 ? Number(((workerRewards24h + infraCost24h + electricityCost24h) / tokens24h).toFixed(10)) : 0
      const publicModels = models.map((model) => {
        const requiredWorkers = Number(model.requiredWorkers || 1)
        const workersOnlineForModel = Number(model.workersOnline || 0)
        const operationalReady = workersOnlineForModel >= requiredWorkers
        return {
          id: model.id,
          label: model.label,
          family: model.family,
          source: model.source,
          ready: operationalReady,
          runnable: operationalReady,
          local: Boolean(model.local),
          cachedOnVps: Boolean(model.ready || model.local),
          requiredWorkers,
          supportedExecutionModes: Array.isArray(model.supportedExecutionModes) ? model.supportedExecutionModes : ['auto'],
          recommendedMemoryGb: model.recommendedMemoryGb || null,
          minMemoryGb: model.minMemoryGb || null,
          effectiveModelGb: model.effectiveModelGb || null,
          totalLayers: model.totalLayers || null,
          workersOnline: workersOnlineForModel,
          workersTotal: Number(model.workersTotal || 0),
          lastSeenAt: model.lastSeenAt || null,
        }
      })

      const payload = {
        ok: true,
        sampledAt: new Date().toISOString(),
        publicExposure: exposeWorkerDetails ? 'worker_details_enabled' : 'redacted',
        redaction: {
          workerDetails: exposeWorkerDetails ? 'exact' : 'redacted',
          businessMetrics: exposeBusinessMetrics ? 'exact' : 'hidden',
          tokenCounters: exposeWorkerDetails ? 'exact' : 'bucketed',
        },
        pricing: {
          published: pricingConfig ? Boolean(pricingConfig.pricingPublished) : true,
          minInputEurPerMillion: pricingConfig?.pricingPublished ? Number(pricingConfig.headline?.minInputEurPerMillion ?? effectiveEurPerMillion) : null,
          minOutputEurPerMillion: pricingConfig?.pricingPublished ? Number(pricingConfig.headline?.minOutputEurPerMillion ?? effectiveEurPerMillion) : null,
          eurPerMillionTokens: pricingConfig?.pricingPublished ? effectiveEurPerMillion : null,
          eurPerThousandTokens: pricingConfig?.pricingPublished ? Number((effectiveEurPerMillion / 1000).toFixed(6)) : null,
          estimatedGrossMarginPercent: exposeBusinessMetrics ? grossMarginPercent : null,
          workerRewardSharePercent: exposeBusinessMetrics ? effectiveWorkerRewardShare : null,
          volumeDiscounts: pricingConfig?.volumeDiscounts || [],
        },
        network: {
          workersRegistered: workers.length,
          workersOnline: onlineWorkers,
          workersLive: liveWorkers,
          workersHealthy: healthyWorkers,
          uptimePercent,
          modelsReady: publicModels.filter((model) => model.ready).length,
          tokens1h: publicMetric(ledger.tokens1h, { exposeExact: exposeWorkerDetails }),
          tokens24h: publicMetric(tokens24h, { exposeExact: exposeWorkerDetails }),
          tokens30d: publicMetric(ledger.tokens30d, { exposeExact: exposeWorkerDetails }),
          activeWorkers24h: Number(ledger.activeWorkers24h || 0),
          activeSessionSamples24h: sessions.length,
          tpsActiveAvg: activeTps.length ? Number((activeTps.reduce((sum, value) => sum + value, 0) / activeTps.length).toFixed(3)) : 0,
          tpsActiveP50: percentile(activeTps, 50),
          tpsActiveP95: percentile(activeTps, 95),
          latencyP50Ms: percentile(latencySamples, 50),
          latencyP95Ms: percentile(latencySamples, 95),
          ttftP50Ms: percentile(ttftSamples, 50),
          ttftP95Ms: percentile(ttftSamples, 95),
          pingP50Ms: percentile(pingSamples, 50),
          pingP95Ms: percentile(pingSamples, 95),
          revenue24h: exposeBusinessMetrics ? revenue24h : null,
          workerRewards24h: exposeBusinessMetrics ? workerRewards24h : null,
          infraCost24h: exposeBusinessMetrics ? infraCost24h : null,
          electricityCost24h: exposeBusinessMetrics ? electricityCost24h : null,
          netMargin24h: exposeBusinessMetrics ? netMargin24h : null,
          costPerTokenEur: exposeBusinessMetrics ? costPerTokenEur : null,
          estimatedNetMarginPercent: exposeBusinessMetrics && revenue24h > 0 ? Number(((netMargin24h / revenue24h) * 100).toFixed(2)) : null,
          apiRequests24h: publicMetric(api.apiRequests24h, { exposeExact: exposeWorkerDetails, bucket: 10 }),
          apiTokens24h: publicMetric(api.apiTokens24h, { exposeExact: exposeWorkerDetails }),
          apiRevenue24h: exposeBusinessMetrics ? Number(api.apiRevenue24h || 0) : null,
        },
        benchmark: {
          label: `${benchmarkModel} / Apple M4 Max`,
          device: 'Apple M4 Max',
          modelTarget: benchmarkModel,
          source: 'public-live-sessions',
          latencyFirstTokenMs: percentile(ttftSamples, 50),
          tpsAverageActive: activeTps.length ? Number((activeTps.reduce((sum, value) => sum + value, 0) / activeTps.length).toFixed(3)) : 0,
          tpsP95Active: percentile(activeTps, 95),
          costEstimatedEurPerMillion: pricingConfig?.pricingPublished ? effectiveEurPerMillion : null,
          sampleSize: sessions.length,
          note:
            sessions.length > 0
              ? 'Calculé depuis les sessions P2P réelles des dernières 24h. Le benchmark Qwen 9B dédié apparaît dès qu’un worker Qwen 9B compatible est live.'
              : 'En attente de sessions publiques récentes pour figer le benchmark Qwen 9B.',
        },
        models: publicModels,
        workers: workers.map((worker) => {
          const out = Object.fromEntries(Object.entries(worker).filter(([, value]) => value !== undefined))
          if (!exposeWorkerDetails) {
            delete out.secondsSinceHeartbeat
            delete out.uptimeSec
          }
          return out
        }),
      }
      await setJsonCache(cacheKey, payload, 5)
      return res.json(payload)
    } catch (error) {
      console.error('public/network-status', error)
      return res.status(500).json({ ok: false, error: 'Impossible de charger le status réseau.' })
    }
  })

  app.get('/api/public/golden-path-status', async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 24))
      const cacheKey = `public:golden-path-status:v1:${hours}`
      const cached = await getJsonCache(cacheKey)
      if (cached) return res.json(cached)
      const goldenModels = String(process.env.VRYX_GOLDEN_PATH_MODELS || 'gemma4:31b,qwen/qwen3.6-35b-a3b,qwen3.6-35b')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      const [workerRows, inferenceRows, benchmarkRows] = await Promise.all([
        pool.query(
          `SELECT peer_id AS peerId, model, desired_model AS desiredModel, runtime_backend AS runtimeBackend,
                  weight_quantization AS weightQuantization, supports_q4_weights AS supportsQ4Weights,
                  capabilities_json AS capabilitiesJson, machine_info AS machineInfo,
                  public_ip AS publicIp, p2p_port AS p2pPort, last_heartbeat_at AS lastHeartbeatAt,
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
                  plan_json AS planJson, error, created_at AS createdAt
           FROM worker_benchmark_runs
           WHERE created_at >= DATE_SUB(NOW(), INTERVAL :hours HOUR)
           ORDER BY created_at DESC
           LIMIT 500`,
          { hours },
        ),
      ])

      const workers = (workerRows[0] || []).map((row) => {
        const machineInfo = parseJsonSafe(row.machineInfo) || {}
        const capabilitiesJson = parseJsonSafe(row.capabilitiesJson) || {}
        const network = capabilitiesJson.network || machineInfo.network || machineInfo.connectivity || {}
        return {
          peerId: row.peerId,
          model: row.model || null,
          desiredModel: row.desiredModel || null,
          runtimeBackend: row.runtimeBackend || null,
          weightQuantization: row.weightQuantization || null,
          supportsQ4Weights: Boolean(row.supportsQ4Weights),
          secondsSinceHeartbeat: toNumber(row.secondsSinceHeartbeat, 999999),
          lastHeartbeatAt: toIsoDate(row.lastHeartbeatAt),
          routeMode: network.routeMode || (network.directReady ? 'direct_tcp' : 'unknown'),
          directReady: Boolean(network.directReady || network.routeMode === 'direct_tcp'),
          publicIp: row.publicIp || null,
          p2pPort: row.p2pPort || null,
          capabilitiesJson,
          machineInfo,
        }
      })
      const requests = inferenceRows[0] || []
      const benchmarks = benchmarkRows[0] || []
      const readiness = scoreProductionReadiness({
        workers,
        inferenceRows: requests,
        inferenceSummary: summarizeInferenceRows(requests),
        benchmarkRows: benchmarks,
        goldenModels,
      })
      const benchmarkOk = benchmarks.filter((row) => row.status === 'ok' && Number(row.tps || 0) > 0)
      const latestBenchmark = benchmarks[0] || null
      const benchmarkEvidence = benchmarks.map((row) => {
        const plan = parseJsonSafe(row.planJson) || {}
        const verdict = plan.verdict && typeof plan.verdict === 'object' ? plan.verdict : {}
        const metrics = verdict.metrics && typeof verdict.metrics === 'object' ? verdict.metrics : {}
        const thresholds = verdict.thresholds && typeof verdict.thresholds === 'object' ? verdict.thresholds : {}
        const requestCount = toNumber(metrics.requestCount ?? plan.requestedRuns, 0)
        const successRate = toNumber(metrics.successRate, row.status === 'ok' ? 100 : 0)
        const emptyResponses = toNumber(metrics.emptyResponses, 0)
        return {
          model: row.model,
          status: row.status,
          requestCount,
          successRate,
          emptyResponses,
          tpsP50: toNumber(metrics.tpsP50 ?? row.tps, 0),
          tpsP95: toNumber(metrics.tpsP95, 0),
          ttftP95Ms: toNumber(metrics.ttftP95Ms ?? row.ttftMs, 0),
          minRequests: toNumber(thresholds.minRequests, 0),
          createdAt: toIsoDate(row.createdAt),
          ok:
            row.status === 'ok' &&
            requestCount >= 100 &&
            successRate >= 99 &&
            emptyResponses === 0,
        }
      })
      const proof100 = benchmarkEvidence.find((item) => item.ok) || null
      const payload = {
        ok: true,
        sampledAt: new Date().toISOString(),
        windowHours: hours,
        readiness,
        goldenPath: {
          models: goldenModels,
          stable99Proven: Boolean(proof100),
          proof100,
          directWorkers: workers.filter((worker) => worker.directReady).length,
          relayWorkers: workers.filter((worker) => worker.secondsSinceHeartbeat <= workerLiveSec && !worker.directReady).length,
          benchmarkRuns: benchmarks.length,
          benchmarkOk: benchmarkOk.length,
          latestBenchmark: latestBenchmark
            ? {
                model: latestBenchmark.model,
                status: latestBenchmark.status,
                tps: Number(latestBenchmark.tps || 0),
                ttftMs: Number(latestBenchmark.ttftMs || 0),
                latencyMs: Number(latestBenchmark.latencyMs || 0),
                workerCount: Number(latestBenchmark.workerCount || 0),
                createdAt: toIsoDate(latestBenchmark.createdAt),
                error: publicBenchmarkError(latestBenchmark.error),
              }
            : null,
        },
        workers: workers.map((worker, index) => ({
          peerId: publicWorkerId(worker.peerId, index),
          peerLabel: publicWorkerId(worker.peerId, index),
          model: worker.model,
          runtimeBackend: worker.runtimeBackend,
          weightQuantization: worker.weightQuantization,
          presence: worker.secondsSinceHeartbeat <= workerLiveSec ? 'live' : 'offline',
          routeMode: worker.routeMode,
          directReady: worker.directReady,
        })),
      }
      await setJsonCache(cacheKey, payload, 10)
      return res.json(payload)
    } catch (error) {
      console.error('public/golden-path-status', error)
      return res.status(500).json({ ok: false, error: 'Impossible de charger le golden path status.' })
    }
  })
}
