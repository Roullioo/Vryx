#!/usr/bin/env node
import assert from 'node:assert/strict'

const baseUrl = (process.env.VRYX_E2E_BASE_URL || 'https://vryx.eu').replace(/\/$/, '')
const csrfHeaders = { Origin: baseUrl, Referer: `${baseUrl}/admin/workers` }
const bearer = process.env.VRYX_ADMIN_BEARER || ''
const email = process.env.VRYX_ADMIN_EMAIL || process.env.VRYX_TEST_EMAIL || ''
const password = process.env.VRYX_ADMIN_PASSWORD || process.env.VRYX_TEST_PASSWORD || ''
const peerId = process.env.VRYX_E2E_WORKER_PEER_ID || ''

function cookieFrom(headers) {
  const raw = headers.get('set-cookie') || ''
  return raw.split(';')[0]
}

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

async function authHeaders() {
  if (bearer) return { Authorization: `Bearer ${bearer}` }
  if (!email || !password) {
    throw new Error('Set VRYX_ADMIN_BEARER or VRYX_ADMIN_EMAIL/VRYX_ADMIN_PASSWORD.')
  }
  const login = await readJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(login.res.status, 200, `login failed: ${login.text}`)
  const cookie = cookieFrom(login.res.headers)
  assert.ok(cookie, 'auth cookie missing')
  return { Cookie: cookie }
}

const headers = await authHeaders()
const status = await readJson('/api/admin/workers/registered?limit=500', { headers })
assert.equal(status.res.status, 200, `workers status failed: ${status.text}`)
const workers = Array.isArray(status.data?.workers) ? status.data.workers : []
const worker = peerId
  ? workers.find((item) => item.peerId === peerId)
  : workers.find((item) => item.mode === 'worker' && item.desiredState === 'active' && Number(item.secondsSinceHeartbeat) <= 90)
assert.ok(worker, 'no active worker found')

const action = {
  action: 'set_memory',
  allocatedVramMb: Number(worker.desiredAllocatedVramMb || worker.allocatedVramMb || 0) || undefined,
  memoryPercent: Number(worker.desiredMemoryLimitPercent || worker.memoryLimitPercent || 70) || 70,
}
assert.ok(action.allocatedVramMb || action.memoryPercent, 'worker memory target missing')

const created = await readJson(`/api/admin/workers/${encodeURIComponent(worker.peerId)}/actions`, {
  method: 'POST',
  headers: { ...headers, ...csrfHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify(action),
})
assert.equal(created.res.status, 200, `create command failed: ${created.text}`)
assert.equal(created.data?.ok, true, 'create command ok')
const commandId = String(created.data?.command?.id || '')
assert.ok(commandId, 'command id missing')

let command = null
for (let attempt = 0; attempt < 18; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5000))
  const commands = await readJson(`/api/admin/workers/${encodeURIComponent(worker.peerId)}/commands`, { headers })
  assert.equal(commands.res.status, 200, `commands failed: ${commands.text}`)
  command = (commands.data?.commands || []).find((item) => String(item.id) === commandId)
  if (command?.status === 'acknowledged') break
  if (command?.status === 'failed') break
}

assert.ok(command, 'command not visible after creation')
assert.equal(command.status, 'acknowledged', `command was not acknowledged: ${JSON.stringify(command)}`)

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  peerId: worker.peerId,
  commandId,
  action: action.action,
  status: command.status,
  deliveredAt: command.deliveredAt,
  acknowledgedAt: command.acknowledgedAt,
}, null, 2))
