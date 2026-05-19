export function percentile(values, p) {
  const clean = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
  if (clean.length === 0) return 0
  const rank = Math.ceil((p / 100) * clean.length) - 1
  return clean[Math.max(0, Math.min(clean.length - 1, rank))]
}

export function compactError(error, fallback = 'inference_failed') {
  const raw =
    typeof error === 'string'
      ? error
      : typeof error?.message === 'string'
        ? error.message
        : fallback
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500) || fallback
}

export function inferRuntimeFromTrace(trace) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return null
  const benchmarkRuntime = String(trace?.benchmark?.runtime_backend || '').trim()
  if (benchmarkRuntime) return benchmarkRuntime
  const perWorker = trace.runtime_backend_per_worker
  if (perWorker && typeof perWorker === 'object' && !Array.isArray(perWorker)) {
    const values = Object.values(perWorker).map((value) => String(value || '').trim()).filter(Boolean)
    if (values.length > 0) return values[0]
  }
  return null
}

export function buildInferenceLog({
  requestId,
  userId = null,
  source = 'admin_p2p_chat',
  status,
  model = null,
  quantization = null,
  runtime = null,
  workerId = null,
  startedAt,
  firstTokenAt = null,
  finishedAt = Date.now(),
  data = null,
  pipelineTrace = null,
  error = null,
  costEur = 0,
}) {
  const trace = pipelineTrace && typeof pipelineTrace === 'object' && !Array.isArray(pipelineTrace)
    ? pipelineTrace
    : data?.pipeline_trace && typeof data.pipeline_trace === 'object' && !Array.isArray(data.pipeline_trace)
      ? data.pipeline_trace
      : null
  const benchmark = trace?.benchmark && typeof trace.benchmark === 'object' ? trace.benchmark : {}
  const promptTokens = Number(data?.prompt_tokens ?? data?.promptTokens ?? 0) || 0
  const completionTokens = Number(data?.completion_tokens ?? data?.completionTokens ?? 0) || 0
  const totalTokens =
    Number(data?.total_tokens ?? data?.totalTokens ?? 0) ||
    promptTokens + completionTokens ||
    0
  const latencyMs = Number(data?.latency_ms ?? data?.latencyMs ?? 0) || Math.max(0, finishedAt - startedAt)
  const ttftMs =
    Number(benchmark.ttft_ms ?? data?.ttft_ms ?? data?.ttftMs ?? 0) ||
    (firstTokenAt ? Math.max(0, firstTokenAt - startedAt) : 0)
  const decodeTps =
    Number(benchmark.actual_tps ?? trace?.hot_path_tps ?? data?.hot_path_tps ?? data?.hotPathTps ?? 0) ||
    (completionTokens > 0 && latencyMs > 0 ? completionTokens * 1000 / latencyMs : 0)
  return {
    requestId,
    userId,
    source,
    status,
    model: model || trace?.model_id || data?.model_id || data?.modelId || null,
    quantization,
    runtime: runtime || inferRuntimeFromTrace(trace),
    workerId,
    ttftMs: Math.max(0, Math.round(ttftMs || 0)),
    decodeTps: Number(Number(decodeTps || 0).toFixed(3)),
    latencyMs: Math.max(0, Math.round(latencyMs || 0)),
    totalDurationMs: Math.max(0, Math.round(finishedAt - startedAt)),
    promptTokens,
    completionTokens,
    totalTokens,
    costEur: Number(Number(costEur || 0).toFixed(6)),
    error: error ? compactError(error) : null,
    trace,
  }
}

export function summarizeInferenceRows(rows) {
  const latency = rows.map((row) => Number(row.latencyMs ?? row.latency_ms ?? 0))
  const ttft = rows.map((row) => Number(row.ttftMs ?? row.ttft_ms ?? 0))
  const tps = rows.map((row) => Number(row.decodeTps ?? row.decode_tps ?? 0)).filter((value) => value > 0)
  const okRows = rows.filter((row) => String(row.status || '').toLowerCase() === 'ok')
  return {
    count: rows.length,
    ok: okRows.length,
    failed: rows.length - okRows.length,
    successRate: rows.length ? Number(((okRows.length / rows.length) * 100).toFixed(2)) : 0,
    latencyMs: {
      p50: percentile(latency, 50),
      p95: percentile(latency, 95),
      p99: percentile(latency, 99),
    },
    ttftMs: {
      p50: percentile(ttft, 50),
      p95: percentile(ttft, 95),
      p99: percentile(ttft, 99),
    },
    decodeTps: {
      p50: Number(percentile(tps, 50).toFixed(3)),
      p95: Number(percentile(tps, 95).toFixed(3)),
      best: tps.length ? Number(Math.max(...tps).toFixed(3)) : 0,
    },
  }
}
