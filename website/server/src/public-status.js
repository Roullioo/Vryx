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
  } = options

  app.get('/api/public/network-status', async (_req, res) => {
    try {
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

      const workers = (workerRows[0] || []).map((row) => {
        const secondsSinceHeartbeat = toNumber(row.secondsSinceHeartbeat, 999999)
        const online = secondsSinceHeartbeat <= workerOfflineSec
        const live = secondsSinceHeartbeat <= workerLiveSec
        const uptimeSec = row.firstSeenAt ? Math.max(0, Math.floor((Date.now() - new Date(row.firstSeenAt).getTime()) / 1000)) : 0
        return {
          peerId: row.peerId,
          peerLabel: shortPeer(row.peerId),
          mode: row.mode || 'worker',
          online,
          live,
          model: row.model || null,
          gpuName: row.gpuName || null,
          gpuVramGb: row.gpuVramMb ? Number((Number(row.gpuVramMb) / 1024).toFixed(1)) : null,
          allocatedVramGb: row.allocatedVramMb ? Number((Number(row.allocatedVramMb) / 1024).toFixed(1)) : null,
          memoryLimitPercent: row.memoryLimitPercent != null ? Number(row.memoryLimitPercent) : null,
          runtimeBackend: row.runtimeBackend || 'unknown',
          weightQuantization: row.weightQuantization || 'fp16',
          supportsQ4Weights: Boolean(row.supportsQ4Weights),
          supportsMlx: Boolean(row.supportsMlx),
          supportsVllm: Boolean(row.supportsVllm),
          tokensGenerated: Number(row.tokensGenerated || 0),
          tokensIn: Number(row.tokensIn || 0),
          tokensOut: Number(row.tokensOut || 0),
          p2pPeers: Number(row.p2pPeers || 0),
          lastHeartbeatAt: toIsoDate(row.lastHeartbeatAt),
          firstSeenAt: toIsoDate(row.firstSeenAt),
          secondsSinceHeartbeat,
          uptimeSec,
        }
      })

      const sessions = (sessionRows[0] || []).map(sessionMetrics).filter((item) => item.completionTokens > 0)
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
      const revenue24h = Number(((tokens24h / 1_000_000) * eurPerMillion).toFixed(6))
      const workerRewards24h = Number((revenue24h * (workerRewardSharePercent / 100)).toFixed(6))
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

      return res.json({
        ok: true,
        sampledAt: new Date().toISOString(),
        pricing: {
          eurPerMillionTokens: eurPerMillion,
          eurPerThousandTokens: Number((eurPerMillion / 1000).toFixed(6)),
          estimatedGrossMarginPercent: grossMarginPercent,
          workerRewardSharePercent,
        },
        network: {
          workersRegistered: workers.length,
          workersOnline: onlineWorkers,
          workersLive: liveWorkers,
          workersHealthy: healthyWorkers,
          uptimePercent,
          modelsReady: publicModels.filter((model) => model.ready).length,
          tokens1h: Number(ledger.tokens1h || 0),
          tokens24h,
          tokens30d: Number(ledger.tokens30d || 0),
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
          revenue24h,
          workerRewards24h,
          infraCost24h,
          electricityCost24h,
          netMargin24h,
          costPerTokenEur,
          estimatedNetMarginPercent: revenue24h > 0 ? Number(((netMargin24h / revenue24h) * 100).toFixed(2)) : 0,
          apiRequests24h: Number(api.apiRequests24h || 0),
          apiTokens24h: Number(api.apiTokens24h || 0),
          apiRevenue24h: Number(api.apiRevenue24h || 0),
        },
        benchmark: {
          label: `${benchmarkModel} / Apple M4 Max`,
          device: 'Apple M4 Max',
          modelTarget: benchmarkModel,
          source: 'public-live-sessions',
          latencyFirstTokenMs: percentile(ttftSamples, 50),
          tpsAverageActive: activeTps.length ? Number((activeTps.reduce((sum, value) => sum + value, 0) / activeTps.length).toFixed(3)) : 0,
          tpsP95Active: percentile(activeTps, 95),
          costEstimatedEurPerMillion: eurPerMillion,
          sampleSize: sessions.length,
          note:
            sessions.length > 0
              ? 'Calculé depuis les sessions P2P réelles des dernières 24h. Le benchmark Qwen 9B dédié apparaît dès qu’un worker Qwen 9B compatible est live.'
              : 'En attente de sessions publiques récentes pour figer le benchmark Qwen 9B.',
        },
        models: publicModels,
        workers,
      })
    } catch (error) {
      console.error('public/network-status', error)
      return res.status(500).json({ ok: false, error: 'Impossible de charger le status réseau.' })
    }
  })
}
