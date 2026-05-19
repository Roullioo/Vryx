#!/usr/bin/env node
import assert from 'node:assert/strict'

const baseUrl = (process.env.VRYX_E2E_BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '')
const email = process.env.VRYX_TEST_EMAIL || ''
const password = process.env.VRYX_TEST_PASSWORD || ''

async function readJson(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options)
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  return { res, data, text }
}

function cookieFrom(headers) {
  const raw = headers.get('set-cookie') || ''
  return raw.split(';')[0]
}

const health = await readJson('/api/health')
assert.equal(health.res.status, 200, 'health status')
assert.equal(health.data?.ok, true, 'health ok')

const publicStatus = await readJson('/api/public/network-status')
assert.equal(publicStatus.res.status, 200, `public status failed: ${publicStatus.text}`)
assert.equal(publicStatus.data?.ok, true, 'public status ok')
for (const key of ['workersOnline', 'tpsActiveAvg', 'latencyP50Ms', 'latencyP95Ms', 'tokens24h']) {
  assert.equal(typeof publicStatus.data?.network?.[key], 'number', `publicStatus.network.${key} must be numeric`)
}
for (const key of ['workersHealthy', 'uptimePercent', 'costPerTokenEur', 'netMargin24h']) {
  assert.equal(typeof publicStatus.data?.network?.[key], 'number', `publicStatus.network.${key} must be numeric`)
}
assert.ok(Array.isArray(publicStatus.data?.models), 'publicStatus.models[] missing')
assert.ok(Array.isArray(publicStatus.data?.workers), 'publicStatus.workers[] missing')

const schedulerPreview = await readJson('/api/public/scheduler-preview?model=Qwen/Qwen3.6-35B-A3B&mode=auto')
assert.equal(schedulerPreview.res.status, 200, `public scheduler preview failed: ${schedulerPreview.text}`)
assert.equal(schedulerPreview.data?.ok, true, 'public scheduler preview ok')
assert.equal(schedulerPreview.data?.plan?.model, 'Qwen/Qwen3.6-35B-A3B', 'public scheduler canonical model')

const publicBenchmarks = await readJson('/api/public/benchmarks')
assert.equal(publicBenchmarks.res.status, 200, `public benchmarks failed: ${publicBenchmarks.text}`)
assert.equal(publicBenchmarks.data?.ok, true, 'public benchmarks ok')
assert.equal(typeof publicBenchmarks.data?.summary?.samples, 'number', 'publicBenchmarks.summary.samples numeric')
assert.ok(Array.isArray(publicBenchmarks.data?.runs), 'publicBenchmarks.runs[] missing')

const summary = {
  ok: true,
  baseUrl,
  health: true,
  authenticated: false,
  checked: ['GET /api/health', 'GET /api/public/network-status', 'GET /api/public/scheduler-preview', 'GET /api/public/benchmarks'],
}

if (email && password) {
  const login = await readJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(login.res.status, 200, `login failed: ${login.text}`)
  const cookie = cookieFrom(login.res.headers)
  assert.ok(cookie, 'auth cookie missing')
  const authHeaders = { Cookie: cookie }

  const overview = await readJson('/api/account/overview', { headers: authHeaders })
  assert.equal(overview.res.status, 200, `overview failed: ${overview.text}`)
  const metrics = overview.data?.investorMetrics
  assert.ok(metrics && typeof metrics === 'object', 'investorMetrics missing')
  for (const key of [
    'latencyP50Ms',
    'latencyP95Ms',
    'tpsP50',
    'tpsP95',
    'costPerMillionTokens',
    'estimatedGrossMarginEur',
    'liveWorkers',
    'totalWorkers',
    'avgWorkerUptimePercent',
  ]) {
    assert.equal(typeof metrics[key], 'number', `investorMetrics.${key} must be numeric`)
  }

  const [models, workers, sessions] = await Promise.all([
    readJson('/api/account/models', { headers: authHeaders }),
    readJson('/api/account/workers', { headers: authHeaders }),
    readJson('/api/account/sessions?limit=5', { headers: authHeaders }),
  ])
  assert.equal(models.res.status, 200, `models failed: ${models.text}`)
  assert.equal(workers.res.status, 200, `workers failed: ${workers.text}`)
  assert.equal(sessions.res.status, 200, `sessions failed: ${sessions.text}`)
  assert.ok(Array.isArray(models.data?.models), 'models[] missing')
  assert.ok(Array.isArray(workers.data?.workers), 'workers[] missing')
  assert.ok(Array.isArray(sessions.data?.sessions), 'sessions[] missing')

  const qwen = models.data.models.find((model) => model.id === 'Qwen/Qwen3.6-35B-A3B')
  assert.ok(qwen, 'Qwen/Qwen3.6-35B-A3B missing from model catalog')
  assert.ok(Array.isArray(qwen.supportedExecutionModes), 'Qwen3.6 supportedExecutionModes missing')

  const [scheduler, modelPlan] = await Promise.all([
    readJson('/api/admin/scheduler/preview?model=Qwen/Qwen3.6-35B-A3B&mode=auto', { headers: authHeaders }),
    readJson('/api/admin/models/plan?model=Qwen/Qwen3.6-35B-A3B&mode=auto', { headers: authHeaders }),
  ])
  assert.equal(scheduler.res.status, 200, `scheduler failed: ${scheduler.text}`)
  assert.equal(modelPlan.res.status, 200, `model plan failed: ${modelPlan.text}`)
  assert.equal(scheduler.data?.ok, true, 'scheduler ok')
  assert.equal(modelPlan.data?.ok, true, 'model plan ok')
  assert.equal(modelPlan.data?.plan?.model, 'Qwen/Qwen3.6-35B-A3B', 'model plan canonical id')

  summary.authenticated = true
  summary.checked.push(
    'POST /api/auth/login',
    'GET /api/account/overview investorMetrics',
    'GET /api/account/models',
    'GET /api/account/workers',
    'GET /api/account/sessions',
    'GET /api/admin/scheduler/preview',
    'GET /api/admin/models/plan',
  )
  summary.investorMetrics = metrics
} else {
  summary.skippedAuth = 'Set VRYX_TEST_EMAIL and VRYX_TEST_PASSWORD to validate account metrics.'
}

console.log(JSON.stringify(summary, null, 2))
