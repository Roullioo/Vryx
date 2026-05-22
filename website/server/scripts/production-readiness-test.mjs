import assert from 'node:assert/strict'
import { summarizeInferenceRows } from '../src/inference-metrics.js'
import { scoreProductionReadiness } from '../src/production-readiness.js'

const rows = [
  { status: 'ok', latencyMs: 1200, ttftMs: 300, decodeTps: 14 },
  { status: 'ok', latencyMs: 1300, ttftMs: 350, decodeTps: 15 },
  { status: 'ok', latencyMs: 1400, ttftMs: 400, decodeTps: 16 },
]

const healthy = scoreProductionReadiness({
  workers: [
    {
      secondsSinceHeartbeat: 3,
      model: 'gemma4:31b',
      runtimeBackend: 'llama_cpp',
      weightQuantization: 'q4',
      supportsQ4Weights: true,
      capabilitiesJson: { network: { routeMode: 'direct_tcp' } },
    },
  ],
  inferenceRows: rows,
  inferenceSummary: summarizeInferenceRows(rows),
  benchmarkRows: [{ status: 'ok', tps: 15 }],
})

assert.equal(healthy.grade, 'production_candidate')
assert.equal(healthy.score, 100)
assert.deepEqual(healthy.blockers, [])

const weak = scoreProductionReadiness({
  workers: [{ secondsSinceHeartbeat: 999, model: 'other', runtimeBackend: 'mlx_lm', weightQuantization: 'fp16' }],
  inferenceRows: [{ status: 'failed', error: 'empty_worker_response', latencyMs: 60_000, ttftMs: 0, decodeTps: 0 }],
  inferenceSummary: summarizeInferenceRows([{ status: 'failed', error: 'empty_worker_response', latencyMs: 60_000, ttftMs: 0, decodeTps: 0 }]),
  benchmarkRows: [],
})

assert.equal(weak.grade, 'not_ready')
assert.ok(weak.score < 50)
assert.ok(weak.blockers.some((item) => item.includes('Aucun worker live')))
assert.ok(weak.blockers.some((item) => item.includes('réponse')))

const benchmarkBacked = scoreProductionReadiness({
  workers: [
    {
      secondsSinceHeartbeat: 3,
      model: 'Qwen/Qwen3.6-35B-A3B',
      runtimeBackend: 'mlx_lm',
      weightQuantization: 'q4',
      supportsQ4Weights: true,
      capabilitiesJson: { network: { routeMode: 'direct_tcp' } },
    },
  ],
  inferenceRows: [
    { status: 'failed', error: 'no_stable_worker_reservation', latencyMs: 6, ttftMs: 0, decodeTps: 0, totalTokens: 0 },
    { status: 'failed', error: 'no_stable_worker_reservation', latencyMs: 5, ttftMs: 0, decodeTps: 0, totalTokens: 0 },
  ],
  inferenceSummary: summarizeInferenceRows([
    { status: 'failed', error: 'no_stable_worker_reservation', latencyMs: 6, ttftMs: 0, decodeTps: 0, totalTokens: 0 },
    { status: 'failed', error: 'no_stable_worker_reservation', latencyMs: 5, ttftMs: 0, decodeTps: 0, totalTokens: 0 },
  ]),
  benchmarkRows: [
    { status: 'ok', tps: 66, ttftMs: 650, latencyMs: 7000 },
    { status: 'ok', tps: 70, ttftMs: 700, latencyMs: 6500 },
    { status: 'ok', tps: 69, ttftMs: 900, latencyMs: 6200 },
    { status: 'failed', tps: 0, ttftMs: 0, latencyMs: 900 },
  ],
})

assert.equal(benchmarkBacked.score, 100)
assert.equal(benchmarkBacked.metrics.requestCount, 4)
assert.equal(benchmarkBacked.metrics.validBenchmarks, 3)
assert.deepEqual(benchmarkBacked.blockers, [])

console.log('production-readiness-test: ok')
