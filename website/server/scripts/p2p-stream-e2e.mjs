#!/usr/bin/env node
import assert from 'node:assert/strict'

const baseUrl = (process.env.VRYX_E2E_BASE_URL || 'https://vryx.eu').replace(/\/$/, '')
const model = process.env.VRYX_E2E_MODEL || 'gemma4:31b'
const prompt = process.env.VRYX_E2E_PROMPT || 'Réponds en 6 mots maximum: test streaming direct Vryx'
const maxNewTokens = Number(process.env.VRYX_E2E_MAX_NEW_TOKENS || 24)
const bearer = process.env.VRYX_ADMIN_BEARER || ''
const email = process.env.VRYX_ADMIN_EMAIL || process.env.VRYX_TEST_EMAIL || ''
const password = process.env.VRYX_ADMIN_PASSWORD || process.env.VRYX_TEST_PASSWORD || ''

function cookieFrom(headers) {
  const raw = headers.get('set-cookie') || ''
  return raw.split(';')[0]
}

async function loginCookie() {
  if (bearer) return ''
  if (!email || !password) {
    throw new Error('Set VRYX_ADMIN_BEARER or VRYX_ADMIN_EMAIL/VRYX_ADMIN_PASSWORD.')
  }
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const text = await res.text()
  assert.equal(res.status, 200, `login failed: ${text}`)
  const cookie = cookieFrom(res.headers)
  assert.ok(cookie, 'auth cookie missing')
  return cookie
}

function parseSseFrames(text) {
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const dataLines = frame
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
      if (!dataLines.length) return null
      try {
        return JSON.parse(dataLines.join('\n'))
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

const cookie = await loginCookie()
const headers = {
  'Content-Type': 'application/json',
  Accept: 'text/event-stream',
}
if (bearer) headers.Authorization = `Bearer ${bearer}`
if (cookie) headers.Cookie = cookie

const startedAt = Date.now()
const res = await fetch(`${baseUrl}/api/admin/p2p/chat/stream`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    prompt,
    model_id: model,
    max_new_tokens: maxNewTokens,
    quantization: 'q4',
  }),
})
const text = await res.text()
assert.equal(res.status, 200, `stream failed: ${text}`)

const frames = parseSseFrames(text)
const tokenFrames = frames.filter((frame) => typeof frame.token === 'string' && frame.token.length > 0)
const nativeTokenFrames = tokenFrames.filter((frame) => frame.nativeTokenStream === true)
const doneFrame = frames.find((frame) => frame.done === true)
const firstTokenIndex = frames.findIndex((frame) => typeof frame.token === 'string' && frame.token.length > 0)
const doneIndex = frames.findIndex((frame) => frame.done === true)

assert.ok(tokenFrames.length > 0, 'no token frame received')
assert.ok(nativeTokenFrames.length > 0, 'no native worker token stream frame received')
assert.ok(doneFrame, 'done frame missing')
assert.ok(firstTokenIndex >= 0 && doneIndex > firstTokenIndex, 'tokens must arrive before done frame')
assert.ok(doneFrame.routingPath?.length > 0, 'routingPath missing')
assert.ok(doneFrame.workerPeerId || doneFrame.primaryWorkerPeerId, 'worker peer id missing')
assert.notEqual(doneFrame.poolClass, 'legacy_pytorch', 'llama.cpp/modern runtime was mislabeled as legacy_pytorch')
assert.ok(Number(doneFrame.computeTimeMs || 0) > 0, 'computeTimeMs missing')
assert.ok(Number(doneFrame.hotPathTps || 0) > 0, 'hotPathTps missing')
assert.ok(Number(doneFrame.pingMs || 0) < Number(doneFrame.computeTimeMs || 0), 'pingMs must not mirror full compute time')

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  model,
  elapsedMs: Date.now() - startedAt,
  frames: frames.length,
  tokenFrames: tokenFrames.length,
  nativeTokenFrames: nativeTokenFrames.length,
  workerPeerId: doneFrame.workerPeerId || doneFrame.primaryWorkerPeerId,
  poolClass: doneFrame.poolClass,
  pingMs: doneFrame.pingMs || 0,
  relayMs: doneFrame.relayMs || 0,
  computeTimeMs: doneFrame.computeTimeMs,
  hotPathTps: doneFrame.hotPathTps,
}, null, 2))
