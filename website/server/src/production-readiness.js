function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function hasGoldenModel(value, goldenModels) {
  const model = String(value || '').toLowerCase()
  return goldenModels.some((candidate) => model.includes(String(candidate).toLowerCase()))
}

function percentile(values, p) {
  const clean = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
  if (clean.length === 0) return 0
  const rank = Math.ceil((p / 100) * clean.length) - 1
  return clean[Math.max(0, Math.min(clean.length - 1, rank))]
}

export function scoreProductionReadiness({
  workers = [],
  inferenceSummary = null,
  inferenceRows = [],
  benchmarkRows = [],
  goldenModels = ['gemma4:31b', 'qwen/qwen3.6-35b-a3b', 'qwen3.6-35b'],
  minDecodeTps = 10,
  maxTtftP95Ms = 10_000,
  maxFailureRatePercent = 5,
} = {}) {
  const blockers = []
  const warnings = []
  const actions = []
  let score = 0

  const liveWorkers = workers.filter((worker) => num(worker.secondsSinceHeartbeat, 999999) <= 30)
  const goldenWorkers = liveWorkers.filter((worker) => hasGoldenModel(worker.model || worker.desiredModel, goldenModels))
  const q4LlamaWorkers = goldenWorkers.filter((worker) => {
    const runtime = String(worker.runtimeBackend || '').toLowerCase()
    const quant = String(worker.weightQuantization || '').toLowerCase()
    return runtime.includes('llama') && (quant.includes('q4') || worker.supportsQ4Weights)
  })

  if (goldenWorkers.length > 0) score += 20
  else {
    blockers.push('Aucun worker live ne porte le modèle golden path.')
    actions.push('Charger Gemma/Qwen 35B Q4 sur un worker M4 Max avant toute nouvelle feature.')
  }

  if (q4LlamaWorkers.length > 0) score += 15
  else {
    blockers.push('Aucun worker golden path live en runtime llama.cpp Q4.')
    actions.push('Forcer le golden path vers llama.cpp Q4 et refuser les fallbacks silencieux.')
  }

  const summary = inferenceSummary || {}
  const validBenchmarks = benchmarkRows.filter((row) => String(row.status || '') === 'ok' && num(row.tps) >= minDecodeTps)
  const okBenchmarks = benchmarkRows.filter((row) => String(row.status || '') === 'ok')
  const benchmarkTps = validBenchmarks.map((row) => num(row.tps)).filter((value) => value > 0)
  const benchmarkTtft = validBenchmarks.map((row) => num(row.ttftMs ?? row.ttft_ms)).filter((value) => value > 0)
  const summaryCount = num(summary.count)
  const ok = summaryCount > 0 ? num(summary.ok) : okBenchmarks.length
  const count = summaryCount > 0 ? summaryCount : benchmarkRows.length
  const failed = summaryCount > 0 ? num(summary.failed, Math.max(0, count - ok)) : Math.max(0, benchmarkRows.length - okBenchmarks.length)
  const successRate = count > 0 ? (ok / count) * 100 : 0
  const failureRate = count > 0 ? (failed / count) * 100 : 100
  const tpsP50 = num(summary.decodeTps?.p50) || Number(percentile(benchmarkTps, 50).toFixed(3))
  const tpsBest = num(summary.decodeTps?.best) || (benchmarkTps.length ? Number(Math.max(...benchmarkTps).toFixed(3)) : 0)
  const ttftP95 = num(summary.ttftMs?.p95) || percentile(benchmarkTtft, 95)
  const latencyP95 = num(summary.latencyMs?.p95)

  if (count >= 3 && ok > 0) score += 15
  else {
    blockers.push('Pas assez de requêtes inference récentes pour prouver la stabilité.')
    actions.push('Lancer au moins 3 benchmarks golden path et vérifier /api/admin/inference/summary.')
  }

  if (successRate >= 95) score += 10
  else if (failureRate <= maxFailureRatePercent) score += 8
  else {
    blockers.push(`Taux d'échec trop élevé sur la fenêtre: ${failureRate.toFixed(1)}%.`)
    actions.push('Corriger les causes de timeout/réponse vide avant scaling.')
  }

  if (tpsP50 >= minDecodeTps) score += 15
  else if (tpsBest >= minDecodeTps) {
    score += 8
    warnings.push(`TPS p50 sous cible (${tpsP50.toFixed(2)}), mais un run atteint ${tpsBest.toFixed(2)} TPS.`)
  } else {
    blockers.push(`TPS decode sous cible: p50 ${tpsP50.toFixed(2)} < ${minDecodeTps}.`)
    actions.push('Réduire relay/TTFT, warmup modèle et vérifier runtime llama.cpp.')
  }

  if (ttftP95 > 0 && ttftP95 <= maxTtftP95Ms) score += 10
  else {
    warnings.push(`TTFT p95 absent ou trop haut (${ttftP95 || 0} ms).`)
    actions.push('Mesurer TTFT côté worker et passer en P2P direct quand possible.')
  }

  const recentEmpty = inferenceRows.filter((row) => /empty_worker_response/i.test(String(row.error || ''))).length
  if (recentEmpty === 0 && count > 0) {
    score += 10
  } else if (count === 0) {
    warnings.push('Aucun sample récent pour prouver l’absence de réponse vide.')
  } else {
    blockers.push(`${recentEmpty} réponse(s) vide(s) détectée(s) récemment.`)
    actions.push('Traiter les réponses vides comme incident P0 et inspecter worker/runtime.')
  }

  if (validBenchmarks.length > 0) score += 10
  else {
    warnings.push('Aucun benchmark golden path récent ne valide la cible TPS.')
    actions.push('Publier un benchmark Gemma/Qwen 35B Q4 avec 128/256 tokens.')
  }

  const directReadyWorkers = liveWorkers.filter((worker) => {
    const info = worker.capabilitiesJson || worker.machineInfo || {}
    const network = info.network || info.connectivity || {}
    return network.directReady || network.routeMode === 'direct_tcp'
  })
  if (directReadyWorkers.length > 0) score += 5
  else warnings.push('Aucun worker live ne prouve une route P2P directe; le relay peut encore augmenter TTFT.')

  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)))
  return {
    score: normalizedScore,
    grade:
      normalizedScore >= 90 ? 'production_candidate'
        : normalizedScore >= 80 ? 'advanced_beta'
          : normalizedScore >= 70 ? 'prototype_plus'
            : 'not_ready',
    goldenPath: {
      models: goldenModels,
      liveWorkers: goldenWorkers.length,
      q4LlamaWorkers: q4LlamaWorkers.length,
      minDecodeTps,
      maxTtftP95Ms,
      maxFailureRatePercent,
    },
    metrics: {
      requestCount: count,
      successRate: Number(successRate.toFixed(2)),
      failureRate: Number(failureRate.toFixed(2)),
      tpsP50,
      tpsBest,
      ttftP95,
      latencyP95,
      recentEmptyResponses: recentEmpty,
      validBenchmarks: validBenchmarks.length,
    },
    blockers,
    warnings,
    actions: Array.from(new Set(actions)),
  }
}
