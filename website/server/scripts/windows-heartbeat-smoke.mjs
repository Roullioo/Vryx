#!/usr/bin/env node
const apiUrl = String(process.env.VRYX_API_URL || 'https://vryx.eu').replace(/\/+$/, '')
const secret = String(process.env.VRYX_WORKER_SECRET || process.env.WORKER_SECRET || '').trim()

if (!secret) {
  console.error('missing_worker_secret: set VRYX_WORKER_SECRET')
  process.exit(2)
}

const peerSuffix = Math.random().toString(16).slice(2, 10)
const payload = {
  peer_id: process.env.VRYX_SMOKE_PEER_ID || `windows-smoke-${Date.now()}-${peerSuffix}`,
  mode: 'worker',
  grpc_port: Number(process.env.VRYX_SMOKE_GRPC_PORT || 50052),
  p2p_port: Number(process.env.VRYX_SMOKE_P2P_PORT || 4021),
  version: process.env.VRYX_WORKER_VERSION || 'windows-heartbeat-smoke',
  user_id: Number(process.env.VRYX_USER_ID || 0),
  tokens_in: 0,
  tokens_out: 0,
  tokens_generated: 0,
  p2p_peers: 0,
  model: process.env.VRYX_TEST_MODEL_ID || 'Qwen/Qwen3.5-9B',
  runtime_backend: 'windows-smoke',
  weight_quantization: 'q4',
  supports_q4_weights: true,
  supports_mlx: false,
  supports_vllm: false,
  machine_info: {
    platform: 'win32',
    os: 'Windows heartbeat smoke',
    workerOs: 'win32',
  },
}

const response = await fetch(`${apiUrl}/api/workers/heartbeat`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${secret}`,
    'x-worker-secret': secret,
  },
  body: JSON.stringify(payload),
})

const text = await response.text()
let body = {}
try {
  body = text ? JSON.parse(text) : {}
} catch {
  body = { raw: text.slice(0, 400) }
}

console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  apiUrl,
  peerId: payload.peer_id,
  body,
}, null, 2))

if (!response.ok) process.exit(1)
