import assert from 'node:assert/strict'
import {
  buildInferenceLog,
  compactError,
  percentile,
  summarizeInferenceRows,
} from '../src/inference-metrics.js'

assert.equal(percentile([10, 20, 30, 40], 50), 20)
assert.equal(percentile([10, 20, 30, 40], 95), 40)
assert.equal(percentile([], 95), 0)

const startedAt = 1_000
const log = buildInferenceLog({
  requestId: 'req-test',
  userId: 7,
  status: 'ok',
  model: 'gemma4:31b',
  quantization: 'q4',
  startedAt,
  firstTokenAt: 1_230,
  finishedAt: 2_000,
  data: {
    prompt_tokens: 12,
    completion_tokens: 24,
    total_tokens: 36,
    pipeline_trace: {
      benchmark: {
        actual_tps: 42.1234,
        runtime_backend: 'llama_cpp',
      },
    },
  },
})

assert.equal(log.requestId, 'req-test')
assert.equal(log.ttftMs, 230)
assert.equal(log.decodeTps, 42.123)
assert.equal(log.runtime, 'llama_cpp')
assert.equal(log.totalTokens, 36)

const summary = summarizeInferenceRows([
  { status: 'ok', latencyMs: 100, ttftMs: 20, decodeTps: 10 },
  { status: 'ok', latencyMs: 200, ttftMs: 40, decodeTps: 20 },
  { status: 'failed', latencyMs: 1000, ttftMs: 0, decodeTps: 0 },
])

assert.equal(summary.count, 3)
assert.equal(summary.ok, 2)
assert.equal(summary.failed, 1)
assert.equal(summary.successRate, 66.67)
assert.equal(summary.latencyMs.p95, 1000)
assert.equal(summary.decodeTps.best, 20)

assert.equal(compactError('  a   b  '), 'a b')

console.log('inference-metrics-test: ok')
