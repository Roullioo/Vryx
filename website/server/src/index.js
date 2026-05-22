import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import mysql from 'mysql2/promise'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { nodeMonitor } from './node-monitor.js'
import { createObservability, registerObservabilityMiddleware, registerObservabilityRoutes } from './observability.js'
import { registerPublicStatusRoutes } from './public-status.js'
import { buildInferenceLog } from './inference-metrics.js'
import { registerAdminInferenceRoutes } from './admin-inference-routes.js'
import { computeRequestCost, computeBlendedPrice } from './pricing-engine.js'
import {
  ensurePricingAndModelCatalogTables,
  getPricingConfig,
  getPublicModels,
  getPublicPricingBundle,
  getPricingTiers,
  getAllSubscriptionPlans,
  getAllPrivatePoolPlans,
  getAllFineTuningPlans,
  invalidatePricingCache,
  updatePricingConfig,
  upsertModelCatalogEntry,
  upsertPricingTier,
  upsertSubscriptionPlan,
  upsertPrivatePoolPlan,
  upsertFineTuningPlan,
  resolveModelPricingByKey,
} from './pricing-models.js'

const execFileAsync = promisify(execFile)

const PORT = Number(process.env.PORT) || 4000
/** URL de l'API Axum du daemon initiateur (chat P2P). */
const VRYX_INITIATOR_CHAT_URL = (process.env.VRYX_INITIATOR_CHAT_URL || 'http://127.0.0.1:3031').replace(/\/$/, '')
/** Préfixes autorisés (CSV) pour `initiator_chat_url` dans POST /api/admin/p2p/chat/stream (orchestreur Edge). Vide = pas de surcharge. */
const VRYX_ALLOWED_INITIATOR_CHAT_PREFIXES = (process.env.VRYX_ALLOWED_INITIATOR_CHAT_PREFIXES || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean)

/** Plafond `max_new_tokens` pour le chat admin P2P. Aligné sur les modèles longs, avec garde-fou serveur. */
const VRYX_P2P_ADMIN_MAX_NEW_TOKENS = (() => {
  const n = Number(process.env.VRYX_P2P_ADMIN_MAX_NEW_TOKENS)
  if (!Number.isFinite(n)) return 16384
  return Math.min(32768, Math.max(16, Math.floor(n)))
})()
const VRYX_P2P_ADMIN_DEFAULT_NEW_TOKENS = (() => {
  const n = Number(process.env.VRYX_P2P_ADMIN_DEFAULT_NEW_TOKENS)
  if (!Number.isFinite(n)) return 2048
  return Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, Math.max(16, Math.floor(n)))
})()
const VRYX_OPENAI_DEFAULT_MAX_TOKENS = (() => {
  const n = Number(process.env.VRYX_OPENAI_DEFAULT_MAX_TOKENS)
  if (!Number.isFinite(n)) return Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, 4096)
  return Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, Math.max(16, Math.floor(n)))
})()
const VRYX_OPENAI_TOOL_MIN_MAX_TOKENS = (() => {
  const n = Number(process.env.VRYX_OPENAI_TOOL_MIN_MAX_TOKENS)
  if (!Number.isFinite(n)) return Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, 16384)
  return Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, Math.max(16, Math.floor(n)))
})()

function resolveInitiatorChatUrl(body) {
  const raw =
    typeof body?.initiator_chat_url === 'string' ? body.initiator_chat_url.trim().replace(/\/$/, '') : ''
  if (!raw) return VRYX_INITIATOR_CHAT_URL
  if (VRYX_ALLOWED_INITIATOR_CHAT_PREFIXES.length === 0) {
    const err = new Error(
      "Surcharge initiator_chat_url refusée : configurez VRYX_ALLOWED_INITIATOR_CHAT_PREFIXES sur l'API (CSV d'origines HTTP).",
    )
    err.statusCode = 400
    throw err
  }
  const ok = VRYX_ALLOWED_INITIATOR_CHAT_PREFIXES.some((p) => raw === p || raw.startsWith(`${p}/`))
  if (!ok) {
    const err = new Error("URL d'initiateur non couverte par les préfixes autorisés.")
    err.statusCode = 400
    throw err
  }
  return raw
}
/** Heartbeat récent pour la liste « workers live » (sidebar admin). */
const WORKER_LIVE_SEC = Math.max(5, Math.min(120, Number(process.env.WORKER_LIVE_SEC) || 30))
const WORKER_RESERVATION_TTL_SEC = Math.max(30, Math.min(900, Number(process.env.WORKER_RESERVATION_TTL_SEC) || 180))
const WORKER_HEALTH_MIN_FOR_SCHEDULER = Math.max(0, Math.min(100, Number(process.env.WORKER_HEALTH_MIN_FOR_SCHEDULER) || 35))
const VRYX_TOKEN_STREAM_BATCH_MS = Math.max(0, Math.min(250, Number(process.env.VRYX_TOKEN_STREAM_BATCH_MS) || 35))
const WORKER_UNSCHEDULABLE_RUNTIME_STATES = new Set(['loading', 'downloading', 'reserved', 'running', 'busy', 'failed', 'cooldown'])
/** Adresses e-mail promues admin automatiquement à chaque démarrage. */
const FORCED_ADMIN_EMAILS = (
  process.env.ADMIN_EMAILS || ''
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_DAYS = Math.min(30, Math.max(1, Number(process.env.JWT_EXPIRES_DAYS) || 7))
const COOKIE_NAME = 'vryx_token'
const LEGACY_COOKIE_NAME = 'velocity_token'
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'
const NODE_ENV = process.env.NODE_ENV || 'development'
const IS_PRODUCTION = NODE_ENV === 'production'
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean)
const CORS_ORIGIN = CORS_ORIGINS[0] || 'http://localhost:5173'
const JSON_BODY_LIMIT = process.env.VRYX_JSON_BODY_LIMIT || (IS_PRODUCTION ? '1mb' : '8mb')
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || ''
/** Tarif de référence Vryx, en EUR / million de tokens facturés. */
const VRYX_EUR_PER_MILLION = (() => {
  const n = Number(process.env.VRYX_EUR_PER_MILLION || '0.3')
  if (!Number.isFinite(n) || n <= 0) return 0.3
  return n
})()
/** Budget mensuel de référence (tokens) pour l’affichage compte/utilisation. */
const VRYX_ACCOUNT_MONTHLY_TOKEN_BUDGET = (() => {
  const n = Number(process.env.VRYX_ACCOUNT_MONTHLY_TOKEN_BUDGET || '10000000')
  if (!Number.isFinite(n) || n <= 0) return 10_000_000
  return Math.max(1_000_000, Math.min(5_000_000_000, Math.floor(n)))
})()
const VRYX_BILLING_ENFORCE_CREDITS = process.env.VRYX_BILLING_ENFORCE_CREDITS === '1'
const VRYX_BILLING_CREDIT_PACKAGES = parseCreditPackages(process.env.VRYX_BILLING_CREDIT_PACKAGES_EUR || '20,50,100,250,500,2000')
const VRYX_APP_BASE_URL = (process.env.VRYX_APP_BASE_URL || CORS_ORIGIN || 'https://vryx.eu').replace(/\/$/, '')
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || '').trim()
const STRIPE_WEBHOOK_SECRET = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim()
const VRYX_BENCH_TOKEN = String(process.env.VRYX_BENCH_TOKEN || '').trim()

/** Sessions chat P2P admin actives (animation « pipeline » sur le graphe). */
let pipelineChatSessions = 0
const activeUserChatSessions = new Set()

function pipelineChatBegin(userId = null) {
  pipelineChatSessions += 1
  if (userId) {
    activeUserChatSessions.add(String(userId))
  }
}
function pipelineChatEnd(userId = null) {
  pipelineChatSessions = Math.max(0, pipelineChatSessions - 1)
  if (userId) {
    activeUserChatSessions.delete(String(userId))
  }
}
function isPipelineChatActive() {
  return pipelineChatSessions > 0
}
function isUserPipelineChatActive(userId) {
  return userId ? activeUserChatSessions.has(String(userId)) : false
}

const WORKER_SECRET = String(process.env.VRYX_WORKER_SECRET || process.env.WORKER_INFERENCE_DELEGATE_SECRET || '').trim()
const RAW_ALLOW_UNSECURE_WORKERS = process.env.ALLOW_UNSECURE_WORKERS === '1'
const ALLOW_UNSECURE_WORKERS = RAW_ALLOW_UNSECURE_WORKERS && !IS_PRODUCTION

function tokenMatchesSecret(token, secret) {
  const tokenBuf = Buffer.from(String(token || ''))
  const secretBuf = Buffer.from(String(secret || ''))
  if (tokenBuf.length === 0 || tokenBuf.length !== secretBuf.length) return false
  return crypto.timingSafeEqual(tokenBuf, secretBuf)
}

async function requireWorkerSecret(req, res, next) {
  const authHeader = req.headers['authorization'] || ''
  let token = ''
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7)
  } else {
    token = req.query.token || req.headers['x-worker-token'] || ''
  }
  if (ALLOW_UNSECURE_WORKERS) return next()
  if (WORKER_SECRET && tokenMatchesSecret(token, WORKER_SECRET)) return next()
  const peerId = String(req.body?.peer_id || req.query.peer_id || '').trim()
  if (peerId && token) {
    try {
      const [rows] = await pool.query(
        `SELECT worker_secret_hash AS workerSecretHash,
                worker_secret_expires_at AS workerSecretExpiresAt,
                worker_next_secret_hash AS workerNextSecretHash,
                worker_next_secret_expires_at AS workerNextSecretExpiresAt
         FROM workers
         WHERE peer_id = :peerId
         LIMIT 1`,
        { peerId },
      )
      const tokenHash = sha256Hex(token)
      const row = rows[0] || {}
      const currentValid = row.workerSecretHash && (!row.workerSecretExpiresAt || new Date(row.workerSecretExpiresAt).getTime() > Date.now())
      const nextValid = row.workerNextSecretHash && (!row.workerNextSecretExpiresAt || new Date(row.workerNextSecretExpiresAt).getTime() > Date.now())
      if ((currentValid && row.workerSecretHash === tokenHash) || (nextValid && row.workerNextSecretHash === tokenHash)) return next()
    } catch (e) {
      console.warn('worker secret lookup failed', e?.code || e?.message || e)
    }
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid worker secret token.' })
}

function normalizedOrigin(value) {
  if (!value) return ''
  try {
    return new URL(String(value)).origin.toLowerCase()
  } catch {
    return ''
  }
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next()
  }
  const origin = req.headers['origin']
  const referer = req.headers['referer']
  const host = req.get('host') || ''
  const protocol = req.protocol || 'http'
  const localUrl = `${protocol}://${host}`
  const allowedOrigins = new Set([
    normalizedOrigin(localUrl),
    ...CORS_ORIGINS.map(normalizedOrigin),
    'https://vryx.eu',
    'https://www.vryx.eu'
  ].filter(Boolean))

  if (origin) {
    if (!allowedOrigins.has(normalizedOrigin(origin))) {
      return res.status(403).json({ error: 'CSRF Protection: Invalid request origin.' })
    }
  } else if (referer) {
    if (!allowedOrigins.has(normalizedOrigin(referer))) {
      return res.status(403).json({ error: 'CSRF Protection: Invalid request referer.' })
    }
  } else {
    const hasAuthCookie = req.cookies && (req.cookies[COOKIE_NAME] || req.cookies[LEGACY_COOKIE_NAME])
    if (hasAuthCookie) {
      return res.status(403).json({ error: 'CSRF Protection: Missing request origin or referer.' })
    }
  }
  next()
}

const p2pTokenStreams = new Map()
function createP2pTokenStream(send, onToken) {
  const streamId = crypto.randomUUID()
  const secret = crypto.randomBytes(32).toString('hex')
  p2pTokenStreams.set(streamId, {
    secret,
    send,
    onToken,
    text: '',
    pendingTokenText: '',
    pendingTokenTimer: null,
    pendingTokenNative: false,
    createdAt: Date.now(),
  })
  setTimeout(() => p2pTokenStreams.delete(streamId), 15 * 60 * 1000).unref?.()
  return { streamId, secret }
}

function flushP2pTokenStream(stream) {
  if (!stream || !stream.pendingTokenText) return
  if (stream.pendingTokenTimer) {
    clearTimeout(stream.pendingTokenTimer)
    stream.pendingTokenTimer = null
  }
  const token = stream.pendingTokenText
  const nativeTokenStream = Boolean(stream.pendingTokenNative)
  stream.pendingTokenText = ''
  stream.pendingTokenNative = false
  stream.send({ token, nativeTokenStream })
}

function enqueueP2pTokenStream(stream, token, nativeTokenStream = true) {
  if (!stream || !token) return
  stream.pendingTokenText += token
  stream.pendingTokenNative = stream.pendingTokenNative || nativeTokenStream
  if (VRYX_TOKEN_STREAM_BATCH_MS <= 0 || stream.pendingTokenText.length >= 96) {
    flushP2pTokenStream(stream)
    return
  }
  if (!stream.pendingTokenTimer) {
    stream.pendingTokenTimer = setTimeout(() => flushP2pTokenStream(stream), VRYX_TOKEN_STREAM_BATCH_MS)
    stream.pendingTokenTimer.unref?.()
  }
}

function sanitizePipelineTraceForAdmin(trace) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return trace
  const clone = JSON.parse(JSON.stringify(trace))
  const stripTokenText = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const next = { ...item }
    delete next.text
    delete next.token
    delete next.piece
    delete next.value
    delete next.byte
    delete next.bytes
    return next
  }
  if (Array.isArray(clone.token_events)) clone.token_events = clone.token_events.map(stripTokenText)
  if (Array.isArray(clone.generation_steps)) clone.generation_steps = clone.generation_steps.map(stripTokenText)
  if (clone.benchmark && typeof clone.benchmark === 'object') {
    delete clone.benchmark.text
    delete clone.benchmark.token
  }
  clone.token_payload_redacted = true
  return clone
}

function peerPingMsFromTrace(trace, peerId) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace) || !peerId) return 0
  const matrix = trace.peer_latency_matrix
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return 0
  const vpsToWorker = matrix.vps_to_worker
  if (!vpsToWorker || typeof vpsToWorker !== 'object' || Array.isArray(vpsToWorker)) return 0
  const entry = vpsToWorker[peerId]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 0
  const raw = entry.vps_rtt_ms ?? entry.latency_ms ?? entry.ping_ms
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function workerHealthScore(workerLike) {
  const seconds = Number(workerLike?.secondsSinceHeartbeat ?? 999999)
  const live = Number.isFinite(seconds) && seconds <= WORKER_LIVE_SEC
  const desired = workerLike?.desiredState || workerLike?.desired_state || 'active'
  const reservedUntil = workerLike?.reservedUntil || workerLike?.reserved_until || null
  const reserved = reservedUntil ? new Date(reservedUntil).getTime() > Date.now() : false
  const commandStatus = String(workerLike?.lastCommandStatus || workerLike?.last_command_status || '')
  const runtimeState = String(workerLike?.runtimeState || workerLike?.runtime_state || 'idle').toLowerCase()
  const tokens1h = Number(workerLike?.tokensGenerated1h || workerLike?.tokens_generated_1h || 0)
  const p2pPeers = Number(workerLike?.p2pPeers ?? workerLike?.p2p_peers ?? 0)
  const allocatedVramMb = Number(workerLike?.allocatedVramMb ?? workerLike?.allocated_vram_mb ?? 0)
  const gpuVramMb = Number(workerLike?.gpuVramMb ?? workerLike?.gpu_vram_mb ?? 0)
  const runtimeBackend = String(workerLike?.runtimeBackend || workerLike?.runtime_backend || '').toLowerCase()
  const supportsMlx = Boolean(workerLike?.supportsMlx ?? workerLike?.supports_mlx)
  const supportsQ4 = Boolean(workerLike?.supportsQ4Weights ?? workerLike?.supports_q4_weights)
  const model = normalizeP2pModelId(workerLike?.model || '') || ''
  const reasons = []
  let score = 100
  if (!live) {
    score -= 45
    reasons.push('heartbeat stale')
  }
  if (desired !== 'active') {
    score -= 35
    reasons.push(`desired ${desired}`)
  }
  if (reserved) {
    score -= 22
    reasons.push('reserved')
  }
  if (WORKER_UNSCHEDULABLE_RUNTIME_STATES.has(runtimeState)) {
    score -= runtimeState === 'failed' ? 40 : 28
    reasons.push(`runtime ${runtimeState}`)
  }
  if (commandStatus === 'pending' || commandStatus === 'pending_worker_offline') {
    score -= 14
    reasons.push(`command ${commandStatus}`)
  }
  if (commandStatus === 'failed') {
    score -= 18
    reasons.push('last command failed')
  }
  if (p2pPeers <= 0) {
    score -= 10
    reasons.push('no p2p peers')
  }
  if (allocatedVramMb <= 0 && gpuVramMb <= 0) {
    score -= 10
    reasons.push('unknown memory')
  }
  if (runtimeBackend.includes('mlx') || supportsMlx) score += 8
  if (supportsQ4) score += 5
  if (tokens1h > 0) score += Math.min(10, Math.log10(tokens1h + 1) * 2.5)
  if (model) score += 2
  score = Math.round(Math.max(0, Math.min(100, score)))
  const state = !live
    ? 'offline'
    : desired !== 'active'
      ? desired
      : WORKER_UNSCHEDULABLE_RUNTIME_STATES.has(runtimeState)
        ? runtimeState
        : reserved
          ? 'reserved'
          : score >= 70
            ? 'healthy'
            : score >= 45
              ? 'degraded'
              : 'risky'
  return { score, state, reasons }
}

function workerSchedulabilityIssue(workerLike) {
  const seconds = Number(workerLike?.secondsSinceHeartbeat ?? 999999)
  if (!Number.isFinite(seconds) || seconds > WORKER_LIVE_SEC) return 'heartbeat_stale'
  const desired = workerLike?.desiredState || workerLike?.desired_state || 'active'
  if (desired !== 'active') return `desired_${desired}`
  const runtimeState = String(workerLike?.runtimeState || workerLike?.runtime_state || 'idle').toLowerCase()
  if (WORKER_UNSCHEDULABLE_RUNTIME_STATES.has(runtimeState)) return `runtime_${runtimeState}`
  const commandStatus = String(workerLike?.lastCommandStatus || workerLike?.last_command_status || '')
  if (commandStatus === 'pending' || commandStatus === 'pending_worker_offline') {
    return `command_${commandStatus}`
  }
  const reservedUntil = workerLike?.reservedUntil || workerLike?.reserved_until || null
  if (reservedUntil && new Date(reservedUntil).getTime() > Date.now()) return 'reserved'
  return ''
}

function workerCapabilities(workerLike) {
  const machineInfo = parseMaybeJsonObject(workerLike?.machineInfo ?? workerLike?.machine_info) || {}
  const gpuVramMb = Number(workerLike?.gpuVramMb ?? workerLike?.gpu_vram_mb ?? machineInfo.vramGb * 1024 ?? 0) || 0
  const allocatedVramMb = Number(workerLike?.allocatedVramMb ?? workerLike?.allocated_vram_mb ?? 0) || 0
  const runtimeBackend = String(workerLike?.runtimeBackend || workerLike?.runtime_backend || '')
  const supportsMlx = Boolean(workerLike?.supportsMlx ?? workerLike?.supports_mlx)
  const supportsVllm = Boolean(workerLike?.supportsVllm ?? workerLike?.supports_vllm)
  const model = normalizeP2pModelId(workerLike?.model || '') || ''
  const reportedQuantization = String(workerLike?.weightQuantization ?? workerLike?.weight_quantization ?? '').toLowerCase()
  const supportsQ4 = Boolean(workerLike?.supportsQ4Weights ?? workerLike?.supports_q4_weights)
    || reportedQuantization.includes('q4')
    || (runtimeBackend.toLowerCase().includes('llama') && /(gemma|llama)/i.test(model))
  return {
    model: model || null,
    gpuName: workerLike?.gpuName ?? workerLike?.gpu_name ?? machineInfo.gpuName ?? null,
    gpuVramMb,
    allocatedVramMb,
    runtimeBackend: runtimeBackend || null,
    quantization: supportsQ4 && !reportedQuantization.includes('q4')
      ? 'q4-effective'
      : workerLike?.weightQuantization ?? workerLike?.weight_quantization ?? null,
    supports: {
      q4: supportsQ4,
      mlx: supportsMlx || runtimeBackend.toLowerCase().includes('mlx'),
      vllm: supportsVllm || runtimeBackend.toLowerCase().includes('vllm'),
      fullLoad: allocatedVramMb >= 24 * 1024 || gpuVramMb >= 24 * 1024,
      shard: allocatedVramMb >= 8 * 1024 || gpuVramMb >= 8 * 1024,
    },
    warnings: supportsQ4 && !Boolean(workerLike?.supportsQ4Weights ?? workerLike?.supports_q4_weights)
      ? ['q4 derived from llama.cpp runtime; worker should upgrade to report native capabilities']
      : [],
    machine: machineInfo,
  }
}

const ACCOUNT_PLAN_NAME = 'Scale'
const VRYX_ESTIMATED_GROSS_MARGIN = clampPercent(Number(process.env.VRYX_ESTIMATED_GROSS_MARGIN_PERCENT || 72))
const VRYX_WORKER_REWARD_SHARE = clampPercent(Number(process.env.VRYX_WORKER_REWARD_SHARE_PERCENT || 58))
const PRICING_FALLBACK = {
  eurPerMillion: VRYX_EUR_PER_MILLION,
  grossMarginPercent: VRYX_ESTIMATED_GROSS_MARGIN,
  workerRewardSharePercent: VRYX_WORKER_REWARD_SHARE,
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function parseCreditPackages(raw) {
  const values = String(raw || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 5 && value <= 100_000)
  const unique = [...new Set(values.map((value) => Number(value.toFixed(2))))]
  return unique.length ? unique : [50, 100, 500, 2000]
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
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function toIsoDate(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function cleanConversationTitle(raw) {
  const value = String(raw || '')
    .replace(/\n\nContexte des pièces jointes:[\s\S]*$/i, '')
    .replace(/^user:\s*/i, '')
    .replace(/\n\nPièces jointes:[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!value) return 'Conversation Vryx'
  return value.slice(0, 90)
}

function isGenericConversationTitle(value) {
  return /^(conversation|nouvelle conversation|conversation vryx|chat vryx)$/i.test(String(value || '').trim())
}

function fallbackConversationTitle(raw) {
  const cleaned = cleanConversationTitle(raw)
  if (isGenericConversationTitle(cleaned)) return 'Nouvelle conversation'
  return cleaned
    .replace(/[.?!,:;]+$/g, '')
    .slice(0, 54)
    .trim() || 'Nouvelle conversation'
}

function normalizeGeneratedConversationTitle(raw, fallback) {
  const cleaned = String(raw || '')
    .split('\n')
    .find((line) => line.trim())
    ?.replace(/^["'«“”‘’]+|["'«»“”‘’]+$/g, '')
    .replace(/^titre\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const candidate = cleaned && !isGenericConversationTitle(cleaned) ? cleaned : fallback
  return fallbackConversationTitle(candidate).slice(0, 58)
}

async function getExistingConversationTitle(userId, conversationId) {
  if (!userId || !conversationId) return ''
  try {
    const [rows] = await pool.query(
      `SELECT session_json AS sessionJson
       FROM p2p_chat_sessions
       WHERE user_id = :userId
       ORDER BY created_at ASC
       LIMIT 300`,
      { userId },
    )
    for (const row of rows) {
      const sessionJson = parseJsonSafe(row.sessionJson)
      if (sessionJson?.conversationId !== conversationId) continue
      const title = cleanConversationTitle(sessionJson?.conversationTitle || '')
      if (title && !isGenericConversationTitle(title)) return title
    }
  } catch (e) {
    console.error('conversation title lookup', e)
  }
  return ''
}

async function generateConversationTitleWithAi({ userId, conversationId, model, firstUserMessage, assistantReply }) {
  const existing = await getExistingConversationTitle(userId, conversationId)
  if (existing) return existing
  const fallback = fallbackConversationTitle(firstUserMessage)
  const userText = String(firstUserMessage || '').slice(0, 700)
  const answerText = String(assistantReply || '').slice(0, 700)
  if (!userText.trim()) return fallback
  const titlePrompt = [
    'system: Tu nommes une conversation Vryx. Réponds uniquement par un titre court en français, 3 à 7 mots, sans guillemets, sans ponctuation finale.',
    `user: Message utilisateur: ${userText}`,
    answerText ? `assistant: Réponse assistant: ${answerText}` : '',
    'user: Donne uniquement le titre.',
  ]
    .filter(Boolean)
    .join('\n')
  try {
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(8000)
        : undefined
    const upstream = await fetch(`${VRYX_INITIATOR_CHAT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: titlePrompt,
        model_id: model,
        quantization: 'q4',
        hidden_transport: 'q4',
        pool_preference: 'velocity_mlx',
        max_new_tokens: 24,
        temperature: 0.15,
        top_p: 0.5,
        top_k: 20,
        repetition_penalty: 1.05,
      }),
      signal,
    })
    const data = await upstream.json().catch(() => null)
    if (!upstream.ok || !data || data.ok === false) return fallback
    return normalizeGeneratedConversationTitle(data.response || data.message || '', fallback)
  } catch (e) {
    console.error('conversation title ai', e?.name === 'AbortError' ? 'timeout' : e)
    return fallback
  }
}

function toUserSessionSummary(row) {
  const sessionJson = parseJsonSafe(row.sessionJson)
  const createdAt = toIsoDate(row.createdAt) || new Date().toISOString()
  const timestamp = Date.parse(createdAt)
  const metrics = sessionJson && typeof sessionJson === 'object' && 'metrics' in sessionJson ? sessionJson.metrics : null
  const promptTokens = toNumber(
    sessionJson?.promptTokens ??
      metrics?.prompt_tokens ??
      metrics?.promptTokens ??
      metrics?.prompt ??
      sessionJson?.prompt_tokens ??
      sessionJson?.promptTokens,
    0,
  )
  const completionTokens = toNumber(
    sessionJson?.completionTokens ??
      metrics?.completion_tokens ??
      metrics?.completionTokens ??
      metrics?.completion ??
      sessionJson?.completion_tokens ??
      sessionJson?.completionTokens,
    0,
  )
  const totalFromPromptCompletion = toNumber(sessionJson?.promptTokens, 0) + toNumber(sessionJson?.completionTokens, 0)
  const totalTokens =
    toNumber(
      sessionJson?.totalTokens ??
        sessionJson?.total_tokens ??
        metrics?.total_tokens ??
        metrics?.totalTokens ??
        metrics?.total ??
        sessionJson?.metrics?.total ??
        totalFromPromptCompletion,
      promptTokens + completionTokens,
    ) ||
    toNumber(sessionJson?.metrics?.total_tokens, 0)

  return {
    id: String(row.id),
    conversationId: typeof sessionJson?.conversationId === 'string' ? sessionJson.conversationId : String(row.id),
    conversationTitle:
      typeof sessionJson?.conversationTitle === 'string' && sessionJson.conversationTitle.trim()
        ? cleanConversationTitle(sessionJson.conversationTitle)
        : cleanConversationTitle(String(row.prompt || '').split('\n').find(Boolean) || row.prompt),
    timestamp,
    createdAt,
    model:
      sessionJson?.model ||
      sessionJson?.workerInfo?.model ||
      sessionJson?.worker_model ||
      row.model ||
      null,
    prompt: typeof row.prompt === 'string' ? row.prompt : '',
    response: typeof row.response === 'string' ? row.response : '',
    promptTokens,
    completionTokens,
    totalTokens,
    latencyMs: toNumber(sessionJson?.latencyMs, 0) || toNumber(sessionJson?.computeTimeMs, 0),
    vpsDelegateMs: toNumber(sessionJson?.vpsDelegateMs, 0),
    workerComputeMs: toNumber(sessionJson?.workerComputeMs, 0),
    pingMs: toNumber(sessionJson?.pingMs),
    avgMsPerToken: toNumber(sessionJson?.avgMsPerToken),
    hotPathTps: toNumber(sessionJson?.hotPathTps),
    mode: typeof sessionJson?.mode === 'string' ? sessionJson.mode : '',
    routingPath: Array.isArray(sessionJson?.routingPath)
      ? sessionJson.routingPath.filter((entry) => typeof entry === 'string')
      : [],
    pipelineLayout: typeof sessionJson?.pipelineLayout === 'string' ? sessionJson.pipelineLayout : 'unknown',
    pipelineOk: Boolean(sessionJson?.pipelineOk),
  }
}

async function computeBillingCost({ model, promptTokens = 0, completionTokens = 0, billingMode = 'public' }) {
  const prompt = Math.max(0, Math.floor(Number(promptTokens) || 0))
  const completion = Math.max(0, Math.floor(Number(completionTokens) || 0))
  const globalConfig = await getPricingConfig(pool, PRICING_FALLBACK)
  const resolved = model ? await resolveModelPricingByKey(pool, PRICING_FALLBACK, model, billingMode) : null
  const modelPricing = resolved?.pricing
    ? {
        inputEurPerMillion: resolved.pricing.inputEurPerMillion,
        outputEurPerMillion: resolved.pricing.outputEurPerMillion,
        privatePoolInputEurPerMillion: resolved.pricing.privatePoolInputEurPerMillion,
        privatePoolOutputEurPerMillion: resolved.pricing.privatePoolOutputEurPerMillion,
        privatePoolDiscountPercent: globalConfig.privatePoolTokenDiscountPercent,
        blendedInputRatioPercent: globalConfig.blendedInputRatioPercent ?? 75,
      }
    : {
        inputEurPerMillion: globalConfig.headline?.minInputEurPerMillion ?? 0.02,
        outputEurPerMillion: globalConfig.headline?.minOutputEurPerMillion ?? 0.06,
        blendedInputRatioPercent: globalConfig.blendedInputRatioPercent ?? 75,
      }
  return computeRequestCost({ modelPricing, promptTokens: prompt, completionTokens: completion, billingMode })
}

async function getBillingCreditPackages() {
  try {
    const pricing = await getPricingConfig(pool, PRICING_FALLBACK)
    const packages = pricing.recharge?.packagesEur
    if (Array.isArray(packages) && packages.length) {
      return [...new Set(packages.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v >= 5))]
    }
  } catch {
    /* fallback env */
  }
  return VRYX_BILLING_CREDIT_PACKAGES
}

async function resolveBillingEurPerMillion() {
  try {
    const pricing = await getPricingConfig(pool, PRICING_FALLBACK)
    if (pricing.headline) {
      return computeBlendedPrice(
        pricing.headline.minInputEurPerMillion,
        pricing.headline.minOutputEurPerMillion,
        pricing.blendedInputRatioPercent ?? 75,
      )
    }
    return pricing.defaultEurPerMillion
  } catch {
    return VRYX_EUR_PER_MILLION
  }
}

function toMoneyAmount(tokens, eurPerMillion = VRYX_EUR_PER_MILLION) {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return Number(((tokens / 1_000_000) * eurPerMillion).toFixed(4))
}

function toEuroAmount(value, precision = 6) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Number(n.toFixed(precision))
}

function euroFromTokens(tokens, eurPerMillion = VRYX_EUR_PER_MILLION) {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return toEuroAmount((tokens / 1_000_000) * eurPerMillion)
}

function estimatePromptTokens(prompt) {
  return Math.max(1, Math.ceil(String(prompt || '').length / 4))
}

async function estimateEnterpriseQuote(input) {
  const billingRate = await resolveBillingEurPerMillion()
  const monthlyTokens = Math.max(1_000_000, Number(input.monthlyTokens || 0))
  const usageBase = euroFromTokens(monthlyTokens, billingRate)
  const offerMultiplier =
    input.offer === 'private_pool' ? 5
      : input.offer === 'knowledge_ai' ? 3.5
        : input.offer === 'custom_ai' ? 7
          : 1.8
  const privacyMultiplier =
    input.privacyLevel === 'no_retention' ? 1.45
      : input.privacyLevel === 'private_pool' ? 1.65
        : input.privacyLevel === 'eu_only' ? 1.2
          : 1
  const dedicatedWorkerBase = Math.max(0, Number(input.dedicatedWorkers || 0)) * 950
  const fineTuningSetup = input.fineTuning ? 4500 : 0
  const monthlyMin =
    input.offer === 'api' ? 250
      : input.offer === 'knowledge_ai' ? 1500
        : input.offer === 'private_pool' ? 3500
          : 6000
  const monthlyEstimate = Math.max(monthlyMin, usageBase * offerMultiplier * privacyMultiplier + dedicatedWorkerBase)
  const setupEstimate = input.offer === 'api' ? 0 : 2500 + fineTuningSetup
  return {
    monthlyEstimateEur: toEuroAmount(monthlyEstimate, 2),
    setupEstimateEur: toEuroAmount(setupEstimate, 2),
    unitTokenCostEurPerMillion: billingRate,
    assumptions: {
      monthlyTokens,
      offerMultiplier,
      privacyMultiplier,
      dedicatedWorkers: Math.max(0, Number(input.dedicatedWorkers || 0)),
      fineTuning: Boolean(input.fineTuning),
    },
  }
}

function newApiKeyPrefix() {
  return `vel_sk_live_${crypto.randomBytes(24).toString('hex')}`
}

function apiKeyHash(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex')
}

function validateSecurityConfig() {
  const fatal = []
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    fatal.push('JWT_SECRET manquant ou trop court (minimum 32 caractères). Copiez server/env.example vers server/.env.')
  }
  if (IS_PRODUCTION) {
    if (!WORKER_SECRET || WORKER_SECRET.length < 32) {
      fatal.push('VRYX_WORKER_SECRET ou WORKER_INFERENCE_DELEGATE_SECRET est obligatoire en production.')
    }
    if (!COOKIE_SECURE) {
      fatal.push('COOKIE_SECURE=true est obligatoire en production.')
    }
    if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.some((origin) => origin === '*' || /localhost|127\.0\.0\.1|\[::1\]/i.test(origin))) {
      fatal.push('CORS_ORIGIN doit contenir uniquement les origines HTTPS publiques autorisées en production.')
    }
    if (RAW_ALLOW_UNSECURE_WORKERS) {
      console.warn('WARN: ALLOW_UNSECURE_WORKERS=1 est ignoré en production; les routes workers restent fail-closed.')
    }
  }
  if (fatal.length > 0) {
    for (const message of fatal) console.error(`FATAL: ${message}`)
    process.exit(1)
  }
}

validateSecurityConfig()

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Adresse e-mail invalide.')
  .max(255, 'Adresse e-mail trop longue.')

const passwordSchema = z
  .string()
  .min(10, 'Le mot de passe doit contenir au moins 10 caractères.')
  .max(128, 'Mot de passe trop long.')
  .regex(/[A-Z]/, 'Le mot de passe doit contenir au moins une majuscule.')
  .regex(/[a-z]/, 'Le mot de passe doit contenir au moins une minuscule.')
  .regex(/[0-9]/, 'Le mot de passe doit contenir au moins un chiffre.')

const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
})

const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Mot de passe requis.'),
})

const desktopAuthCallbackSchema = z.object({
  token: z.string().min(20),
})

const googleFinishSchema = z.object({
  code: z.string().min(1),
  state: z.string().optional().default(''),
})

const accountApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Le libellé de la clé est requis.').max(80, 'Libellé trop long.'),
})

const accountCheckoutSchema = z.object({
  amountEur: z.number().min(5).max(100_000),
})

const adminCreditSchema = z.object({
  amountEur: z.number().min(-100_000).max(100_000).refine((value) => Math.abs(value) >= 0.000001, 'Montant nul.'),
  description: z.string().trim().max(240).optional().default('Ajustement admin'),
})

const enterpriseQuoteSchema = z.object({
  company: z.string().trim().min(2).max(160),
  email: emailSchema,
  offer: z.enum(['api', 'private_pool', 'knowledge_ai', 'custom_ai']),
  monthlyTokens: z.number().min(1_000_000).max(50_000_000_000),
  latencyTargetMs: z.number().min(250).max(60_000),
  privacyLevel: z.enum(['standard', 'eu_only', 'private_pool', 'no_retention']),
  fineTuning: z.boolean().optional().default(false),
  dedicatedWorkers: z.number().int().min(0).max(128).optional().default(0),
  notes: z.string().trim().max(2000).optional().default(''),
})

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  connectTimeout: 15_000,
})

function normalizeP2pModelId(value) {
  if (typeof value !== 'string') return null
  let model = value.trim()
  if (!model || model.length > 120) return null
  if (!/^[A-Za-z0-9._/:-]+$/.test(model)) return null
  const lower = model.toLowerCase()
  if (lower.includes('qwen3.6-35b-a3b')) model = 'Qwen/Qwen3.6-35B-A3B'
  else if (lower.includes('qwen3.5-9b')) model = 'Qwen/Qwen3.5-9B'
  else if (lower.includes('qwen2-0.5b-instruct')) model = 'Qwen/Qwen2-0.5B-Instruct'
  else if ((lower.includes('llama-2') || lower.includes('llama2')) && lower.includes('70b')) model = 'meta-llama/Llama-2-70b-hf'
  else if (lower === 'gemma4:31b' || lower.includes('gemma-4-31b')) model = 'gemma4:31b'
  return model
}

function normalizeP2pModelKey(value) {
  const model = normalizeP2pModelId(value)
  if (!model) return null
  return model.toLowerCase()
}

function modelKeyMatches(actual, requested) {
  const actualKey = normalizeP2pModelKey(actual || '')
  const requestedKey = normalizeP2pModelKey(requested || '')
  return Boolean(actualKey && requestedKey && actualKey === requestedKey)
}

function workerCompatibilityIssue(worker, requestedModel) {
  if (!modelKeyMatches(worker.model, requestedModel)) {
    return `model_mismatch:${worker.model || 'unknown'}`
  }
  const runtime = String(worker.runtimeBackend || worker.runtime_backend || '').toLowerCase()
  const requested = normalizeP2pModelKey(requestedModel || '') || ''
  if ((requested.includes('gemma') || requested.includes('llama')) && !runtime.includes('llama')) {
    return `runtime_mismatch:${runtime || 'unknown'}`
  }
  if (requested.includes('qwen') && !(runtime.includes('mlx') || runtime.includes('vllm'))) {
    return `runtime_mismatch:${runtime || 'unknown'}`
  }
  const quant = String(worker.weightQuantization || worker.weight_quantization || '').toLowerCase()
  const supportsQ4 = Boolean(worker.supportsQ4Weights ?? worker.supports_q4_weights)
  if ((requested.includes('gemma') || requested.includes('llama')) && !runtime.includes('llama') && !supportsQ4 && !quant.includes('q4')) {
    return 'q4_not_advertised'
  }
  return ''
}

function modelDisplayName(model) {
  const value = normalizeP2pModelId(model)
  if (!value) return 'Modèle inconnu'
  return value.split('/').at(-1) || value
}

function inferModelFamily(model) {
  const lower = String(model || '').toLowerCase()
  if (lower.includes('qwen')) return 'Qwen'
  if (lower.includes('llama')) return 'Llama'
  if (lower.includes('gemma')) return 'Gemma'
  if (lower.includes('mistral')) return 'Mistral'
  if (lower.includes('ollama')) return 'Ollama'
  return 'Vryx'
}

function normalizeModelFromPathEntry(entry, parent = '') {
  const value = String(entry || '').trim()
  if (!value) return null
  if (value.startsWith('models--')) {
    return normalizeP2pModelId(value.slice('models--'.length).replaceAll('--', '/'))
  }
  if (value.endsWith('.gguf')) {
    const base = value.replace(/\.gguf$/i, '')
    const owner = parent && parent !== 'models' ? parent : 'local'
    return normalizeP2pModelId(`${owner}/${base}`)
  }
  if (/^prepared-/i.test(value)) {
    return normalizeP2pModelId(`vryx/${value}`)
  }
  if (parent && parent !== 'models' && !value.startsWith('.')) {
    return normalizeP2pModelId(`${parent}/${value}`)
  }
  return normalizeP2pModelId(value)
}

async function discoverModelDirs(root, depth = 0, maxDepth = 3, parent = '') {
  const found = []
  let entries = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    if (!entry || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (['blobs', 'refs', 'snapshots', '.locks'].includes(entry.name)) continue
    const full = path.join(root, entry.name)
    if (entry.isFile() && /\.gguf$/i.test(entry.name)) {
      const id = normalizeModelFromPathEntry(entry.name, parent || path.basename(root))
      if (id) found.push({ id, source: 'gguf', path: full })
      continue
    }
    if (!entry.isDirectory()) continue

    const fromName = normalizeModelFromPathEntry(entry.name, parent || path.basename(root))
    if (fromName && (entry.name.startsWith('models--') || /^prepared-/i.test(entry.name) || parent)) {
      found.push({ id: fromName, source: entry.name.startsWith('models--') ? 'hf-cache' : 'storage', path: full })
    }

    if (depth < maxDepth && !entry.name.startsWith('models--')) {
      const nextParent = entry.name.startsWith('models--') ? '' : entry.name
      found.push(...(await discoverModelDirs(full, depth + 1, maxDepth, nextParent)))
    }
  }
  return found
}

async function discoverAvailableModels() {
  const modelMap = new Map()
  const addModel = (id, patch = {}) => {
    const normalized = normalizeP2pModelId(id)
    if (!normalized) return
    const lower = normalized.toLowerCase()
    if (!normalized.includes('/') || lower.includes('https___') || lower.endsWith('/staging') || lower.startsWith('xet/')) return
    const key = normalizeP2pModelKey(normalized)
    const prev = modelMap.get(key) || {
      id: normalized,
      label: modelDisplayName(normalized),
      family: inferModelFamily(normalized),
      source: 'unknown',
      workersOnline: 0,
      workersTotal: 0,
      requiredWorkers: requiredWorkersForModel(normalized),
      lastSeenAt: null,
      local: false,
      ready: false,
      runnable: false,
    }
    const nextWorkersOnline = Number(patch.workersOnline ?? prev.workersOnline ?? 0)
    const nextRequiredWorkers = Number(patch.requiredWorkers ?? prev.requiredWorkers ?? requiredWorkersForModel(normalized))
    const nextLocal = Boolean(prev.local || patch.local)
    modelMap.set(key, {
      ...prev,
      ...patch,
      id: normalized,
      label: patch.label || prev.label || modelDisplayName(normalized),
      family: patch.family || prev.family || inferModelFamily(normalized),
      source: patch.source || prev.source,
      workersOnline: nextWorkersOnline,
      requiredWorkers: nextRequiredWorkers,
      local: nextLocal,
      ready: Boolean(patch.ready || prev.ready || nextWorkersOnline >= nextRequiredWorkers),
      runnable: nextWorkersOnline >= nextRequiredWorkers || (nextLocal && nextRequiredWorkers <= 1),
    })
  }

  const discoveryRoots = (process.env.VRYX_MODEL_DISCOVERY_DIRS || [
    process.env.VRYX_HF_HOME,
    process.env.HF_HOME,
    process.env.TRANSFORMERS_CACHE,
    process.env.VRYX_SHARD_BASE_DIR || '/var/lib/vryx-shards',
    '/mnt/vryx-storage/vryx-hf',
    '/mnt/vryx-storage/models',
    '/mnt/vryx-storage/vryx-shards',
    '/home/ubuntu/.cache/huggingface/hub',
  ].filter(Boolean).join(':'))
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean)

  const [workerRows] = await pool.query(
    `SELECT model,
            COUNT(*) AS workersTotal,
            SUM(CASE WHEN TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) <= :liveSec THEN 1 ELSE 0 END) AS workersOnline,
            MAX(last_heartbeat_at) AS lastSeenAt
     FROM workers
     WHERE mode = 'worker'
       AND model IS NOT NULL AND model <> ''
     GROUP BY model
     ORDER BY workersOnline DESC, lastSeenAt DESC`,
    { liveSec: WORKER_LIVE_SEC },
  )
  for (const row of workerRows || []) {
    addModel(row.model, {
      source: 'worker',
      workersOnline: Number(row.workersOnline || 0),
      workersTotal: Number(row.workersTotal || 0),
      lastSeenAt: toIsoDate(row.lastSeenAt),
      ready: Number(row.workersOnline || 0) > 0,
    })
  }

  for (const model of CURATED_MODEL_CATALOG) {
    addModel(model.id, model)
  }

  const discovered = (await Promise.all(discoveryRoots.map((root) => discoverModelDirs(root)))).flat()
  for (const item of discovered) {
    addModel(item.id, { source: item.source, local: true, ready: true })
  }

  return Array.from(modelMap.values()).sort((a, b) => {
    const runnableDelta = Number(b.runnable) - Number(a.runnable)
    if (runnableDelta) return runnableDelta
    const readyDelta = Number(b.ready) - Number(a.ready)
    if (readyDelta) return readyDelta
    const onlineDelta = Number(b.workersOnline || 0) - Number(a.workersOnline || 0)
    if (onlineDelta) return onlineDelta
    return a.id.localeCompare(b.id)
  })
}

function modelTail(value) {
  const model = normalizeP2pModelKey(value)
  if (!model) return null
  return model.split('/').at(-1)
}

function modelRequiresDistributedShards(value) {
  const model = normalizeP2pModelKey(value)
  const tail = modelTail(model) || ''
  return (
    model.includes('llama-2-70b') ||
    model.includes('llama2-70b') ||
    tail === 'llama-2-70b-hf' ||
    tail === 'llama-2-70b-chat-hf' ||
    tail.includes('70b')
  )
}

function requiredWorkersForModel(value) {
  const model = normalizeP2pModelKey(value)
  if (model.includes('qwen/qwen3.6-35b') || model.includes('qwen3.6-35b-a3b')) return 2
  return modelRequiresDistributedShards(value) ? 2 : 1
}

const CURATED_MODEL_CATALOG = [
  {
    id: 'Qwen/Qwen3.6-35B-A3B',
    label: 'Qwen3.6 35B A3B',
    family: 'Qwen',
    source: 'catalog',
    requiredWorkers: 2,
    totalLayers: 40,
    paramsB: 35,
    activeParamsB: 3,
    architecture: 'MoE',
    contextTokens: 262144,
    recommendedMemoryGb: 48,
    minMemoryGb: 10,
    shardMinGb: 8,
    // Disk footprint for the MLX Q4 checkpoint is about 19 GB, but a stable
    // solo full load on macOS needs much more unified-memory headroom.
    effectiveModelGb: 44,
    totalModelGb: 70,
    supportedExecutionModes: ['auto', 'full', 'shard'],
    executionModes: [
      {
        id: 'full',
        label: 'Solo complet',
        description: 'Un worker charge le modèle quantifié complet si la mémoire allouée suffit.',
        requiredWorkers: 1,
        minMemoryGb: 44,
        recommendedMemoryGb: 48,
      },
      {
        id: 'shard',
        label: 'Multi-worker shardé',
        description: 'Les couches sont réparties sur plusieurs workers selon leur VRAM disponible.',
        requiredWorkers: 2,
        minMemoryGb: 8,
        recommendedMemoryGb: 16,
      },
    ],
    quantizedVariants: [
      { quantization: 'q4', backend: 'mlx_lm', modelId: 'mlx-community/Qwen3.6-35B-A3B-4bit', diskGb: 19, minMemoryGb: 44 },
      { quantization: 'q4-dwq', backend: 'mlx_lm', modelId: 'mlx-community/Qwen3.6-35B-A3B-4bit-DWQ', diskGb: 19.3, minMemoryGb: 44 },
      { quantization: 'int8', backend: 'mlx_lm', modelId: 'mlx-community/Qwen3.6-35B-A3B-8bit', diskGb: 35.2, minMemoryGb: 38 },
    ],
  },
  {
    id: 'Qwen/Qwen3.5-9B',
    label: 'Qwen3.5 9B',
    family: 'Qwen',
    source: 'catalog',
    requiredWorkers: 1,
    recommendedMemoryGb: 24,
    minMemoryGb: 14,
    effectiveModelGb: 5.9,
    supportedExecutionModes: ['auto', 'full'],
  },
  {
    id: 'Qwen/Qwen2-0.5B-Instruct',
    label: 'Qwen2 0.5B Instruct',
    family: 'Qwen',
    source: 'catalog',
    requiredWorkers: 1,
    recommendedMemoryGb: 3,
    minMemoryGb: 2,
    supportedExecutionModes: ['auto', 'full'],
  },
  {
    id: 'meta-llama/Llama-2-70b-hf',
    label: 'Llama 2 70B',
    family: 'Llama',
    source: 'catalog',
    requiredWorkers: 2,
    recommendedMemoryGb: 96,
    minMemoryGb: 24,
    effectiveModelGb: 39.2,
    totalLayers: 80,
    supportedExecutionModes: ['auto', 'full', 'shard'],
  },
  {
    id: 'gemma4:31b',
    label: 'Gemma 31B local',
    family: 'Gemma',
    source: 'live-catalog',
    requiredWorkers: 1,
    recommendedMemoryGb: 32,
    minMemoryGb: 18,
    effectiveModelGb: 20,
    totalLayers: 48,
    supportedExecutionModes: ['auto', 'full'],
    quantizedVariants: [
      { quantization: 'q4', backend: 'llama_cpp', modelId: 'gemma4:31b', diskGb: 20, minMemoryGb: 18 },
    ],
  },
]

function modelPlanFor(modelId, workers = [], requestedMode = 'auto') {
  const model = normalizeP2pModelId(modelId) || 'Qwen/Qwen3.6-35B-A3B'
  const catalog = CURATED_MODEL_CATALOG.find((m) => normalizeP2pModelKey(m.id) === normalizeP2pModelKey(model))
  const loadMode = ['auto', 'full', 'shard'].includes(requestedMode) ? requestedMode : 'auto'
  const supportedExecutionModes = Array.isArray(catalog?.supportedExecutionModes) && catalog.supportedExecutionModes.length
    ? catalog.supportedExecutionModes
    : ['auto', 'full', 'shard']
  const unsupportedRequestedMode = loadMode !== 'auto' && !supportedExecutionModes.includes(loadMode)
  const totalLayers = Number(catalog?.totalLayers || (modelRequiresDistributedShards(model) ? 80 : 40))
  const effectiveModelGb = Number(catalog?.effectiveModelGb || catalog?.recommendedMemoryGb || 8)
  const liveWorkers = (workers || [])
    .map((w) => ({ ...w, health: workerHealthScore(w), capabilities: workerCapabilities(w) }))
    .filter((w) => !workerSchedulabilityIssue(w))
    .filter((w) => w.health.score >= WORKER_HEALTH_MIN_FOR_SCHEDULER)
  const fullCandidates = liveWorkers.filter((w) => (w.capabilities.allocatedVramMb || w.capabilities.gpuVramMb || 0) >= effectiveModelGb * 1024)
  const mode =
    unsupportedRequestedMode
      ? 'unsupported'
      :
    loadMode === 'full'
      ? 'full'
      : loadMode === 'shard'
        ? 'shard'
        : fullCandidates.length > 0
          ? 'full'
          : 'shard'
  const requiredWorkers = mode === 'unsupported'
    ? 0
    : mode === 'full'
      ? 1
      : Math.max(requiredWorkersForModel(model), Math.min(totalLayers, Math.max(2, liveWorkers.length || 2)))
  const chosen = mode === 'full'
    ? fullCandidates.sort((a, b) => b.health.score - a.health.score)[0]
      ? [fullCandidates.sort((a, b) => b.health.score - a.health.score)[0]]
      : []
    : mode === 'unsupported'
      ? []
      : liveWorkers
        .sort((a, b) => {
          const av = Number(a.capabilities.allocatedVramMb || a.capabilities.gpuVramMb || 0)
          const bv = Number(b.capabilities.allocatedVramMb || b.capabilities.gpuVramMb || 0)
          return b.health.score + bv / 4096 - (a.health.score + av / 4096)
        })
        .slice(0, requiredWorkers)
  const totalWeight = chosen.reduce((s, w) => s + Math.max(1, Number(w.capabilities.allocatedVramMb || w.capabilities.gpuVramMb || 1024)), 0)
  let cursor = 0
  const assignments = chosen.map((w, index) => {
    const weight = Math.max(1, Number(w.capabilities.allocatedVramMb || w.capabilities.gpuVramMb || 1024))
    const remainingWorkers = chosen.length - index
    const remainingLayers = totalLayers - cursor
    const count = index === chosen.length - 1
      ? remainingLayers
      : Math.max(1, Math.min(remainingLayers - remainingWorkers + 1, Math.round((weight / totalWeight) * totalLayers)))
    const start = cursor
    const end = Math.min(totalLayers, cursor + count)
    cursor = end
    return {
      peerId: w.peerId || w.peer_id,
      healthScore: w.health.score,
      gpuName: w.gpuName || w.gpu_name || w.capabilities.gpuName,
      allocatedVramMb: w.capabilities.allocatedVramMb,
      layerStart: start,
      layerEnd: end,
      layerCount: Math.max(0, end - start),
      role: mode === 'full' ? 'full_model' : index === 0 ? 'embedding_layers' : index === chosen.length - 1 ? 'lm_head_layers' : 'middle_layers',
    }
  })
  const ready = mode === 'unsupported'
    ? false
    : mode === 'full'
      ? assignments.length >= 1
      : assignments.length >= requiredWorkers && assignments.reduce((s, a) => s + a.layerCount, 0) >= totalLayers
  const blockers = []
  if (unsupportedRequestedMode) {
    blockers.push(`Mode ${loadMode} non supporté pour ${catalog?.label || modelDisplayName(model)} avec le runtime actuel.`)
  }
  if (assignments.length < requiredWorkers) {
    blockers.push(`${assignments.length}/${requiredWorkers} worker(s) éligible(s)`)
  }
  return {
    model,
    label: catalog?.label || modelDisplayName(model),
    mode,
    ready,
    requiredWorkers,
    availableWorkers: liveWorkers.length,
    totalLayers,
    effectiveModelGb,
    recommendedMemoryGb: catalog?.recommendedMemoryGb || null,
    assignments,
    blockers,
  }
}

async function loadSchedulerWorkers(modelId = null, options = {}) {
  const [rows] = await pool.query(
    `SELECT w.peer_id AS peerId, w.mode, w.model, w.gpu_name AS gpuName, w.gpu_vram_mb AS gpuVramMb,
            w.allocated_vram_mb AS allocatedVramMb, w.memory_limit_percent AS memoryLimitPercent,
            w.runtime_backend AS runtimeBackend, w.weight_quantization AS weightQuantization,
            w.supports_q4_weights AS supportsQ4Weights, w.supports_mlx AS supportsMlx, w.supports_vllm AS supportsVllm,
            w.machine_info AS machineInfo, w.desired_state AS desiredState,
            w.runtime_state AS runtimeState, w.reserved_until AS reservedUntil, w.current_job_id AS currentJobId,
            w.health_score AS storedHealthScore, w.p2p_peers AS p2pPeers,
            w.last_command_status AS lastCommandStatus,
            TIMESTAMPDIFF(SECOND, w.last_heartbeat_at, NOW()) AS secondsSinceHeartbeat,
            (SELECT COALESCE(SUM(l.delta_tokens), 0) FROM worker_token_ledger l
              WHERE l.peer_id = w.peer_id AND l.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS tokensGenerated1h
     FROM workers w
     WHERE w.mode = 'worker'
       AND w.desired_state = 'active'
       AND COALESCE(w.runtime_state, 'idle') NOT IN ('loading','downloading','reserved','running','busy','failed','cooldown')
       AND COALESCE(w.last_command_status, '') NOT IN ('pending','pending_worker_offline')
       AND TIMESTAMPDIFF(SECOND, w.last_heartbeat_at, NOW()) <= :offline
     ORDER BY w.last_heartbeat_at DESC
     LIMIT 200`,
    { offline: WORKER_OFFLINE_SEC },
  )
  const requestedKey = normalizeP2pModelKey(modelId || '')
  const strictModel = Boolean(options.strictModel)
  return (rows || [])
    .map((row) => ({
      ...row,
      model: normalizeP2pModelId(row.model || '') || row.model,
      machineInfo: parseMaybeJsonObject(row.machineInfo),
      secondsSinceHeartbeat: Number(row.secondsSinceHeartbeat || 999999),
      tokensGenerated1h: Number(row.tokensGenerated1h || 0),
    }))
    .filter((row) => {
      if (!requestedKey || !strictModel) return true
      return !workerCompatibilityIssue(row, modelId)
    })
}

async function reserveWorkersForJob({ modelId, loadMode = 'auto', createdBy = null }) {
  await expireWorkerReservations()
  const jobId = `job_${crypto.randomUUID()}`
  const workers = await loadSchedulerWorkers(modelId, { strictModel: true })
  const plan = modelPlanFor(modelId, workers, loadMode)
  if (!plan.ready) return { ok: false, jobId, plan, reservations: [] }
  const reservations = []
  for (const assignment of plan.assignments) {
    const [result] = await pool.query(
      `UPDATE workers
       SET runtime_state = 'reserved',
           current_job_id = :jobId,
           reserved_until = DATE_ADD(NOW(), INTERVAL :ttl SECOND)
       WHERE peer_id = :peerId
         AND desired_state = 'active'
         AND TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) <= :liveSec
         AND COALESCE(runtime_state, 'idle') NOT IN ('loading','downloading','reserved','running','busy','failed','cooldown')
         AND COALESCE(last_command_status, '') NOT IN ('pending','pending_worker_offline')
         AND (reserved_until IS NULL OR reserved_until < NOW() OR current_job_id = :jobId)`,
      { jobId, peerId: assignment.peerId, ttl: WORKER_RESERVATION_TTL_SEC, liveSec: WORKER_LIVE_SEC },
    )
    if (Number(result.affectedRows || 0) > 0) {
      await pool.query(
        `INSERT INTO worker_job_reservations (job_id, peer_id, model, status, created_by, reserved_until)
         VALUES (:jobId, :peerId, :model, 'reserved', :createdBy, DATE_ADD(NOW(), INTERVAL :ttl SECOND))
         ON DUPLICATE KEY UPDATE status = 'reserved', reserved_until = VALUES(reserved_until), released_at = NULL`,
        { jobId, peerId: assignment.peerId, model: plan.model, createdBy, ttl: WORKER_RESERVATION_TTL_SEC },
      )
      reservations.push(assignment)
    }
  }
  const ok = reservations.length >= plan.requiredWorkers || (plan.mode === 'full' && reservations.length >= 1)
  if (!ok) await releaseWorkerReservation(jobId, 'failed')
  return { ok, jobId, plan: { ...plan, assignments: reservations }, reservations }
}

async function expireWorkerReservations() {
  await pool.query(
    `UPDATE worker_job_reservations
     SET status = 'expired', released_at = CURRENT_TIMESTAMP
     WHERE status IN ('reserved','running') AND reserved_until < NOW()`,
  )
  await pool.query(
    `UPDATE workers
     SET runtime_state = 'idle',
         reserved_until = NULL,
         current_job_id = NULL
     WHERE reserved_until IS NOT NULL AND reserved_until < NOW()`,
  )
}

async function markWorkerReservationRunning(jobId) {
  if (!jobId) return
  await pool.query(
    `UPDATE worker_job_reservations SET status = 'running' WHERE job_id = :jobId AND status = 'reserved'`,
    { jobId },
  )
  await pool.query(
    `UPDATE workers SET runtime_state = 'running' WHERE current_job_id = :jobId`,
    { jobId },
  )
}

async function releaseWorkerReservation(jobId, status = 'released') {
  if (!jobId) return
  const safeStatus = ['released', 'expired', 'failed'].includes(status) ? status : 'released'
  await pool.query(
    `UPDATE worker_job_reservations
     SET status = :status, released_at = CURRENT_TIMESTAMP
     WHERE job_id = :jobId AND status IN ('reserved','running')`,
    { jobId, status: safeStatus },
  )
  await pool.query(
    `UPDATE workers
     SET runtime_state = IF(:status = 'failed', 'failed', 'cooldown'),
         reserved_until = NULL,
         current_job_id = NULL
     WHERE current_job_id = :jobId`,
    { jobId, status: safeStatus },
  )
}

async function expireWorkerCommands() {
  await pool.query(
    `UPDATE worker_commands
     SET status = 'failed',
         error = COALESCE(error, 'Commande expirée avant confirmation worker.')
     WHERE status IN ('pending','delivered')
       AND expires_at IS NOT NULL
       AND expires_at < NOW()`,
  )
}

function workerCommandSatisfiedByHeartbeat(command, heartbeat) {
  const action = String(command?.action || '')
  const payload = parseMaybeJsonObject(command?.payloadJson ?? command?.payload_json) || {}
  if (action === 'set_model') {
    return modelKeyMatches(heartbeat.model, payload.model)
  }
  if (action === 'set_memory') {
    const requestedMb = Number(payload.allocatedVramMb || 0)
    const requestedPct = Number(payload.memoryPercent || 0)
    const actualMb = Number(heartbeat.allocatedVramMb ?? heartbeat.allocated_vram_mb ?? 0)
    const actualPct = Number(heartbeat.memoryLimitPercent ?? heartbeat.memory_limit_percent ?? 0)
    return (requestedMb > 0 && actualMb > 0 && Math.abs(actualMb - requestedMb) <= 256)
      || (requestedPct > 0 && actualPct > 0 && Math.abs(actualPct - requestedPct) <= 1)
  }
  if (['pause', 'resume', 'drain', 'stop', 'rotate_secret'].includes(action)) {
    return true
  }
  if (action === 'update_software') {
    const targetVersion = String(payload.targetVersion || payload.release?.version || payload.version || '').trim()
    const actualVersion = String(heartbeat.version || '').trim()
    if (!targetVersion || !actualVersion) return false
    return compareVersionLike(actualVersion, targetVersion) >= 0
  }
  return false
}

async function acknowledgeSatisfiedDeliveredCommands(peerId, heartbeat) {
  if (!peerId) return
  const [commands] = await pool.query(
    `SELECT id, action, payload_json AS payloadJson
     FROM worker_commands
     WHERE peer_id = :peerId
       AND status = 'delivered'
      AND action IN ('pause','resume','drain','stop','set_model','set_memory','update_software','rotate_secret')
     ORDER BY created_at ASC
     LIMIT 10`,
    { peerId },
  )
  const satisfied = commands.filter((command) => workerCommandSatisfiedByHeartbeat(command, heartbeat))
  if (!satisfied.length) return
  const ids = satisfied.map((command) => Number(command.id)).filter((id) => Number.isSafeInteger(id) && id > 0)
  if (!ids.length) return
  await pool.query(
    `UPDATE worker_commands
     SET status = 'acknowledged',
         error = NULL,
         acknowledged_at = CURRENT_TIMESTAMP
     WHERE peer_id = :peerId
       AND id IN (${ids.join(',')})
       AND status = 'delivered'`,
    { peerId },
  )
  await pool.query(
    `UPDATE workers
     SET last_command_status = 'acknowledged',
         last_command_error = NULL,
         runtime_state = 'ready'
     WHERE peer_id = :peerId`,
    { peerId },
  )
}

async function rollbackDesiredStateFromCommand(peerId, commandId) {
  if (!peerId || !commandId) return
  const [rows] = await pool.query(
    `SELECT payload_json AS payloadJson FROM worker_commands WHERE id = :id AND peer_id = :peerId LIMIT 1`,
    { id: String(commandId), peerId },
  )
  const previous = parseMaybeJsonObject(rows[0]?.payloadJson)?.previous
  if (!previous || typeof previous !== 'object') return
  await pool.query(
    `UPDATE workers
     SET desired_model = :desiredModel,
         desired_allocated_vram_mb = :desiredAllocatedVramMb,
         desired_memory_limit_percent = :desiredMemoryLimitPercent
     WHERE peer_id = :peerId`,
    {
      peerId,
      desiredModel: previous.desiredModel ?? null,
      desiredAllocatedVramMb: previous.desiredAllocatedVramMb ?? null,
      desiredMemoryLimitPercent: previous.desiredMemoryLimitPercent ?? null,
    },
  )
}

async function resolveP2pChatModelId(requestedModelId) {
  const requested = normalizeP2pModelId(requestedModelId)
  const requestedKey = normalizeP2pModelKey(requested)
  const requestedTail = modelTail(requested)
  try {
    const [rows] = await pool.query(
      `SELECT model, COUNT(*) AS workerCount, MAX(last_heartbeat_at) AS lastHeartbeatAt
       FROM workers
       WHERE mode = 'worker'
         AND model IS NOT NULL
         AND model <> ''
         AND TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) <= :liveSec
       GROUP BY model
       ORDER BY workerCount DESC, lastHeartbeatAt DESC
       LIMIT 50`,
      { liveSec: WORKER_LIVE_SEC },
    )
    const liveModels = (rows || [])
      .map((row) => ({
        id: normalizeP2pModelId(row?.model),
        workersOnline: Number(row?.workerCount || 0),
      }))
      .filter((row) => row.id)
    const runnableModels = liveModels.filter((row) => row.workersOnline >= requiredWorkersForModel(row.id))
    if (requested && requestedKey) {
      const exactMatch = liveModels.find((rowModel) => normalizeP2pModelKey(rowModel.id) === requestedKey)
      if (exactMatch) return exactMatch.id
      const tailMatch = requestedTail
        ? liveModels.find((rowModel) => modelTail(rowModel.id) === requestedTail)
        : null
      if (tailMatch) return tailMatch.id
      return requested
    }
    return runnableModels[0]?.id || null
  } catch (e) {
    console.error('resolve p2p chat model', e)
    return requested
  }
}

function isTransientDbError(err) {
  const msg = String(err?.message || '')
  if (err?.code === 'ER_ACCESS_DENIED_ERROR' || msg.includes('Access denied')) return false
  const code = err?.code
  return (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    code === 'ECONNRESET' ||
    msg.includes('Connection lost') ||
    msg.includes('server closed the connection')
  )
}

/** MariaDB Docker met souvent 5–20 s à accepter les connexions après `docker compose up`. */
async function waitForDatabase(maxAttempts = 45, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1')
      if (attempt > 1) console.log('Base de données joignable.')
      return
    } catch (err) {
      if (!isTransientDbError(err) || attempt === maxAttempts) throw err
      console.error(
        `[${attempt}/${maxAttempts}] Base indisponible (${err.code || err.message}). Nouvelle tentative dans ${delayMs / 1000} s…`,
      )
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_admin TINYINT(1) NOT NULL DEFAULT 0,
      last_login_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  // Migrations idempotentes pour les colonnes ajoutées après la première install.
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`,
  )
  const present = new Set(cols.map((c) => c.COLUMN_NAME))
  if (!present.has('is_admin')) {
    await pool.query('ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0')
  }
  if (!present.has('last_login_at')) {
    await pool.query('ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL DEFAULT NULL')
  }
  if (!present.has('google_id')) {
    await pool.query('ALTER TABLE users ADD COLUMN google_id VARCHAR(80) NULL')
    await pool.query('CREATE UNIQUE INDEX uq_users_google_id ON users (google_id)')
  }
}

async function ensureWorkersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      peer_id VARCHAR(100) NOT NULL,
      mode ENUM('worker','initiator','bootstrap') NOT NULL DEFAULT 'worker',
      grpc_port SMALLINT UNSIGNED NULL,
      p2p_port SMALLINT UNSIGNED NULL,
      public_ip VARCHAR(45) NULL,
      version VARCHAR(30) NULL,
      p2p_peers INT UNSIGNED NOT NULL DEFAULT 0,
      tokens_generated BIGINT UNSIGNED NOT NULL DEFAULT 0,
      model VARCHAR(100) NULL,
      user_id BIGINT UNSIGNED NULL,
      allocated_vram_mb INT UNSIGNED NULL,
      memory_limit_percent TINYINT UNSIGNED NULL,
      last_heartbeat_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_peer_id (peer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  // Idempotent migrations for new columns
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='workers'`
  )
  const present = new Set(cols.map(c => c.COLUMN_NAME))
  if (!present.has('p2p_peers'))        await pool.query(`ALTER TABLE workers ADD COLUMN p2p_peers INT UNSIGNED NOT NULL DEFAULT 0`)
  if (!present.has('tokens_generated')) await pool.query(`ALTER TABLE workers ADD COLUMN tokens_generated BIGINT UNSIGNED NOT NULL DEFAULT 0`)
  if (!present.has('model'))            await pool.query(`ALTER TABLE workers ADD COLUMN model VARCHAR(100) NULL`)
  if (!present.has('user_id'))          await pool.query(`ALTER TABLE workers ADD COLUMN user_id BIGINT UNSIGNED NULL`)
  if (!present.has('tokens_in'))        await pool.query(`ALTER TABLE workers ADD COLUMN tokens_in BIGINT UNSIGNED NOT NULL DEFAULT 0`)
  if (!present.has('tokens_out'))       await pool.query(`ALTER TABLE workers ADD COLUMN tokens_out BIGINT UNSIGNED NOT NULL DEFAULT 0`)
  if (!present.has('gpu_name'))         await pool.query(`ALTER TABLE workers ADD COLUMN gpu_name VARCHAR(120) NULL`)
  if (!present.has('gpu_vram_mb'))      await pool.query(`ALTER TABLE workers ADD COLUMN gpu_vram_mb INT UNSIGNED NULL`)
  if (!present.has('allocated_vram_mb')) await pool.query(`ALTER TABLE workers ADD COLUMN allocated_vram_mb INT UNSIGNED NULL`)
  if (!present.has('memory_limit_percent')) await pool.query(`ALTER TABLE workers ADD COLUMN memory_limit_percent TINYINT UNSIGNED NULL`)
  if (!present.has('runtime_backend'))  await pool.query(`ALTER TABLE workers ADD COLUMN runtime_backend VARCHAR(40) NULL`)
  if (!present.has('weight_quantization')) await pool.query(`ALTER TABLE workers ADD COLUMN weight_quantization VARCHAR(40) NULL`)
  if (!present.has('supports_q4_weights')) await pool.query(`ALTER TABLE workers ADD COLUMN supports_q4_weights TINYINT(1) NOT NULL DEFAULT 0`)
  if (!present.has('supports_mlx'))     await pool.query(`ALTER TABLE workers ADD COLUMN supports_mlx TINYINT(1) NOT NULL DEFAULT 0`)
  if (!present.has('supports_vllm'))    await pool.query(`ALTER TABLE workers ADD COLUMN supports_vllm TINYINT(1) NOT NULL DEFAULT 0`)
  if (!present.has('machine_info'))      await pool.query(`ALTER TABLE workers ADD COLUMN machine_info JSON NULL`)
  if (!present.has('desired_state'))    await pool.query(`ALTER TABLE workers ADD COLUMN desired_state ENUM('active','paused','draining','stopped') NOT NULL DEFAULT 'active'`)
  if (!present.has('desired_model'))    await pool.query(`ALTER TABLE workers ADD COLUMN desired_model VARCHAR(140) NULL`)
  if (!present.has('desired_allocated_vram_mb')) await pool.query(`ALTER TABLE workers ADD COLUMN desired_allocated_vram_mb INT UNSIGNED NULL`)
  if (!present.has('desired_memory_limit_percent')) await pool.query(`ALTER TABLE workers ADD COLUMN desired_memory_limit_percent TINYINT UNSIGNED NULL`)
  if (!present.has('last_command_at'))  await pool.query(`ALTER TABLE workers ADD COLUMN last_command_at TIMESTAMP NULL DEFAULT NULL`)
  if (!present.has('last_command_status')) await pool.query(`ALTER TABLE workers ADD COLUMN last_command_status VARCHAR(40) NULL`)
  if (!present.has('last_command_error')) await pool.query(`ALTER TABLE workers ADD COLUMN last_command_error VARCHAR(255) NULL`)
  if (!present.has('health_score')) await pool.query(`ALTER TABLE workers ADD COLUMN health_score TINYINT UNSIGNED NOT NULL DEFAULT 0`)
  if (!present.has('runtime_state')) await pool.query(`ALTER TABLE workers ADD COLUMN runtime_state ENUM('idle','updating','restarting','loading_shard','ready','reserved','running','cooldown','failed') NOT NULL DEFAULT 'idle'`)
  else {
    try {
      await pool.query(`ALTER TABLE workers MODIFY runtime_state ENUM('idle','updating','restarting','loading_shard','ready','reserved','running','cooldown','failed') NOT NULL DEFAULT 'idle'`)
    } catch {
      /* compatible enough on older MySQL variants */
    }
  }
  if (!present.has('reserved_until')) await pool.query(`ALTER TABLE workers ADD COLUMN reserved_until TIMESTAMP NULL DEFAULT NULL`)
  if (!present.has('current_job_id')) await pool.query(`ALTER TABLE workers ADD COLUMN current_job_id VARCHAR(80) NULL`)
  if (!present.has('capabilities_json')) await pool.query(`ALTER TABLE workers ADD COLUMN capabilities_json JSON NULL`)
  if (!present.has('worker_secret_hash')) await pool.query(`ALTER TABLE workers ADD COLUMN worker_secret_hash VARCHAR(64) NULL`)
  if (!present.has('worker_secret_expires_at')) await pool.query(`ALTER TABLE workers ADD COLUMN worker_secret_expires_at TIMESTAMP NULL DEFAULT NULL`)
  if (!present.has('worker_next_secret_hash')) await pool.query(`ALTER TABLE workers ADD COLUMN worker_next_secret_hash VARCHAR(64) NULL`)
  if (!present.has('worker_next_secret_expires_at')) await pool.query(`ALTER TABLE workers ADD COLUMN worker_next_secret_expires_at TIMESTAMP NULL DEFAULT NULL`)
}

async function ensureWorkerReservationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_job_reservations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      job_id VARCHAR(80) NOT NULL,
      peer_id VARCHAR(100) NOT NULL,
      model VARCHAR(140) NULL,
      status ENUM('reserved','running','released','expired','failed') NOT NULL DEFAULT 'reserved',
      created_by BIGINT UNSIGNED NULL,
      reserved_until TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      released_at TIMESTAMP NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_worker_job_reservation (job_id, peer_id),
      KEY idx_worker_reservation_peer_status (peer_id, status, reserved_until),
      KEY idx_worker_reservation_model_status (model, status, reserved_until)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

async function ensureWorkerCommandsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_releases (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      channel VARCHAR(40) NOT NULL DEFAULT 'stable',
      version VARCHAR(40) NOT NULL,
      mac_url VARCHAR(500) NULL,
      win_x64_url VARCHAR(500) NULL,
      win_arm64_url VARCHAR(500) NULL,
      runtime_url VARCHAR(500) NULL,
      mac_sha256 VARCHAR(64) NULL,
      win_x64_sha256 VARCHAR(64) NULL,
      win_arm64_sha256 VARCHAR(64) NULL,
      runtime_sha256 VARCHAR(64) NULL,
      notes TEXT NULL,
      mandatory TINYINT(1) NOT NULL DEFAULT 0,
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_worker_releases_channel_created (channel, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_commands (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      peer_id VARCHAR(100) NOT NULL,
      action ENUM('pause','resume','drain','stop','restart','set_model','set_memory','update_software','hot_reload_python','rotate_secret') NOT NULL,
      payload_json JSON NULL,
      status ENUM('pending','delivered','acknowledged','failed','cancelled') NOT NULL DEFAULT 'pending',
      requested_by BIGINT UNSIGNED NULL,
      error VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at TIMESTAMP NULL,
      acknowledged_at TIMESTAMP NULL,
      expires_at TIMESTAMP NULL,
      superseded_by BIGINT UNSIGNED NULL,
      PRIMARY KEY (id),
      KEY idx_worker_commands_peer_status (peer_id, status, created_at),
      KEY idx_worker_commands_requested_by (requested_by),
      KEY idx_worker_commands_expiry (status, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  const [commandCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='worker_commands'`,
  )
  const commandPresent = new Set(commandCols.map((c) => c.COLUMN_NAME))
  if (!commandPresent.has('expires_at')) await pool.query(`ALTER TABLE worker_commands ADD COLUMN expires_at TIMESTAMP NULL`)
  if (!commandPresent.has('superseded_by')) await pool.query(`ALTER TABLE worker_commands ADD COLUMN superseded_by BIGINT UNSIGNED NULL`)
  const [releaseCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='worker_releases'`,
  )
  const releasePresent = new Set(releaseCols.map((c) => c.COLUMN_NAME))
  const releaseHashColumns = [
    ['mac_sha256', 'ALTER TABLE worker_releases ADD COLUMN mac_sha256 VARCHAR(64) NULL'],
    ['win_x64_sha256', 'ALTER TABLE worker_releases ADD COLUMN win_x64_sha256 VARCHAR(64) NULL'],
    ['win_arm64_sha256', 'ALTER TABLE worker_releases ADD COLUMN win_arm64_sha256 VARCHAR(64) NULL'],
    ['runtime_sha256', 'ALTER TABLE worker_releases ADD COLUMN runtime_sha256 VARCHAR(64) NULL'],
  ]
  for (const [name, sql] of releaseHashColumns) {
    if (!releasePresent.has(name)) await pool.query(sql)
  }
  try {
    await pool.query(`
      ALTER TABLE worker_commands
      MODIFY action ENUM('pause','resume','drain','stop','restart','set_model','set_memory','update_software','hot_reload_python','rotate_secret') NOT NULL
    `)
  } catch {
    /* older MySQL variants may already be compatible */
  }
}

async function ensureWorkerBenchmarkRunsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_benchmark_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      job_id VARCHAR(80) NULL,
      model VARCHAR(140) NOT NULL,
      mode VARCHAR(20) NOT NULL DEFAULT 'auto',
      status ENUM('ok','failed') NOT NULL DEFAULT 'failed',
      worker_count INT UNSIGNED NOT NULL DEFAULT 0,
      latency_ms INT UNSIGNED NOT NULL DEFAULT 0,
      ttft_ms INT UNSIGNED NOT NULL DEFAULT 0,
      tps DECIMAL(10,3) NOT NULL DEFAULT 0,
      prompt_tokens INT UNSIGNED NOT NULL DEFAULT 0,
      completion_tokens INT UNSIGNED NOT NULL DEFAULT 0,
      total_tokens INT UNSIGNED NOT NULL DEFAULT 0,
      cost_per_million_eur DECIMAL(12,6) NOT NULL DEFAULT 0,
      plan_json JSON NULL,
      error VARCHAR(500) NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_worker_benchmark_model_time (model, created_at),
      KEY idx_worker_benchmark_status_time (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

async function ensureInferenceRequestLogsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inference_request_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      request_id VARCHAR(80) NOT NULL,
      user_id BIGINT UNSIGNED NULL,
      source VARCHAR(40) NOT NULL DEFAULT 'admin_p2p_chat',
      status ENUM('ok','failed','cancelled') NOT NULL DEFAULT 'failed',
      model VARCHAR(140) NULL,
      quantization VARCHAR(40) NULL,
      runtime VARCHAR(60) NULL,
      worker_id VARCHAR(100) NULL,
      ttft_ms INT UNSIGNED NOT NULL DEFAULT 0,
      decode_tps DECIMAL(10,3) NOT NULL DEFAULT 0,
      latency_ms INT UNSIGNED NOT NULL DEFAULT 0,
      total_duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
      prompt_tokens INT UNSIGNED NOT NULL DEFAULT 0,
      completion_tokens INT UNSIGNED NOT NULL DEFAULT 0,
      total_tokens INT UNSIGNED NOT NULL DEFAULT 0,
      cost_eur DECIMAL(12,6) NOT NULL DEFAULT 0,
      error VARCHAR(500) NULL,
      trace_json JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_inference_request_id (request_id),
      KEY idx_inference_model_time (model, created_at),
      KEY idx_inference_status_time (status, created_at),
      KEY idx_inference_worker_time (worker_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

async function recordInferenceRequestLog(entry) {
  if (!entry?.requestId) return
  await pool.query(
    `INSERT INTO inference_request_logs
       (request_id, user_id, source, status, model, quantization, runtime, worker_id,
        ttft_ms, decode_tps, latency_ms, total_duration_ms,
        prompt_tokens, completion_tokens, total_tokens, cost_eur, error, trace_json)
     VALUES
       (:requestId, :userId, :source, :status, :model, :quantization, :runtime, :workerId,
        :ttftMs, :decodeTps, :latencyMs, :totalDurationMs,
        :promptTokens, :completionTokens, :totalTokens, :costEur, :error, :traceJson)
     ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        model = VALUES(model),
        quantization = VALUES(quantization),
        runtime = VALUES(runtime),
        worker_id = VALUES(worker_id),
        ttft_ms = VALUES(ttft_ms),
        decode_tps = VALUES(decode_tps),
        latency_ms = VALUES(latency_ms),
        total_duration_ms = VALUES(total_duration_ms),
        prompt_tokens = VALUES(prompt_tokens),
        completion_tokens = VALUES(completion_tokens),
        total_tokens = VALUES(total_tokens),
        cost_eur = VALUES(cost_eur),
        error = VALUES(error),
        trace_json = VALUES(trace_json)`,
    {
      requestId: entry.requestId,
      userId: entry.userId ?? null,
      source: entry.source || 'admin_p2p_chat',
      status: entry.status === 'ok' ? 'ok' : entry.status === 'cancelled' ? 'cancelled' : 'failed',
      model: entry.model ?? null,
      quantization: entry.quantization ?? null,
      runtime: entry.runtime ?? null,
      workerId: entry.workerId ?? null,
      ttftMs: Number(entry.ttftMs || 0),
      decodeTps: Number(entry.decodeTps || 0),
      latencyMs: Number(entry.latencyMs || 0),
      totalDurationMs: Number(entry.totalDurationMs || 0),
      promptTokens: Number(entry.promptTokens || 0),
      completionTokens: Number(entry.completionTokens || 0),
      totalTokens: Number(entry.totalTokens || 0),
      costEur: Number(entry.costEur || 0),
      error: entry.error ?? null,
      traceJson: entry.trace ? JSON.stringify(entry.trace) : null,
    },
  ).catch((e) => {
    console.error('recordInferenceRequestLog', e?.message || e)
  })
}

/** Historique des jetons générés (delta par heartbeat) pour stats 1h / 24h admin. */
async function ensureWorkerTokenLedgerTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_token_ledger (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      peer_id VARCHAR(100) NOT NULL,
      delta_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ledger_peer_time (peer_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

async function ensureP2pChatSessionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS p2p_chat_sessions (
      id VARCHAR(80) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      prompt MEDIUMTEXT NOT NULL,
      response MEDIUMTEXT NOT NULL,
      session_json LONGTEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_p2p_chat_sessions_user_created (user_id, created_at),
      CONSTRAINT fk_p2p_chat_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

async function ensureApiKeysTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(120) NOT NULL,
      key_hash CHAR(64) NOT NULL,
      key_prefix VARCHAR(40) NOT NULL,
      last_used_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TIMESTAMP NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_api_keys_hash (key_hash),
      KEY idx_api_keys_user (user_id),
      CONSTRAINT fk_api_keys_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

async function ensureApiKeyUsageTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_key_usage (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      api_key_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      model VARCHAR(120) NULL,
      prompt_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
      completion_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
      total_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
      cost_eur DECIMAL(12,6) NOT NULL DEFAULT 0,
      latency_ms INT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_api_key_usage_key_time (api_key_id, created_at),
      KEY idx_api_key_usage_user_time (user_id, created_at),
      CONSTRAINT fk_api_key_usage_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
      CONSTRAINT fk_api_key_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  for (const [col, def] of [
    ['cost_input_eur', 'DECIMAL(12,6) NULL'],
    ['cost_output_eur', 'DECIMAL(12,6) NULL'],
    ['billing_mode', "VARCHAR(24) NOT NULL DEFAULT 'public'"],
    ['pricing_snapshot_json', 'LONGTEXT NULL'],
  ]) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_key_usage' AND COLUMN_NAME = :column`,
      { column: col },
    )
    if (Number(rows[0]?.c || 0) === 0) {
      await pool.query(`ALTER TABLE api_key_usage ADD COLUMN ${col} ${def}`)
    }
  }
}

async function ensureBillingTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_credit_ledger (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      type ENUM('credit_purchase','usage_debit','admin_adjustment','refund') NOT NULL,
      amount_eur DECIMAL(12,6) NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'EUR',
      description VARCHAR(240) NULL,
      reference_type VARCHAR(80) NULL,
      reference_id VARCHAR(120) NULL,
      metadata_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_billing_ledger_user_time (user_id, created_at),
      KEY idx_billing_ledger_reference (reference_type, reference_id),
      CONSTRAINT fk_billing_ledger_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_checkout_sessions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      provider VARCHAR(40) NOT NULL DEFAULT 'stripe',
      provider_session_id VARCHAR(120) NULL,
      amount_eur DECIMAL(12,6) NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'EUR',
      status VARCHAR(40) NOT NULL DEFAULT 'created',
      checkout_url TEXT NULL,
      metadata_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_billing_checkout_provider_session (provider, provider_session_id),
      KEY idx_billing_checkout_user_time (user_id, created_at),
      CONSTRAINT fk_billing_checkout_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

async function ensureEnterpriseQuoteRequestsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS enterprise_quote_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      company VARCHAR(160) NOT NULL,
      email VARCHAR(255) NOT NULL,
      offer VARCHAR(40) NOT NULL,
      monthly_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
      latency_target_ms INT UNSIGNED NOT NULL DEFAULT 0,
      privacy_level VARCHAR(40) NOT NULL,
      fine_tuning TINYINT(1) NOT NULL DEFAULT 0,
      dedicated_workers INT UNSIGNED NOT NULL DEFAULT 0,
      monthly_estimate_eur DECIMAL(12,2) NOT NULL DEFAULT 0,
      setup_estimate_eur DECIMAL(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(40) NOT NULL DEFAULT 'new',
      notes TEXT NULL,
      quote_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_enterprise_quotes_status_created (status, created_at),
      KEY idx_enterprise_quotes_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

async function ensureForcedAdmins() {
  if (FORCED_ADMIN_EMAILS.length === 0) return
  for (const email of FORCED_ADMIN_EMAILS) {
    await pool
      .query('UPDATE users SET is_admin = 1 WHERE email = :email', { email })
      .catch((e) => console.error('forced admin promote', email, e.message))
  }
  console.log('Admins forcés vérifiés :', FORCED_ADMIN_EMAILS.join(', '))
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: `${JWT_EXPIRES_DAYS}d`,
    issuer: 'vryx-api',
    audience: 'vryx-web',
  })
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: ['vryx-api', 'velocity-api'],
      audience: ['vryx-web', 'velocity-web'],
    })
  } catch {
    return null
  }
}

function setAuthCookie(res, token) {
  const maxAge = JWT_EXPIRES_DAYS * 24 * 60 * 60 * 1000
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge,
  })
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
  })
  res.clearCookie(LEGACY_COOKIE_NAME, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
  })
}

function authMiddleware(req, res, next) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]
  const token = bearer || req.cookies?.[COOKIE_NAME] || req.cookies?.[LEGACY_COOKIE_NAME]
  if (!token) {
    req.user = null
    return next()
  }
  const decoded = verifyToken(token)
  if (!decoded || typeof decoded.sub !== 'string') {
    req.user = null
    return next()
  }
  req.user = { id: decoded.sub, email: decoded.email }
  next()
}

async function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentification requise.' })
  try {
    const [rows] = await pool.query('SELECT id, email, is_admin AS isAdmin FROM users WHERE id = :id LIMIT 1', {
      id: req.user.id,
    })
    if (!rows[0]) {
      clearAuthCookie(res)
      return res.status(401).json({ error: 'Session invalide.' })
    }
    req.user.email = rows[0].email
    req.user.isAdmin = Boolean(rows[0].isAdmin)
    next()
  } catch (e) {
    console.error('requireAuth', e)
    res.status(500).json({ error: 'Erreur de vérification de la session.' })
  }
}

async function requireApiKey(req, res, next) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!bearer || !bearer.startsWith('vel_sk_')) {
    return res.status(401).json({
      error: {
        message: 'Clé API Vryx requise. Utilisez Authorization: Bearer vel_sk_live_...',
        type: 'invalid_request_error',
      },
    })
  }
  try {
    const keyHash = apiKeyHash(bearer)
    const [rows] = await pool.query(
      `SELECT k.id, k.user_id AS userId, u.email
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = :keyHash
         AND k.revoked_at IS NULL
       LIMIT 1`,
      { keyHash },
    )
    const hit = rows[0]
    if (!hit) {
      return res.status(401).json({
        error: { message: 'Clé API Vryx invalide ou révoquée.', type: 'invalid_request_error' },
      })
    }
    await pool.query('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = :id', { id: hit.id })
    req.apiUser = { id: String(hit.userId), email: hit.email, keyId: String(hit.id) }
    return next()
  } catch (e) {
    console.error('api key auth', e)
    return res.status(500).json({
      error: { message: 'Erreur de vérification de la clé API.', type: 'server_error' },
    })
  }
}

async function getUserCreditBalance(userId, conn = pool) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(amount_eur), 0) AS balance
     FROM billing_credit_ledger
     WHERE user_id = :userId`,
    { userId },
  )
  return toEuroAmount(row?.balance || 0)
}

async function insertBillingLedgerEntry(conn, {
  userId,
  type,
  amountEur,
  description = null,
  referenceType = null,
  referenceId = null,
  metadata = null,
}) {
  const amount = toEuroAmount(amountEur)
  await conn.query(
    `INSERT INTO billing_credit_ledger
       (user_id, type, amount_eur, currency, description, reference_type, reference_id, metadata_json)
     VALUES
       (:userId, :type, :amountEur, 'EUR', :description, :referenceType, :referenceId, :metadataJson)`,
    {
      userId,
      type,
      amountEur: amount,
      description: description ? String(description).slice(0, 240) : null,
      referenceType: referenceType ? String(referenceType).slice(0, 80) : null,
      referenceId: referenceId ? String(referenceId).slice(0, 120) : null,
      metadataJson: metadata ? JSON.stringify(metadata) : null,
    },
  )
  return amount
}

async function ensureApiCreditForRequest(req, { prompt, maxTokens, model = null }) {
  const userId = Number(req.apiUser?.id)
  if (!Number.isFinite(userId) || userId <= 0) return { ok: true, estimatedCostEur: 0, balanceEur: 0 }
  const promptTokens = estimatePromptTokens(prompt)
  const completionTokens = Math.max(1, Math.floor(Number(maxTokens) || 0))
  const costBreakdown = await computeBillingCost({ model, promptTokens, completionTokens })
  const estimatedCostEur = costBreakdown.totalCostEur
  if (!VRYX_BILLING_ENFORCE_CREDITS) return { ok: true, estimatedCostEur, balanceEur: null }
  const balanceEur = await getUserCreditBalance(userId)
  if (balanceEur + 0.000001 < estimatedCostEur) {
    return { ok: false, estimatedCostEur, balanceEur }
  }
  return { ok: true, estimatedCostEur, balanceEur }
}

async function recordApiKeyUsage(req, { model, promptTokens = 0, completionTokens = 0, totalTokens = 0, latencyMs = 0, billingMode = 'public' } = {}) {
  const keyId = Number(req.apiUser?.keyId)
  const userId = Number(req.apiUser?.id)
  if (!Number.isFinite(keyId) || keyId <= 0 || !Number.isFinite(userId) || userId <= 0) return
  const prompt = Math.max(0, Math.floor(Number(promptTokens) || 0))
  const completion = Math.max(0, Math.floor(Number(completionTokens) || 0))
  const total = Math.max(prompt + completion, Math.floor(Number(totalTokens) || 0))
  const costBreakdown = await computeBillingCost({ model, promptTokens: prompt, completionTokens: completion, billingMode })
  const cost = costBreakdown.totalCostEur
  const pricingSnapshot = JSON.stringify({
    rates: costBreakdown.rates,
    billingMode: costBreakdown.billingMode,
    inputCostEur: costBreakdown.inputCostEur,
    outputCostEur: costBreakdown.outputCostEur,
  })
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query(
      `INSERT INTO api_key_usage
         (api_key_id, user_id, model, prompt_tokens, completion_tokens, total_tokens,
          cost_eur, cost_input_eur, cost_output_eur, billing_mode, pricing_snapshot_json, latency_ms)
       VALUES
         (:apiKeyId, :userId, :model, :promptTokens, :completionTokens, :totalTokens,
          :costEur, :costInputEur, :costOutputEur, :billingMode, :pricingSnapshot, :latencyMs)`,
      {
        apiKeyId: keyId,
        userId,
        model: typeof model === 'string' ? model.slice(0, 120) : null,
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
        costEur: cost,
        costInputEur: costBreakdown.inputCostEur,
        costOutputEur: costBreakdown.outputCostEur,
        billingMode,
        pricingSnapshot,
        latencyMs: Math.max(0, Math.floor(Number(latencyMs) || 0)),
      },
    )
    if (cost > 0) {
      await insertBillingLedgerEntry(conn, {
        userId,
        type: 'usage_debit',
        amountEur: -cost,
        description: `Usage API ${typeof model === 'string' ? model.slice(0, 80) : 'Vryx'}`,
        referenceType: 'api_key_usage',
        referenceId: String(result.insertId || ''),
        metadata: {
          apiKeyId: keyId,
          model: typeof model === 'string' ? model.slice(0, 120) : null,
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: total,
          latencyMs: Math.max(0, Math.floor(Number(latencyMs) || 0)),
        },
      })
    }
    await conn.commit()
    return { usageId: String(result.insertId || ''), costEur: cost }
  } catch (e) {
    await conn.rollback().catch(() => {})
    console.error('api key usage insert', e)
    return null
  } finally {
    conn.release()
  }
}

/** Vérifie en base que l'utilisateur courant est administrateur. */
async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentification requise.' })
  try {
    const [rows] = await pool.query(
      'SELECT is_admin FROM users WHERE id = :id LIMIT 1',
      { id: req.user.id },
    )
    if (!rows[0] || !rows[0].is_admin) {
      return res.status(403).json({ error: 'Accès réservé aux administrateurs.' })
    }
    req.user.isAdmin = true
    next()
  } catch (e) {
    console.error('requireAdmin', e)
    res.status(500).json({ error: 'Erreur de vérification des droits.' })
  }
}

const app = express()
app.set('trust proxy', 1)
const observability = createObservability({ serviceName: 'vryx-api' })

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    ...(NODE_ENV === 'production' ? {} : { contentSecurityPolicy: false }),
  }),
)
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true)
      return callback(null, CORS_ORIGINS.includes(origin.replace(/\/$/, '')))
    },
    credentials: true,
  }),
)
app.use(express.json({
  limit: JSON_BODY_LIMIT,
  verify: (req, _res, buf) => {
    if (req.originalUrl === '/api/billing/stripe/webhook') {
      req.rawBody = Buffer.from(buf)
    }
  },
}))
app.use(cookieParser())
app.use(csrfProtection)
app.use(authMiddleware)
registerObservabilityMiddleware(app, observability)

app.post('/api/internal/p2p-token-stream', (req, res) => {
  const streamId = typeof req.body?.stream_id === 'string' ? req.body.stream_id : ''
  const token = typeof req.body?.token === 'string' ? req.body.token : ''
  const event = typeof req.body?.event === 'string' ? req.body.event : 'token'
  const auth = String(req.headers.authorization || '')
  const stream = streamId ? p2pTokenStreams.get(streamId) : null
  if (!stream || auth !== `Bearer ${stream.secret}`) {
    return res.status(404).json({ ok: false })
  }
  if (event === 'token' && token) {
    stream.text += token
    if (typeof stream.onToken === 'function') stream.onToken(token)
    enqueueP2pTokenStream(stream, token, true)
  } else if (event === 'stage') {
    flushP2pTokenStream(stream)
    stream.send({ stage: 'worker_stream', status: String(req.body?.status || 'Token stream actif') })
  }
  res.json({ ok: true })
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Réessayez plus tard.' },
})

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion. Réessayez plus tard.' },
})

const enterpriseQuoteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de demandes Enterprise. Réessayez plus tard.' },
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/enterprise/quote', enterpriseQuoteLimiter, async (req, res) => {
  const parsed = enterpriseQuoteSchema.safeParse(req.body)
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0] || 'Demande Enterprise invalide.'
    return res.status(400).json({ ok: false, error: first })
  }
  const data = parsed.data
  const estimate = await estimateEnterpriseQuote(data)
  try {
    const [result] = await pool.query(
      `INSERT INTO enterprise_quote_requests
         (company, email, offer, monthly_tokens, latency_target_ms, privacy_level,
          fine_tuning, dedicated_workers, monthly_estimate_eur, setup_estimate_eur,
          notes, quote_json)
       VALUES
         (:company, :email, :offer, :monthlyTokens, :latencyTargetMs, :privacyLevel,
          :fineTuning, :dedicatedWorkers, :monthlyEstimateEur, :setupEstimateEur,
          :notes, :quoteJson)`,
      {
        company: data.company,
        email: data.email.toLowerCase(),
        offer: data.offer,
        monthlyTokens: Math.floor(data.monthlyTokens),
        latencyTargetMs: Math.floor(data.latencyTargetMs),
        privacyLevel: data.privacyLevel,
        fineTuning: data.fineTuning ? 1 : 0,
        dedicatedWorkers: Math.floor(data.dedicatedWorkers || 0),
        monthlyEstimateEur: estimate.monthlyEstimateEur,
        setupEstimateEur: estimate.setupEstimateEur,
        notes: data.notes || null,
        quoteJson: JSON.stringify({ input: data, estimate }),
      },
    )
    res.json({
      ok: true,
      id: String(result.insertId || ''),
      status: 'new',
      estimate,
    })
  } catch (e) {
    console.error('enterprise/quote', e)
    res.status(500).json({ ok: false, error: 'Impossible d’enregistrer la demande Enterprise.' })
  }
})

const openAiRouter = express.Router()
openAiRouter.use(requireApiKey)

function openAiModelId(raw) {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : 'Qwen/Qwen3.6-35B-A3B'
  const normalized = normalizeP2pModelId(value)
  if (/qwen.*3[.-]?6.*35/i.test(normalized) || /Qwen3\.6-35B/i.test(normalized)) return 'Qwen/Qwen3.6-35B-A3B'
  return normalized || 'Qwen/Qwen3.6-35B-A3B'
}

function modelSupportsVision(model) {
  return /(vision|vl|v-l|llava|pixtral|qwen.*vl|gemma.*it.*vision|mllama|multi[-_]?modal)/i.test(String(model || ''))
}

function normalizeChatAttachments(rawAttachments, model) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return { ok: true, attachments: [], promptSuffix: '' }
  const supportsVision = modelSupportsVision(model)
  const attachments = []
  const notes = []
  const rows = rawAttachments.slice(0, 6)
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const name = String(raw.name || 'fichier').replace(/[^\p{L}\p{N}_.\- ()[\]]/gu, '').slice(0, 120) || 'fichier'
    const mime = String(raw.type || 'application/octet-stream').slice(0, 80)
    const size = Math.max(0, Math.floor(Number(raw.size) || 0))
    const kind = String(raw.kind || '').toLowerCase() === 'image' || mime.startsWith('image/') ? 'image' : 'file'
    if (kind === 'image') {
      if (!supportsVision) {
        return { ok: false, error: `Le modèle ${model} ne supporte pas les images. Choisissez un modèle Vision/VL pour joindre ${name}.` }
      }
      if (size > 2_500_000) return { ok: false, error: `Image trop lourde (${name}). Limite: 2,5 Mo.` }
      const dataUrl = typeof raw.dataUrl === 'string' && raw.dataUrl.startsWith('data:image/') ? raw.dataUrl.slice(0, 3_500_000) : ''
      attachments.push({ kind, name, type: mime, size, dataUrl })
      notes.push(`[Image jointe: ${name} (${mime}, ${Math.round(size / 1024)} Ko)]`)
      continue
    }
    if (size > 400_000) return { ok: false, error: `Fichier trop lourd (${name}). Limite texte: 400 Ko.` }
    const text = typeof raw.text === 'string' ? raw.text.slice(0, 80_000) : ''
    if (!text.trim()) return { ok: false, error: `Le fichier ${name} n'est pas lisible en texte pour ce modèle.` }
    attachments.push({ kind, name, type: mime, size, text })
    notes.push(`--- Fichier joint: ${name} (${mime}, ${Math.round(size / 1024)} Ko) ---\n${text}`)
  }
  const promptSuffix = notes.length ? `\n\nContexte des pièces jointes:\n${notes.join('\n\n')}` : ''
  return { ok: true, attachments, promptSuffix }
}

function resolveOpenAiMaxTokens(body, hasTools) {
  const requestedRaw = Number(body?.max_tokens ?? body?.max_completion_tokens)
  const fallback = hasTools ? VRYX_OPENAI_TOOL_MIN_MAX_TOKENS : VRYX_OPENAI_DEFAULT_MAX_TOKENS
  const requested = Number.isFinite(requestedRaw) ? Math.max(1, Math.floor(requestedRaw)) : fallback
  const effective = hasTools ? Math.max(requested, VRYX_OPENAI_TOOL_MIN_MAX_TOKENS) : requested
  return Math.max(1, Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, effective))
}

function openAiMessagesToPrompt(messages) {
  if (!Array.isArray(messages)) return ''
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return ''
      const role = typeof message.role === 'string' ? message.role : 'user'
      const content = message.content
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        text = content
          .map((part) => {
            if (typeof part === 'string') return part
            if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
            return ''
          })
          .filter(Boolean)
          .join('\n')
      }
      return text.trim() ? `${role}: ${text.trim()}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

function openAiMessageContentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function latestUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message && typeof message === 'object' && message.role === 'user') {
      return openAiMessageContentToText(message.content)
    }
  }
  return ''
}

function allOpenAiMessagesText(messages) {
  if (!Array.isArray(messages)) return ''
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return ''
      const content = openAiMessageContentToText(message.content)
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
            .map((toolCall) => {
              const fn = toolCall?.function
              if (!fn || typeof fn !== 'object') return ''
              return [fn.name, fn.arguments].filter(Boolean).join(' ')
            })
            .join('\n')
        : ''
      return [content, toolCalls].filter(Boolean).join('\n')
    })
    .filter(Boolean)
    .join('\n')
}

function latestAssistantToolCallText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || typeof message !== 'object') continue
    if (message.role !== 'assistant') continue
    if (!Array.isArray(message.tool_calls)) continue
    return message.tool_calls
      .map((toolCall) => {
        const fn = toolCall?.function
        if (!fn || typeof fn !== 'object') return ''
        return [fn.name, fn.arguments].filter(Boolean).join(' ')
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function openAiToolName(tool) {
  if (!tool || typeof tool !== 'object') return ''
  if (tool.type === 'function' && tool.function && typeof tool.function.name === 'string') return tool.function.name
  if (typeof tool.name === 'string') return tool.name
  return ''
}

function openAiToolSchema(tool) {
  if (!tool || typeof tool !== 'object') return null
  if (tool.type === 'function' && tool.function && typeof tool.function === 'object') return tool.function
  return tool
}

function openAiToolsFromBody(body) {
  const tools = Array.isArray(body?.tools)
    ? body.tools
    : Array.isArray(body?.functions)
      ? body.functions.map((fn) => ({ type: 'function', function: fn }))
      : []
  return tools
    .map((tool) => ({ raw: tool, name: openAiToolName(tool), schema: openAiToolSchema(tool) }))
    .filter((tool) => tool.name)
}

function openAiToolPropertyNames(tool) {
  const properties = tool?.schema?.parameters?.properties
  return properties && typeof properties === 'object' ? Object.keys(properties) : []
}

function firstMatchingProperty(tool, patterns) {
  const props = openAiToolPropertyNames(tool)
  return props.find((prop) => patterns.some((pattern) => pattern.test(prop))) || ''
}

function setToolArg(args, key, value) {
  if (key && value !== undefined && value !== null) args[key] = value
}

function buildCommandToolArgs(tool, command, cwd = '') {
  const args = {}
  const commandKey = firstMatchingProperty(tool, [/^command$/i, /^cmd$/i, /shell/i, /terminal/i, /script/i])
  const cwdKey = firstMatchingProperty(tool, [/^cwd$/i, /working.*dir/i, /workdir/i])
  setToolArg(args, commandKey || openAiToolPropertyNames(tool)[0] || 'command', command)
  setToolArg(args, cwdKey, cwd)
  return args
}

function buildWriteFileToolArgs(tool, filePath, content) {
  const args = {}
  const pathKey = firstMatchingProperty(tool, [/^path$/i, /file.*path/i, /target.*file/i, /filename/i])
  const contentKey = firstMatchingProperty(tool, [/^content$/i, /^code$/i, /^text$/i, /new.*string/i])
  setToolArg(args, pathKey || openAiToolPropertyNames(tool)[0] || 'path', filePath)
  setToolArg(args, contentKey || openAiToolPropertyNames(tool)[1] || 'content', content)
  return args
}

function openAiToolInstruction(tools) {
  if (!tools.length) return ''
  const compactTools = tools.map((tool) => ({
    name: tool.name,
    description: tool.schema?.description || '',
    parameters: tool.schema?.parameters || {},
  }))
  return [
    'system: Tu es utilisé dans Cursor avec des outils locaux.',
    "Règle critique: si l'utilisateur demande de créer, modifier, lire des fichiers ou lancer une commande, tu ne dois jamais écrire la commande ou le contenu du fichier dans le chat.",
    'Réponds uniquement avec un appel outil au format strict suivant, sans Markdown et sans texte autour:',
    '{"tool_call":{"name":"NOM_OUTIL","arguments":{}}}',
    "Si tu viens de lire un fichier ou d'explorer le projet, enchaîne avec l'outil d'édition/écriture adapté. Ne répète pas ton plan.",
    "Ne mets jamais un script heredoc complet dans le message assistant. S'il faut modifier plusieurs fichiers, fais plusieurs appels outil courts.",
    'Après un résultat outil, continue avec le prochain appel outil nécessaire. Si aucune action outil n’est nécessaire, réponds normalement.',
    `Outils disponibles: ${JSON.stringify(compactTools)}`,
  ].join('\n')
}

function parseJsonToolCallText(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const candidates = []
  const trimmed = text.trim()
  candidates.push(trimmed)
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  const tagged = trimmed.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i)
  if (tagged) candidates.push(tagged[1].trim())
  const openTagged = trimmed.match(/<tool_call>\s*([\s\S]*)/i)
  if (openTagged) candidates.push(openTagged[1].trim())
  const objectLike = trimmed.match(/\{[\s\S]*\}/)
  if (objectLike) candidates.push(objectLike[0])
  for (const raw of candidates) {
    for (const candidate of extractJsonObjectCandidates(raw)) {
      try {
        const parsed = JSON.parse(candidate)
      const call = parsed?.tool_call || parsed?.toolCall || parsed
      if (call && typeof call === 'object' && typeof call.name === 'string') {
          const args =
            call.arguments && typeof call.arguments === 'object'
              ? call.arguments
              : Object.fromEntries(Object.entries(call).filter(([key]) => key !== 'name'))
          return { name: call.name, arguments: args && typeof args === 'object' ? args : {} }
        }
      } catch {
        // Continue with the next candidate.
      }
    }
  }
  return null
}

function extractJsonObjectCandidates(raw) {
  const source = String(raw || '').trim()
  if (!source) return []
  const out = [source]
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        out.push(source.slice(start, i + 1))
        start = -1
      }
    }
  }
  return [...new Set(out)]
}

function extractHtmlDocument(text) {
  if (typeof text !== 'string') return ''
  const start = text.search(/<!doctype html>|<html[\s>]/i)
  if (start < 0) return ''
  const html = text.slice(start)
  const end = html.search(/<\/html>/i)
  return end >= 0 ? html.slice(0, end + '</html>'.length) : html.trim()
}

function inferDirectoryFromText(text) {
  if (typeof text !== 'string') return ''
  const mkdir = text.match(/mkdir\s+-p\s+(['"]?)([^'"\n\r]+)\1/i)
  if (mkdir?.[2]) return sanitizeOpenAiLocalPath(mkdir[2])
  const path = text.match(/(\/Users\/[^\s'"]+\/[^\s'"]+)/)
  return sanitizeOpenAiLocalPath(path?.[1] || '')
}

function sanitizeOpenAiLocalPath(value) {
  return String(value || '')
    .trim()
    .replace(/[.,;:!?]+$/g, '')
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function buildStarterSiteCommand(dir) {
  const safeDir = sanitizeOpenAiLocalPath(dir)
  return `set -e
DIR=${shellSingleQuote(safeDir)}
mkdir -p "$DIR"
cat > "$DIR/index.html" <<'VRYX_EOF'
<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Futuristic</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main class="scene">
    <nav>
      <strong>FUTURISTIC</strong>
      <span>2026</span>
    </nav>
    <section class="hero">
      <p class="eyebrow">Interface neon</p>
      <h1>L'avenir commence ici.</h1>
      <p>Un site futuriste, fluide, prêt à être amélioré dans Cursor.</p>
      <button>Explorer</button>
    </section>
    <section class="grid">
      <article><span>01</span><h2>IA</h2><p>Automatisation créative et agents intelligents.</p></article>
      <article><span>02</span><h2>Quantum</h2><p>Calcul distribué et nouvelles architectures.</p></article>
      <article><span>03</span><h2>Immersion</h2><p>Expériences visuelles et interactions vivantes.</p></article>
    </section>
  </main>
  <script src="./script.js"></script>
</body>
</html>
VRYX_EOF
cat > "$DIR/styles.css" <<'VRYX_EOF'
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; color: #eef7ff; background: radial-gradient(circle at 20% 10%, #1dd6ff55, transparent 28%), radial-gradient(circle at 80% 0%, #a855f755, transparent 24%), #060810; overflow-x: hidden; }
body::before { content: ""; position: fixed; inset: 0; background-image: linear-gradient(#ffffff12 1px, transparent 1px), linear-gradient(90deg, #ffffff12 1px, transparent 1px); background-size: 48px 48px; mask-image: linear-gradient(to bottom, #000, transparent); pointer-events: none; }
.scene { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 32px 0 64px; }
nav { display: flex; justify-content: space-between; align-items: center; padding: 16px 0; color: #a9c7d8; letter-spacing: .18em; }
.hero { min-height: 58vh; display: grid; align-content: center; gap: 18px; }
.eyebrow { margin: 0; color: #67e8f9; text-transform: uppercase; letter-spacing: .28em; font-weight: 800; }
h1 { max-width: 820px; margin: 0; font-size: clamp(56px, 10vw, 138px); line-height: .86; letter-spacing: -0.04em; text-shadow: 0 0 40px #22d3ee66; }
.hero p:not(.eyebrow) { max-width: 560px; margin: 0; color: #b6c8d8; font-size: 20px; line-height: 1.7; }
button { width: fit-content; border: 1px solid #67e8f9aa; border-radius: 999px; padding: 14px 22px; color: #061018; background: linear-gradient(135deg, #67e8f9, #c084fc); font-weight: 900; cursor: pointer; box-shadow: 0 20px 80px #22d3ee44; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
article { min-height: 220px; border: 1px solid #ffffff18; border-radius: 24px; padding: 24px; background: linear-gradient(180deg, #ffffff14, #ffffff08); backdrop-filter: blur(18px); transition: transform .25s ease, border-color .25s ease; }
article:hover { transform: translateY(-6px); border-color: #67e8f9aa; }
article span { color: #67e8f9; font-weight: 900; }
article h2 { margin: 42px 0 8px; font-size: 30px; }
article p { margin: 0; color: #aab8c6; line-height: 1.6; }
@media (max-width: 760px) { .grid { grid-template-columns: 1fr; } h1 { font-size: 62px; } }
VRYX_EOF
cat > "$DIR/script.js" <<'VRYX_EOF'
document.querySelectorAll("article").forEach((card) => {
  card.addEventListener("pointermove", (event) => {
    const rect = card.getBoundingClientRect();
    card.style.background = \`radial-gradient(circle at \${event.clientX - rect.left}px \${event.clientY - rect.top}px, #67e8f933, #ffffff10 34%, #ffffff08)\`;
  });
});
VRYX_EOF`
}

function inferProjectRootFromMessages(messages) {
  const text = allOpenAiMessagesText(messages)
  const packagePath = text.match(/(\/Users\/[^\s'"]+?\/package\.json)\b/)?.[1]
  if (packagePath) return packagePath.replace(/\/package\.json$/, '')
  const srcPath = text.match(/(\/Users\/[^\s'"]+?\/(?:src|app|pages)\/[^\s'"]+)/)?.[1]
  if (srcPath) return srcPath.replace(/\/(?:src|app|pages)\/.*$/, '')
  const anyPath = text.match(/(\/Users\/[^\s'"]+)/)?.[1] || ''
  return sanitizeOpenAiLocalPath(anyPath)
}

function hasGeneratedLandingRecently(messages) {
  const text = latestAssistantToolCallText(messages)
  return /app\/page\.tsx|src\/app\/page\.tsx|index\.html|cat > .*page\.tsx|cat > .*index\.html/i.test(text)
}

function asksForLandingOrFrontend(text) {
  return /(landing|page|site|front[- ]?end|ui\/ux|designer|directeur artistique|cinematic|futuristic|futuriste|vryx\.eu)/i.test(
    String(text || ''),
  )
}

function buildNextLandingCommand(projectRoot) {
  const root = sanitizeOpenAiLocalPath(projectRoot)
  return `set -e
ROOT=${shellSingleQuote(root)}
mkdir -p "$ROOT/app"
cat > "$ROOT/app/page.tsx" <<'VRYX_EOF'
const signals = [
  ["Compute mesh", "Workers GPU synchronisés en temps réel"],
  ["Latency race", "Routage dynamique pour garder la génération fluide"],
  ["Model shards", "Chargement distribué des couches selon la VRAM"],
]

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#05070d] text-white">
      <section className="relative isolate flex min-h-screen items-center px-6 py-12 sm:px-10 lg:px-16">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_18%_20%,rgba(34,211,238,.38),transparent_28%),radial-gradient(circle_at_80%_10%,rgba(168,85,247,.32),transparent_26%),linear-gradient(135deg,#05070d,#0b1020_48%,#05070d)]" />
        <div className="absolute inset-0 -z-10 opacity-30 [background-image:linear-gradient(rgba(255,255,255,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.08)_1px,transparent_1px)] [background-size:48px_48px]" />
        <div className="mx-auto grid w-full max-w-7xl gap-12 lg:grid-cols-[1fr_420px] lg:items-center">
          <div>
            <p className="mb-6 inline-flex rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold uppercase tracking-[.28em] text-cyan-200">
              VRYX.EU
            </p>
            <h1 className="max-w-5xl text-balance text-6xl font-black leading-[.86] tracking-[-.06em] sm:text-7xl lg:text-8xl">
              L'inférence IA devient un réseau vivant.
            </h1>
            <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-slate-300 sm:text-xl">
              Une expérience ultra-futuriste pour connecter les GPU, distribuer les modèles et streamer les tokens avec une sensation instantanée.
            </p>
            <div className="mt-10 flex flex-col gap-4 sm:flex-row">
              <a className="rounded-full bg-cyan-200 px-7 py-4 font-bold text-slate-950 shadow-[0_0_60px_rgba(103,232,249,.35)]" href="#network">
                Explorer le réseau
              </a>
              <a className="rounded-full border border-white/15 px-7 py-4 font-bold text-white backdrop-blur transition hover:bg-white/10" href="https://vryx.eu/compte">
                Ouvrir la console
              </a>
            </div>
          </div>
          <div id="network" className="relative aspect-square rounded-[2rem] border border-white/10 bg-white/[.06] p-6 shadow-2xl backdrop-blur-xl">
            <div className="absolute inset-8 rounded-full border border-cyan-200/20" />
            <div className="absolute inset-20 rounded-full border border-fuchsia-300/20" />
            <div className="absolute left-1/2 top-1/2 h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-200 shadow-[0_0_90px_rgba(103,232,249,.8)]" />
            {signals.map(([title, body], index) => (
              <article key={title} className="absolute left-6 right-6 rounded-2xl border border-white/10 bg-black/35 p-4 backdrop-blur-md" style={{ top: \`\${18 + index * 27}%\` }}>
                <p className="text-sm font-bold text-cyan-200">{title}</p>
                <p className="mt-1 text-sm text-slate-300">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}
VRYX_EOF
cat > "$ROOT/app/globals.css" <<'VRYX_EOF'
@tailwind base;
@tailwind components;
@tailwind utilities;

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: #05070d; }
::selection { background: rgba(103,232,249,.32); }
VRYX_EOF
echo "Landing page VRYX créée dans $ROOT/app/page.tsx et $ROOT/app/globals.css"
`
}

function vryxLandingPageTsx() {
  return `const cards = [
  ["Mesh GPU", "Des workers synchronisés pour distribuer les calculs en temps réel."],
  ["Pipeline P2P", "Les tokens traversent le réseau avec une orchestration basse latence."],
  ["Shard loading", "Chaque machine charge uniquement ce que sa VRAM peut porter."],
]

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#05070d] text-white">
      <section className="relative isolate flex min-h-screen items-center px-6 py-12 sm:px-10 lg:px-16">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_16%_18%,rgba(34,211,238,.36),transparent_28%),radial-gradient(circle_at_78%_8%,rgba(168,85,247,.30),transparent_28%),linear-gradient(135deg,#05070d,#0b1020_48%,#05070d)]" />
        <div className="absolute inset-0 -z-10 opacity-25 [background-image:linear-gradient(rgba(255,255,255,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.08)_1px,transparent_1px)] [background-size:48px_48px]" />
        <div className="mx-auto grid w-full max-w-7xl gap-12 lg:grid-cols-[1fr_430px] lg:items-center">
          <div>
            <p className="mb-6 inline-flex rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold uppercase tracking-[.28em] text-cyan-200">
              VRYX.EU
            </p>
            <h1 className="max-w-5xl text-balance text-6xl font-black leading-[.86] tracking-[-.06em] sm:text-7xl lg:text-8xl">
              L'inférence IA devient un réseau vivant.
            </h1>
            <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-slate-300 sm:text-xl">
              Une landing page cinématique pour connecter les GPU, distribuer les modèles et streamer les tokens avec une sensation instantanée.
            </p>
            <div className="mt-10 flex flex-col gap-4 sm:flex-row">
              <a className="rounded-full bg-cyan-200 px-7 py-4 font-bold text-slate-950 shadow-[0_0_60px_rgba(103,232,249,.35)]" href="#network">
                Explorer le réseau
              </a>
              <a className="rounded-full border border-white/15 px-7 py-4 font-bold text-white backdrop-blur transition hover:bg-white/10" href="https://vryx.eu/compte">
                Ouvrir la console
              </a>
            </div>
          </div>
          <div id="network" className="relative rounded-[2rem] border border-white/10 bg-white/[.06] p-6 shadow-2xl backdrop-blur-xl">
            <div className="mb-6 flex items-center justify-between text-sm text-slate-300">
              <span>Live compute graph</span>
              <span className="rounded-full bg-emerald-300/15 px-3 py-1 text-emerald-200">ONLINE</span>
            </div>
            <div className="grid gap-4">
              {cards.map(([title, body]) => (
                <article key={title} className="rounded-2xl border border-white/10 bg-black/35 p-5 backdrop-blur-md transition hover:border-cyan-200/50 hover:bg-cyan-200/10">
                  <p className="text-lg font-bold text-cyan-200">{title}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-300">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
`
}

function vryxLandingGlobalsCss() {
  return `@tailwind base;
@tailwind components;
@tailwind utilities;

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: #05070d; }
::selection { background: rgba(103,232,249,.32); }
`
}

function buildWriteToolCall(toolName, filePath, content) {
  return {
    name: toolName,
    arguments: {
      path: filePath,
      content,
    },
  }
}

function synthesizeToolCallFromText(text, tools) {
  const structured = parseJsonToolCallText(text)
  if (structured) {
    if (!tools.length || tools.some((candidate) => candidate.name === structured.name)) return structured
  }
  if (!tools.length) return null
  const commandTool = tools.find((tool) => /(terminal|shell|bash|cmd|command|run)/i.test(tool.name))
  const writeTool = tools.find((tool) => /(edit|write|create|file|apply)/i.test(tool.name) && !/(read|list|search|grep)/i.test(tool.name))
  const mkdir = text.match(/mkdir\s+-p\s+(['"]?)([^'"\n\r]+)\1/i)
  if (mkdir && commandTool) {
    const command = `mkdir -p ${JSON.stringify(sanitizeOpenAiLocalPath(mkdir[2]))}`
    return { name: commandTool.name, arguments: buildCommandToolArgs(commandTool, command) }
  }
  const html = extractHtmlDocument(text)
  if (html && writeTool) {
    const dir = inferDirectoryFromText(text)
    const filePath = dir ? `${dir.replace(/\/$/, '')}/index.html` : 'index.html'
    return { name: writeTool.name, arguments: buildWriteFileToolArgs(writeTool, filePath, html) }
  }
  return null
}

function looksLikeToolCallPrefix(text) {
  const value = String(text || '').trimStart()
  return /^<tool_call\b/i.test(value) || /^\{[\s\n\r]*"(tool_call|toolCall|name)"/i.test(value)
}

function openAiToolCallChunk({ id, created, model, toolCall }) {
  const toolCallId = toolCall.id || `call_${crypto.randomUUID().replace(/-/g, '')}`
  return [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: toolCallId,
                type: 'function',
                function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments || {}) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
  ]
}

function openAiToolCallResponse({ id, created, model, toolCall, usage = {} }) {
  const toolCallId = toolCall.id || `call_${crypto.randomUUID().replace(/-/g, '')}`
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: toolCallId,
              type: 'function',
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments || {}) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: Number(usage.prompt_tokens || 0),
      completion_tokens: Number(usage.completion_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0),
    },
  }
}

function directToolCallFromMessages(messages, tools) {
  if (!Array.isArray(messages)) return null
  const text = latestUserText(messages)
  if (!text) return null
  const commandTool = tools.find((tool) => /(terminal|shell|bash|cmd|command|run)/i.test(tool.name))
  const writeTool = tools.find((tool) => /^(write|edit)$/i.test(tool.name) || /(write|edit|create|file|apply)/i.test(tool.name))
  const writeToolName = writeTool?.name || 'Write'
  const last = messages[messages.length - 1]
  const projectRoot = inferProjectRootFromMessages(messages)
  const wantsLanding = asksForLandingOrFrontend(text)
  if (last && typeof last === 'object' && (last.role === 'tool' || last.role === 'function') && wantsLanding && projectRoot) {
    const history = allOpenAiMessagesText(messages)
    const pagePath = `${projectRoot.replace(/\/$/, '')}/app/page.tsx`
    const globalsPath = `${projectRoot.replace(/\/$/, '')}/app/globals.css`
    if (!history.includes(pagePath) && !/app\/page\.tsx/i.test(history)) {
      return buildWriteToolCall(writeToolName, pagePath, vryxLandingPageTsx())
    }
    if (!history.includes(globalsPath) && !/app\/globals\.css/i.test(history)) {
      return buildWriteToolCall(writeToolName, globalsPath, vryxLandingGlobalsCss())
    }
    return null
  }
  if (!commandTool) return null
  if (last && typeof last === 'object' && (last.role === 'tool' || last.role === 'function')) return null
  const path = sanitizeOpenAiLocalPath(text.match(/(\/Users\/[^\s'"]+\/[^\s'"]+)/)?.[1] || '')
  const asksCreateProject = /(crée|cree|create|fais|faire|génère|genere|make|build).{0,120}(dossier|folder|site|projet|project|app)/i.test(text)
  if (path && asksCreateProject) {
    return null
  }
  const explicitMkdir = text.match(/mkdir\s+-p\s+(['"]?)([^'"\n\r]+)\1/i)
  if (explicitMkdir?.[2]) {
    const command = `mkdir -p ${JSON.stringify(sanitizeOpenAiLocalPath(explicitMkdir[2]))}`
    return { name: commandTool.name, arguments: buildCommandToolArgs(commandTool, command) }
  }
  return null
}

function sendOpenAiSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
  if (typeof res.flush === 'function') res.flush()
}

openAiRouter.get('/models', async (_req, res) => {
  try {
    const models = await discoverAvailableModels()
    res.json({
      object: 'list',
      data: models.map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: 'vryx',
        context_length: 32768,
        max_completion_tokens: VRYX_P2P_ADMIN_MAX_NEW_TOKENS,
      })),
    })
  } catch (e) {
    console.error('v1/models', e)
    res.status(500).json({ error: { message: 'Impossible de lister les modèles Vryx.', type: 'server_error' } })
  }
})

openAiRouter.post('/chat/completions', async (req, res) => {
  const model = openAiModelId(req.body?.model)
  const tools = openAiToolsFromBody(req.body)
  const toolInstruction = openAiToolInstruction(tools)
  const prompt = [toolInstruction, openAiMessagesToPrompt(req.body?.messages)].filter(Boolean).join('\n\n')
  if (!prompt) {
    return res.status(400).json({
      error: { message: 'messages requis.', type: 'invalid_request_error' },
    })
  }
  const maxTokens = resolveOpenAiMaxTokens(req.body, tools.length > 0)
  const temperatureRaw = Number(req.body?.temperature ?? 0)
  const temperature = Number.isFinite(temperatureRaw) ? Math.max(0, Math.min(2, temperatureRaw)) : 0
  const stream = req.body?.stream === true
  const id = `chatcmpl-vryx-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const directToolCall = directToolCallFromMessages(req.body?.messages, tools)
  if (directToolCall) {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders?.()
      for (const chunk of openAiToolCallChunk({ id, created, model, toolCall: directToolCall })) sendOpenAiSse(res, chunk)
      res.write('data: [DONE]\n\n')
      return res.end()
    }
    return res.json(openAiToolCallResponse({ id, created, model, toolCall: directToolCall }))
  }
  const creditCheck = await ensureApiCreditForRequest(req, { prompt, maxTokens })
  if (!creditCheck.ok) {
    return res.status(402).json({
      error: {
        message: `Crédits API insuffisants. Solde ${toEuroAmount(creditCheck.balanceEur, 4)} €, coût estimé ${toEuroAmount(creditCheck.estimatedCostEur, 4)} €.`,
        type: 'insufficient_quota',
        code: 'insufficient_vryx_credits',
      },
    })
  }
  const requestedQuantization = ['q4', 'int8', 'fp16'].includes(req.body?.quantization) ? req.body.quantization : 'q4'
  const chatBody = {
    prompt,
    model_id: model,
    quantization: requestedQuantization,
    hidden_transport: requestedQuantization,
    pool_preference: 'velocity_mlx',
    max_new_tokens: maxTokens,
    temperature,
    top_p: Number(req.body?.top_p ?? 0.65) || 0.65,
    top_k: 20,
    repetition_penalty: 1.08,
  }
  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders?.()
      let streamedText = ''
      let streamedTokenCount = 0
      let finalData = null
      const upstream = await fetch(`${VRYX_INITIATOR_CHAT_URL}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify(chatBody),
      })
      if (!upstream.ok || !upstream.body) {
        throw new Error(`Initiateur indisponible (${upstream.status})`)
      }
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const rawLine = line.trim()
          if (!rawLine) continue
          let evt = null
          try {
            evt = JSON.parse(rawLine)
          } catch {
            continue
          }
          if (evt.event === 'token' && typeof evt.token === 'string' && evt.token) {
            streamedText += evt.token
            streamedTokenCount += 1
            sendOpenAiSse(res, {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: evt.token }, finish_reason: null }],
            })
          } else if (evt.event === 'done' || evt.done) {
            let doneData = {}
            if (evt && typeof evt.json === 'string' && evt.json.trim()) {
              try {
                doneData = JSON.parse(evt.json)
              } catch {
                doneData = {}
              }
            } else if (evt && evt.json && typeof evt.json === 'object') {
              doneData = evt.json
            }
            finalData = doneData
          } else if (evt.event === 'error' || evt.error) {
            sendOpenAiSse(res, { error: { message: String(evt.error || 'Erreur Vryx'), type: 'server_error' } })
          }
        }
      }
      if (buffer.trim()) {
        try {
          const evt = JSON.parse(buffer.trim())
          if (evt.event === 'done' || evt.done) {
            let doneData = {}
            if (evt && typeof evt.json === 'string' && evt.json.trim()) {
              try {
                doneData = JSON.parse(evt.json)
              } catch {
                doneData = {}
              }
            } else if (evt && evt.json && typeof evt.json === 'object') {
              doneData = evt.json
            }
            finalData = doneData
          }
        } catch {
          /* ignore */
        }
      }
      const promptEstTokens = Math.max(1, Math.round(prompt.length / 4))
      const promptTokens = Number(finalData?.prompt_tokens || promptEstTokens)
      const completionTokens = Number(finalData?.completion_tokens || streamedTokenCount)
      const totalTokens = Number(finalData?.total_tokens || (promptTokens + completionTokens))
      await recordApiKeyUsage(req, {
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        latencyMs: Date.now() - created * 1000,
      }).catch(err => console.error('Error recording API key usage for stream:', err))
      const toolCall = synthesizeToolCallFromText(streamedText, tools)
      if (toolCall) {
        for (const chunk of openAiToolCallChunk({ id, created, model, toolCall })) sendOpenAiSse(res, chunk)
      } else {
        sendOpenAiSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })
      }
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    const openAiStartedAt = Date.now()
    const upstream = await fetch(`${VRYX_INITIATOR_CHAT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody),
    })
    const data = await upstream.json().catch(() => null)
    if (!upstream.ok || !data || data.ok === false) {
      return res.status(upstream.status >= 400 ? upstream.status : 502).json({
        error: { message: String(data?.error || 'Erreur Vryx.'), type: 'server_error' },
      })
    }
    const text = typeof data.response === 'string' ? data.response : ''
    const toolCall = synthesizeToolCallFromText(text, tools)
    const usage = {
      prompt_tokens: Number(data.prompt_tokens || 0),
      completion_tokens: Number(data.completion_tokens || 0),
      total_tokens: Number(data.total_tokens || 0),
    }
    await recordApiKeyUsage(req, {
      model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      latencyMs: Date.now() - openAiStartedAt,
    })
    if (toolCall) {
      return res.json(
        openAiToolCallResponse({
          id,
          created,
          model,
          toolCall,
          usage,
        }),
      )
    }
    return res.json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: (data.pipeline_trace && data.pipeline_trace.stop_reason) || 'stop',
        },
      ],
      usage,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Erreur Vryx.'
    if (stream && !res.headersSent) {
      return res.status(502).json({ error: { message, type: 'server_error' } })
    }
    if (stream) {
      sendOpenAiSse(res, { error: { message, type: 'server_error' } })
      return res.end()
    }
    return res.status(502).json({ error: { message, type: 'server_error' } })
  }
})

app.use('/v1', openAiRouter)

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const parsed = registerBodySchema.safeParse(req.body)
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors
    const first = Object.values(msg).flat()[0] || 'Données invalides.'
    return res.status(400).json({ error: first })
  }
  const { email, password } = parsed.data
  try {
    const hash = await bcrypt.hash(password, 12)
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES (:email, :hash)',
      { email, hash },
    )
    const id = String(result.insertId)
    // Promotion automatique : la 1re inscription d'un e-mail admin force is_admin = 1.
    let isAdmin = FORCED_ADMIN_EMAILS.includes(email)
    if (isAdmin) {
      await pool
        .query('UPDATE users SET is_admin = 1 WHERE id = :id', { id })
        .catch(() => {})
    }
    const token = signToken({ sub: id, email })
    setAuthCookie(res, token)
    return res.status(201).json({ user: { id, email, isAdmin }, token })
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Cette adresse e-mail est déjà utilisée.' })
    }
    console.error('register', e)
    return res.status(500).json({ error: 'Une erreur est survenue. Réessayez plus tard.' })
  }
})

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const parsed = loginBodySchema.safeParse(req.body)
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors
    const first = Object.values(msg).flat()[0] || 'Données invalides.'
    return res.status(400).json({ error: first })
  }
  const { email, password } = parsed.data
  try {
    const [rows] = await pool.query(
      'SELECT id, password_hash AS h, is_admin AS isAdmin FROM users WHERE email = :email LIMIT 1',
      { email },
    )
    const row = rows[0]
    const ok = row && (await bcrypt.compare(password, row.h))
    if (!ok) {
      return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' })
    }
    const id = String(row.id)
    let isAdmin = !!row.isAdmin
    if (!isAdmin && FORCED_ADMIN_EMAILS.includes(email)) {
      await pool.query('UPDATE users SET is_admin = 1 WHERE id = :id', { id }).catch(() => {})
      isAdmin = true
    }
    await pool
      .query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id', { id })
      .catch(() => {})
    const token = signToken({ sub: id, email })
    setAuthCookie(res, token)
    return res.json({ user: { id, email, isAdmin }, token })
  } catch (e) {
    console.error('login', e)
    const code = e?.code
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
      return res.status(503).json({ error: 'Service temporairement indisponible (base de données).' })
    }
    if (typeof code === 'string' && code.startsWith('ER_')) {
      return res.status(503).json({ error: 'Service temporairement indisponible. Réessayez plus tard.' })
    }
    return res.status(500).json({ error: 'Une erreur est survenue. Réessayez plus tard.' })
  }
})

app.post('/api/auth/logout', (_req, res) => {
  clearAuthCookie(res)
  res.json({ ok: true })
})

app.get('/api/auth/me', async (req, res) => {
  if (!req.user) {
    return res.json({ user: null })
  }
  try {
    const [rows] = await pool.query(
      'SELECT id, email, is_admin AS isAdmin FROM users WHERE id = :id AND email = :email LIMIT 1',
      { id: req.user.id, email: req.user.email },
    )
    const row = rows[0]
    if (!row) {
      clearAuthCookie(res)
      return res.json({ user: null })
    }
    return res.json({
      user: { id: String(row.id), email: row.email, isAdmin: !!row.isAdmin },
    })
  } catch (e) {
    console.error('me', e)
    return res.status(500).json({ error: 'Une erreur est survenue.' })
  }
})

app.post('/api/auth/desktop-callback', authLimiter, async (req, res) => {
  const parsed = desktopAuthCallbackSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Token invalide.' })
  const decoded = verifyToken(parsed.data.token)
  if (!decoded || typeof decoded.sub !== 'string') return res.status(401).json({ error: 'Session expirée.' })
  try {
    const [rows] = await pool.query(
      'SELECT id, email, is_admin AS isAdmin FROM users WHERE id = :id LIMIT 1',
      { id: decoded.sub },
    )
    const row = rows[0]
    if (!row) return res.status(401).json({ error: 'Utilisateur introuvable.' })
    return res.json({ user: { id: String(row.id), email: row.email, isAdmin: !!row.isAdmin }, token: parsed.data.token })
  } catch (e) {
    console.error('desktop callback', e)
    return res.status(500).json({ error: 'Une erreur est survenue.' })
  }
})

function sanitizeNextPath(next) {
  if (typeof next !== 'string') return '/'
  const cleaned = next.trim()
  if (cleaned.startsWith('/') && !cleaned.startsWith('//') && !cleaned.includes('://')) {
    return cleaned
  }
  return '/'
}

app.get('/api/auth/google/start', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(501).send('Connexion Google non configurée sur le serveur.')
  }
  const nextParam = sanitizeNextPath(req.query.next)
  const stateToken = jwt.sign({
    desktop: req.query.desktop === '1',
    next: nextParam,
  }, JWT_SECRET, { expiresIn: '15m' })
  const redirectUri = getGoogleRedirectUri(req)
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', stateToken)
  url.searchParams.set('prompt', 'select_account')
  res.redirect(url.toString())
})

function parseGoogleState(rawState) {
  let state = { desktop: false, next: '/' }
  try {
    const decoded = jwt.verify(rawState, JWT_SECRET)
    if (decoded && typeof decoded === 'object') {
      state = {
        desktop: Boolean(decoded.desktop),
        next: sanitizeNextPath(decoded.next),
      }
    }
  } catch {
    try {
      const parsed = JSON.parse(Buffer.from(String(rawState || ''), 'base64url').toString('utf8'))
      if (parsed && typeof parsed === 'object') {
        state = {
          desktop: parsed.desktop === '1' || parsed.desktop === true,
          next: sanitizeNextPath(parsed.next),
        }
      }
    } catch {
      /* ignore */
    }
  }
  return state && typeof state === 'object' ? state : { desktop: false, next: '/' }
}

function getGoogleRedirectUri(req) {
  return GOOGLE_OAUTH_REDIRECT_URI || `${req.protocol}://${req.get('host')}/compte`
}

async function finishGoogleAuth({ code, rawState, redirectUri }) {
  const state = parseGoogleState(rawState)
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    const tokenJson = await tokenRes.json()
    if (!tokenRes.ok) {
      const reason = typeof tokenJson.error_description === 'string' ? tokenJson.error_description : 'Google a refusé la connexion.'
      return { ok: false, status: 401, error: reason }
    }
    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    })
    const profile = await userRes.json()
    const email = emailSchema.parse(profile.email)
    const googleId = String(profile.sub || '')
    if (!googleId) return { ok: false, status: 401, error: 'Profil Google incomplet.' }
    const [rows] = await pool.query('SELECT id, is_admin AS isAdmin FROM users WHERE email = :email OR google_id = :googleId LIMIT 1', { email, googleId })
    let id = rows[0]?.id ? String(rows[0].id) : ''
    let isAdmin = !!rows[0]?.isAdmin || FORCED_ADMIN_EMAILS.includes(email)
    if (!id) {
      const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12)
      const [result] = await pool.query(
        'INSERT INTO users (email, password_hash, google_id, is_admin, last_login_at) VALUES (:email, :hash, :googleId, :isAdmin, CURRENT_TIMESTAMP)',
        { email, hash, googleId, isAdmin: isAdmin ? 1 : 0 },
      )
      id = String(result.insertId)
    } else {
      await pool.query(
        'UPDATE users SET google_id = COALESCE(google_id, :googleId), is_admin = GREATEST(is_admin, :isAdmin), last_login_at = CURRENT_TIMESTAMP WHERE id = :id',
        { id, googleId, isAdmin: isAdmin ? 1 : 0 },
      ).catch(() => {})
    }
    const token = signToken({ sub: id, email })
    return {
      ok: true,
      state,
      token,
      user: { id, email, isAdmin },
    }
  } catch (e) {
    console.error('google auth', e)
    return { ok: false, status: 500, error: 'Connexion Google impossible.' }
  }
}

app.post('/api/auth/google/finish', authLimiter, async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.status(501).json({ error: 'Connexion Google non configurée.' })
  const parsed = googleFinishSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Code Google manquant.' })
  const redirectUri = getGoogleRedirectUri(req)
  const out = await finishGoogleAuth({
    code: parsed.data.code,
    rawState: parsed.data.state,
    redirectUri,
  })
  if (!out.ok) return res.status(out.status).json({ error: out.error })
  setAuthCookie(res, out.token)
  return res.json({
    user: out.user,
    token: out.token,
    desktop: !!out.state.desktop,
    next: typeof out.state.next === 'string' ? out.state.next : '/',
  })
})

app.get('/api/auth/google/callback', async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.status(501).send('Connexion Google non configurée.')
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  if (!code) return res.status(400).send('Code Google manquant.')
  const redirectUri = getGoogleRedirectUri(req)
  const out = await finishGoogleAuth({
    code,
    rawState: req.query.state,
    redirectUri,
  })
  if (!out.ok) return res.status(out.status).send(out.error)
  setAuthCookie(res, out.token)
  if (out.state.desktop) {
    return res.redirect(`vryx://auth?token=${encodeURIComponent(out.token)}`)
  }
  return res.redirect(typeof out.state.next === 'string' ? out.state.next : '/compte')
})

const accountRouter = express.Router()
accountRouter.use(requireAuth)

const accountChatLimiter = rateLimit({ windowMs: 60_000, max: 30, message: { error: 'Trop de messages. Patientez un instant.' } })

accountRouter.get('/overview', async (req, res) => {
  try {
    const userId = req.user.id
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    const [[userRow]] = await pool.query(
      'SELECT email, last_login_at AS lastLoginAt FROM users WHERE id = :id LIMIT 1',
      { id: userId },
    )
    if (!userRow) {
      clearAuthCookie(res)
      return res.status(401).json({ error: 'Session invalide.' })
    }

    const [sessionRows] = await pool.query(
      'SELECT session_json AS sessionJson FROM p2p_chat_sessions WHERE user_id = :userId AND created_at >= :monthStart ORDER BY created_at DESC',
      { userId, monthStart },
    )
    let monthTokens = 0
    let completionTokensMonth = 0
    const latencySamples = []
    const tpsSamples = []
    const pingSamples = []
    for (const row of sessionRows) {
      const parsed = parseJsonSafe(row.sessionJson)
      const promptTokens = toNumber(parsed?.promptTokens, 0)
      const completionTokens = toNumber(parsed?.completionTokens, 0)
      const sessionTotal =
        toNumber(parsed?.totalTokens, promptTokens + completionTokens) ||
        toNumber(parsed?.metrics?.total_tokens, 0)
      monthTokens += sessionTotal
      completionTokensMonth += completionTokens
      const latencyMs = toNumber(parsed?.latencyMs, 0) || toNumber(parsed?.computeTimeMs, 0)
      if (latencyMs > 0) latencySamples.push(latencyMs)
      const pingMs = toNumber(parsed?.pingMs, 0) || toNumber(parsed?.pipelineTrace?.ping_ms, 0) || toNumber(parsed?.pipeline_trace?.ping_ms, 0)
      if (pingMs > 0) pingSamples.push(pingMs)
      const tps =
        toNumber(parsed?.hotPathTps, 0) ||
        (completionTokens > 0 && latencyMs > 0 ? completionTokens / (latencyMs / 1000) : 0)
      if (tps > 0) tpsSamples.push(tps)
    }

    const [keyRows] = await pool.query(
      'SELECT COUNT(*) AS activeApiKeys FROM api_keys WHERE user_id = :userId AND revoked_at IS NULL',
      { userId },
    )
    const [[apiUsageMonth]] = await pool.query(
      `SELECT COUNT(*) AS apiRequests,
              COALESCE(SUM(total_tokens), 0) AS apiTokens,
              COALESCE(SUM(cost_eur), 0) AS apiCostEur
       FROM api_key_usage
       WHERE user_id = :userId
         AND created_at >= :monthStart`,
      { userId, monthStart },
    )

    const apiTokensMonth = Number(apiUsageMonth?.apiTokens || 0)
    const apiCostMonth = Number(apiUsageMonth?.apiCostEur || 0)
    monthTokens += apiTokensMonth
    const requestsThisMonth = Number(sessionRows.length) + Number(apiUsageMonth?.apiRequests || 0)
    const usagePercent = clampPercent((monthTokens / VRYX_ACCOUNT_MONTHLY_TOKEN_BUDGET) * 100)
    const billingRate = await resolveBillingEurPerMillion()
    const spendThisMonth = toEuroAmount(toMoneyAmount(monthTokens - apiTokensMonth, billingRate) + apiCostMonth, 4)
    const costPerMillionTokens = monthTokens > 0 ? spendThisMonth / (monthTokens / 1_000_000) : billingRate
    const estimatedGrossMarginEur = spendThisMonth * (VRYX_ESTIMATED_GROSS_MARGIN / 100)
    const estimatedWorkerRewardsEur = spendThisMonth * (VRYX_WORKER_REWARD_SHARE / 100)
    const creditBalance = await getUserCreditBalance(userId)
    const [workerRows] = await pool.query(
      `SELECT
         COUNT(*) AS totalWorkers,
         SUM(CASE WHEN TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) <= :liveSec THEN 1 ELSE 0 END) AS liveWorkers,
         AVG(CASE
           WHEN first_seen_at IS NULL OR last_heartbeat_at IS NULL THEN NULL
           ELSE LEAST(1, GREATEST(0, TIMESTAMPDIFF(SECOND, first_seen_at, last_heartbeat_at) / GREATEST(1, TIMESTAMPDIFF(SECOND, first_seen_at, NOW()))))
         END) AS avgUptimeRatio
       FROM workers
       WHERE user_id = :userId`,
      { userId, liveSec: WORKER_LIVE_SEC },
    )
    const workerStats = workerRows[0] || {}

    res.json({
      user: { id: String(userId), email: userRow.email },
      plan: ACCOUNT_PLAN_NAME,
      monthlyTokenBudget: VRYX_ACCOUNT_MONTHLY_TOKEN_BUDGET,
      balanceCurrency: 'EUR',
      balanceCredits: creditBalance,
      usagePercent,
      tokensUsed: monthTokens,
      tokensQuota: VRYX_ACCOUNT_MONTHLY_TOKEN_BUDGET,
      requestsThisMonth,
      activeApiKeys: Number(keyRows[0]?.activeApiKeys || 0),
      spendThisMonth,
      nextInvoiceEstimate: spendThisMonth,
      investorMetrics: {
        latencyP50Ms: percentile(latencySamples, 50),
        latencyP95Ms: percentile(latencySamples, 95),
        tpsP50: percentile(tpsSamples, 50),
        tpsP95: percentile(tpsSamples, 95),
        pingP50Ms: percentile(pingSamples, 50),
        pingP95Ms: percentile(pingSamples, 95),
        costPerMillionTokens,
        estimatedGrossMarginPercent: VRYX_ESTIMATED_GROSS_MARGIN,
        estimatedGrossMarginEur,
        estimatedWorkerRewardsEur,
        completionTokens: completionTokensMonth,
        liveWorkers: Number(workerStats.liveWorkers || 0),
        totalWorkers: Number(workerStats.totalWorkers || 0),
        avgWorkerUptimePercent: clampPercent(Number(workerStats.avgUptimeRatio || 0) * 100),
        sampleSize: latencySamples.length,
      },
      lastLoginAt: toIsoDate(userRow.lastLoginAt),
    })
  } catch (e) {
    console.error('account/overview', e)
    res.status(500).json({ error: 'Impossible de charger le résumé de compte.' })
  }
})

accountRouter.get('/billing', async (req, res) => {
  try {
    const userId = req.user.id
    const [ledgerRows] = await pool.query(
      `SELECT id, type, amount_eur AS amountEur, currency, description,
              reference_type AS referenceType, reference_id AS referenceId, created_at AS createdAt
       FROM billing_credit_ledger
       WHERE user_id = :userId
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
      { userId },
    )
    const [[usageMonth]] = await pool.query(
      `SELECT COUNT(*) AS requestCount,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(cost_eur), 0) AS costEur
       FROM api_key_usage
       WHERE user_id = :userId
         AND created_at >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01')`,
      { userId },
    )
    res.json({
      ok: true,
      currency: 'EUR',
      balanceEur: await getUserCreditBalance(userId),
      enforceCredits: VRYX_BILLING_ENFORCE_CREDITS,
      checkoutEnabled: Boolean(STRIPE_SECRET_KEY),
      packages: await getBillingCreditPackages(),
      monthUsage: {
        requestCount: Number(usageMonth?.requestCount || 0),
        totalTokens: Number(usageMonth?.totalTokens || 0),
        costEur: Number(usageMonth?.costEur || 0),
      },
      ledger: ledgerRows.map((row) => ({
        id: String(row.id),
        type: row.type,
        amountEur: Number(row.amountEur || 0),
        currency: row.currency || 'EUR',
        description: row.description || '',
        referenceType: row.referenceType || null,
        referenceId: row.referenceId || null,
        createdAt: toIsoDate(row.createdAt),
      })),
    })
  } catch (e) {
    console.error('account/billing', e)
    res.status(500).json({ error: 'Impossible de charger la facturation.' })
  }
})

accountRouter.post('/billing/checkout', async (req, res) => {
  const parsed = accountCheckoutSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Montant invalide.' })
  const amountEur = toEuroAmount(parsed.data.amountEur, 2)
  const packages = await getBillingCreditPackages()
  const pricing = await getPricingConfig(pool, PRICING_FALLBACK)
  const minRecharge = pricing.recharge?.minEur ?? 20
  if (amountEur + 0.0001 < minRecharge) {
    return res.status(400).json({ error: `Recharge minimale : ${minRecharge} €.` })
  }
  if (!packages.includes(amountEur)) {
    return res.status(400).json({ error: 'Pack de crédits indisponible.' })
  }
  if (!STRIPE_SECRET_KEY) {
    return res.status(501).json({ error: 'Checkout Stripe non configuré côté serveur.' })
  }
  try {
    const userId = String(req.user.id)
    const successUrl = `${VRYX_APP_BASE_URL}/compte/facturation?checkout=success`
    const cancelUrl = `${VRYX_APP_BASE_URL}/compte/facturation?checkout=cancelled`
    const params = new URLSearchParams()
    params.set('mode', 'payment')
    params.set('success_url', successUrl)
    params.set('cancel_url', cancelUrl)
    params.set('client_reference_id', userId)
    params.set('customer_email', req.user.email || '')
    params.set('line_items[0][quantity]', '1')
    params.set('line_items[0][price_data][currency]', 'eur')
    params.set('line_items[0][price_data][unit_amount]', String(Math.round(amountEur * 100)))
    params.set('line_items[0][price_data][product_data][name]', `Crédits API Vryx ${amountEur} EUR`)
    params.set('metadata[user_id]', userId)
    params.set('metadata[vryx_credit_amount_eur]', String(amountEur))
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    })
    const stripeData = await stripeRes.json().catch(() => null)
    if (!stripeRes.ok || !stripeData?.id || !stripeData?.url) {
      return res.status(502).json({ error: String(stripeData?.error?.message || 'Stripe a refusé la session checkout.') })
    }
    await pool.query(
      `INSERT INTO billing_checkout_sessions
         (user_id, provider, provider_session_id, amount_eur, currency, status, checkout_url, metadata_json)
       VALUES
         (:userId, 'stripe', :providerSessionId, :amountEur, 'EUR', :status, :checkoutUrl, :metadataJson)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         checkout_url = VALUES(checkout_url),
         metadata_json = VALUES(metadata_json),
         updated_at = CURRENT_TIMESTAMP`,
      {
        userId,
        providerSessionId: stripeData.id,
        amountEur,
        status: String(stripeData.status || 'created').slice(0, 40),
        checkoutUrl: stripeData.url,
        metadataJson: JSON.stringify({ stripe: { id: stripeData.id }, amountEur }),
      },
    )
    res.json({ ok: true, provider: 'stripe', sessionId: stripeData.id, url: stripeData.url })
  } catch (e) {
    console.error('account/billing/checkout', e)
    res.status(500).json({ error: 'Impossible de créer le paiement.' })
  }
})

accountRouter.get('/api-keys', async (req, res) => {
  try {
    const userId = req.user.id
    const [rows] = await pool.query(
      `SELECT
         k.id,
         k.name,
         k.key_prefix AS keyPrefix,
         k.created_at AS createdAt,
         k.last_used_at AS lastUsedAt,
         COALESCE(u.requestCount, 0) AS requestCount,
         COALESCE(u.totalTokens, 0) AS totalTokens,
         COALESCE(u.promptTokens, 0) AS promptTokens,
         COALESCE(u.completionTokens, 0) AS completionTokens,
         COALESCE(u.costEur, 0) AS costEur,
         COALESCE(u.avgLatencyMs, 0) AS avgLatencyMs
       FROM api_keys k
       LEFT JOIN (
         SELECT
           api_key_id,
           COUNT(*) AS requestCount,
           SUM(total_tokens) AS totalTokens,
           SUM(prompt_tokens) AS promptTokens,
           SUM(completion_tokens) AS completionTokens,
           SUM(cost_eur) AS costEur,
           AVG(latency_ms) AS avgLatencyMs
         FROM api_key_usage
         WHERE user_id = :userId
         GROUP BY api_key_id
       ) u ON u.api_key_id = k.id
       WHERE k.user_id = :userId
         AND k.revoked_at IS NULL
       ORDER BY k.created_at DESC`,
      { userId },
    )
    res.json({
      keys: rows.map((r) => ({
        id: String(r.id),
        name: r.name,
        keyPrefix: r.keyPrefix,
        createdAt: toIsoDate(r.createdAt),
        lastUsedAt: toIsoDate(r.lastUsedAt),
        requestCount: Number(r.requestCount || 0),
        totalTokens: Number(r.totalTokens || 0),
        promptTokens: Number(r.promptTokens || 0),
        completionTokens: Number(r.completionTokens || 0),
        costEur: Number(r.costEur || 0),
        avgLatencyMs: Number(r.avgLatencyMs || 0),
      })),
    })
  } catch (e) {
    console.error('account/api-keys', e)
    res.status(500).json({ error: 'Impossible de charger les clés API.' })
  }
})

accountRouter.get('/models', async (_req, res) => {
  try {
    const models = await discoverAvailableModels()
    res.json({
      models,
      defaultModel: models.find((model) => model.runnable)?.id || null,
      discovery: {
        liveWindowSec: WORKER_LIVE_SEC,
        autoRefresh: true,
      },
    })
  } catch (e) {
    console.error('account/models', e)
    res.status(500).json({ error: 'Impossible de charger les modèles disponibles.' })
  }
})

accountRouter.get('/workers', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT peer_id AS peerId, mode, grpc_port AS grpcPort, p2p_port AS p2pPort, public_ip AS publicIp,
              version, p2p_peers AS p2pPeers, tokens_generated AS tokensGenerated,
              tokens_in AS tokensIn, tokens_out AS tokensOut, model,
              gpu_name AS gpuName, gpu_vram_mb AS gpuVramMb,
              allocated_vram_mb AS allocatedVramMb, memory_limit_percent AS memoryLimitPercent,
              runtime_backend AS runtimeBackend, weight_quantization AS weightQuantization,
              supports_q4_weights AS supportsQ4Weights, supports_mlx AS supportsMlx, supports_vllm AS supportsVllm,
              machine_info AS machineInfo,
              last_heartbeat_at AS lastHeartbeatAt, first_seen_at AS firstSeenAt,
              TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
       FROM workers
       WHERE user_id = :userId
       ORDER BY last_heartbeat_at DESC`,
      { userId: req.user.id },
    )
    res.json({
      workers: rows.map((r) => ({
        peerId: r.peerId,
        mode: r.mode,
        grpcPort: r.grpcPort,
        p2pPort: r.p2pPort,
        publicIp: r.publicIp,
        version: r.version,
        p2pPeers: Number(r.p2pPeers || 0),
        tokensGenerated: Number(r.tokensGenerated || 0),
        tokensIn: Number(r.tokensIn || 0),
        tokensOut: Number(r.tokensOut || 0),
        model: r.model ?? null,
        gpuName: r.gpuName ?? null,
        gpuVramMb: Number(r.gpuVramMb || 0),
        allocatedVramMb: Number(r.allocatedVramMb || 0),
        memoryLimitPercent: Number(r.memoryLimitPercent || 0),
        runtimeBackend: r.runtimeBackend ?? null,
        weightQuantization: r.weightQuantization ?? null,
        supportsQ4Weights: Boolean(r.supportsQ4Weights),
        supportsMlx: Boolean(r.supportsMlx),
        supportsVllm: Boolean(r.supportsVllm),
        machineInfo: parseMaybeJsonObject(r.machineInfo),
        lastHeartbeatAt: toIsoDate(r.lastHeartbeatAt),
        firstSeenAt: toIsoDate(r.firstSeenAt),
        secondsSinceHeartbeat: Number(r.secondsSinceHeartbeat || 0),
        online: Number(r.secondsSinceHeartbeat || 999999) <= WORKER_LIVE_SEC,
      })),
    })
  } catch (e) {
    console.error('account/workers', e)
    res.status(500).json({ error: 'Impossible de charger les workers.' })
  }
})

accountRouter.post('/api-keys', async (req, res) => {
  const parsed = accountApiKeySchema.safeParse(req.body)
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors
    const first = Object.values(msg).flat()[0] || 'Données invalides.'
    return res.status(400).json({ error: first })
  }
  const raw = newApiKeyPrefix()
  const keyPrefix = `${raw.slice(0, 17)}…`
  try {
    const [result] = await pool.query(
      `INSERT INTO api_keys (user_id, name, key_hash, key_prefix)
       VALUES (:userId, :name, :keyHash, :keyPrefix)`,
      { userId: req.user.id, name: parsed.data.name, keyHash: apiKeyHash(raw), keyPrefix },
    )
    res.status(201).json({
      key: {
        id: String(result.insertId),
        name: parsed.data.name,
        keyPrefix,
        createdAt: new Date().toISOString(),
      },
      plainKey: raw,
    })
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Veuillez réessayer, la génération de clé a collisionné.' })
    }
    console.error('account/api-keys create', e)
    res.status(500).json({ error: 'Impossible de créer la clé API.' })
  }
})

accountRouter.delete('/api-keys/:id', async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Identifiant de clé invalide.' })
  try {
    const [result] = await pool.query(
      'UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = :id AND user_id = :userId AND revoked_at IS NULL',
      { id, userId: req.user.id },
    )
    if (Number(result.affectedRows || 0) <= 0) {
      return res.status(404).json({ error: 'Clé introuvable.' })
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('account/api-keys delete', e)
    res.status(500).json({ error: 'Impossible de révoquer la clé.' })
  }
})

accountRouter.get('/sessions', async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 75))
  try {
    const [rows] = await pool.query(
      `SELECT id, prompt, response, session_json AS sessionJson, created_at AS createdAt
       FROM p2p_chat_sessions
       WHERE user_id = :userId
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      { userId: req.user.id },
    )
    const sessions = rows.map(toUserSessionSummary)
    res.json({ sessions })
  } catch (e) {
    console.error('account/sessions', e)
    res.status(500).json({ error: 'Impossible de charger les sessions.' })
  }
})

accountRouter.get('/sessions/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, prompt, response, session_json AS sessionJson, created_at AS createdAt
       FROM p2p_chat_sessions
       WHERE id = :id AND user_id = :userId
       LIMIT 1`,
      { id: String(req.params.id || '').trim(), userId: req.user.id },
    )
    if (!rows[0]) return res.status(404).json({ error: 'Session introuvable.' })
    res.json({ session: toUserSessionSummary(rows[0]) })
  } catch (e) {
    console.error('account/sessions detail', e)
    res.status(500).json({ error: 'Impossible de charger le détail session.' })
  }
})

accountRouter.post('/chat', accountChatLimiter, async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-16) : []
  const fallbackPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  let prompt = openAiMessagesToPrompt(messages) || fallbackPrompt
  if (!prompt.trim()) return res.status(400).json({ error: 'Message requis.' })

  const model = openAiModelId(req.body?.model)
  const attachmentResult = normalizeChatAttachments(req.body?.attachments, model)
  if (!attachmentResult.ok) return res.status(400).json({ error: attachmentResult.error })
  prompt += attachmentResult.promptSuffix
  const conversationId =
    typeof req.body?.conversation_id === 'string' && /^[a-zA-Z0-9:_-]{8,80}$/.test(req.body.conversation_id)
      ? req.body.conversation_id
      : `account-conv-${crypto.randomUUID()}`
  const firstUserMessage = messages.filter((message) => message?.role === 'user' && typeof message.content === 'string').at(-1)?.content || fallbackPrompt || prompt
  const requestedMaxTokens = Number(req.body?.max_tokens ?? req.body?.max_new_tokens)
  const maxTokens = Number.isFinite(requestedMaxTokens)
    ? Math.max(64, Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, Math.floor(requestedMaxTokens)))
    : Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, 8192)
  const temperatureRaw = Number(req.body?.temperature ?? 0.2)
  const temperature = Number.isFinite(temperatureRaw) ? Math.max(0, Math.min(1.5, temperatureRaw)) : 0.2
  const requestedQuantization = ['q4', 'int8', 'fp16'].includes(req.body?.quantization) ? req.body.quantization : 'q4'
  const chatBody = {
    prompt,
    model_id: model,
    quantization: requestedQuantization,
    hidden_transport: requestedQuantization,
    pool_preference: 'velocity_mlx',
    max_new_tokens: maxTokens,
    temperature,
    top_p: Number(req.body?.top_p ?? 0.65) || 0.65,
    top_k: 20,
    repetition_penalty: 1.08,
  }

  try {
    const startedAt = Date.now()
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(45_000)
      : undefined
    const upstream = await fetch(`${VRYX_INITIATOR_CHAT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody),
      signal,
    })
    const data = await upstream.json().catch(() => null)
    if (!upstream.ok || !data || data.ok === false) {
      return res.status(upstream.status >= 400 ? upstream.status : 502).json({
        error: String(data?.error || 'Erreur Vryx. Aucun worker compatible ne répond pour le moment.'),
      })
    }
    const text = typeof data.response === 'string' ? data.response : ''
    const latencyMs = Date.now() - startedAt
    const conversationTitle = await generateConversationTitleWithAi({
      userId: req.user.id,
      conversationId,
      model,
      firstUserMessage,
      assistantReply: text,
    })
    const session = {
      id: `account-chat-${crypto.randomUUID()}`,
      prompt,
      response: text,
      model,
      promptTokens: Number(data.prompt_tokens || 0),
      completionTokens: Number(data.completion_tokens || 0),
      totalTokens: Number(data.total_tokens || 0),
      latencyMs,
      computeTimeMs: Number(data.compute_time_ms || data.pipeline_trace?.compute_time_ms || latencyMs),
      mode: 'account_chat',
      conversationId,
      conversationTitle,
      attachments: attachmentResult.attachments.map((item) => ({ ...item, dataUrl: item.dataUrl ? '[image-data]' : undefined })),
      pipelineOk: true,
      metrics: data.metrics || null,
      pipeline_trace: sanitizePipelineTraceForAdmin(data.pipeline_trace || null),
    }
    await pool
      .query(
        `INSERT INTO p2p_chat_sessions (id, user_id, prompt, response, session_json)
         VALUES (:id, :userId, :prompt, :response, :sessionJson)
         ON DUPLICATE KEY UPDATE
           prompt = VALUES(prompt),
           response = VALUES(response),
           session_json = VALUES(session_json),
           updated_at = CURRENT_TIMESTAMP`,
        {
          id: session.id,
          userId: req.user.id,
          prompt,
          response: text,
          sessionJson: JSON.stringify(session),
        },
      )
      .catch((e) => console.error('account/chat session save', e))

    res.json({
      ok: true,
      message: text,
      session,
      conversationId,
      usage: {
        promptTokens: session.promptTokens,
        completionTokens: session.completionTokens,
        totalTokens: session.totalTokens,
        latencyMs,
        conversationTitle,
      },
    })
  } catch (e) {
    console.error('account/chat', e)
    res.status(502).json({ error: e instanceof Error ? e.message : 'Erreur Vryx.' })
  }
})

accountRouter.post('/chat/stream', accountChatLimiter, async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-16) : []
  const fallbackPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  let prompt = openAiMessagesToPrompt(messages) || fallbackPrompt
  if (!prompt.trim()) return res.status(400).json({ error: 'Message requis.' })

  const model = openAiModelId(req.body?.model)
  const attachmentResult = normalizeChatAttachments(req.body?.attachments, model)
  if (!attachmentResult.ok) return res.status(400).json({ error: attachmentResult.error })
  prompt += attachmentResult.promptSuffix
  const conversationId =
    typeof req.body?.conversation_id === 'string' && /^[a-zA-Z0-9:_-]{8,80}$/.test(req.body.conversation_id)
      ? req.body.conversation_id
      : `account-conv-${crypto.randomUUID()}`
  const firstUserMessage = messages.filter((message) => message?.role === 'user' && typeof message.content === 'string').at(-1)?.content || fallbackPrompt || prompt
  const requestedMaxTokens = Number(req.body?.max_tokens ?? req.body?.max_new_tokens)
  const maxTokens = Number.isFinite(requestedMaxTokens)
    ? Math.max(64, Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, Math.floor(requestedMaxTokens)))
    : Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, 8192)
  const requestedQuantization = ['q4', 'int8', 'fp16'].includes(req.body?.quantization) ? req.body.quantization : 'q4'

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (typeof res.flush === 'function') res.flush()
  }

  if (isUserPipelineChatActive(req.user.id)) {
    send({ error: 'Une génération P2P est déjà en cours. Attendez la fin du stream actuel.', retryable: true })
    return res.end()
  }

  const startedAt = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 180_000)
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n')
    if (typeof res.flush === 'function') res.flush()
  }, 12000)
  let streamedReply = ''
  let completionFragments = 0
  const { streamId, secret: streamSecret } = createP2pTokenStream(send, (token) => {
    streamedReply += token
    completionFragments += 1
  })

  req.on('close', () => {
    clearTimeout(timer)
    clearInterval(keepAlive)
    p2pTokenStreams.delete(streamId)
    ctrl.abort()
  })

  const saveSession = async (data) => {
    const text = typeof data?.response === 'string' ? data.response : streamedReply
    const latencyMs = Date.now() - startedAt
    const promptTokens = Number(data?.prompt_tokens || 0)
    const completionTokens = Number(data?.completion_tokens || completionFragments || 0)
    const totalTokens = Number(data?.total_tokens || promptTokens + completionTokens)
    const conversationTitle = await generateConversationTitleWithAi({
      userId: req.user.id,
      conversationId,
      model,
      firstUserMessage,
      assistantReply: text,
    })
    const session = {
      id: `account-chat-${crypto.randomUUID()}`,
      prompt,
      response: text,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      latencyMs,
      computeTimeMs: Number(data?.compute_time_ms || data?.pipeline_trace?.compute_time_ms || latencyMs),
      mode: 'account_chat_stream',
      conversationId,
      conversationTitle,
      attachments: attachmentResult.attachments.map((item) => ({ ...item, dataUrl: item.dataUrl ? '[image-data]' : undefined })),
      pipelineOk: data?.ok !== false,
      metrics: data?.metrics || null,
      pipeline_trace: sanitizePipelineTraceForAdmin(data?.pipeline_trace || null),
    }
    await pool
      .query(
        `INSERT INTO p2p_chat_sessions (id, user_id, prompt, response, session_json)
         VALUES (:id, :userId, :prompt, :response, :sessionJson)`,
        {
          id: session.id,
          userId: req.user.id,
          prompt,
          response: text,
          sessionJson: JSON.stringify(session),
        },
      )
      .catch((e) => console.error('account/chat stream session save', e))
    return session
  }

  const readDonePayload = (evt) => {
    if (evt?.json && typeof evt.json === 'object') return evt.json
    if (typeof evt?.json === 'string' && evt.json.trim()) {
      try {
        return JSON.parse(evt.json)
      } catch {
        return {}
      }
    }
    return evt && typeof evt === 'object' ? evt : {}
  }

  pipelineChatBegin(req.user.id)
  try {
    send({ stage: 'queued', status: 'Connexion au pipeline P2P...' })
    const tokenStreamCallbackUrl =
      process.env.VRYX_TOKEN_STREAM_CALLBACK_URL ||
      `${NODE_ENV === 'production' ? 'https' : req.protocol}://${req.get('host')}/api/internal/p2p-token-stream`
    const chatBody = {
      prompt,
      model_id: model,
      quantization: requestedQuantization,
      hidden_transport: requestedQuantization,
      pool_preference: 'velocity_mlx',
      max_new_tokens: maxTokens,
      temperature: 0.2,
      top_p: 0.65,
      top_k: 20,
      repetition_penalty: 1.08,
      stream_id: streamId,
      stream_secret: streamSecret,
      stream_callback_url: tokenStreamCallbackUrl,
      attachments: attachmentResult.attachments,
    }

    let finalData = null
    const upstream = await fetch(`${VRYX_INITIATOR_CHAT_URL}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(chatBody),
      signal: ctrl.signal,
    }).catch(() => null)

    if (upstream?.ok && upstream.body) {
      send({ stage: 'stream', status: 'Stream ouvert.' })
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const raw = line.trim()
          if (!raw) continue
          let evt = null
          try {
            evt = JSON.parse(raw)
          } catch {
            continue
          }
          if (evt.event === 'token' && typeof evt.token === 'string') {
            streamedReply += evt.token
            completionFragments += 1
            send({ token: evt.token })
          } else if (evt.event === 'done' || evt.done) {
            finalData = readDonePayload(evt)
          } else if (evt.event === 'error' || evt.error) {
            send({ error: String(evt.error || 'Erreur stream initiateur.') })
            return res.end()
          }
        }
      }
    }

    if (!finalData && !streamedReply) {
      send({ stage: 'fallback', status: 'Stream natif indisponible, génération HTTP...' })
      const fallback = await fetch(`${VRYX_INITIATOR_CHAT_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chatBody),
        signal: ctrl.signal,
      })
      const data = await fallback.json().catch(() => null)
      if (!fallback.ok || !data || data.ok === false) {
        send({ error: String(data?.error || 'Erreur Vryx. Aucun worker compatible ne répond pour le moment.') })
        return res.end()
      }
      const text = typeof data.response === 'string' ? data.response : ''
      streamedReply = text
      for (let i = 0; i < text.length; i += 12) {
        send({ token: text.slice(i, i + 12) })
      }
      finalData = data
    }

    const session = await saveSession({ ...(finalData || {}), response: finalData?.response || streamedReply })
    send({
      done: true,
      session,
      usage: {
        promptTokens: session.promptTokens,
        completionTokens: session.completionTokens,
        totalTokens: session.totalTokens,
        latencyMs: session.latencyMs,
        tps: session.completionTokens > 0 && session.latencyMs > 0 ? session.completionTokens / (session.latencyMs / 1000) : 0,
        conversationId,
        conversationTitle: session.conversationTitle,
      },
    })
  } catch (e) {
    send({ error: e?.name === 'AbortError' ? 'Timeout P2P côté compte.' : e instanceof Error ? e.message : 'Erreur Vryx.' })
  } finally {
    clearTimeout(timer)
    clearInterval(keepAlive)
    p2pTokenStreams.delete(streamId)
    pipelineChatEnd(req.user.id)
    res.end()
  }
})

accountRouter.delete('/sessions/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'Identifiant de session invalide.' })
    const [result] = await pool.query(
      'DELETE FROM p2p_chat_sessions WHERE id = :id AND user_id = :userId',
      { id, userId: req.user.id },
    )
    if (Number(result.affectedRows || 0) <= 0) {
      return res.status(404).json({ error: 'Session introuvable.' })
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('account/sessions delete', e)
    res.status(500).json({ error: 'Impossible de supprimer la session.' })
  }
})

accountRouter.delete('/sessions', async (req, res) => {
  try {
    await pool.query('DELETE FROM p2p_chat_sessions WHERE user_id = :userId', { userId: req.user.id })
    res.json({ ok: true })
  } catch (e) {
    console.error('account/sessions clear', e)
    res.status(500).json({ error: 'Impossible de vider l’historique des sessions.' })
  }
})

app.use('/api/account', accountRouter)

app.post('/api/internal/bench/chat', accountChatLimiter, async (req, res) => {
  if (!VRYX_BENCH_TOKEN) return res.status(404).json({ ok: false })
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const headerToken = String(req.headers['x-vryx-bench-token'] || '').trim()
  const token = bearer || headerToken
  if (!tokenMatchesSecret(token, VRYX_BENCH_TOKEN)) {
    return res.status(401).json({ ok: false, error: 'bench_unauthorized' })
  }
  try {
    const upstream = await fetch(`${VRYX_INITIATOR_CHAT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(Math.max(30_000, Math.min(2_400_000, Number(process.env.VRYX_BENCH_HTTP_TIMEOUT_MS || 600_000))))
        : undefined,
    })
    const text = await upstream.text()
    res.status(upstream.status)
    res.type(upstream.headers.get('content-type') || 'application/json')
    return res.send(text)
  } catch (e) {
    console.error('internal/bench/chat', e?.name === 'AbortError' ? 'timeout' : e)
    return res.status(502).json({ ok: false, error: e?.name === 'AbortError' ? 'bench_timeout' : 'bench_proxy_failed' })
  }
})

function verifyStripeWebhookSignature(req) {
  if (!STRIPE_WEBHOOK_SECRET) return true
  const signature = String(req.headers['stripe-signature'] || '')
  const rawBody = req.rawBody
  if (!signature || !rawBody) return false
  const parts = Object.fromEntries(
    signature
      .split(',')
      .map((part) => part.split('='))
      .filter((pair) => pair.length === 2)
      .map(([key, value]) => [key.trim(), value.trim()]),
  )
  const timestamp = parts.t
  const expected = parts.v1
  if (!timestamp || !expected) return false
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp))
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false
  const payload = `${timestamp}.${rawBody.toString('utf8')}`
  const digest = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(payload).digest('hex')
  return tokenMatchesSecret(digest, expected)
}

app.post('/api/billing/stripe/webhook', async (req, res) => {
  if (!STRIPE_SECRET_KEY) return res.status(501).json({ ok: false, error: 'Stripe non configuré.' })
  if (!verifyStripeWebhookSignature(req)) return res.status(400).json({ ok: false, error: 'Signature Stripe invalide.' })
  try {
    const eventId = typeof req.body?.id === 'string' ? req.body.id : ''
    let event = req.body
    if (eventId) {
      const stripeRes = await fetch(`https://api.stripe.com/v1/events/${encodeURIComponent(eventId)}`, {
        headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
      })
      const stripeEvent = await stripeRes.json().catch(() => null)
      if (stripeRes.ok && stripeEvent?.id) event = stripeEvent
    }
    const type = String(event?.type || '')
    if (type !== 'checkout.session.completed') return res.json({ ok: true, ignored: type || 'unknown' })
    const session = event?.data?.object || {}
    if (session.payment_status && session.payment_status !== 'paid') {
      return res.json({ ok: true, ignored: `payment_status=${session.payment_status}` })
    }
    const providerSessionId = String(session.id || '')
    const userId = Number(session.metadata?.user_id || session.client_reference_id || 0)
    const amountEur = toEuroAmount(
      Number(session.metadata?.vryx_credit_amount_eur || 0) || Number(session.amount_total || 0) / 100,
    )
    if (!providerSessionId || !Number.isFinite(userId) || userId <= 0 || amountEur <= 0) {
      return res.status(400).json({ ok: false, error: 'Webhook Stripe incomplet.' })
    }
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await conn.query(
        `INSERT INTO billing_checkout_sessions
           (user_id, provider, provider_session_id, amount_eur, currency, status, checkout_url, metadata_json)
         VALUES
           (:userId, 'stripe', :providerSessionId, :amountEur, 'EUR', 'paid', :checkoutUrl, :metadataJson)
         ON DUPLICATE KEY UPDATE
           status = 'paid',
           amount_eur = VALUES(amount_eur),
           metadata_json = VALUES(metadata_json),
           updated_at = CURRENT_TIMESTAMP`,
        {
          userId,
          providerSessionId,
          amountEur,
          checkoutUrl: session.url || null,
          metadataJson: JSON.stringify({ eventId: event.id || null, providerSessionId, amountEur }),
        },
      )
      const [existing] = await conn.query(
        `SELECT id FROM billing_credit_ledger
         WHERE user_id = :userId
           AND reference_type = 'stripe_checkout_session'
           AND reference_id = :providerSessionId
         LIMIT 1`,
        { userId, providerSessionId },
      )
      if (!existing[0]) {
        await insertBillingLedgerEntry(conn, {
          userId,
          type: 'credit_purchase',
          amountEur,
          description: `Achat crédits Stripe ${amountEur} EUR`,
          referenceType: 'stripe_checkout_session',
          referenceId: providerSessionId,
          metadata: { eventId: event.id || null, paymentIntent: session.payment_intent || null },
        })
      }
      await conn.commit()
      res.json({ ok: true, credited: !existing[0], amountEur, userId: String(userId) })
    } catch (e) {
      await conn.rollback().catch(() => {})
      throw e
    } finally {
      conn.release()
    }
  } catch (e) {
    console.error('billing/stripe/webhook', e)
    res.status(500).json({ ok: false, error: 'Webhook billing impossible.' })
  }
})

app.get('/compte', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  if (!code) return res.redirect('/compte/')
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.status(501).send('Connexion Google non configurée.')
  const redirectUri = getGoogleRedirectUri(req)
  const out = await finishGoogleAuth({
    code,
    rawState: req.query.state,
    redirectUri,
  })
  if (!out.ok) return res.status(out.status).send(out.error)
  setAuthCookie(res, out.token)
  if (out.state.desktop) {
    return res.redirect(`vryx://auth?token=${encodeURIComponent(out.token)}`)
  }
  return res.redirect(typeof out.state.next === 'string' ? out.state.next : '/compte/')
})

// ===========================================================================
//                        ROUTES WORKERS (publiques + admin)
// ===========================================================================

/** Seuil présence dans `/api/workers/status` (utilisé par l’initiateur Rust pour re-découvrir les workers).
 * Cette route alimente le scheduler : elle ne doit jamais exposer des heartbeats très vieux comme "online".
 * Pour l'historique long, utiliser les routes admin/registered plutôt que ce statut live.
 */
const WORKER_OFFLINE_SEC = Math.min(
  5 * 60,
  Math.max(120, Number(process.env.WORKER_OFFLINE_SEC) || 180),
)

registerPublicStatusRoutes(app, {
  pool,
  discoverAvailableModels,
  workerLiveSec: WORKER_LIVE_SEC,
  workerOfflineSec: WORKER_OFFLINE_SEC,
  eurPerMillion: VRYX_EUR_PER_MILLION,
  grossMarginPercent: VRYX_ESTIMATED_GROSS_MARGIN,
  workerRewardSharePercent: VRYX_WORKER_REWARD_SHARE,
  getPricingConfig: () => getPricingConfig(pool, PRICING_FALLBACK),
})

function publicPricingDto(pricing, extras = {}) {
  const published = Boolean(pricing.pricingPublished)
  const headline = pricing.headline || { minInputEurPerMillion: 0.02, minOutputEurPerMillion: 0.06 }
  const blended = published
    ? (pricing.eurPerMillionTokens ?? null)
    : null
  return {
    published,
    headline: published ? headline : null,
    minInputEurPerMillion: published ? headline.minInputEurPerMillion : null,
    minOutputEurPerMillion: published ? headline.minOutputEurPerMillion : null,
    blendedInputRatioPercent: pricing.blendedInputRatioPercent ?? 75,
    /** @deprecated use headline + per-model pricing */
    eurPerMillionTokens: published ? blended : null,
    eurPerThousandTokens: published && blended != null ? Number((blended / 1000).toFixed(6)) : null,
    vatPercent: pricing.vatPercent,
    workerRewardSharePercent: pricing.workerRewardSharePercent,
    defaultWorkerSharePercent: pricing.defaultWorkerSharePercent ?? 60,
    estimatedGrossMarginPercent: pricing.estimatedGrossMarginPercent,
    volumeDiscounts: pricing.volumeDiscounts,
    recharge: pricing.recharge,
    privatePoolTokenDiscountPercent: pricing.privatePoolTokenDiscountPercent ?? 30,
    minVryxNetMarginPercent: pricing.minVryxNetMarginPercent ?? 20,
    subscriptionPlans: extras.subscriptionPlans || [],
    privatePoolPlans: extras.privatePoolPlans || [],
    fineTuningPlans: extras.fineTuningPlans || [],
    pricingTiers: extras.pricingTiers || [],
    updatedAt: pricing.updatedAt,
  }
}

async function publicModelsWithRuntime({ includeInactive = false, includePrivate = false } = {}) {
  const [catalog, runtimeModels] = await Promise.all([
    getPublicModels(pool, PRICING_FALLBACK, { includeInactive, includePrivate }),
    discoverAvailableModels().catch(() => []),
  ])
  const runtimeByKey = new Map()
  for (const model of runtimeModels || []) {
    const keys = [model.id, model.label].map(normalizeP2pModelKey).filter(Boolean)
    for (const key of keys) runtimeByKey.set(key, model)
  }
  return catalog.map((model) => {
    const runtime = runtimeByKey.get(normalizeP2pModelKey(model.hfId || model.id)) || runtimeByKey.get(normalizeP2pModelKey(model.name))
    return {
      ...model,
      workersOnline: Number(runtime?.workersOnline || 0),
      workersTotal: Number(runtime?.workersTotal || 0),
      requiredWorkers: Number(model.requiredWorkers || runtime?.requiredWorkers || 1),
      runnable: Boolean(runtime?.runnable),
      ready: Boolean(runtime?.ready),
      lastSeenAt: runtime?.lastSeenAt || null,
    }
  })
}

app.get('/api/public/pricing', async (_req, res) => {
  try {
    const bundle = await getPublicPricingBundle(pool, PRICING_FALLBACK)
    res.json({
      ok: true,
      pricing: publicPricingDto(bundle.pricing, {
        subscriptionPlans: bundle.subscriptionPlans,
        privatePoolPlans: bundle.privatePoolPlans,
        fineTuningPlans: bundle.fineTuningPlans,
        pricingTiers: bundle.tiers,
      }),
    })
  } catch (e) {
    console.error('public/pricing', e)
    res.status(500).json({ error: 'Erreur lecture pricing.' })
  }
})

app.get('/api/public/models', async (_req, res) => {
  try {
    const bundle = await getPublicPricingBundle(pool, PRICING_FALLBACK)
    const models = await publicModelsWithRuntime()
    res.json({
      ok: true,
      pricing: publicPricingDto(bundle.pricing, {
        subscriptionPlans: bundle.subscriptionPlans,
        privatePoolPlans: bundle.privatePoolPlans,
        fineTuningPlans: bundle.fineTuningPlans,
        pricingTiers: bundle.tiers,
      }),
      models,
    })
  } catch (e) {
    console.error('public/models', e)
    res.status(500).json({ error: 'Erreur lecture modèles.' })
  }
})

/** Cible interdite pour sondes latence depuis le VPS (boucle locale / métadonnées). */
function forbiddenWorkerProbeHost(ip) {
  const s = String(ip || '').trim()
  if (!s) return true
  if (s === '0.0.0.0' || s === '::') return true
  if (s === '::1' || s.startsWith('127.')) return true
  if (s.startsWith('169.254.')) return true
  return false
}

function tcpConnectLatencyMs(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const p = Number(port)
    if (!host || !Number.isFinite(p) || p <= 0 || p > 65535) {
      resolve(null)
      return
    }
    const t0 = Date.now()
    const sock = net.createConnection({ host, port: p })
    const timer = setTimeout(() => {
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(null)
    }, timeoutMs)
    const finish = (ms) => {
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(ms)
    }
    sock.once('connect', () => {
      finish(Math.max(0, Date.now() - t0))
    })
    sock.once('error', () => {
      finish(null)
    })
  })
}

async function icmpPingLatencyMs(host) {
  const isMac = process.platform === 'darwin'
  const args = isMac ? ['-c', '1', '-t', '2', host] : ['-c', '1', '-W', '2', host]
  try {
    const { stdout } = await execFileAsync('ping', args, { timeout: 5000 })
    const m =
      stdout.match(/time[=<]([\d.]+)\s*ms/i) ||
      stdout.match(/temps[=<]([\d.]+)\s*ms/i) ||
      stdout.match(/\b([\d.]+)\s*ms\b/)
    if (m) return Math.max(0, Math.round(Number(m[1])))
  } catch {
    /* ignore */
  }
  return null
}

async function measureWorkerProbeLatency({ publicIp, grpcPort, p2pPort }) {
  if (!publicIp || forbiddenWorkerProbeHost(publicIp)) {
    return { ok: false, error: 'Adresse IP non utilisable pour une sonde depuis le serveur.' }
  }
  if (grpcPort) {
    const ms = await tcpConnectLatencyMs(publicIp, grpcPort, 4000)
    if (ms != null) return { ok: true, latencyMs: ms, method: 'tcp_grpc' }
  }
  if (p2pPort) {
    const ms = await tcpConnectLatencyMs(publicIp, p2pPort, 4000)
    if (ms != null) return { ok: true, latencyMs: ms, method: 'tcp_p2p' }
  }
  const icmp = await icmpPingLatencyMs(publicIp)
  if (icmp != null) return { ok: true, latencyMs: icmp, method: 'icmp' }
  return { ok: false, error: 'Hôte injoignable (ports TCP fermés ou filtrage ICMP).' }
}

const GRAPH_ORCHESTRATOR_ID = 'vps-core'

function sanitizeGraphPoolGroupId(poolId) {
  return String(poolId || 'default')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 48)
}

function parseMaybeJsonObject(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function compareVersionLike(a, b) {
  const pa = String(a || '').split(/[^0-9A-Za-z]+/).filter(Boolean)
  const pb = String(b || '').split(/[^0-9A-Za-z]+/).filter(Boolean)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const xa = pa[i] || '0'
    const xb = pb[i] || '0'
    const na = Number(xa)
    const nb = Number(xb)
    const cmp = Number.isFinite(na) && Number.isFinite(nb) ? na - nb : xa.localeCompare(xb)
    if (cmp !== 0) return cmp
  }
  return 0
}

async function currentWorkerRelease(channel = 'stable') {
  const [rows] = await pool.query(
    `SELECT id, channel, version, mac_url AS macUrl, win_x64_url AS winX64Url,
            win_arm64_url AS winArm64Url, runtime_url AS runtimeUrl,
            mac_sha256 AS macSha256, win_x64_sha256 AS winX64Sha256,
            win_arm64_sha256 AS winArm64Sha256, runtime_sha256 AS runtimeSha256,
            notes, mandatory, created_at AS createdAt
     FROM worker_releases
     WHERE channel = :channel
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    { channel },
  )
  const row = rows[0]
  if (row) {
    return {
      id: String(row.id),
      channel: row.channel,
      version: row.version,
      macUrl: row.macUrl || null,
      winX64Url: row.winX64Url || null,
      winArm64Url: row.winArm64Url || null,
      runtimeUrl: row.runtimeUrl || null,
      macSha256: row.macSha256 || null,
      winX64Sha256: row.winX64Sha256 || null,
      winArm64Sha256: row.winArm64Sha256 || null,
      runtimeSha256: row.runtimeSha256 || null,
      notes: row.notes || '',
      mandatory: Boolean(row.mandatory),
      createdAt: row.createdAt,
    }
  }
  return {
    id: 'default',
    channel,
    version: process.env.VRYX_WORKER_TARGET_VERSION || '1.0.2',
    macUrl: '/downloads/Vryx-Worker-latest-mac.zip',
    winX64Url: '/downloads/Vryx-Worker-Setup-latest-x64.exe',
    winArm64Url: '/downloads/Vryx-Worker-Setup-latest-arm64.exe',
    runtimeUrl: null,
    macSha256: null,
    winX64Sha256: null,
    winArm64Sha256: null,
    runtimeSha256: null,
    notes: 'Release worker stable par défaut.',
    mandatory: false,
    createdAt: null,
  }
}

/** Estimation grossière des indices de couches pour l’UI (pipeline parallel). */
function estimateShardLayerRange(rank, assignmentCount, totalLayers = 32) {
  if (assignmentCount <= 0 || rank < 0) return '—'
  const start = Math.floor((rank / assignmentCount) * totalLayers)
  const end = Math.max(start, Math.ceil(((rank + 1) / assignmentCount) * totalLayers) - 1)
  return `${start}-${end}`
}

/**
 * État graphe « Nerve Center » : nœuds + liens (react-force-graph).
 */
function buildPoolGraphPayload({
  poolId,
  assignments,
  routingPath,
  registeredWorkers,
  pipelineActive,
}) {
  const nodes = []
  const links = []
  const groupLabel = sanitizeGraphPoolGroupId(poolId)

  nodes.push({
    id: GRAPH_ORCHESTRATOR_ID,
    group: 'orchestrator',
    val: 50,
    poolId,
    hardware: 'Orchestrateur VPS',
    vram: null,
    shards: '—',
    status: pipelineActive ? 'computing' : 'idle',
    pingMs: null,
  })

  const routingSet = new Set(Array.isArray(routingPath) ? routingPath : [])
  const assignList = Array.isArray(assignments) ? assignments : []
  const nAssign = assignList.length

  /** Même critère « live » que `routingPath` / orchestrateur : pas de nœuds hors pool active. */
  const workerRows = registeredWorkers.filter(
    (w) => w.mode === 'worker' && Number(w.secondsSinceHeartbeat) <= WORKER_LIVE_SEC && w.desiredState === 'active',
  )
  for (const w of workerRows) {
    const totalVramMb = Number(w.gpuVramMb) || 0
    const allocatedVramMb = Number(w.allocatedVramMb || totalVramMb) || 0
    const hasVram = allocatedVramMb > 0
    const vramGb = hasVram ? Math.round((allocatedVramMb / 1024) * 10) / 10 : null
    const mlxish =
      String(w.runtimeBackend || '')
        .toLowerCase()
        .includes('mlx') || Boolean(w.supportsMlx)
    const hardware =
      (w.gpuName && String(w.gpuName).trim()) ||
      (mlxish ? 'Apple Silicon (Metal / MLX)' : null) ||
      'Matériel non renseigné'
    const assign = assignList.find((a) => a.peer === w.peerId)
    const rank = typeof assign?.rank === 'number' ? assign.rank : -1

    let status = 'idle'
    if (pipelineActive && routingSet.has(w.peerId)) status = 'computing'

    const shards =
      assign && nAssign > 0 ? estimateShardLayerRange(rank, nAssign) : 'non assigné'

    const pingMs =
      typeof w.secondsSinceHeartbeat === 'number'
        ? Math.min(600_000, Math.max(0, w.secondsSinceHeartbeat * 1000))
        : null

    nodes.push({
      id: w.peerId,
      group: `pool-${groupLabel}`,
      poolId,
      hardware,
      vram: vramGb,
      val: Math.max(6, hasVram ? Math.sqrt(vramGb || 1) * 8 : 10),
      shards,
      status,
      pingMs,
      vramMbTotal: totalVramMb > 0 ? totalVramMb : null,
      vramMbUsed: allocatedVramMb > 0 ? allocatedVramMb : null,
      publicIp: w.publicIp ?? null,
      model: w.model ?? null,
      runtimeBackend: w.runtimeBackend ?? null,
      tokensGeneratedTotal: Number(w.tokensGenerated || 0) || 0,
      tokensGenerated1h: Number(w.tokensGenerated1h || 0) || 0,
      tokensGenerated24h: Number(w.tokensGenerated24h || 0) || 0,
      vramMbAvailable: totalVramMb > 0 ? totalVramMb : null,
      allocatedVramMb: allocatedVramMb > 0 ? allocatedVramMb : null,
      memoryLimitPercent: w.memoryLimitPercent ?? null,
    })
  }

  const rp = Array.isArray(routingPath) ? routingPath.filter((x) => typeof x === 'string' && x.length > 0) : []
  if (rp.length > 0) {
    links.push({
      source: GRAPH_ORCHESTRATOR_ID,
      target: rp[0],
      is_active: !!pipelineActive,
    })
    for (let i = 0; i < rp.length - 1; i++) {
      links.push({
        source: rp[i],
        target: rp[i + 1],
        is_active: !!pipelineActive,
      })
    }
  }

  return { nodes, links }
}

const heartbeatBodySchema = z.object({
  peer_id: z.string().min(1).max(100),
  mode: z.enum(['worker', 'initiator', 'bootstrap']).optional().default('worker'),
  grpc_port: z.number().int().min(1).max(65535).nullable().optional(),
  p2p_port: z.number().int().min(1).max(65535).nullable().optional(),
  version: z.string().max(30).optional(),
  p2p_peers: z.number().int().min(0).optional().default(0),
  tokens_generated: z.number().int().min(0).optional().default(0),
  model: z.string().max(100).nullable().optional(),
  user_id: z.number().int().min(0).nullable().optional().default(0),
  tokens_in: z.number().int().min(0).optional().default(0),
  tokens_out: z.number().int().min(0).optional().default(0),
  gpu_name: z.string().max(120).nullable().optional(),
  gpu_vram_mb: z.number().int().min(0).max(262144).nullable().optional(),
  allocated_vram_mb: z.number().int().min(0).max(262144).nullable().optional(),
  memory_limit_percent: z.number().int().min(1).max(100).nullable().optional(),
  runtime_backend: z.string().max(40).nullable().optional(),
  weight_quantization: z.string().max(40).nullable().optional(),
  supports_q4_weights: z.boolean().optional().default(false),
  supports_mlx: z.boolean().optional().default(false),
  supports_vllm: z.boolean().optional().default(false),
  machine_info: z.record(z.string(), z.unknown()).nullable().optional(),
  runtime_state: z.enum(['idle', 'updating', 'restarting', 'loading_shard', 'ready', 'reserved', 'running', 'cooldown', 'failed']).optional(),
  command_ack: z
    .object({
      id: z.union([z.number().int().min(1), z.string().min(1)]),
      status: z.enum(['acknowledged', 'failed']).optional().default('acknowledged'),
      error: z.string().max(255).nullable().optional(),
    })
    .optional(),
})

const workerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de heartbeats.' },
})

const adminWorkerPingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de mesures de latence. Réessayez dans une minute.' },
})

app.post('/api/workers/heartbeat', requireWorkerSecret, workerLimiter, async (req, res) => {
  const parsed = heartbeatBodySchema.safeParse(req.body)
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0] || 'Données invalides.'
    return res.status(400).json({ error: first })
  }
  const {
    peer_id,
    mode,
    grpc_port,
    p2p_port,
    version,
    p2p_peers,
    tokens_generated,
    model,
    user_id,
    tokens_in,
    tokens_out,
    gpu_name,
    gpu_vram_mb,
    allocated_vram_mb,
    memory_limit_percent,
    runtime_backend,
    weight_quantization,
    supports_q4_weights,
    supports_mlx,
    supports_vllm,
    machine_info,
    runtime_state,
    command_ack,
  } = parsed.data
  const hasGpuName = gpu_name !== undefined
  const hasGpuVram = gpu_vram_mb !== undefined
  const hasAllocatedVram = allocated_vram_mb !== undefined
  const hasMemoryLimitPercent = memory_limit_percent !== undefined
  const hasRuntimeBackend = runtime_backend !== undefined && runtime_backend !== null && String(runtime_backend).trim() !== ''
  const hasWeightQuantization =
    weight_quantization !== undefined && weight_quantization !== null && String(weight_quantization).trim() !== ''
  const normalizedRuntimeBackend = hasRuntimeBackend
    ? String(runtime_backend).trim().toLowerCase()
    : supports_mlx
      ? 'mlx'
      : supports_vllm
        ? 'vllm'
        : 'pytorch'
  const shouldUpdateRuntimeBackend = hasRuntimeBackend || supports_mlx || supports_vllm
  const hasMachineInfo = machine_info !== undefined && machine_info !== null && typeof machine_info === 'object'
  const public_ip =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  try {
    const reported = Math.max(0, Number(tokens_generated ?? 0))
    const [prevRows] = await pool.query('SELECT tokens_generated AS tg FROM workers WHERE peer_id = :peer_id LIMIT 1', {
      peer_id,
    })
    const prevT = prevRows[0]?.tg != null ? Number(prevRows[0].tg) : 0
    const counterReset = reported < prevT
    const newTokensTotal = counterReset ? reported : Math.max(prevT, reported)
    const inc = counterReset ? reported : Math.max(0, newTokensTotal - prevT)

  const normalizedAllocatedVram =
      allocated_vram_mb != null && gpu_vram_mb != null ? Math.min(allocated_vram_mb, gpu_vram_mb) : allocated_vram_mb
    const normalizedModel = normalizeP2pModelId(model || '') || model || null
    const modelKey = normalizeP2pModelKey(normalizedModel || '')
    const reportsLlamaCppQ4 = normalizedRuntimeBackend.includes('llama') && /(gemma|llama)/i.test(modelKey)
    const normalizedWeightQuantization = reportsLlamaCppQ4
      ? 'q4'
      : hasWeightQuantization
        ? String(weight_quantization).trim().toLowerCase()
        : 'fp16'
    const normalizedSupportsQ4 = Boolean(supports_q4_weights) || reportsLlamaCppQ4 || normalizedWeightQuantization.includes('q4')
    const heartbeatRuntimeState = runtime_state || (
      mode === 'worker' && normalizedModel ? 'ready' : 'idle'
    )
    const capabilitySnapshot = workerCapabilities({
      model: normalizedModel,
      gpuName: gpu_name,
      gpuVramMb: gpu_vram_mb,
      allocatedVramMb: normalizedAllocatedVram,
      runtimeBackend: normalizedRuntimeBackend,
      weightQuantization: normalizedWeightQuantization,
      supportsQ4Weights: normalizedSupportsQ4,
      supportsMlx: supports_mlx,
      supportsVllm: supports_vllm,
      machineInfo: machine_info ? JSON.stringify(machine_info) : null,
    })
    const healthSnapshot = workerHealthScore({
      secondsSinceHeartbeat: 0,
      desiredState: 'active',
      model: normalizedModel,
      p2pPeers: p2p_peers ?? 0,
      gpuVramMb: gpu_vram_mb,
      allocatedVramMb: normalizedAllocatedVram,
      runtimeBackend: normalizedRuntimeBackend,
      supportsQ4Weights: normalizedSupportsQ4,
      supportsMlx: supports_mlx,
      supportsVllm: supports_vllm,
    })

    await pool.query(
      `INSERT INTO workers (peer_id, mode, grpc_port, p2p_port, public_ip, version, p2p_peers, tokens_generated,
                            tokens_in, tokens_out, model, user_id, gpu_name, gpu_vram_mb,
                            allocated_vram_mb, memory_limit_percent,
                            runtime_backend, weight_quantization, supports_q4_weights, supports_mlx, supports_vllm, machine_info,
	                            health_score, runtime_state, capabilities_json)
       VALUES (:peer_id, :mode, :grpc_port, :p2p_port, :public_ip, :version, :p2p_peers, :tokens_gen,
               :tokens_in, :tokens_out, :model, :user_id, :gpu_name_ins, :gpu_vram_ins,
               :allocated_vram_ins, :memory_limit_percent_ins,
               :runtime_backend, :weight_quantization, :supports_q4_weights, :supports_mlx, :supports_vllm, :machine_info,
	               :health_score, :runtime_state, :capabilities_json)
       ON DUPLICATE KEY UPDATE
         mode = VALUES(mode),
         grpc_port = VALUES(grpc_port),
         p2p_port = VALUES(p2p_port),
         public_ip = VALUES(public_ip),
         version = VALUES(version),
         p2p_peers = VALUES(p2p_peers),
         tokens_generated = VALUES(tokens_generated),
         tokens_in = VALUES(tokens_in),
         tokens_out = VALUES(tokens_out),
         model = VALUES(model),
         user_id = IF(VALUES(user_id) > 0, VALUES(user_id), user_id),
         gpu_name = IF(:has_gpu_name, VALUES(gpu_name), gpu_name),
         gpu_vram_mb = IF(:has_gpu_vram, VALUES(gpu_vram_mb), gpu_vram_mb),
         allocated_vram_mb = IF(:has_allocated_vram, VALUES(allocated_vram_mb), allocated_vram_mb),
         memory_limit_percent = IF(:has_memory_limit_percent, VALUES(memory_limit_percent), memory_limit_percent),
         runtime_backend = IF(:has_runtime_backend, VALUES(runtime_backend), runtime_backend),
         weight_quantization = IF(:has_weight_quantization, VALUES(weight_quantization), weight_quantization),
         supports_q4_weights = VALUES(supports_q4_weights),
         supports_mlx = VALUES(supports_mlx),
         supports_vllm = VALUES(supports_vllm),
         machine_info = IF(:has_machine_info, VALUES(machine_info), machine_info),
         health_score = VALUES(health_score),
	         runtime_state = CASE
	           WHEN reserved_until IS NOT NULL AND reserved_until > NOW() THEN runtime_state
	           WHEN last_command_status IN ('pending','delivered') AND runtime_state IN ('updating','restarting','loading_shard') THEN runtime_state
	           ELSE VALUES(runtime_state)
	         END,
         capabilities_json = VALUES(capabilities_json),
         last_heartbeat_at = CURRENT_TIMESTAMP`,
      {
        peer_id,
        mode,
        grpc_port: grpc_port ?? null,
        p2p_port: p2p_port ?? null,
        public_ip,
        version: version ?? null,
        p2p_peers: p2p_peers ?? 0,
        tokens_gen: newTokensTotal,
        tokens_in: tokens_in ?? 0,
        tokens_out: tokens_out ?? 0,
        model: normalizedModel,
        user_id: user_id && user_id > 0 ? user_id : null,
        gpu_name_ins: gpu_name ?? null,
        gpu_vram_ins: gpu_vram_mb ?? null,
        allocated_vram_ins: normalizedAllocatedVram ?? null,
        memory_limit_percent_ins: memory_limit_percent ?? null,
        has_gpu_name: hasGpuName ? 1 : 0,
        has_gpu_vram: hasGpuVram ? 1 : 0,
        has_allocated_vram: hasAllocatedVram ? 1 : 0,
        has_memory_limit_percent: hasMemoryLimitPercent ? 1 : 0,
        has_runtime_backend: shouldUpdateRuntimeBackend ? 1 : 0,
        has_weight_quantization: hasWeightQuantization || reportsLlamaCppQ4 ? 1 : 0,
        runtime_backend: normalizedRuntimeBackend,
        weight_quantization: normalizedWeightQuantization,
        supports_q4_weights: normalizedSupportsQ4 ? 1 : 0,
        supports_mlx: supports_mlx ? 1 : 0,
        supports_vllm: supports_vllm ? 1 : 0,
        machine_info: hasMachineInfo ? JSON.stringify(machine_info) : null,
        has_machine_info: hasMachineInfo ? 1 : 0,
        health_score: healthSnapshot.score,
        runtime_state: heartbeatRuntimeState,
        capabilities_json: JSON.stringify(capabilitySnapshot),
      },
    )
    if (inc > 0) {
      try {
        await pool.query('INSERT INTO worker_token_ledger (peer_id, delta_tokens) VALUES (:peer_id, :inc)', {
          peer_id,
          inc,
        })
      } catch (ledgerError) {
        console.warn('workers/heartbeat ledger skipped', ledgerError?.code || ledgerError?.message || ledgerError)
      }
    }
    if (command_ack?.id) {
      const ackFailed = command_ack.status === 'failed'
      const [ackRows] = await pool.query(
        `SELECT id, action, payload_json AS payloadJson
         FROM worker_commands
         WHERE id = :id AND peer_id = :peer_id
         LIMIT 1`,
        { id: String(command_ack.id), peer_id },
      )
      const ackCommand = ackRows[0]
      const ackPayload = parseMaybeJsonObject(ackCommand?.payloadJson) || {}
      const targetVersion = String(ackPayload.targetVersion || ackPayload.release?.version || ackPayload.version || '').trim()
      const ackPrematureUpdate =
        !ackFailed &&
        ackCommand?.action === 'update_software' &&
        targetVersion &&
        (!version || compareVersionLike(version, targetVersion) < 0)
      if (ackFailed) await rollbackDesiredStateFromCommand(peer_id, command_ack.id).catch(() => {})
      if (ackPrematureUpdate) {
        await pool.query(
          `UPDATE worker_commands
           SET status = 'delivered',
               error = :error
           WHERE id = :id AND peer_id = :peer_id AND status IN ('pending','delivered')`,
          {
            id: String(command_ack.id),
            peer_id,
            error: `ACK ignoré: version heartbeat ${version || 'unknown'} < cible ${targetVersion}`,
          },
        )
        await pool.query(
          `UPDATE workers
           SET last_command_status = 'delivered',
               last_command_error = :error,
               runtime_state = 'updating'
           WHERE peer_id = :peer_id`,
          {
            peer_id,
            error: `Update appliquée non vérifiée: ${version || 'unknown'} < ${targetVersion}`,
          },
        )
      } else {
      await pool.query(
        `UPDATE worker_commands
         SET status = :status, error = :error, acknowledged_at = CURRENT_TIMESTAMP
         WHERE id = :id AND peer_id = :peer_id`,
        {
          id: String(command_ack.id),
          peer_id,
          status: ackFailed ? 'failed' : 'acknowledged',
          error: command_ack.error ?? null,
        },
      )
      const nextRuntimeState = ackFailed
        ? 'failed'
        : ackCommand?.action === 'restart'
          ? 'restarting'
          : ackCommand?.action === 'update_software'
            ? 'ready'
            : ackCommand?.action === 'set_model'
              ? 'loading_shard'
              : 'ready'
      if (!ackFailed && ackCommand?.action === 'rotate_secret') {
        await pool.query(
          `UPDATE workers
           SET worker_secret_hash = worker_next_secret_hash,
               worker_secret_expires_at = worker_next_secret_expires_at,
               worker_next_secret_hash = NULL,
               worker_next_secret_expires_at = NULL
           WHERE peer_id = :peer_id
             AND worker_next_secret_hash IS NOT NULL`,
          { peer_id },
        )
      }
      await pool.query(
        `UPDATE workers
         SET last_command_status = :status,
             last_command_error = :error,
             runtime_state = :runtime_state
         WHERE peer_id = :peer_id`,
        {
          peer_id,
          status: ackFailed ? 'failed' : 'acknowledged',
          error: command_ack.error ?? null,
          runtime_state: nextRuntimeState,
        },
      )
      }
    }
    await acknowledgeSatisfiedDeliveredCommands(peer_id, {
      model: normalizedModel,
      allocatedVramMb: normalizedAllocatedVram,
      memoryLimitPercent: memory_limit_percent,
      version,
    }).catch((e) => console.warn('workers/heartbeat auto-ack skipped', e?.code || e?.message || e))

    await expireWorkerCommands()
    const release = await currentWorkerRelease('stable')
    if (
      mode === 'worker' &&
      release?.version &&
      (release.macSha256 || release.winX64Sha256 || release.winArm64Sha256 || release.runtimeSha256) &&
      version &&
      !ALLOW_UNSECURE_WORKERS &&
      compareVersionLike(version, release.version) < 0
    ) {
      const [existingUpdate] = await pool.query(
        `SELECT id FROM worker_commands
         WHERE peer_id = :peer_id
           AND action = 'update_software'
           AND status IN ('pending','delivered')
         LIMIT 1`,
        { peer_id },
      )
      if (!existingUpdate[0]) {
        await pool.query(
          `INSERT INTO worker_commands (peer_id, action, payload_json, requested_by, expires_at)
           VALUES (:peer_id, 'update_software', :payload, NULL, DATE_ADD(NOW(), INTERVAL 15 MINUTE))`,
          {
            peer_id,
            payload: JSON.stringify({
              targetVersion: release.version,
              currentVersion: version,
              channel: release.channel,
              macUrl: release.macUrl,
              winX64Url: release.winX64Url,
              winArm64Url: release.winArm64Url,
              runtimeUrl: release.runtimeUrl,
              macSha256: release.macSha256,
              winX64Sha256: release.winX64Sha256,
              winArm64Sha256: release.winArm64Sha256,
              runtimeSha256: release.runtimeSha256,
              mandatory: release.mandatory,
              notes: release.notes,
            }),
          },
        )
        await pool.query(
          `UPDATE workers
	           SET last_command_at = CURRENT_TIMESTAMP,
	               last_command_status = 'pending',
	               last_command_error = NULL,
	               runtime_state = 'updating'
	           WHERE peer_id = :peer_id`,
          { peer_id },
        )
      }
    }

    const [commandRows] = await pool.query(
      `SELECT id, action, payload_json AS payloadJson, created_at AS createdAt
       FROM worker_commands
       WHERE peer_id = :peer_id AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at ASC
       LIMIT 1`,
      { peer_id },
    )
    const command = commandRows[0]
    if (command) {
      const deliveredRuntimeState =
        command.action === 'update_software' ? 'updating'
        : command.action === 'restart' ? 'restarting'
        : command.action === 'set_model' ? 'loading_shard'
        : command.action === 'rotate_secret' ? 'updating'
        : null
      await pool.query(
        `UPDATE worker_commands
         SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP
         WHERE id = :id AND status = 'pending'`,
        { id: command.id },
      )
      await pool.query(
        `UPDATE workers
         SET last_command_status = 'delivered',
             last_command_error = NULL,
             runtime_state = COALESCE(:runtimeState, runtime_state)
         WHERE peer_id = :peer_id`,
        { peer_id, runtimeState: deliveredRuntimeState },
      )
    }

    return res.json({
      ok: true,
      desired: {
        state: command?.action === 'resume' ? 'active' : undefined,
      },
      command: command
        ? {
            id: String(command.id),
            action: command.action,
            payload: parseMaybeJsonObject(command.payloadJson),
            createdAt: command.createdAt,
          }
        : null,
    })
  } catch (e) {
    if (['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK'].includes(e?.code)) {
      console.warn('workers/heartbeat accepted without DB update after lock contention', {
        peer_id,
        code: e.code,
      })
      return res.status(202).json({ ok: true, degraded: true })
    }
    console.error('workers/heartbeat', e)
    return res.status(500).json({ error: 'Erreur enregistrement worker.' })
  }
})

// Limiteur partagé par le chat P2P admin (rate-limit côté initiateur).
const chatLimiter = rateLimit({ windowMs: 60_000, max: 20, message: { error: 'Trop de requêtes.' } })

app.get('/api/workers/status', requireWorkerSecret, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT peer_id, mode, grpc_port, p2p_port, public_ip, version,
              p2p_peers, tokens_generated, tokens_in, tokens_out, model,
              gpu_name AS gpuName, gpu_vram_mb AS gpuVramMb,
              allocated_vram_mb AS allocatedVramMb, memory_limit_percent AS memoryLimitPercent,
              runtime_backend AS runtimeBackend, weight_quantization AS weightQuantization,
              supports_q4_weights AS supportsQ4Weights, supports_mlx AS supportsMlx, supports_vllm AS supportsVllm,
              desired_state AS desiredState, desired_model AS desiredModel,
              desired_allocated_vram_mb AS desiredAllocatedVramMb,
              desired_memory_limit_percent AS desiredMemoryLimitPercent,
              last_command_at AS lastCommandAt, last_command_status AS lastCommandStatus,
              last_command_error AS lastCommandError,
              last_heartbeat_at AS lastHeartbeatAt, first_seen_at AS firstSeenAt,
              TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
       FROM workers
       WHERE TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) <= :offline
         AND mode = 'worker'
         AND desired_state = 'active'
       ORDER BY last_heartbeat_at DESC`,
      { offline: WORKER_OFFLINE_SEC },
    )
    return res.json({
      onlineCount: rows.length,
      workers: rows.map((r) => ({
        peerId: r.peer_id,
        mode: r.mode,
        grpcPort: r.grpc_port,
        p2pPort: r.p2p_port,
        publicIp: r.public_ip,
        version: r.version,
        p2pPeers: Number(r.p2p_peers || 0),
        tokensGenerated: Number(r.tokens_generated || 0),
        tokensIn: Number(r.tokens_in || 0),
        tokensOut: Number(r.tokens_out || 0),
        model: r.model ?? null,
        gpuName: r.gpuName ?? null,
        gpuVramMb: r.gpuVramMb != null ? Number(r.gpuVramMb) : null,
        allocatedVramMb: r.allocatedVramMb != null ? Number(r.allocatedVramMb) : null,
        memoryLimitPercent: r.memoryLimitPercent != null ? Number(r.memoryLimitPercent) : null,
        runtimeBackend: r.runtimeBackend ?? 'pytorch',
        weightQuantization: r.weightQuantization ?? 'fp16',
        supportsQ4Weights: Boolean(r.supportsQ4Weights),
        supportsMlx: Boolean(r.supportsMlx),
        supportsVllm: Boolean(r.supportsVllm),
        desiredState: r.desiredState ?? 'active',
        desiredModel: r.desiredModel ?? null,
        desiredAllocatedVramMb: r.desiredAllocatedVramMb != null ? Number(r.desiredAllocatedVramMb) : null,
        desiredMemoryLimitPercent: r.desiredMemoryLimitPercent != null ? Number(r.desiredMemoryLimitPercent) : null,
        lastCommandAt: r.lastCommandAt ?? null,
        lastCommandStatus: r.lastCommandStatus ?? null,
        lastCommandError: r.lastCommandError ?? null,
        lastHeartbeatAt: r.lastHeartbeatAt,
        firstSeenAt: r.firstSeenAt,
        secondsSinceHeartbeat: Number(r.secondsSinceHeartbeat),
      })),
    })
  } catch (e) {
    console.error('workers/status', e)
    return res.status(500).json({ error: 'Erreur lecture workers.' })
  }
})

app.get('/api/workers/network-stats', async (_req, res) => {
  try {
    const [[workers]] = await pool.query(
      `SELECT
          COUNT(*) AS registeredWorkers,
          SUM(tokens_generated) AS totalTokensGenerated,
          SUM(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) <= :offline) AS onlineCount
       FROM workers
       WHERE mode = 'worker'`,
      { offline: WORKER_OFFLINE_SEC },
    )
    const [[ledger]] = await pool.query(
      `SELECT
          COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR) THEN delta_tokens ELSE 0 END), 0) AS totalTokens1h,
          COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN delta_tokens ELSE 0 END), 0) AS totalTokens24h,
          COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN delta_tokens ELSE 0 END), 0) AS totalTokens30d,
          COUNT(DISTINCT CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN peer_id END) AS activeWorkers30d
       FROM worker_token_ledger`,
    )
    const totalTokens30d = Number(ledger.totalTokens30d || 0)
    const activeWorkers30d = Number(ledger.activeWorkers30d || 0)
    return res.json({
      ok: true,
      sampledAt: new Date().toISOString(),
      onlineCount: Number(workers.onlineCount || 0),
      registeredWorkers: Number(workers.registeredWorkers || 0),
      activeWorkers30d,
      totalTokensGenerated: Number(workers.totalTokensGenerated || 0),
      totalTokens1h: Number(ledger.totalTokens1h || 0),
      totalTokens24h: Number(ledger.totalTokens24h || 0),
      totalTokens30d,
      avgTokensPerActiveWorker30d: activeWorkers30d > 0 ? Math.round(totalTokens30d / activeWorkers30d) : 0,
    })
  } catch (e) {
    console.error('workers/network-stats', e)
    return res.status(500).json({ error: 'Erreur lecture stats réseau workers.' })
  }
})

app.get('/api/public/scheduler-preview', async (req, res) => {
  try {
    await expireWorkerReservations()
    const model = normalizeP2pModelId(String(req.query.model || '')) || 'Qwen/Qwen3.6-35B-A3B'
    const mode = ['auto', 'full', 'shard'].includes(req.query.mode) ? req.query.mode : 'auto'
    const workers = await loadSchedulerWorkers(model, { strictModel: true })
    const plan = modelPlanFor(model, workers, mode)
    res.json({
      ok: true,
      sampledAt: new Date().toISOString(),
      model,
      mode,
      plan: {
        ...plan,
        assignments: plan.assignments.map((assignment) => ({
          ...assignment,
          peerId: String(assignment.peerId || '').slice(0, 12) + '…',
        })),
      },
      candidates: workers.length,
      healthThreshold: WORKER_HEALTH_MIN_FOR_SCHEDULER,
      reservationTtlSec: WORKER_RESERVATION_TTL_SEC,
    })
  } catch (e) {
    console.error('public/scheduler-preview', e)
    res.status(500).json({ ok: false, error: 'Erreur preview scheduler.' })
  }
})

function publicBenchmarkError(error) {
  if (!error) return null
  return 'Benchmark échoué. Détails complets réservés à l’admin.'
}

app.get('/api/public/benchmarks', async (req, res) => {
  try {
    const model = normalizeP2pModelId(String(req.query.model || '')) || null
    const where = model ? 'WHERE model = :model' : ''
    const [rows] = await pool.query(
      `SELECT id, job_id AS jobId, model, mode, status, worker_count AS workerCount,
              latency_ms AS latencyMs, ttft_ms AS ttftMs, tps,
              prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
              total_tokens AS totalTokens, cost_per_million_eur AS costPerMillionEur,
              error, created_at AS createdAt
       FROM worker_benchmark_runs
       ${where}
       ORDER BY created_at DESC
       LIMIT 50`,
      { model },
    )
    const activeRows = rows.filter((row) => Number(row.completionTokens || 0) >= 64)
    const okRows = activeRows.filter((row) => row.status === 'ok' && Number(row.tps) > 0)
    const tpsValues = okRows.map((row) => Number(row.tps)).filter(Number.isFinite).sort((a, b) => a - b)
    const latencyValues = okRows.map((row) => Number(row.latencyMs)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
    const ttftValues = okRows.map((row) => Number(row.ttftMs)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
    const hotRows = okRows.filter((row) => Number(row.completionTokens || 0) >= 64 && Number(row.ttftMs || 0) <= 2500)
    const hotTpsValues = hotRows.map((row) => Number(row.tps)).filter(Number.isFinite).sort((a, b) => a - b)
    res.json({
      ok: true,
      sampledAt: new Date().toISOString(),
      summary: {
        samples: rows.length,
        activeSamples: activeRows.length,
        okSamples: okRows.length,
        hotSamples: hotRows.length,
        tpsP50: percentile(tpsValues, 50),
        tpsP95: percentile(tpsValues, 95),
        hotTpsP50: percentile(hotTpsValues, 50),
        hotTpsP95: percentile(hotTpsValues, 95),
        latencyP50Ms: percentile(latencyValues, 50),
        latencyP95Ms: percentile(latencyValues, 95),
        ttftP50Ms: percentile(ttftValues, 50),
        ttftP95Ms: percentile(ttftValues, 95),
      },
      runs: rows.map((row) => ({
        id: String(row.id),
        jobId: row.jobId,
        model: row.model,
        mode: row.mode,
        status: row.status,
        workerCount: Number(row.workerCount || 0),
        latencyMs: Number(row.latencyMs || 0),
        ttftMs: Number(row.ttftMs || 0),
        tps: Number(row.tps || 0),
        promptTokens: Number(row.promptTokens || 0),
        completionTokens: Number(row.completionTokens || 0),
        totalTokens: Number(row.totalTokens || 0),
        costPerMillionEur: Number(row.costPerMillionEur || 0),
        error: publicBenchmarkError(row.error),
        createdAt: row.createdAt,
      })),
    })
  } catch (e) {
    console.error('public/benchmarks', e)
    res.status(500).json({ ok: false, error: 'Erreur lecture benchmarks publics.' })
  }
})

// ===========================================================================
//                            ROUTES ADMIN
// ===========================================================================

const adminRouter = express.Router()
adminRouter.use(requireAdmin)
registerObservabilityRoutes(adminRouter, observability)
registerAdminInferenceRoutes(adminRouter, { pool })

const pricingConfigBodySchema = z.object({
  defaultEurPerMillion: z.number().positive().max(1000).optional(),
  pricingPublished: z.boolean(),
  vatPercent: z.number().min(0).max(100),
  workerRewardSharePercent: z.number().min(0).max(100),
  defaultWorkerSharePercent: z.number().min(0).max(100).optional(),
  blendedInputRatioPercent: z.number().min(0).max(100).optional(),
  privatePoolTokenDiscountPercent: z.number().min(0).max(95).optional(),
  minVryxNetMarginPercent: z.number().min(0).max(95).optional(),
  minInputEurPerMillion: z.number().positive().max(1000).optional(),
  minOutputEurPerMillion: z.number().positive().max(1000).optional(),
  headline: z.object({
    minInputEurPerMillion: z.number().positive().max(1000),
    minOutputEurPerMillion: z.number().positive().max(1000),
  }).optional(),
  recharge: z.object({
    minEur: z.number().min(5).max(100_000),
    recommendedEur: z.number().min(5).max(100_000),
    b2bMinEur: z.number().min(5).max(100_000),
    packagesEur: z.array(z.number().min(5).max(100_000)).max(20).optional(),
  }).optional(),
  volumeDiscounts: z.array(z.object({
    minMonthlyMillions: z.number().min(0).max(10_000_000),
    discountPercent: z.number().min(0).max(95),
  })).max(12).optional().default([]),
})

const modelCatalogBodySchema = z.object({
  slug: z.string().trim().max(120).optional(),
  hfId: z.string().trim().max(180).nullable().optional(),
  apiAlias: z.string().trim().max(120).nullable().optional(),
  name: z.string().trim().min(1).max(180),
  provider: z.string().trim().min(1).max(100),
  family: z.string().trim().min(1).max(100),
  paramsNote: z.string().trim().max(120).nullable().optional(),
  contextTokens: z.number().int().min(0).max(20_000_000).optional().default(0),
  modalities: z.array(z.string().trim().min(1).max(40)).max(12).optional().default([]),
  openWeights: z.boolean().optional().default(true),
  weightGb: z.number().min(0).max(10_000).nullable().optional(),
  pricingTier: z.string().trim().max(40).optional(),
  eurPerMillion: z.number().positive().max(1000).nullable().optional(),
  eurPerMillionInput: z.number().positive().max(1000).nullable().optional(),
  eurPerMillionOutput: z.number().positive().max(1000).nullable().optional(),
  eurPerMillionCachedInput: z.number().positive().max(1000).nullable().optional(),
  eurPerMillionBatchInput: z.number().positive().max(1000).nullable().optional(),
  eurPerMillionBatchOutput: z.number().positive().max(1000).nullable().optional(),
  privatePoolInputEurPerMillion: z.number().positive().max(1000).nullable().optional(),
  privatePoolOutputEurPerMillion: z.number().positive().max(1000).nullable().optional(),
  workerSharePercent: z.number().min(0).max(100).nullable().optional(),
  estimatedWorkerCostInput: z.number().min(0).max(1000).nullable().optional(),
  estimatedWorkerCostOutput: z.number().min(0).max(1000).nullable().optional(),
  minVryxMarginPercent: z.number().min(0).max(95).nullable().optional(),
  availabilityStatus: z.enum(['available', 'limited', 'reservation', 'unavailable']).optional(),
  isActive: z.boolean().optional().default(true),
  isPublic: z.boolean().optional().default(true),
  minVramMb: z.number().int().min(0).max(1_000_000).nullable().optional(),
  requiredWorkers: z.number().int().min(1).max(256).optional().default(1),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional().default(0),
})

const pricingTierBodySchema = z.object({
  slug: z.string().trim().max(40),
  label: z.string().trim().max(120),
  defaultInputEurPerMillion: z.number().positive().max(1000),
  defaultOutputEurPerMillion: z.number().positive().max(1000),
  defaultWorkerSharePercent: z.number().min(0).max(100),
  sortOrder: z.number().int().optional().default(0),
})

const subscriptionPlanBodySchema = z.object({
  slug: z.string().trim().max(40),
  name: z.string().trim().max(120),
  monthlyEur: z.number().min(0).max(1_000_000),
  description: z.string().trim().max(500).optional(),
  isPublic: z.boolean().optional().default(true),
  sortOrder: z.number().int().optional().default(0),
})

const privatePoolPlanBodySchema = z.object({
  slug: z.string().trim().max(40),
  name: z.string().trim().max(120),
  monthlyEur: z.number().min(0).max(1_000_000),
  workerCountMin: z.number().int().min(0).max(10_000),
  workerCountMax: z.number().int().min(0).max(10_000),
  tokenDiscountPercent: z.number().min(0).max(95),
  isPublic: z.boolean().optional().default(true),
  sortOrder: z.number().int().optional().default(0),
})

const fineTuningPlanBodySchema = z.object({
  slug: z.string().trim().max(40),
  name: z.string().trim().max(120),
  eurPerMillionTraining: z.number().min(0).max(10_000),
  setupMinEur: z.number().min(0).max(1_000_000),
  setupMaxEur: z.number().min(0).max(1_000_000),
  deploymentMonthlyMinEur: z.number().min(0).max(1_000_000),
  deploymentMonthlyMaxEur: z.number().min(0).max(1_000_000),
  isPublic: z.boolean().optional().default(true),
  sortOrder: z.number().int().optional().default(0),
})

adminRouter.get('/pricing', async (_req, res) => {
  try {
    const bundle = await getPublicPricingBundle(pool, PRICING_FALLBACK)
    res.json({
      ok: true,
      pricing: bundle.pricing,
      tiers: bundle.tiers,
      subscriptionPlans: await getAllSubscriptionPlans(pool),
      privatePoolPlans: await getAllPrivatePoolPlans(pool),
      fineTuningPlans: await getAllFineTuningPlans(pool),
    })
  } catch (e) {
    console.error('admin/pricing', e)
    res.status(500).json({ error: 'Erreur lecture pricing.' })
  }
})

adminRouter.patch('/pricing', async (req, res) => {
  const parsed = pricingConfigBodySchema.safeParse(req.body)
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0] || 'Données invalides.'
    return res.status(400).json({ error: first })
  }
  try {
    const pricing = await updatePricingConfig(pool, parsed.data, PRICING_FALLBACK, req.user?.id || null)
    res.json({ ok: true, pricing })
  } catch (e) {
    console.error('admin/pricing patch', e)
    res.status(500).json({ error: 'Erreur mise à jour pricing.' })
  }
})

adminRouter.get('/models/catalog', async (_req, res) => {
  try {
    const bundle = await getPublicPricingBundle(pool, PRICING_FALLBACK)
    const models = await publicModelsWithRuntime({ includeInactive: true, includePrivate: true })
    res.json({ ok: true, pricing: bundle.pricing, tiers: bundle.tiers, models })
  } catch (e) {
    console.error('admin/models/catalog', e)
    res.status(500).json({ error: 'Erreur lecture catalogue modèles.' })
  }
})

adminRouter.post('/models/catalog', async (req, res) => {
  const parsed = modelCatalogBodySchema.safeParse(req.body)
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0] || 'Données invalides.'
    return res.status(400).json({ error: first })
  }
  try {
    const result = await upsertModelCatalogEntry(pool, parsed.data, PRICING_FALLBACK)
    invalidatePricingCache()
    const models = await publicModelsWithRuntime({ includeInactive: true, includePrivate: true })
    res.json({ ok: true, slug: result.slug, warnings: result.warnings, models })
  } catch (e) {
    console.error('admin/models/catalog post', e)
    res.status(500).json({ error: 'Erreur sauvegarde modèle.' })
  }
})

adminRouter.patch('/models/catalog/:slug', async (req, res) => {
  const parsed = modelCatalogBodySchema.partial().safeParse(req.body)
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0] || 'Données invalides.'
    return res.status(400).json({ error: first })
  }
  try {
    const [rows] = await pool.query('SELECT * FROM model_catalog WHERE slug = :slug LIMIT 1', { slug: req.params.slug })
    if (!rows[0]) return res.status(404).json({ error: 'Modèle introuvable.' })
    const base = {
      slug: rows[0].slug,
      hfId: rows[0].hf_id,
      apiAlias: rows[0].api_alias,
      name: rows[0].name,
      provider: rows[0].provider,
      family: rows[0].family,
      paramsNote: rows[0].params_note,
      contextTokens: Number(rows[0].context_tokens || 0),
      modalities: JSON.parse(rows[0].modalities_json || '[]'),
      openWeights: Boolean(rows[0].open_weights),
      weightGb: rows[0].weight_gb == null ? null : Number(rows[0].weight_gb),
      pricingTier: rows[0].pricing_tier,
      eurPerMillion: rows[0].eur_per_million == null ? null : Number(rows[0].eur_per_million),
      eurPerMillionInput: rows[0].eur_per_million_input == null ? null : Number(rows[0].eur_per_million_input),
      eurPerMillionOutput: rows[0].eur_per_million_output == null ? null : Number(rows[0].eur_per_million_output),
      workerSharePercent: rows[0].worker_share_percent == null ? null : Number(rows[0].worker_share_percent),
      availabilityStatus: rows[0].availability_status || 'available',
      isActive: Boolean(rows[0].is_active),
      isPublic: Boolean(rows[0].is_public),
      minVramMb: rows[0].min_vram_mb == null ? null : Number(rows[0].min_vram_mb),
      requiredWorkers: Number(rows[0].required_workers || 1),
      sortOrder: Number(rows[0].sort_order || 0),
    }
    const result = await upsertModelCatalogEntry(pool, { ...base, ...parsed.data, slug: rows[0].slug }, PRICING_FALLBACK)
    invalidatePricingCache()
    const models = await publicModelsWithRuntime({ includeInactive: true, includePrivate: true })
    res.json({ ok: true, slug: result.slug, warnings: result.warnings, models })
  } catch (e) {
    console.error('admin/models/catalog patch', e)
    res.status(500).json({ error: 'Erreur mise à jour modèle.' })
  }
})

adminRouter.delete('/models/catalog/:slug', async (req, res) => {
  try {
    await pool.query('DELETE FROM model_catalog WHERE slug = :slug', { slug: req.params.slug })
    const models = await publicModelsWithRuntime({ includeInactive: true, includePrivate: true })
    res.json({ ok: true, models })
  } catch (e) {
    console.error('admin/models/catalog delete', e)
    res.status(500).json({ error: 'Erreur suppression modèle.' })
  }
})

adminRouter.get('/pricing/tiers', async (_req, res) => {
  try {
    res.json({ ok: true, tiers: await getPricingTiers(pool, { force: true }) })
  } catch (e) {
    res.status(500).json({ error: 'Erreur lecture tiers.' })
  }
})

adminRouter.patch('/pricing/tiers/:slug', async (req, res) => {
  const parsed = pricingTierBodySchema.partial().safeParse({ ...req.body, slug: req.params.slug })
  if (!parsed.success) return res.status(400).json({ error: 'Données tier invalides.' })
  try {
    await upsertPricingTier(pool, parsed.data)
    res.json({ ok: true, tiers: await getPricingTiers(pool, { force: true }) })
  } catch (e) {
    res.status(500).json({ error: 'Erreur mise à jour tier.' })
  }
})

adminRouter.get('/plans/subscriptions', async (_req, res) => {
  res.json({ ok: true, plans: await getAllSubscriptionPlans(pool) })
})

adminRouter.patch('/plans/subscriptions/:slug', async (req, res) => {
  const parsed = subscriptionPlanBodySchema.partial().safeParse({ ...req.body, slug: req.params.slug })
  if (!parsed.success) return res.status(400).json({ error: 'Plan invalide.' })
  try {
    await upsertSubscriptionPlan(pool, parsed.data)
    res.json({ ok: true, plans: await getAllSubscriptionPlans(pool) })
  } catch (e) {
    res.status(500).json({ error: 'Erreur plan abonnement.' })
  }
})

adminRouter.get('/plans/private-pool', async (_req, res) => {
  res.json({ ok: true, plans: await getAllPrivatePoolPlans(pool) })
})

adminRouter.patch('/plans/private-pool/:slug', async (req, res) => {
  const parsed = privatePoolPlanBodySchema.partial().safeParse({ ...req.body, slug: req.params.slug })
  if (!parsed.success) return res.status(400).json({ error: 'Plan pool invalide.' })
  try {
    await upsertPrivatePoolPlan(pool, parsed.data)
    res.json({ ok: true, plans: await getAllPrivatePoolPlans(pool) })
  } catch (e) {
    res.status(500).json({ error: 'Erreur plan private pool.' })
  }
})

adminRouter.get('/plans/fine-tuning', async (_req, res) => {
  res.json({ ok: true, plans: await getAllFineTuningPlans(pool) })
})

adminRouter.patch('/plans/fine-tuning/:slug', async (req, res) => {
  const parsed = fineTuningPlanBodySchema.partial().safeParse({ ...req.body, slug: req.params.slug })
  if (!parsed.success) return res.status(400).json({ error: 'Plan fine-tuning invalide.' })
  try {
    await upsertFineTuningPlan(pool, parsed.data)
    res.json({ ok: true, plans: await getAllFineTuningPlans(pool) })
  } catch (e) {
    res.status(500).json({ error: 'Erreur plan fine-tuning.' })
  }
})

adminRouter.get('/billing/summary', async (_req, res) => {
  try {
    const [[totals]] = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN amount_eur > 0 THEN amount_eur ELSE 0 END), 0) AS credits,
        COALESCE(SUM(CASE WHEN amount_eur < 0 THEN -amount_eur ELSE 0 END), 0) AS debits,
        COALESCE(SUM(amount_eur), 0) AS balance,
        COUNT(DISTINCT user_id) AS usersWithLedger
      FROM billing_credit_ledger
    `)
    const [recent] = await pool.query(
      `SELECT l.id, l.user_id AS userId, u.email, l.type, l.amount_eur AS amountEur,
              l.description, l.created_at AS createdAt
       FROM billing_credit_ledger l
       JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT 50`,
    )
    res.json({
      ok: true,
      currency: 'EUR',
      enforceCredits: VRYX_BILLING_ENFORCE_CREDITS,
      checkoutEnabled: Boolean(STRIPE_SECRET_KEY),
      packages: VRYX_BILLING_CREDIT_PACKAGES,
      totals: {
        creditsEur: Number(totals?.credits || 0),
        debitsEur: Number(totals?.debits || 0),
        balanceEur: Number(totals?.balance || 0),
        usersWithLedger: Number(totals?.usersWithLedger || 0),
      },
      recent: recent.map((row) => ({
        id: String(row.id),
        userId: String(row.userId),
        email: row.email,
        type: row.type,
        amountEur: Number(row.amountEur || 0),
        description: row.description || '',
        createdAt: toIsoDate(row.createdAt),
      })),
    })
  } catch (e) {
    console.error('admin/billing/summary', e)
    res.status(500).json({ ok: false, error: 'Erreur synthèse billing.' })
  }
})

adminRouter.get('/enterprise/quotes', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim()
    const where = status ? 'WHERE status = :status' : ''
    const [rows] = await pool.query(
      `SELECT id, company, email, offer, monthly_tokens AS monthlyTokens,
              latency_target_ms AS latencyTargetMs, privacy_level AS privacyLevel,
              fine_tuning AS fineTuning, dedicated_workers AS dedicatedWorkers,
              monthly_estimate_eur AS monthlyEstimateEur, setup_estimate_eur AS setupEstimateEur,
              status, notes, created_at AS createdAt, updated_at AS updatedAt
       FROM enterprise_quote_requests
       ${where}
       ORDER BY created_at DESC
       LIMIT 200`,
      { status },
    )
    res.json({
      ok: true,
      quotes: rows.map((row) => ({
        id: String(row.id),
        company: row.company,
        email: row.email,
        offer: row.offer,
        monthlyTokens: Number(row.monthlyTokens || 0),
        latencyTargetMs: Number(row.latencyTargetMs || 0),
        privacyLevel: row.privacyLevel,
        fineTuning: Boolean(row.fineTuning),
        dedicatedWorkers: Number(row.dedicatedWorkers || 0),
        monthlyEstimateEur: Number(row.monthlyEstimateEur || 0),
        setupEstimateEur: Number(row.setupEstimateEur || 0),
        status: row.status,
        notes: row.notes || '',
        createdAt: toIsoDate(row.createdAt),
        updatedAt: toIsoDate(row.updatedAt),
      })),
    })
  } catch (e) {
    console.error('admin/enterprise/quotes', e)
    res.status(500).json({ ok: false, error: 'Erreur lecture demandes Enterprise.' })
  }
})

adminRouter.post('/billing/users/:id/credit', async (req, res) => {
  const parsed = adminCreditSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Montant ou description invalide.' })
  const userId = Number(req.params.id)
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'Utilisateur invalide.' })
  try {
    const [users] = await pool.query('SELECT id FROM users WHERE id = :userId LIMIT 1', { userId })
    if (!users[0]) return res.status(404).json({ error: 'Utilisateur introuvable.' })
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await insertBillingLedgerEntry(conn, {
        userId,
        type: parsed.data.amountEur >= 0 ? 'admin_adjustment' : 'refund',
        amountEur: parsed.data.amountEur,
        description: parsed.data.description,
        referenceType: 'admin_adjustment',
        referenceId: `admin-${Date.now().toString(36)}`,
        metadata: { adminUserId: String(req.user.id) },
      })
      const balanceEur = await getUserCreditBalance(userId, conn)
      await conn.commit()
      res.json({ ok: true, userId: String(userId), balanceEur })
    } catch (e) {
      await conn.rollback().catch(() => {})
      throw e
    } finally {
      conn.release()
    }
  } catch (e) {
    console.error('admin/billing/users credit', e)
    res.status(500).json({ error: 'Impossible d’ajuster les crédits.' })
  }
})

adminRouter.get('/site/stats', async (_req, res) => {
  try {
    const [[counts]] = await pool.query(`
      SELECT
        COUNT(*) AS totalUsers,
        SUM(is_admin = 1) AS totalAdmins,
        SUM(created_at >= NOW() - INTERVAL 24 HOUR) AS newUsers24h,
        SUM(created_at >= NOW() - INTERVAL 7 DAY) AS newUsers7d,
        SUM(last_login_at >= NOW() - INTERVAL 24 HOUR) AS activeUsers24h,
        SUM(last_login_at >= NOW() - INTERVAL 7 DAY) AS activeUsers7d
      FROM users
    `)
    const [series] = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS n
      FROM users
      WHERE created_at >= NOW() - INTERVAL 30 DAY
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `)
    res.json({
      stats: {
        totalUsers: Number(counts.totalUsers || 0),
        totalAdmins: Number(counts.totalAdmins || 0),
        newUsers24h: Number(counts.newUsers24h || 0),
        newUsers7d: Number(counts.newUsers7d || 0),
        activeUsers24h: Number(counts.activeUsers24h || 0),
        activeUsers7d: Number(counts.activeUsers7d || 0),
      },
      registrationsLast30d: series.map((r) => ({
        day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
        count: Number(r.n),
      })),
    })
  } catch (e) {
    console.error('admin/site/stats', e)
    res.status(500).json({ error: 'Erreur lecture statistiques.' })
  }
})

adminRouter.get('/users', async (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase()
  try {
    let rows
    if (search) {
      ;[rows] = await pool.query(
        `SELECT u.id, u.email, u.is_admin AS isAdmin, u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
                COALESCE(b.balanceEuro, 0) AS balanceEuro
         FROM users u
         LEFT JOIN (
           SELECT user_id, SUM(amount_eur) AS balanceEuro
           FROM billing_credit_ledger
           GROUP BY user_id
         ) b ON b.user_id = u.id
         WHERE LOWER(u.email) LIKE :q
         ORDER BY u.created_at DESC LIMIT 500`,
        { q: `%${search}%` },
      )
    } else {
      ;[rows] = await pool.query(
        `SELECT u.id, u.email, u.is_admin AS isAdmin, u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
                COALESCE(b.balanceEuro, 0) AS balanceEuro
         FROM users u
         LEFT JOIN (
           SELECT user_id, SUM(amount_eur) AS balanceEuro
           FROM billing_credit_ledger
           GROUP BY user_id
         ) b ON b.user_id = u.id
         ORDER BY u.created_at DESC LIMIT 500`,
      )
    }
    res.json({
      users: rows.map((r) => ({
        id: String(r.id),
        email: r.email,
        isAdmin: !!r.isAdmin,
        balanceEuro: Number(r.balanceEuro || 0),
        createdAt: r.createdAt,
        lastLoginAt: r.lastLoginAt,
      })),
    })
  } catch (e) {
    console.error('admin/users', e)
    res.status(500).json({ error: 'Erreur lecture utilisateurs.' })
  }
})

adminRouter.get('/users/:id', async (req, res) => {
  const id = String(req.params.id)
  try {
    const [userRows] = await pool.query(
      `SELECT u.id, u.email, u.is_admin AS isAdmin, u.google_id AS googleId,
              u.created_at AS createdAt, u.updated_at AS updatedAt, u.last_login_at AS lastLoginAt,
              COALESCE(b.balanceEuro, 0) AS balanceEuro
       FROM users u
       LEFT JOIN (
         SELECT user_id, SUM(amount_eur) AS balanceEuro
         FROM billing_credit_ledger
         WHERE user_id = :id
         GROUP BY user_id
       ) b ON b.user_id = u.id
       WHERE u.id = :id
       LIMIT 1`,
      { id },
    )
    const user = userRows[0]
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' })

    const [[usage]] = await pool.query(
      `SELECT
         COUNT(*) AS apiRequests,
         COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
         COALESCE(SUM(completion_tokens), 0) AS completionTokens,
         COALESCE(SUM(total_tokens), 0) AS totalTokens,
         COALESCE(SUM(cost_eur), 0) AS costEur,
         COALESCE(AVG(NULLIF(latency_ms, 0)), 0) AS avgLatencyMs
       FROM api_key_usage
       WHERE user_id = :id`,
      { id },
    )
    const [[sessionStats]] = await pool.query(
      `SELECT COUNT(*) AS sessionCount,
              COALESCE(SUM(JSON_EXTRACT(session_json, '$.completionTokens')), 0) AS sessionCompletionTokens,
              COALESCE(AVG(JSON_EXTRACT(session_json, '$.hotPathTps')), 0) AS avgSessionTps
       FROM p2p_chat_sessions
       WHERE user_id = :id`,
      { id },
    )
    const [workers] = await pool.query(
      `SELECT peer_id AS peerId, mode, public_ip AS publicIp, model,
              gpu_name AS gpuName, gpu_vram_mb AS gpuVramMb,
              allocated_vram_mb AS allocatedVramMb, memory_limit_percent AS memoryLimitPercent,
              runtime_backend AS runtimeBackend, tokens_generated AS tokensGenerated,
              tokens_in AS tokensIn, tokens_out AS tokensOut,
              desired_state AS desiredState, desired_model AS desiredModel,
              last_command_status AS lastCommandStatus, last_command_error AS lastCommandError,
              last_heartbeat_at AS lastHeartbeatAt,
              TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
       FROM workers
       WHERE user_id = :id
       ORDER BY last_heartbeat_at DESC
       LIMIT 100`,
      { id },
    )
    const [keys] = await pool.query(
      `SELECT k.id, k.name, k.key_prefix AS keyPrefix, k.created_at AS createdAt,
              k.last_used_at AS lastUsedAt, k.revoked_at AS revokedAt,
              COALESCE(u.requestCount, 0) AS requestCount,
              COALESCE(u.totalTokens, 0) AS totalTokens,
              COALESCE(u.costEur, 0) AS costEur
       FROM api_keys k
       LEFT JOIN (
         SELECT api_key_id, COUNT(*) AS requestCount, SUM(total_tokens) AS totalTokens, SUM(cost_eur) AS costEur
         FROM api_key_usage
         WHERE user_id = :id
         GROUP BY api_key_id
       ) u ON u.api_key_id = k.id
       WHERE k.user_id = :id
       ORDER BY k.created_at DESC
       LIMIT 50`,
      { id },
    )
    const [sessions] = await pool.query(
      `SELECT id, created_at AS createdAt, session_json AS sessionJson
       FROM p2p_chat_sessions
       WHERE user_id = :id
       ORDER BY created_at DESC
       LIMIT 20`,
      { id },
    )
    res.json({
      user: {
        id: String(user.id),
        email: user.email,
        isAdmin: Boolean(user.isAdmin),
        googleLinked: Boolean(user.googleId),
        balanceEuro: Number(user.balanceEuro || 0),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
      },
      usage: {
        apiRequests: Number(usage.apiRequests || 0),
        promptTokens: Number(usage.promptTokens || 0),
        completionTokens: Number(usage.completionTokens || 0),
        totalTokens: Number(usage.totalTokens || 0),
        costEur: Number(usage.costEur || 0),
        avgLatencyMs: Number(usage.avgLatencyMs || 0),
        sessionCount: Number(sessionStats.sessionCount || 0),
        sessionCompletionTokens: Number(sessionStats.sessionCompletionTokens || 0),
        avgSessionTps: Number(sessionStats.avgSessionTps || 0),
      },
      workers: workers.map((w) => ({
        ...w,
        gpuVramMb: w.gpuVramMb != null ? Number(w.gpuVramMb) : null,
        allocatedVramMb: w.allocatedVramMb != null ? Number(w.allocatedVramMb) : null,
        memoryLimitPercent: w.memoryLimitPercent != null ? Number(w.memoryLimitPercent) : null,
        tokensGenerated: Number(w.tokensGenerated || 0),
        tokensIn: Number(w.tokensIn || 0),
        tokensOut: Number(w.tokensOut || 0),
        online: Number(w.secondsSinceHeartbeat) <= WORKER_OFFLINE_SEC,
        secondsSinceHeartbeat: Number(w.secondsSinceHeartbeat),
      })),
      apiKeys: keys.map((k) => ({
        id: String(k.id),
        name: k.name,
        keyPrefix: k.keyPrefix,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
        requestCount: Number(k.requestCount || 0),
        totalTokens: Number(k.totalTokens || 0),
        costEur: Number(k.costEur || 0),
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        metrics: parseMaybeJsonObject(s.sessionJson),
      })),
    })
  } catch (e) {
    console.error('admin/users/detail', e)
    res.status(500).json({ error: 'Erreur lecture détail utilisateur.' })
  }
})

const setAdminBodySchema = z.object({ isAdmin: z.boolean() })
adminRouter.patch('/users/:id/admin', async (req, res) => {
  const parsed = setAdminBodySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Corps invalide.' })
  const id = String(req.params.id)
  if (id === String(req.user.id) && parsed.data.isAdmin === false) {
    return res
      .status(400)
      .json({ error: 'Vous ne pouvez pas retirer votre propre statut administrateur.' })
  }
  try {
    const [rows] = await pool.query('SELECT email FROM users WHERE id = :id', { id })
    if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable.' })
    if (
      parsed.data.isAdmin === false &&
      FORCED_ADMIN_EMAILS.includes(String(rows[0].email).toLowerCase())
    ) {
      return res
        .status(400)
        .json({ error: 'Cet e-mail est protégé (admin imposé par configuration).' })
    }
    await pool.query('UPDATE users SET is_admin = :v WHERE id = :id', {
      v: parsed.data.isAdmin ? 1 : 0,
      id,
    })
    res.json({ ok: true })
  } catch (e) {
    console.error('admin/users/admin', e)
    res.status(500).json({ error: 'Erreur mise à jour.' })
  }
})

adminRouter.delete('/users/:id', async (req, res) => {
  const id = String(req.params.id)
  if (id === String(req.user.id)) {
    return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte ici.' })
  }
  try {
    const [rows] = await pool.query('SELECT email FROM users WHERE id = :id', { id })
    if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable.' })
    if (FORCED_ADMIN_EMAILS.includes(String(rows[0].email).toLowerCase())) {
      return res.status(400).json({ error: 'Cet e-mail est protégé.' })
    }
    await pool.query('DELETE FROM users WHERE id = :id', { id })
    res.json({ ok: true })
  } catch (e) {
    console.error('admin/users/delete', e)
    res.status(500).json({ error: 'Erreur suppression.' })
  }
})

adminRouter.get('/workers/live', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT w.peer_id AS peerId, w.mode, w.grpc_port AS grpcPort, w.p2p_port AS p2pPort,
              w.public_ip AS publicIp, w.version, w.p2p_peers AS p2pPeers,
              w.tokens_generated AS tokensGenerated, w.tokens_in AS tokensIn, w.tokens_out AS tokensOut,
              w.model, w.gpu_name AS gpuName, w.gpu_vram_mb AS gpuVramMb,
              w.allocated_vram_mb AS allocatedVramMb, w.memory_limit_percent AS memoryLimitPercent,
              w.runtime_backend AS runtimeBackend, w.weight_quantization AS weightQuantization,
              w.supports_q4_weights AS supportsQ4Weights, w.supports_mlx AS supportsMlx, w.supports_vllm AS supportsVllm,
              w.machine_info AS machineInfo,
              w.desired_state AS desiredState, w.desired_model AS desiredModel,
              w.desired_allocated_vram_mb AS desiredAllocatedVramMb,
              w.desired_memory_limit_percent AS desiredMemoryLimitPercent,
              w.health_score AS storedHealthScore, w.runtime_state AS runtimeState,
              w.reserved_until AS reservedUntil, w.current_job_id AS currentJobId,
              w.capabilities_json AS capabilitiesJson,
              w.last_command_at AS lastCommandAt, w.last_command_status AS lastCommandStatus,
              w.last_command_error AS lastCommandError,
              w.last_heartbeat_at AS lastHeartbeatAt,
              TIMESTAMPDIFF(SECOND, w.last_heartbeat_at, NOW()) AS secondsSinceHeartbeat,
              u.email AS ownerEmail
       FROM workers w
       LEFT JOIN users u ON u.id = w.user_id
       WHERE TIMESTAMPDIFF(SECOND, w.last_heartbeat_at, NOW()) <= :liveSec
       ORDER BY w.last_heartbeat_at DESC
       LIMIT 100`,
      { liveSec: WORKER_LIVE_SEC },
    )
    return res.json({
      liveSec: WORKER_LIVE_SEC,
      workers: rows.map((r) => ({
        peerId: r.peerId,
        mode: r.mode,
        grpcPort: r.grpcPort,
        p2pPort: r.p2pPort,
        publicIp: r.publicIp,
        version: r.version,
        p2pPeers: Number(r.p2pPeers || 0),
        tokensGenerated: Number(r.tokensGenerated || 0),
        tokensIn: Number(r.tokensIn || 0),
        tokensOut: Number(r.tokensOut || 0),
        model: r.model ?? null,
        gpuName: r.gpuName ?? null,
        gpuVramMb: r.gpuVramMb != null ? Number(r.gpuVramMb) : null,
        allocatedVramMb: r.allocatedVramMb != null ? Number(r.allocatedVramMb) : null,
        memoryLimitPercent: r.memoryLimitPercent != null ? Number(r.memoryLimitPercent) : null,
        machineInfo: parseMaybeJsonObject(r.machineInfo),
        lastHeartbeatAt: r.lastHeartbeatAt,
        secondsSinceHeartbeat: Number(r.secondsSinceHeartbeat),
        ownerEmail: r.ownerEmail ?? null,
        desiredState: r.desiredState ?? 'active',
        desiredModel: r.desiredModel ?? null,
        desiredAllocatedVramMb: r.desiredAllocatedVramMb != null ? Number(r.desiredAllocatedVramMb) : null,
        desiredMemoryLimitPercent: r.desiredMemoryLimitPercent != null ? Number(r.desiredMemoryLimitPercent) : null,
        lastCommandAt: r.lastCommandAt ?? null,
        lastCommandStatus: r.lastCommandStatus ?? null,
        lastCommandError: r.lastCommandError ?? null,
      })),
    })
  } catch (e) {
    console.error('admin/workers/live', e)
    return res.status(500).json({ error: 'Erreur lecture workers live.' })
  }
})

adminRouter.get('/workers/registered', async (req, res) => {
  const limit = Math.max(10, Math.min(500, Number(req.query.limit) || 200))
  try {
    const [rows] = await pool.query(
      `SELECT w.peer_id, w.mode, w.grpc_port, w.p2p_port, w.public_ip, w.version,
              w.p2p_peers, w.tokens_generated, w.tokens_in, w.tokens_out, w.model,
              w.gpu_name AS gpuName, w.gpu_vram_mb AS gpuVramMb,
              w.allocated_vram_mb AS allocatedVramMb, w.memory_limit_percent AS memoryLimitPercent,
              w.runtime_backend AS runtimeBackend, w.weight_quantization AS weightQuantization,
              w.supports_q4_weights AS supportsQ4Weights, w.supports_mlx AS supportsMlx, w.supports_vllm AS supportsVllm,
              w.machine_info AS machineInfo,
              w.desired_state AS desiredState, w.desired_model AS desiredModel,
              w.desired_allocated_vram_mb AS desiredAllocatedVramMb,
              w.desired_memory_limit_percent AS desiredMemoryLimitPercent,
              w.health_score AS storedHealthScore, w.runtime_state AS runtimeState,
              w.reserved_until AS reservedUntil, w.current_job_id AS currentJobId,
              w.capabilities_json AS capabilitiesJson,
              w.last_command_at AS lastCommandAt, w.last_command_status AS lastCommandStatus,
              w.last_command_error AS lastCommandError,
              w.last_heartbeat_at AS lastHeartbeatAt, w.first_seen_at AS firstSeenAt,
              TIMESTAMPDIFF(SECOND, w.last_heartbeat_at, NOW()) AS secondsSinceHeartbeat,
              u.email AS ownerEmail,
              (SELECT COALESCE(SUM(l.delta_tokens), 0) FROM worker_token_ledger l
                 WHERE l.peer_id = w.peer_id AND l.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS tokensGenerated1h,
              (SELECT COALESCE(SUM(l.delta_tokens), 0) FROM worker_token_ledger l
                 WHERE l.peer_id = w.peer_id AND l.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS tokensGenerated24h
       FROM workers w
       LEFT JOIN users u ON u.id = w.user_id
       ORDER BY w.last_heartbeat_at DESC LIMIT :limit`,
      { limit },
    )
    const totalTokens = rows.reduce((s, r) => s + Number(r.tokens_generated || 0), 0)
    return res.json({
      totalTokensGenerated: totalTokens,
      workers: rows.map((r) => {
        const health = workerHealthScore(r)
        return ({
        peerId: r.peer_id,
        mode: r.mode,
        grpcPort: r.grpc_port,
        p2pPort: r.p2p_port,
        publicIp: r.public_ip,
        version: r.version,
        p2pPeers: Number(r.p2p_peers || 0),
        tokensGenerated: Number(r.tokens_generated || 0),
        tokensGenerated1h: Number(r.tokensGenerated1h || 0),
        tokensGenerated24h: Number(r.tokensGenerated24h || 0),
        tokensIn: Number(r.tokens_in ?? 0),
        tokensOut: Number(r.tokens_out ?? 0),
        model: r.model ?? null,
        gpuName: r.gpuName ?? null,
        gpuVramMb: r.gpuVramMb != null ? Number(r.gpuVramMb) : null,
        allocatedVramMb: r.allocatedVramMb != null ? Number(r.allocatedVramMb) : null,
        memoryLimitPercent: r.memoryLimitPercent != null ? Number(r.memoryLimitPercent) : null,
        runtimeBackend: r.runtimeBackend ?? null,
        weightQuantization: r.weightQuantization ?? null,
        supportsQ4Weights: Boolean(r.supportsQ4Weights),
        supportsMlx: Boolean(r.supportsMlx),
        supportsVllm: Boolean(r.supportsVllm),
        machineInfo: parseMaybeJsonObject(r.machineInfo),
        lastHeartbeatAt: r.lastHeartbeatAt,
        firstSeenAt: r.firstSeenAt,
        online: Number(r.secondsSinceHeartbeat) <= WORKER_OFFLINE_SEC,
        secondsSinceHeartbeat: Number(r.secondsSinceHeartbeat),
        ownerEmail: r.ownerEmail ?? null,
        desiredState: r.desiredState ?? 'active',
        desiredModel: r.desiredModel ?? null,
        desiredAllocatedVramMb: r.desiredAllocatedVramMb != null ? Number(r.desiredAllocatedVramMb) : null,
        desiredMemoryLimitPercent: r.desiredMemoryLimitPercent != null ? Number(r.desiredMemoryLimitPercent) : null,
        healthScore: health.score,
        healthState: health.state,
        healthReasons: health.reasons,
        storedHealthScore: Number(r.storedHealthScore || 0),
        runtimeState: r.runtimeState || 'idle',
        reservedUntil: toIsoDate(r.reservedUntil),
        currentJobId: r.currentJobId ?? null,
        capabilities: parseMaybeJsonObject(r.capabilitiesJson) || workerCapabilities(r),
        lastCommandAt: r.lastCommandAt ?? null,
        lastCommandStatus: r.lastCommandStatus ?? null,
        lastCommandError: r.lastCommandError ?? null,
      })}),
    })
  } catch (e) {
    console.error('admin/workers/registered', e)
    return res.status(500).json({ error: 'Erreur lecture workers.' })
  }
})

async function fetchJsonWithTimeout(url, timeoutMs = 2500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(url, { signal: controller.signal })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 1000) } }
    return { ok: response.ok, status: response.status, elapsedMs: Date.now() - started, body }
  } catch (e) {
    return { ok: false, status: 0, elapsedMs: Date.now() - started, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

adminRouter.get('/workers/:peerId/health', async (req, res) => {
  const peerId = decodeURIComponent(String(req.params.peerId || ''))
  if (!peerId) return res.status(400).json({ ok: false, error: 'peerId requis.' })
  try {
    const [rows] = await pool.query(
      `SELECT peer_id AS peerId, public_ip AS publicIp, grpc_port AS grpcPort, p2p_port AS p2pPort,
              version, model, runtime_backend AS runtimeBackend, weight_quantization AS weightQuantization,
              runtime_state AS runtimeState, health_score AS healthScore,
              last_command_status AS lastCommandStatus, last_command_error AS lastCommandError,
              worker_secret_hash IS NOT NULL AS hasWorkerSecret,
              worker_secret_expires_at AS workerSecretExpiresAt,
              TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
       FROM workers WHERE peer_id = :peerId LIMIT 1`,
      { peerId },
    )
    const worker = rows[0]
    if (!worker) return res.status(404).json({ ok: false, error: 'Worker introuvable.' })
    const publicIp = String(worker.publicIp || '').replace(/^::ffff:/, '')
    const probes = {}
    if (publicIp) {
      probes.status = await fetchJsonWithTimeout(`http://${publicIp}:3031/api/status`, 2200)
      probes.shards = await fetchJsonWithTimeout(`http://${publicIp}:3031/api/shards`, 2500)
      const grpcPort = Number(worker.grpcPort || 50052)
      if (Number.isFinite(grpcPort) && grpcPort > 0) {
        probes.pythonAdmin = await fetchJsonWithTimeout(`http://${publicIp}:${grpcPort + 1}/health`, 1800)
      }
    }
    const shardBody = probes.shards?.body || {}
    const shards = Array.isArray(shardBody.shards) ? shardBody.shards : []
    const shardSummary = {
      ok: Boolean(probes.shards?.ok && shardBody.ok !== false),
      count: shards.length,
      ready: shards.filter((s) => s?.ready || s?.resident_vram || s?.built).length,
      loading: shards.filter((s) => s?.loading).length,
      errors: shards.map((s) => s?.load_error || s?.error).filter(Boolean).slice(0, 5),
      sessions: shards.slice(0, 8).map((s) => ({
        sessionId: s.session_id,
        modelId: s.model_id,
        layers: `${s.layer_start}-${s.layer_end}`,
        ready: Boolean(s.ready || s.resident_vram || s.built),
        loading: Boolean(s.loading),
        weightsLoaded: Number(s.weights_loaded || 0),
        weightQuantization: s.weight_quantization || null,
        runtimeBackend: s.runtime_backend || null,
        attentionBackend: s.attention_backend || null,
        loadError: s.load_error || null,
      })),
    }
    return res.json({
      ok: true,
      worker: {
        ...worker,
        secondsSinceHeartbeat: Number(worker.secondsSinceHeartbeat),
        healthScore: Number(worker.healthScore || 0),
        hasWorkerSecret: Boolean(worker.hasWorkerSecret),
      },
      probes,
      shardSummary,
    })
  } catch (e) {
    console.error('admin/workers/health', e)
    return res.status(500).json({ ok: false, error: 'Erreur healthcheck worker.' })
  }
})

const workerActionBodySchema = z.object({
  action: z.enum(['pause', 'resume', 'drain', 'stop', 'restart', 'set_model', 'set_memory', 'update_software', 'hot_reload_python', 'rotate_secret']),
  model: z.string().min(1).max(140).optional(),
  loadMode: z.enum(['auto', 'full', 'shard']).optional(),
  quantization: z.string().min(1).max(20).optional(),
  allocatedVramMb: z.number().int().min(256).max(262144).optional(),
  memoryPercent: z.number().int().min(1).max(100).optional(),
  files: z.array(z.string().min(1).max(80)).max(10).optional(),
})

adminRouter.post('/workers/:peerId/actions', async (req, res) => {
  const peerId = decodeURIComponent(String(req.params.peerId || ''))
  const parsed = workerActionBodySchema.safeParse(req.body || {})
  if (!peerId) return res.status(400).json({ ok: false, error: 'peerId requis.' })
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Action worker invalide.' })
  const { action, model, loadMode, quantization, allocatedVramMb, memoryPercent, files } = parsed.data
  if (action === 'set_model' && !model) {
    return res.status(400).json({ ok: false, error: 'Modèle requis.' })
  }
  if (action === 'set_memory' && !allocatedVramMb && !memoryPercent) {
    return res.status(400).json({ ok: false, error: 'Mémoire ou pourcentage requis.' })
  }
  try {
    await expireWorkerCommands()
    const [rows] = await pool.query(
      `SELECT peer_id, desired_model AS desiredModel,
              desired_allocated_vram_mb AS desiredAllocatedVramMb,
              desired_memory_limit_percent AS desiredMemoryLimitPercent,
              version
       FROM workers WHERE peer_id = :peerId LIMIT 1`,
      { peerId },
    )
    const currentWorker = rows[0]
    if (!currentWorker) return res.status(404).json({ ok: false, error: 'Worker introuvable.' })
    const desiredState =
      action === 'pause' ? 'paused'
      : action === 'drain' ? 'draining'
      : action === 'stop' ? 'stopped'
      : action === 'resume' || action === 'restart' ? 'active'
      : null
    const payload = {
      model: model || null,
      loadMode: action === 'set_model' ? loadMode || 'auto' : null,
      quantization: action === 'set_model' ? quantization || 'q4' : null,
      allocatedVramMb: allocatedVramMb ?? null,
      memoryPercent: memoryPercent ?? null,
      files: action === 'hot_reload_python' ? (files ?? ['shard_runtime', 'distributed_llm_orchestrator']) : null,
      requestedBy: req.user.id,
      previous: {
        desiredModel: currentWorker.desiredModel ?? null,
        desiredAllocatedVramMb: currentWorker.desiredAllocatedVramMb ?? null,
        desiredMemoryLimitPercent: currentWorker.desiredMemoryLimitPercent ?? null,
      },
    }
    if (action === 'update_software') {
      Object.assign(payload, { release: await currentWorkerRelease('stable') })
      const targetVersion = String(payload.release?.version || '').trim()
      const currentVersion = String(currentWorker.version || '').trim()
      const hasReleaseHash = Boolean(payload.release?.macSha256 || payload.release?.winX64Sha256 || payload.release?.winArm64Sha256 || payload.release?.runtimeSha256)
      if (!hasReleaseHash) {
        return res.status(409).json({ ok: false, error: 'Release worker sans hash SHA-256: update distante refusée.' })
      }
      if (targetVersion && currentVersion && compareVersionLike(currentVersion, targetVersion) >= 0) {
        return res.json({
          ok: true,
          noop: true,
          command: null,
          status: 'already_current',
          currentVersion,
          targetVersion,
        })
      }
    }
    let rotatedWorkerSecret = ''
    if (action === 'rotate_secret') {
      rotatedWorkerSecret = crypto.randomBytes(32).toString('hex')
      Object.assign(payload, {
        workerSecret: rotatedWorkerSecret,
        secretExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      })
    }
    const runtimeState =
      action === 'update_software' ? 'updating'
      : action === 'restart' ? 'restarting'
      : action === 'set_model' ? 'loading_shard'
      : action === 'rotate_secret' ? 'updating'
      : null
    const [result] = await pool.query(
      `INSERT INTO worker_commands (peer_id, action, payload_json, requested_by, expires_at)
       VALUES (:peerId, :action, :payload, :requestedBy, DATE_ADD(NOW(), INTERVAL :ttlMinute MINUTE))`,
      {
        peerId,
        action,
        payload: JSON.stringify(payload),
        requestedBy: req.user.id,
        ttlMinute: action === 'update_software' ? 15 : 5,
      },
    )
    await pool.query(
      `UPDATE workers
	       SET desired_state = COALESCE(:desiredState, desired_state),
           desired_model = COALESCE(:model, desired_model),
           desired_allocated_vram_mb = COALESCE(:allocatedVramMb, desired_allocated_vram_mb),
           desired_memory_limit_percent = COALESCE(:memoryPercent, desired_memory_limit_percent),
	           last_command_at = CURRENT_TIMESTAMP,
	           last_command_status = 'pending',
	           last_command_error = NULL,
	           runtime_state = COALESCE(:runtimeState, runtime_state),
	           worker_next_secret_hash = COALESCE(:workerSecretHash, worker_next_secret_hash),
	           worker_next_secret_expires_at = COALESCE(:workerSecretExpiresAt, worker_next_secret_expires_at)
	       WHERE peer_id = :peerId`,
      {
        peerId,
        desiredState,
        model: action === 'set_model' ? model : null,
        allocatedVramMb: action === 'set_memory' ? allocatedVramMb ?? null : null,
	        memoryPercent: action === 'set_memory' ? memoryPercent ?? null : null,
	        runtimeState,
	        workerSecretHash: rotatedWorkerSecret ? sha256Hex(rotatedWorkerSecret) : null,
	        workerSecretExpiresAt: rotatedWorkerSecret ? payload.secretExpiresAt.slice(0, 19).replace('T', ' ') : null,
	      },
	    )
    return res.json({
      ok: true,
      command: {
        id: String(result.insertId),
        peerId,
        action,
        payload: action === 'rotate_secret' ? { ...payload, workerSecret: '[redacted]' } : payload,
        status: 'pending',
      },
    })
  } catch (e) {
    console.error('admin/workers/actions', e)
    return res.status(500).json({ ok: false, error: 'Erreur création commande worker.' })
  }
})

adminRouter.post('/workers/:peerId/commands/:commandId/cancel', async (req, res) => {
  const peerId = decodeURIComponent(String(req.params.peerId || ''))
  const commandId = String(req.params.commandId || '')
  if (!peerId || !commandId) return res.status(400).json({ ok: false, error: 'Commande invalide.' })
  try {
    const [result] = await pool.query(
      `UPDATE worker_commands
       SET status = 'cancelled',
           error = COALESCE(error, 'Annulée depuis le panel admin.')
       WHERE id = :commandId
         AND peer_id = :peerId
         AND status IN ('pending','delivered')`,
      { commandId, peerId },
    )
    if (Number(result.affectedRows || 0) === 0) {
      return res.status(409).json({ ok: false, error: 'Commande déjà terminée ou introuvable.' })
    }
    await rollbackDesiredStateFromCommand(peerId, commandId).catch(() => {})
    await pool.query(
      `UPDATE workers
       SET last_command_status = 'cancelled',
           last_command_error = NULL
       WHERE peer_id = :peerId`,
      { peerId },
    )
    return res.json({ ok: true })
  } catch (e) {
    console.error('admin/workers/commands/cancel', e)
    return res.status(500).json({ ok: false, error: 'Erreur annulation commande worker.' })
  }
})

adminRouter.get('/workers/:peerId/commands', async (req, res) => {
  const peerId = decodeURIComponent(String(req.params.peerId || ''))
  if (!peerId) return res.status(400).json({ ok: false, error: 'peerId requis.' })
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.action, c.payload_json AS payloadJson, c.status, c.error,
              c.created_at AS createdAt, c.delivered_at AS deliveredAt, c.acknowledged_at AS acknowledgedAt,
              c.expires_at AS expiresAt, c.superseded_by AS supersededBy,
              u.email AS requestedByEmail
       FROM worker_commands c
       LEFT JOIN users u ON u.id = c.requested_by
       WHERE c.peer_id = :peerId
       ORDER BY c.created_at DESC
       LIMIT 40`,
      { peerId },
    )
    return res.json({
      ok: true,
      commands: rows.map((r) => ({
        id: String(r.id),
        action: r.action,
        payload: parseMaybeJsonObject(r.payloadJson),
        status: r.status,
        error: r.error ?? null,
        createdAt: r.createdAt,
        deliveredAt: r.deliveredAt,
        acknowledgedAt: r.acknowledgedAt,
        expiresAt: r.expiresAt,
        supersededBy: r.supersededBy != null ? String(r.supersededBy) : null,
        requestedByEmail: r.requestedByEmail ?? null,
      })),
    })
  } catch (e) {
    console.error('admin/workers/commands', e)
    return res.status(500).json({ ok: false, error: 'Erreur lecture commandes worker.' })
  }
})

app.get('/api/worker/releases/current', async (req, res) => {
  try {
    const channel = String(req.query.channel || 'stable').slice(0, 40)
    res.json({ ok: true, release: await currentWorkerRelease(channel) })
  } catch (e) {
    console.error('worker/releases/current', e)
    res.status(500).json({ ok: false, error: 'Erreur lecture release worker.' })
  }
})

const workerReleaseBodySchema = z.object({
  version: z.string().min(1).max(40),
  channel: z.string().min(1).max(40).optional().default('stable'),
  macUrl: z.string().max(500).nullable().optional(),
  winX64Url: z.string().max(500).nullable().optional(),
  winArm64Url: z.string().max(500).nullable().optional(),
  runtimeUrl: z.string().max(500).nullable().optional(),
  macSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
  winX64Sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
  winArm64Sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
  runtimeSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  mandatory: z.boolean().optional().default(false),
})

adminRouter.post('/worker/releases', async (req, res) => {
  const parsed = workerReleaseBodySchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Release invalide.' })
  const r = parsed.data
  try {
    const [result] = await pool.query(
      `INSERT INTO worker_releases
         (channel, version, mac_url, win_x64_url, win_arm64_url, runtime_url,
          mac_sha256, win_x64_sha256, win_arm64_sha256, runtime_sha256,
          notes, mandatory, created_by)
       VALUES
         (:channel, :version, :macUrl, :winX64Url, :winArm64Url, :runtimeUrl,
          :macSha256, :winX64Sha256, :winArm64Sha256, :runtimeSha256,
          :notes, :mandatory, :createdBy)`,
      {
        channel: r.channel,
        version: r.version,
        macUrl: r.macUrl || null,
        winX64Url: r.winX64Url || null,
        winArm64Url: r.winArm64Url || null,
        runtimeUrl: r.runtimeUrl || null,
        macSha256: r.macSha256 || null,
        winX64Sha256: r.winX64Sha256 || null,
        winArm64Sha256: r.winArm64Sha256 || null,
        runtimeSha256: r.runtimeSha256 || null,
        notes: r.notes || null,
        mandatory: r.mandatory ? 1 : 0,
        createdBy: req.user.id,
      },
    )
    res.json({ ok: true, release: { id: String(result.insertId), ...r } })
  } catch (e) {
    console.error('admin/worker/releases', e)
    res.status(500).json({ ok: false, error: 'Erreur création release worker.' })
  }
})

adminRouter.get('/workers/:peerId/ping', adminWorkerPingLimiter, async (req, res) => {
  const peerId = decodeURIComponent(String(req.params.peerId || ''))
  if (!peerId) return res.status(400).json({ ok: false, error: 'peerId requis.' })
  try {
    const [rows] = await pool.query(
      `SELECT public_ip AS publicIp, grpc_port AS grpcPort, p2p_port AS p2pPort,
              TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
       FROM workers WHERE peer_id = ? LIMIT 1`,
      [peerId],
    )
    const row = rows[0]
    if (!row) return res.status(404).json({ ok: false, error: 'Worker inconnu.' })
    const secondsSinceHeartbeat = Number(row.secondsSinceHeartbeat)
    if (Number.isFinite(secondsSinceHeartbeat) && secondsSinceHeartbeat > WORKER_LIVE_SEC) {
      return res.json({
        ok: false,
        stale: true,
        secondsSinceHeartbeat,
        error: 'Worker hors ligne : heartbeat trop ancien, ping actif non lancé.',
      })
    }
    const out = await measureWorkerProbeLatency({
      publicIp: row.publicIp,
      grpcPort: row.grpcPort,
      p2pPort: row.p2pPort,
    })
    return res.json(out)
  } catch (e) {
    console.error('admin/workers/:peerId/ping', e)
    return res.status(500).json({ ok: false, error: 'Erreur mesure latence.' })
  }
})

adminRouter.get('/scheduler/preview', async (req, res) => {
  try {
    const model = normalizeP2pModelId(String(req.query.model || '')) || 'Qwen/Qwen3.6-35B-A3B'
    const mode = ['auto', 'full', 'shard'].includes(req.query.mode) ? req.query.mode : 'auto'
    const workers = await loadSchedulerWorkers(model, { strictModel: true })
    const candidates = workers.map((worker) => {
      const health = workerHealthScore(worker)
      return {
        peerId: worker.peerId,
        model: worker.model,
        gpuName: worker.gpuName,
        allocatedVramMb: Number(worker.allocatedVramMb || 0),
        runtimeBackend: worker.runtimeBackend,
        secondsSinceHeartbeat: worker.secondsSinceHeartbeat,
        runtimeState: worker.runtimeState || 'idle',
        reservedUntil: toIsoDate(worker.reservedUntil),
        healthScore: health.score,
        healthState: health.state,
        healthReasons: health.reasons,
        capabilities: workerCapabilities(worker),
      }
    })
    res.json({
      ok: true,
      model,
      mode,
      healthThreshold: WORKER_HEALTH_MIN_FOR_SCHEDULER,
      reservationTtlSec: WORKER_RESERVATION_TTL_SEC,
      plan: modelPlanFor(model, workers, mode),
      candidates,
    })
  } catch (e) {
    console.error('admin/scheduler/preview', e)
    res.status(500).json({ ok: false, error: 'Erreur preview scheduler.' })
  }
})

adminRouter.get('/models/plan', async (req, res) => {
  try {
    const model = normalizeP2pModelId(String(req.query.model || '')) || 'Qwen/Qwen3.6-35B-A3B'
    const mode = ['auto', 'full', 'shard'].includes(req.query.mode) ? req.query.mode : 'auto'
    const workers = await loadSchedulerWorkers(model, { strictModel: true })
    res.json({ ok: true, plan: modelPlanFor(model, workers, mode) })
  } catch (e) {
    console.error('admin/models/plan', e)
    res.status(500).json({ ok: false, error: 'Erreur calcul plan modèle.' })
  }
})

adminRouter.post('/benchmarks/run', chatLimiter, async (req, res) => {
  const billingRate = await resolveBillingEurPerMillion()
  const model = normalizeP2pModelId(req.body?.model || '') || 'Qwen/Qwen3.6-35B-A3B'
  const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
    ? req.body.prompt.trim()
    : 'Réponds en une phrase courte: Vryx benchmark OK.'
  const maxNewTokens = Math.max(8, Math.min(512, Number(req.body?.max_new_tokens || req.body?.maxNewTokens || 64)))
  const reservation = await reserveWorkersForJob({ modelId: model, loadMode: req.body?.mode || 'auto', createdBy: req.user.id })
  if (!reservation.ok) {
    await pool.query(
      `INSERT INTO worker_benchmark_runs
       (job_id, model, mode, status, worker_count, plan_json, error, created_by, cost_per_million_eur)
       VALUES (:jobId, :model, :mode, 'failed', 0, :plan, :error, :createdBy, :costPerMillion)`,
      {
        jobId: reservation.jobId,
        model,
        mode: req.body?.mode || 'auto',
        plan: JSON.stringify(reservation.plan || null),
        error: 'Aucun plan worker stable disponible pour ce benchmark.',
        createdBy: req.user.id,
        costPerMillion: billingRate,
      },
    ).catch(() => {})
    return res.status(409).json({
      ok: false,
      error: 'Aucun plan worker stable disponible pour ce benchmark.',
      plan: reservation.plan,
    })
  }
  const startedAt = Date.now()
  try {
    await markWorkerReservationRunning(reservation.jobId)
    const upstream = await fetch(`${VRYX_INITIATOR_CHAT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model_id: model,
        max_new_tokens: maxNewTokens,
        quantization: req.body?.quantization || 'q4',
        hidden_transport: req.body?.quantization || 'q4',
        pool_preference: req.body?.pool_preference || 'auto',
        preferred_worker_peer_ids: reservation.reservations.map((r) => r.peerId),
        scheduler_job_id: reservation.jobId,
        temperature: 0,
        top_p: 0.65,
      }),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(180_000) : undefined,
    })
    const data = await upstream.json().catch(() => null)
    const latencyMs = Date.now() - startedAt
    const completionTokens = Number(data?.completion_tokens || data?.completionTokens || 0)
    const ttftMs = Number(data?.pipeline_trace?.benchmark?.ttft_ms || data?.ttft_ms || 0)
    const decodeTps = Number(data?.pipeline_trace?.benchmark?.actual_tps || data?.pipeline_trace?.hot_path_tps || 0)
    const tps = decodeTps > 0
      ? Number(decodeTps.toFixed(2))
      : completionTokens > 0 && latencyMs > 0
        ? Number(((completionTokens * 1000) / latencyMs).toFixed(2))
        : 0
    const ok = upstream.ok && data?.ok !== false
    await pool.query(
      `INSERT INTO worker_benchmark_runs
       (job_id, model, mode, status, worker_count, latency_ms, ttft_ms, tps,
        prompt_tokens, completion_tokens, total_tokens, cost_per_million_eur, plan_json, error, created_by)
       VALUES (:jobId, :model, :mode, :status, :workerCount, :latencyMs, :ttftMs, :tps,
        :promptTokens, :completionTokens, :totalTokens, :costPerMillion, :plan, :error, :createdBy)`,
      {
        jobId: reservation.jobId,
        model,
        mode: req.body?.mode || 'auto',
        status: ok ? 'ok' : 'failed',
        workerCount: reservation.reservations.length,
        latencyMs,
        ttftMs,
        tps,
        promptTokens: Number(data?.prompt_tokens || 0),
        completionTokens,
        totalTokens: Number(data?.total_tokens || 0),
        costPerMillion: billingRate,
        plan: JSON.stringify(reservation.plan || null),
        error: data?.error ? String(data.error).slice(0, 500) : null,
        createdBy: req.user.id,
      },
    ).catch(() => {})
    await releaseWorkerReservation(reservation.jobId, ok ? 'released' : 'failed')
    return res.json({
      ok,
      jobId: reservation.jobId,
      model,
      plan: reservation.plan,
      metrics: {
        latencyMs,
        ttftMs,
        tps,
        promptTokens: Number(data?.prompt_tokens || 0),
        completionTokens,
        totalTokens: Number(data?.total_tokens || 0),
        costPerMillionEur: billingRate,
      },
      responsePreview: typeof data?.response === 'string' ? data.response.slice(0, 500) : '',
      error: data?.error || null,
    })
  } catch (e) {
    await pool.query(
      `INSERT INTO worker_benchmark_runs
       (job_id, model, mode, status, worker_count, plan_json, error, created_by, cost_per_million_eur)
       VALUES (:jobId, :model, :mode, 'failed', :workerCount, :plan, :error, :createdBy, :costPerMillion)`,
      {
        jobId: reservation.jobId,
        model,
        mode: req.body?.mode || 'auto',
        workerCount: reservation.reservations?.length || 0,
        plan: JSON.stringify(reservation.plan || null),
        error: String(e?.message || 'Benchmark impossible.').slice(0, 500),
        createdBy: req.user.id,
        costPerMillion: billingRate,
      },
    ).catch(() => {})
    await releaseWorkerReservation(reservation.jobId, 'failed')
    return res.status(502).json({ ok: false, jobId: reservation.jobId, error: e?.message || 'Benchmark impossible.' })
  }
})

/** Empreinte stable pour le SSE : ignore pingMs, sampledAt, tokens, etc. (sinon hash change à chaque tick DB). */
function stablePoolStreamHash(snap) {
  const liveWorkerPeerIds = (snap.registeredWorkers || [])
    .filter((w) => w.mode === 'worker' && Number(w.secondsSinceHeartbeat) <= WORKER_LIVE_SEC && w.desiredState === 'active')
    .map((w) => w.peerId)
    .sort()
  const normNodes = (snap.nodes || [])
    .map((n) => ({
      id: n.id,
      group: n.group,
      val: n.val,
      shards: n.shards ?? null,
      status: n.status ?? null,
      poolId: n.poolId ?? null,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const normLinks = (snap.links || [])
    .map((l) => {
      const s = typeof l.source === 'object' && l.source !== null ? l.source.id : l.source
      const t = typeof l.target === 'object' && l.target !== null ? l.target.id : l.target
      return { s: String(s), t: String(t), a: !!l.is_active }
    })
    .sort((a, b) => `${a.s}|${a.t}`.localeCompare(`${b.s}|${b.t}`))
  const compact = {
    normNodes,
    normLinks,
    pipelineActive: !!snap.pipelineActive,
    poolStatus: snap.pool?.status,
    poolId: snap.pool?.id,
    routingPath: snap.pool?.routingPath,
    liveWorkerPeerIds,
  }
  return crypto.createHash('sha256').update(JSON.stringify(compact)).digest('hex')
}

async function buildAdminPoolSnapshot() {
  const [registeredRows] = await pool.query(
    `SELECT w.peer_id, w.mode, w.grpc_port, w.p2p_port, w.public_ip, w.version,
            w.p2p_peers, w.tokens_generated, w.tokens_in, w.tokens_out, w.model,
            w.gpu_name AS gpuName, w.gpu_vram_mb AS gpuVramMb,
            w.allocated_vram_mb AS allocatedVramMb, w.memory_limit_percent AS memoryLimitPercent,
            w.runtime_backend AS runtimeBackend, w.weight_quantization AS weightQuantization,
            w.supports_q4_weights AS supportsQ4Weights, w.supports_mlx AS supportsMlx, w.supports_vllm AS supportsVllm,
            w.machine_info AS machineInfo,
            w.desired_state AS desiredState, w.desired_model AS desiredModel,
            w.desired_allocated_vram_mb AS desiredAllocatedVramMb,
            w.desired_memory_limit_percent AS desiredMemoryLimitPercent,
            w.health_score AS storedHealthScore, w.runtime_state AS runtimeState,
            w.reserved_until AS reservedUntil, w.current_job_id AS currentJobId,
            w.capabilities_json AS capabilitiesJson,
            w.last_command_at AS lastCommandAt, w.last_command_status AS lastCommandStatus,
            w.last_command_error AS lastCommandError,
            w.last_heartbeat_at AS lastHeartbeatAt, w.first_seen_at AS firstSeenAt,
            TIMESTAMPDIFF(SECOND, w.last_heartbeat_at, NOW()) AS secondsSinceHeartbeat,
            u.email AS ownerEmail,
            (SELECT COALESCE(SUM(l.delta_tokens), 0) FROM worker_token_ledger l
               WHERE l.peer_id = w.peer_id AND l.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS tokensGenerated1h,
            (SELECT COALESCE(SUM(l.delta_tokens), 0) FROM worker_token_ledger l
               WHERE l.peer_id = w.peer_id AND l.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS tokensGenerated24h
     FROM workers w
     LEFT JOIN users u ON u.id = w.user_id
     ORDER BY w.last_heartbeat_at DESC LIMIT 500`,
  )
  const registeredWorkers = registeredRows.map((r) => {
    const base = {
      peerId: r.peer_id,
      mode: r.mode,
      grpcPort: r.grpc_port,
      p2pPort: r.p2p_port,
      publicIp: r.public_ip,
      version: r.version,
      p2pPeers: Number(r.p2p_peers || 0),
      tokensGenerated: Number(r.tokens_generated || 0),
      tokensGenerated1h: Number(r.tokensGenerated1h || 0),
      tokensGenerated24h: Number(r.tokensGenerated24h || 0),
      tokensIn: Number(r.tokens_in ?? 0),
      tokensOut: Number(r.tokens_out ?? 0),
      model: r.model ?? null,
      gpuName: r.gpuName ?? null,
      gpuVramMb: r.gpuVramMb != null ? Number(r.gpuVramMb) : null,
      allocatedVramMb: r.allocatedVramMb != null ? Number(r.allocatedVramMb) : null,
      memoryLimitPercent: r.memoryLimitPercent != null ? Number(r.memoryLimitPercent) : null,
      runtimeBackend: r.runtimeBackend ?? null,
      weightQuantization: r.weightQuantization ?? null,
      supportsQ4Weights: Boolean(r.supportsQ4Weights),
      supportsMlx: Boolean(r.supportsMlx),
      supportsVllm: Boolean(r.supportsVllm),
      machineInfo: parseMaybeJsonObject(r.machineInfo),
      desiredState: r.desiredState ?? 'active',
      desiredModel: r.desiredModel ?? null,
      desiredAllocatedVramMb: r.desiredAllocatedVramMb != null ? Number(r.desiredAllocatedVramMb) : null,
      desiredMemoryLimitPercent: r.desiredMemoryLimitPercent != null ? Number(r.desiredMemoryLimitPercent) : null,
      runtimeState: r.runtimeState || 'idle',
      reservedUntil: toIsoDate(r.reservedUntil),
      currentJobId: r.currentJobId ?? null,
      storedHealthScore: Number(r.storedHealthScore || 0),
      capabilities: parseMaybeJsonObject(r.capabilitiesJson) || null,
      lastCommandAt: r.lastCommandAt ?? null,
      lastCommandStatus: r.lastCommandStatus ?? null,
      lastCommandError: r.lastCommandError ?? null,
      lastHeartbeatAt: r.lastHeartbeatAt,
      firstSeenAt: r.firstSeenAt,
      online: Number(r.secondsSinceHeartbeat) <= WORKER_OFFLINE_SEC,
      secondsSinceHeartbeat: Number(r.secondsSinceHeartbeat),
      ownerEmail: r.ownerEmail ?? null,
    }
    const health = workerHealthScore(base)
    return { ...base, healthScore: health.score, healthState: health.state, healthReasons: health.reasons, capabilities: base.capabilities || workerCapabilities(base) }
  })
  const liveWorkers = registeredWorkers.filter((w) => w.secondsSinceHeartbeat <= WORKER_LIVE_SEC && w.desiredState === 'active')
  const workerPeers = liveWorkers.filter((w) => w.mode === 'worker').map((w) => w.peerId).sort()
  const totalVramMb = liveWorkers.reduce((s, w) => s + Number(w.allocatedVramMb || w.gpuVramMb || 0), 0)
  const requiredModelVramMb = Number(process.env.VRYX_POOL_REQUIRED_VRAM_MB || 100 * 1024)
  const estimatedWorkersNeeded = totalVramMb > 0
    ? Math.max(1, Math.ceil(requiredModelVramMb / Math.max(1, totalVramMb / Math.max(1, liveWorkers.length))))
    : 0
  const sortedByVram = [...liveWorkers].sort(
    (a, b) => Number(b.allocatedVramMb || b.gpuVramMb || 0) - Number(a.allocatedVramMb || a.gpuVramMb || 0),
  )
  const poolId = workerPeers.length > 0 ? `pool-${workerPeers.join('|').slice(0, 10)}` : 'pool-empty'
  const assignments = workerPeers.map((peerId, rank) => {
    const w = liveWorkers.find((x) => x.peerId === peerId)
    return {
      peer: peerId,
      rank,
      role: rank === 0 ? 'embedding' : rank === workerPeers.length - 1 ? 'lm_head' : 'layers',
      gpu: w?.gpuName ?? null,
      vramMb: w?.gpuVramMb ?? null,
      allocatedVramMb: w?.allocatedVramMb ?? null,
      memoryLimitPercent: w?.memoryLimitPercent ?? null,
      ready: true,
    }
  })
  const pipelineActive = isPipelineChatActive()
  const graph = buildPoolGraphPayload({
    poolId,
    assignments,
    routingPath: workerPeers,
    registeredWorkers,
    pipelineActive,
  })

  return {
    ok: true,
    sampledAt: Date.now(),
    liveSec: WORKER_LIVE_SEC,
    pipelineActive,
    nodes: graph.nodes,
    links: graph.links,
    registeredWorkers,
    liveWorkers,
    totalTokensGenerated: registeredWorkers.reduce((s, w) => s + Number(w.tokensGenerated || 0), 0),
    pool: {
      id: poolId,
      status: workerPeers.length >= 2 ? 'ready_for_placement' : 'insufficient_workers',
      model: process.env.VRYX_DIST_MODEL || 'Qwen/Qwen2.5-1.5B-Instruct',
      routingPath: workerPeers,
      assignments,
      totalVramMb,
      requiredModelVramMb,
      estimatedWorkersNeeded,
      replicationFactor: Number(process.env.VRYX_POOL_REPLICATION_FACTOR || 1),
      hotWorkers: workerPeers.length,
      warmReplicas: Math.max(0, liveWorkers.length - workerPeers.length),
      largestGpu: sortedByVram[0]
        ? {
            peerId: sortedByVram[0].peerId,
            gpuName: sortedByVram[0].gpuName,
            gpuVramMb: sortedByVram[0].gpuVramMb,
            allocatedVramMb: sortedByVram[0].allocatedVramMb,
          }
        : null,
      latencyTargetsMs: {
        hotRouting: [10, 50],
        firstTokenSmallModel: [400, 1000],
        nextTokenWithKvCache: [120, 350],
        hotFailover: [100, 500],
        coldShardReload: [20000, 120000],
      },
    },
    nodeStatus: await nodeMonitor.getStatus(),
    history: {
      points: nodeMonitor.getHistory(120),
      tests: nodeMonitor.getTestHistory(),
    },
  }
}

adminRouter.get('/pool/snapshot', async (_req, res) => {
  try {
    res.json(await buildAdminPoolSnapshot())
  } catch (e) {
    console.error('admin/pool/snapshot', e)
    res.status(500).json({ error: 'Erreur lecture pool P2P.' })
  }
})

adminRouter.get('/pool/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const send = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
      if (typeof res.flush === 'function') res.flush()
    } catch {
      closedRef.closed = true
      if (timeoutId) clearTimeout(timeoutId)
    }
  }
  const closedRef = { closed: false }
  let lastHash = ''
  let lastSentAt = 0
  let timeoutId = null
  let prevPeerIds = new Set()
  let streamSeenOnce = false

  const STREAM_FORCE_MS = 45_000
  const tick = async () => {
    if (closedRef.closed) return
    try {
      const snap = await buildAdminPoolSnapshot()
      const h = stablePoolStreamHash(snap)
      const now = Date.now()
      const stale = now - lastSentAt >= STREAM_FORCE_MS

      const workerIds = new Set(
        (snap.registeredWorkers || [])
          .filter((w) => w.mode === 'worker' && Number(w.secondsSinceHeartbeat) <= WORKER_LIVE_SEC)
          .map((w) => w.peerId),
      )
      let streamEvent = null
      if (streamSeenOnce) {
        for (const id of workerIds) {
          if (!prevPeerIds.has(id)) {
            streamEvent = 'worker_connected'
            break
          }
        }
        if (!streamEvent) {
          for (const id of prevPeerIds) {
            if (!workerIds.has(id)) {
              streamEvent = 'worker_disconnected'
              break
            }
          }
        }
      }
      prevPeerIds = workerIds
      streamSeenOnce = true

      if (!streamEvent && h !== lastHash) {
        streamEvent = snap.pipelineActive ? 'pipeline_active' : 'pool_status_changed'
      }

      const mustPushSnapshot =
        h !== lastHash ||
        streamEvent === 'worker_connected' ||
        streamEvent === 'worker_disconnected'

      if (mustPushSnapshot) {
        lastHash = h
        lastSentAt = now
        send({
          ...snap,
          streamEvent: streamEvent || 'pool_status_changed',
        })
      } else if (stale) {
        lastSentAt = now
        try {
          res.write(': keepalive\n\n')
          if (typeof res.flush === 'function') res.flush()
        } catch {
          closedRef.closed = true
          if (timeoutId) clearTimeout(timeoutId)
        }
      }
    } catch (e) {
      send({ ok: false, error: e.message || 'Erreur pool stream.' })
    }
  }

  const schedule = () => {
    const delay = isPipelineChatActive() ? 1500 : 5000
    timeoutId = setTimeout(async () => {
      await tick()
      if (!closedRef.closed) schedule()
    }, delay)
  }

  await tick()
  schedule()

  req.on('close', () => {
    closedRef.closed = true
    if (timeoutId) clearTimeout(timeoutId)
  })
})

/** Visibilité scheduler / runtime shard éphémère (stub documenté côté API). */
adminRouter.get('/p2p/shard-runtime', (_req, res) => {
  res.json({
    ok: true,
    mode: 'ephemeral_ram',
    pipelineParallel: true,
    description:
      'Pipeline parallel (Daisy Chain) : l’initiateur Rust enchaîne vryx.dist.* / vryx.tp.* via gRPC sur les workers selon routing_path ; chaque nœud calcule son segment et passe au suivant.',
  })
})

adminRouter.get('/sessions', async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100))
  try {
    const [rows] = await pool.query(
      `SELECT id, session_json AS sessionJson
       FROM p2p_chat_sessions
       WHERE user_id = :userId
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      { userId: req.user.id },
    )
    const sessions = rows
      .map((row) => {
        try {
          return JSON.parse(row.sessionJson)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    res.json({ ok: true, sessions })
  } catch (e) {
    console.error('admin sessions list', e)
    res.status(500).json({ error: 'Impossible de charger les sessions.' })
  }
})

adminRouter.get('/sessions/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT session_json AS sessionJson
       FROM p2p_chat_sessions
       WHERE id = :id AND user_id = :userId
       LIMIT 1`,
      { id: String(req.params.id), userId: req.user.id },
    )
    if (!rows[0]) return res.status(404).json({ error: 'Session introuvable.' })
    res.json({ ok: true, session: JSON.parse(rows[0].sessionJson) })
  } catch (e) {
    console.error('admin session detail', e)
    res.status(500).json({ error: 'Impossible de charger cette session.' })
  }
})

adminRouter.post('/sessions', async (req, res) => {
  const s = req.body?.session
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return res.status(400).json({ error: 'Session invalide.' })
  }
  const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim().slice(0, 80) : crypto.randomUUID()
  const prompt = typeof s.prompt === 'string' ? s.prompt : ''
  const response = typeof s.response === 'string' ? s.response : ''
  if (!prompt.trim()) return res.status(400).json({ error: 'Prompt session requis.' })
  const session = { ...s, id }
  try {
    await pool.query(
      `INSERT INTO p2p_chat_sessions (id, user_id, prompt, response, session_json)
       VALUES (:id, :userId, :prompt, :response, :sessionJson)
       ON DUPLICATE KEY UPDATE
         prompt = VALUES(prompt),
         response = VALUES(response),
         session_json = VALUES(session_json),
         updated_at = CURRENT_TIMESTAMP`,
      {
        id,
        userId: req.user.id,
        prompt,
        response,
        sessionJson: JSON.stringify(session),
      },
    )
    res.json({ ok: true, session })
  } catch (e) {
    console.error('admin session save', e)
    res.status(500).json({ error: 'Impossible de sauvegarder la session.' })
  }
})

adminRouter.delete('/sessions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM p2p_chat_sessions WHERE id = :id AND user_id = :userId', {
      id: String(req.params.id),
      userId: req.user.id,
    })
    res.json({ ok: true })
  } catch (e) {
    console.error('admin session delete', e)
    res.status(500).json({ error: 'Impossible de supprimer la session.' })
  }
})

adminRouter.delete('/sessions', async (req, res) => {
  try {
    await pool.query('DELETE FROM p2p_chat_sessions WHERE user_id = :userId', { userId: req.user.id })
    res.json({ ok: true })
  } catch (e) {
    console.error('admin sessions clear', e)
    res.status(500).json({ error: 'Impossible de vider les sessions.' })
  }
})

adminRouter.post('/chat/stream', (_req, res) => {
  return res.status(410).json({
    error: 'Ancien endpoint admin désactivé. Rechargez le panel : le chat utilise maintenant /api/admin/p2p/chat/stream.',
  })
})

/** Chat via le daemon initiateur P2P (Axum local), renvoyé en SSE pour le front. */
adminRouter.post('/p2p/chat/stream', chatLimiter, async (req, res) => {
  const prompt = req.body?.prompt
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'prompt requis' })
  }
  let initiatorChatUrl
  try {
    initiatorChatUrl = resolveInitiatorChatUrl(req.body)
  } catch (e) {
    const msg = typeof e?.message === 'string' ? e.message : 'Initiateur invalide.'
    return res.status(Number(e?.statusCode) === 400 ? 400 : 400).json({ error: msg })
  }
  const requestedQuantization = ['q4', 'int8', 'fp16'].includes(req.body?.quantization)
    ? req.body.quantization
    : 'fp16'
  const poolPreference = ['auto', 'velocity_mlx', 'velocity_vllm', 'legacy_pytorch'].includes(req.body?.pool_preference)
    ? req.body.pool_preference
    : 'auto'
  let maxNewTokens = VRYX_P2P_ADMIN_DEFAULT_NEW_TOKENS
  const rawCap = req.body?.maxNewTokens ?? req.body?.max_new_tokens
  const parsedCap =
    typeof rawCap === 'number' ? rawCap : typeof rawCap === 'string' ? Number(rawCap) : NaN
  if (Number.isFinite(parsedCap) && parsedCap >= 1) {
    maxNewTokens = Math.min(VRYX_P2P_ADMIN_MAX_NEW_TOKENS, Math.floor(parsedCap))
  }
  const chatModelId = await resolveP2pChatModelId(req.body?.model_id ?? req.body?.modelId)
  const requestedLoadMode = ['auto', 'full', 'shard'].includes(req.body?.load_mode || req.body?.loadMode)
    ? (req.body?.load_mode || req.body?.loadMode)
    : 'shard'
  const requestId = req.requestId || crypto.randomUUID()
  const startedAt = Date.now()
  let firstTokenAt = null
  res.setHeader('X-Vryx-Request-Id', requestId)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (typeof res.flush === 'function') res.flush()
  }
  if (isUserPipelineChatActive(req.user.id)) {
    await recordInferenceRequestLog(buildInferenceLog({
      requestId,
      userId: req.user.id,
      status: 'failed',
      model: chatModelId,
      quantization: requestedQuantization,
      startedAt,
      finishedAt: Date.now(),
      error: 'pipeline_already_active',
    }))
    send({
      requestId,
      error:
        'Une génération P2P est déjà en cours. Attendez la fin du stream actuel avant de relancer une requête.',
      retryable: true,
    })
    return res.end()
  }
  const reservation = chatModelId
    ? await reserveWorkersForJob({ modelId: chatModelId, loadMode: requestedLoadMode, createdBy: req.user.id })
    : { ok: true, jobId: null, plan: null, reservations: [] }
  if (!reservation.ok) {
    await recordInferenceRequestLog(buildInferenceLog({
      requestId,
      userId: req.user.id,
      status: 'failed',
      model: chatModelId,
      quantization: requestedQuantization,
      startedAt,
      finishedAt: Date.now(),
      pipelineTrace: reservation.plan,
      error: 'no_stable_worker_reservation',
    }))
    send({
      requestId,
      error: 'Aucun worker stable/réservable pour ce modèle pour le moment.',
      retryable: true,
      schedulerPlan: reservation.plan,
    })
    return res.end()
  }
  let streamedTokensAlreadySent = false
  let streamedTokenFragments = 0
  let streamedReply = ''
  let inferenceLogged = false
  const logInferenceOnce = async ({ status, data = null, pipelineTrace = null, workerId = null, runtime = null, error = null }) => {
    if (inferenceLogged) return
    inferenceLogged = true
    let costEur = 0
    if (data) {
      const promptTokens = Number(data.prompt_tokens ?? data.promptTokens ?? 0)
      const completionTokens = Number(data.completion_tokens ?? data.completionTokens ?? 0)
      const totalTokens = Number(data.total_tokens ?? data.totalTokens ?? 0)
      const costBreakdown = await computeBillingCost({
        model: chatModelId,
        promptTokens: promptTokens || Math.max(0, totalTokens - completionTokens),
        completionTokens: completionTokens || totalTokens,
      })
      costEur = costBreakdown.totalCostEur
    }
    await recordInferenceRequestLog(buildInferenceLog({
      requestId,
      userId: req.user.id,
      status,
      model: chatModelId,
      quantization: requestedQuantization,
      runtime,
      workerId,
      startedAt,
      firstTokenAt,
      finishedAt: Date.now(),
      data,
      pipelineTrace,
      error,
      costEur,
    }))
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 600_000) // 10 minutes max
  const { streamId, secret: streamSecret } = createP2pTokenStream(send, (token) => {
    if (!firstTokenAt) firstTokenAt = Date.now()
    streamedTokensAlreadySent = true
    streamedTokenFragments += 1
    streamedReply += token
  })
  
  // Keep-alive pour éviter le timeout Nginx (proxy_read_timeout = 60s par défaut)
  const keepAliveInterval = setInterval(() => {
    res.write(': keepalive\n\n')
    if (typeof res.flush === 'function') res.flush()
  }, 15000)

  req.on('close', () => {
    clearTimeout(timer)
    clearInterval(keepAliveInterval)
    ctrl.abort()
  })
  pipelineChatBegin(req.user.id)
  const readNativeDonePayload = (evt) => {
    let doneData = {}
    if (evt && typeof evt.json === 'string' && evt.json.trim()) {
      try {
        doneData = JSON.parse(evt.json)
      } catch {
        doneData = {}
      }
    } else if (evt && evt.json && typeof evt.json === 'object' && !Array.isArray(evt.json)) {
      doneData = evt.json
    }
    const responseText =
      typeof doneData.response === 'string'
        ? doneData.response
        : typeof evt?.response === 'string'
          ? evt.response
          : streamedReply
    return {
      ...doneData,
      ok: doneData.ok !== false,
      response: responseText,
    }
  }
  /** Timer progression : l’initiateur Rust ne stream pas le JSON, on informe le client pendant l’attente. */
  let progressTimer = null
  let chatSucceeded = false
  const clearProgressTimer = () => {
    if (progressTimer) {
      clearInterval(progressTimer)
      progressTimer = null
    }
  }
  try {
    send({
      requestId,
      stage: 'queued',
      status: 'Requête acceptée, préparation de l’appel initiateur…',
      schedulerJobId: reservation.jobId,
      schedulerPlan: reservation.plan,
    })
    if (reservation.jobId) await markWorkerReservationRunning(reservation.jobId)
    const waitStartedAt = Date.now()
    progressTimer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - waitStartedAt) / 1000)
      send({
        stage: 'awaiting_initiator',
        status: `Attente du pipeline P2P (initiateur, ${elapsedSec} s)…`,
        elapsedSec,
      })
    }, 2000)

    const tokenStreamCallbackUrl =
      process.env.VRYX_TOKEN_STREAM_CALLBACK_URL ||
      `${NODE_ENV === 'production' ? 'https' : req.protocol}://${req.get('host')}/api/internal/p2p-token-stream`

    const chatBody = {
      prompt: prompt.trim(),
      quantization: requestedQuantization,
      hidden_transport: requestedQuantization,
      pool_preference: poolPreference,
      load_mode: requestedLoadMode,
      force_distributed: requestedLoadMode === 'shard' || reservation.reservations.length > 1,
      temperature: 0,
      top_p: 0.65,
      top_k: 20,
      repetition_penalty: 1.08,
      stream_id: streamId,
      stream_secret: streamSecret,
      stream_callback_url: tokenStreamCallbackUrl,
      scheduler_job_id: reservation.jobId,
      preferred_worker_peer_ids: reservation.reservations.map((r) => r.peerId),
    }
    if (chatModelId) chatBody.model_id = chatModelId
    if (maxNewTokens != null) chatBody.max_new_tokens = maxNewTokens
    const chatPayload = JSON.stringify(chatBody)
    const callInitiatorChat = () =>
      fetch(`${initiatorChatUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: chatPayload,
        signal: ctrl.signal,
      })
    const callInitiatorChatStream = () =>
      fetch(`${initiatorChatUrl}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: chatPayload,
        signal: ctrl.signal,
      })

    let r = null
    let data = null
    let sr = null
    try {
      sr = await callInitiatorChatStream()
      if (sr.ok && sr.body) {
        clearProgressTimer()
        send({ stage: 'native_stream', status: 'Stream token natif initiateur ouvert.' })
        const reader = sr.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const rawLine = line.trim()
            if (!rawLine) continue
            let evt = null
            try {
              evt = JSON.parse(rawLine)
            } catch {
              continue
            }
            if (evt.event === 'token' && typeof evt.token === 'string' && evt.token.length > 0) {
              if (!firstTokenAt) firstTokenAt = Date.now()
              streamedReply += evt.token
              streamedTokensAlreadySent = true
              streamedTokenFragments += 1
              enqueueP2pTokenStream(p2pTokenStreams.get(streamId), evt.token, true)
            } else if (evt.event === 'stage' && typeof evt.json === 'string') {
              flushP2pTokenStream(p2pTokenStreams.get(streamId))
              try {
                const stageData = JSON.parse(evt.json)
                send(stageData)
              } catch {
                send({ stage: 'native_stream', status: evt.json })
              }
            } else if (evt.event === 'error' || evt.error) {
              flushP2pTokenStream(p2pTokenStreams.get(streamId))
              await logInferenceOnce({ status: 'failed', error: String(evt.error || 'Erreur stream initiateur.') })
              send({ requestId, error: String(evt.error || 'Erreur stream initiateur.') })
              return res.end()
            } else if (evt.event === 'done' || evt.done) {
              flushP2pTokenStream(p2pTokenStreams.get(streamId))
              data = readNativeDonePayload(evt)
            }
          }
        }
        if (buffer.trim()) {
          try {
            const evt = JSON.parse(buffer.trim())
            if (evt.event === 'done' || evt.done) {
              data = readNativeDonePayload(evt)
            }
          } catch {
            void 0
          }
        }
        if (!data && streamedTokensAlreadySent) {
          data = {
            ok: true,
            response: streamedReply,
            completion_tokens: streamedTokenFragments,
            total_tokens: streamedTokenFragments,
            streamed_only: true,
            pipeline_trace: {
              layout: 'native_stream',
              ok: true,
              stream_summary_missing: true,
              note: 'Résumé final absent côté initiateur ; fallback HTTP volontairement bloqué pour éviter une seconde génération sur le worker.',
            },
          }
          send({
            stage: 'native_stream_finalized',
            status: 'Flux natif terminé sans résumé final : seconde génération bloquée.',
          })
        }
        r = { ok: Boolean(data && data.ok !== false), status: sr.status }
      }
    } catch {
      data = null
      r = null
    }

    if (sr && sr.ok === false && sr.status === 404) {
      send({
        stage: 'initiator_legacy',
        status:
          'Initiateur sans /api/chat/stream (HTTP 404) : utilisation de /api/chat. Déployez le rust-daemon actuel pour le flux NDJSON ; sinon le pipeline peut rester long si aucun worker P2P n’est relié.',
      })
    }

    if ((!data || !r) && !streamedTokensAlreadySent) {
      r = await callInitiatorChat()
      clearProgressTimer()
      send({
        stage: 'http_headers',
        status: r.ok ? 'Réponse HTTP reçue, lecture du corps…' : `Réponse HTTP ${r.status}, lecture du corps…`,
      })
      const text = await r.text()

      /** L’initiateur Rust peut lancer « Pré-chat » + dial puis échouer tant que select! n’a pas traité ConnexionEstablished. Une seule retry API suffit pour la même requête. */
      try {
        data = JSON.parse(text)
      } catch {
        await logInferenceOnce({ status: 'failed', error: 'invalid_initiator_json' })
        send({ requestId, error: 'Réponse initiateur invalide.' })
        return res.end()
      }
    } else if ((!data || !r) && streamedTokensAlreadySent) {
      data = {
        ok: true,
        response: streamedReply,
        completion_tokens: streamedTokenFragments,
        total_tokens: streamedTokenFragments,
        streamed_only: true,
      }
      r = { ok: true, status: sr?.status || 200 }
    }
    /** Fail rapide intentionnel (aucun worker P2P connecté, tp-peers vide) — pas de retry. */
    const isNoWorkerPermanent = () =>
      !r.ok &&
      (data?.pipeline_trace?.failure_stage === 'discover_live_peers_empty' ||
        (typeof data?.error === 'string' &&
          (data.error.includes('pair worker') || data.error.includes('liste vide'))))

    const noWorkerTransient = () =>
      !r.ok &&
      !isNoWorkerPermanent() &&
      typeof data?.error === 'string' &&
      (data.error.includes('worker P2P') ||
        data.error.includes('Aucun worker'))

    if (!streamedTokensAlreadySent && noWorkerTransient()) {
      send({
        stage: 'p2p_warm_retry',
        status:
          'Aucune session P2P active pour ce tour initiateur : nouvelle tentative après 850 ms pour laisser le relais s’établir.',
      })
      progressTimer = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - waitStartedAt) / 1000)
        send({
          stage: 'awaiting_initiator',
          status: `Nouvelle tentative imminente (${elapsedSec} s depuis le départ)…`,
          elapsedSec,
        })
      }, 2000)
      await new Promise((resolve) => setTimeout(resolve, 850))
      clearProgressTimer()
      r = await callInitiatorChat()
      send({
        stage: 'http_headers_retry',
        status: r.ok ? 'Deuxième réponse initiateur OK, lecture…' : `Deuxième réponse HTTP ${r.status}…`,
      })
      const text = await r.text()
      try {
        data = JSON.parse(text)
      } catch {
        await logInferenceOnce({ status: 'failed', error: 'invalid_initiator_json_retry' })
        send({ requestId, error: 'Réponse initiateur invalide (2ᵉ tentative).' })
        return res.end()
      }
    }

    send({ stage: 'parsed', status: 'Analyse du JSON initiateur terminée.' })
    if (!r.ok) {
      let detailError = typeof data?.error === 'string' ? data.error : `HTTP ${r.status}`
      const isWorkerError =
        typeof detailError === 'string' &&
        (detailError.includes('worker P2P') ||
          detailError.includes('Aucun worker') ||
          detailError.includes('pair worker') ||
          detailError.includes('liste vide') ||
          data?.pipeline_trace?.failure_stage === 'discover_live_peers_empty')
      if (isWorkerError) {
        try {
          const [stRes, initRes] = await Promise.allSettled([
            fetch(`http://127.0.0.1:${PORT}/api/workers/status`, {
              headers: {
                Accept: 'application/json',
                ...(WORKER_SECRET ? { Authorization: `Bearer ${WORKER_SECRET}` } : {}),
              },
            }),
            fetch('http://127.0.0.1:3031/api/status', { headers: { Accept: 'application/json' } }),
          ])
          const stBody = stRes.status === 'fulfilled' ? await stRes.value.json().catch(() => null) : null
          const initBody = initRes.status === 'fulfilled' ? await initRes.value.json().catch(() => null) : null
          const workers = Array.isArray(stBody?.workers) ? stBody.workers : []
          const nWorker = workers.filter((w) => w.mode === 'worker').length
          const connectedP2P = initBody?.orchestrator_health?.workers_connected_p2p ?? '?'
          const visibleP2P = initBody?.orchestrator_health?.workers_visible_p2p ?? '?'
          detailError =
            `Aucun worker P2P actif. ` +
            `Connectés P2P : ${connectedP2P} / Visibles via heartbeat : ${visibleP2P} / Déclarés API : ${nWorker}. ` +
            `Relancez le daemon rust-daemon en mode worker sur la machine Apple Silicon pour rétablir la connexion P2P.`
        } catch {
          /* ignore diagnostic secondaire */
        }
      }
      const errComputeMs = Number(data?.compute_time_ms ?? data?.computeTimeMs ?? 0) || 0
      const errLatencyRaw = Number(data?.latency_ms ?? data?.latencyMs ?? 0) || 0
      await logInferenceOnce({
        status: 'failed',
        data,
        pipelineTrace: data?.pipeline_trace ?? data?.pipelineTrace ?? null,
        workerId: data?.worker_peer_id || data?.workerPeerId || null,
        error: detailError,
      })
      send({
        requestId,
        error: detailError,
        latencyMs: Math.max(errLatencyRaw, errComputeMs),
        computeTimeMs: errComputeMs,
        workerComputeMs: Number(data?.worker_compute_ms ?? data?.workerComputeMs ?? 0) || 0,
        routingPath: Array.isArray(data?.routing_path)
          ? data.routing_path.filter((s) => typeof s === 'string' && s.length > 0)
          : [],
        pipelineTrace: data?.pipeline_trace ?? data?.pipelineTrace ?? null,
        requestedQuantization,
        poolPreference,
        effectiveQuantization: data?.effective_quantization ?? data?.effectiveQuantization ?? null,
        quantizationFallbackReason: data?.quantization_fallback_reason ?? data?.quantizationFallbackReason ?? null,
      })
      return res.end()
    }
    const reply = typeof data.response === 'string' ? data.response : ''
    let workerPeerId = data.worker_peer_id || data.workerPeerId || ''
    const latencyMs = Number(data.latency_ms ?? data.latencyMs ?? 0) || null
    const tokensIn = Number(data.tokens_in ?? data.tokensIn ?? 0) || 0
    const tokensOut = Number(data.tokens_out ?? data.tokensOut ?? 0) || 0
    const promptTokens = Number(data.prompt_tokens ?? data.promptTokens ?? 0) || 0
    const completionTokens = Number(data.completion_tokens ?? data.completionTokens ?? 0) || 0
    const totalTokens =
      Number(data.total_tokens ?? data.totalTokens ?? 0) ||
      promptTokens + completionTokens ||
      0
    const p2pMessagesIn = Number(data.p2p_messages_in ?? data.p2pMessagesIn ?? 0) || 0
    const p2pMessagesOut = Number(data.p2p_messages_out ?? data.p2pMessagesOut ?? 0) || 0
    const vpsDelegateMs = Number(data.vps_delegate_ms ?? data.vpsDelegateMs ?? 0) || 0
    const workerComputeMs = Number(data.worker_compute_ms ?? data.workerComputeMs ?? 0) || 0
    const schedulerWarmupSent = Number(data.scheduler_warmup_sent ?? data.schedulerWarmupSent ?? 0) || 0
    const schedulerWorkersUsed = Number(data.scheduler_workers_used ?? data.schedulerWorkersUsed ?? 0) || 0
    const shardSessionId = String(data.shard_session_id ?? data.shardSessionId ?? '') || null
    const rawPipelineTrace = data.pipeline_trace ?? data.pipelineTrace ?? null
    const pipelineTrace = sanitizePipelineTraceForAdmin(rawPipelineTrace)
    const pipelineWorkers = data.pipeline_workers ?? data.pipelineWorkers ?? null
    // `compute_time_ms` : proto `ProcessedTensorData` champ 12 ; secours depuis `pipeline_trace`.
    let computeTimeMs = Number(data.compute_time_ms ?? data.computeTimeMs ?? 0) || 0
    if (
      computeTimeMs <= 0 &&
      pipelineTrace &&
      typeof pipelineTrace === 'object' &&
      pipelineTrace !== null &&
      !Array.isArray(pipelineTrace)
    ) {
      const cm = pipelineTrace.compute_time_ms ?? pipelineTrace.computeTimeMs
      if (typeof cm === 'number' && cm > 0) computeTimeMs = cm
    }
    // Chaîne de relais : top-level ou embarquée dans la trace pipeline (Daisy Chain).
    const rawRoutingPath = data.routing_path ?? data.routingPath ?? []
    let routingPath = Array.isArray(rawRoutingPath)
      ? rawRoutingPath.filter((s) => typeof s === 'string' && s.length > 0)
      : []
    if (
      routingPath.length === 0 &&
      pipelineTrace &&
      typeof pipelineTrace === 'object' &&
      pipelineTrace !== null &&
      !Array.isArray(pipelineTrace)
    ) {
      const rp = pipelineTrace.routing_path ?? pipelineTrace.routingPath
      if (Array.isArray(rp)) {
        routingPath = rp.filter((s) => typeof s === 'string' && s.length > 0)
      }
    }
    if (!workerPeerId && routingPath.length > 0) {
      workerPeerId = routingPath[0]
    }
    const primaryWorkerPeerId =
      String(data.primary_worker_peer_id ?? data.primaryWorkerPeerId ?? '') || workerPeerId || null
    const traceLayout =
      pipelineTrace && typeof pipelineTrace === 'object' && pipelineTrace.layout
        ? String(pipelineTrace.layout)
        : ''
    const tr = pipelineTrace && typeof pipelineTrace === 'object' && !Array.isArray(pipelineTrace) ? pipelineTrace : null
    const quicUsed = Boolean(data.quic_used ?? tr?.quic_used ?? false)
    const quicAvailable = Boolean(data.quic_available ?? tr?.quic_available ?? false)
    const kvCacheUsed = Boolean(data.worker_kv_cache ?? tr?.worker_kv_cache ?? false)
    const hiddenTransport = String(data.hidden_transport ?? tr?.hidden_transport ?? 'fp16')
    const effectiveQuantization = String(
      data.effective_quantization ??
        data.effectiveQuantization ??
        tr?.effective_quantization ??
        tr?.hidden_transport ??
        hiddenTransport,
    )
    const quantizationFallbackReason =
      tr?.quantization_fallback_reason ??
      data.quantization_fallback_reason ??
      data.quantizationFallbackReason ??
      null
    const avgMsPerToken = Number(data.avg_ms_per_token ?? tr?.avg_ms_per_token ?? 0) || 0
    const hotPathTps = Number(data.hot_path_tps ?? tr?.hot_path_tps ?? 0) || 0
    const decodeMode = String(data.decode_mode ?? data.decodeMode ?? tr?.decode_mode ?? '') || null
    const stopReason = String(tr?.generation_control?.stop_reason ?? data.stop_reason ?? '') || null
    const prefixCacheHit = Boolean(tr?.prefix_cache?.hit ?? false)
    const prefixCacheTokens = Number(tr?.prefix_cache?.tokens ?? 0) || 0
    const setupMs = Number(data.setup_ms ?? tr?.setup_ms ?? 0) || 0
    const benchmarkActualTps = Number(tr?.benchmark?.actual_tps ?? tr?.hot_path_tps ?? 0) || 0
    const pingMs =
      Number(data.ping_ms ?? data.pingMs ?? tr?.ping_ms ?? tr?.benchmark?.ping_ms ?? 0) ||
      peerPingMsFromTrace(tr, primaryWorkerPeerId || workerPeerId) ||
      0
    const relayMs = Number(data.relay_ms ?? data.relayMs ?? tr?.relay_ms ?? tr?.benchmark?.relay_ms ?? 0) || 0
    const genControl = tr?.generation_control && typeof tr.generation_control === 'object' ? tr.generation_control : null
    const traceRuntimeBackends = Object.values(
      tr?.runtime_backend_per_worker && typeof tr.runtime_backend_per_worker === 'object'
        ? tr.runtime_backend_per_worker
        : {},
    )
      .map((value) => String(value || '').toLowerCase())
      .filter(Boolean)
    const benchmarkRuntimeBackend = String(tr?.benchmark?.runtime_backend ?? '').toLowerCase()
    const hasLlamaCppRuntime = benchmarkRuntimeBackend.includes('llama_cpp') || traceRuntimeBackends.some((v) => v.includes('llama_cpp'))
    const hasMlxRuntime = benchmarkRuntimeBackend.includes('mlx_lm') || traceRuntimeBackends.some((v) => v.includes('mlx'))
    const inferredPoolClass =
      hasLlamaCppRuntime
        ? 'velocity_llama_cpp'
        : traceLayout === 'mlx_lm_direct_p2p' || hasMlxRuntime
        ? 'velocity_mlx'
        : 'legacy_pytorch'
    const poolClass = String(data.pool_class ?? data.poolClass ?? tr?.pool_class ?? inferredPoolClass)
    const requestedPoolClass = String(tr?.requested_pool_class ?? data.requested_pool_class ?? data.requestedPoolClass ?? poolClass)
    const actualPoolClass = String(tr?.actual_pool_class ?? data.actual_pool_class ?? data.actualPoolClass ?? poolClass)
    const poolFallbackReason = tr?.pool_fallback_reason ?? data.pool_fallback_reason ?? data.poolFallbackReason ?? null
    const batching = tr?.batching && typeof tr.batching === 'object' ? tr.batching : null
    const overlap = tr?.overlap && typeof tr.overlap === 'object' ? tr.overlap : null
    const runtimeBackendPerWorker = tr?.runtime_backend_per_worker ?? null
    const weightQuantizationPerWorker = tr?.weight_quantization_per_worker ?? null
    const attentionBackendPerWorker = tr?.attention_backend_per_worker ?? null
    const effectiveReplyText = streamedReply || reply
    if (String(effectiveReplyText || '').trim().length === 0 && completionTokens <= 0) {
      const emptyError = 'Réponse vide du worker : génération considérée comme échouée, sans faux succès.'
      await logInferenceOnce({
        status: 'failed',
        data,
        pipelineTrace,
        workerId: primaryWorkerPeerId || workerPeerId || null,
        runtime: benchmarkRuntimeBackend || null,
        error: 'empty_worker_response',
      })
      observability.record('warn', 'inference', emptyError, {
        requestId,
        model: chatModelId,
        workerPeerId: primaryWorkerPeerId || workerPeerId || null,
        traceLayout,
        latencyMs,
      })
      send({
        requestId,
        error: emptyError,
        retryable: true,
        workerPeerId,
        primaryWorkerPeerId,
        latencyMs,
        pipelineTrace,
      })
      return res.end()
    }
    let worker = null
    if (workerPeerId) {
      try {
        const [rows] = await pool.query(
          `SELECT w.peer_id AS peerId, w.mode, w.grpc_port AS grpcPort, w.p2p_port AS p2pPort,
                  w.public_ip AS publicIp, w.version, w.p2p_peers AS p2pPeers,
                  w.tokens_generated AS tokensGenerated, w.tokens_in AS tokensIn, w.tokens_out AS tokensOut,
                  w.model, w.gpu_name AS gpuName, w.gpu_vram_mb AS gpuVramMb,
                  w.allocated_vram_mb AS allocatedVramMb, w.memory_limit_percent AS memoryLimitPercent,
                  w.runtime_backend AS runtimeBackend, w.weight_quantization AS weightQuantization,
                  w.supports_q4_weights AS supportsQ4Weights, w.supports_mlx AS supportsMlx, w.supports_vllm AS supportsVllm,
                  w.last_heartbeat_at AS lastHeartbeatAt,
                  TIMESTAMPDIFF(SECOND, w.last_heartbeat_at, NOW()) AS secondsSinceHeartbeat,
                  u.email AS ownerEmail
           FROM workers w
           LEFT JOIN users u ON u.id = w.user_id
           WHERE w.peer_id = :peerId
           LIMIT 1`,
          { peerId: workerPeerId },
        )
        const row = rows[0]
        if (row) {
          worker = {
            peerId: row.peerId,
            mode: row.mode,
            grpcPort: row.grpcPort,
            p2pPort: row.p2pPort,
            publicIp: row.publicIp,
            version: row.version,
            p2pPeers: Number(row.p2pPeers || 0),
            tokensGenerated: Number(row.tokensGenerated || 0),
            tokensIn: Number(row.tokensIn || 0),
            tokensOut: Number(row.tokensOut || 0),
            model: row.model ?? null,
            gpuName: row.gpuName ?? null,
            gpuVramMb: row.gpuVramMb != null ? Number(row.gpuVramMb) : null,
            allocatedVramMb: row.allocatedVramMb != null ? Number(row.allocatedVramMb) : null,
            memoryLimitPercent: row.memoryLimitPercent != null ? Number(row.memoryLimitPercent) : null,
            runtimeBackend: row.runtimeBackend ?? 'pytorch',
            weightQuantization: row.weightQuantization ?? 'fp16',
            supportsQ4Weights: Boolean(row.supportsQ4Weights),
            supportsMlx: Boolean(row.supportsMlx),
            supportsVllm: Boolean(row.supportsVllm),
            lastHeartbeatAt: row.lastHeartbeatAt,
            secondsSinceHeartbeat: Number(row.secondsSinceHeartbeat),
            ownerEmail: row.ownerEmail ?? null,
            online: Number(row.secondsSinceHeartbeat) <= WORKER_OFFLINE_SEC,
          }
        }
      } catch (e) {
        console.error('p2p chat stream : enrichissement worker ignoré', e?.message || e)
      }
    }
    if (worker) {
      // Détail message : métriques LLM + P2P (pas les cumuls heartbeat).
      worker.tokensIn = tokensIn
      worker.tokensOut = tokensOut
      worker.llmPromptTokens = promptTokens
      worker.llmCompletionTokens = completionTokens
      worker.llmTotalTokens = totalTokens
    }
    let replyToStream = streamedTokensAlreadySent ? '' : reply
    const words = replyToStream.length ? replyToStream.split(/(\s+)/) : []
    const nWords = words.filter(Boolean).length
    // Pas de tempo artificielle : tout le goulot réseau+P2P est déjà résolu avant ce point ; diffusé en rafales au client.
    const delayMsPerToken = 0
    if (!streamedTokensAlreadySent || replyToStream.length > 0) {
      send({
        stage: streamedTokensAlreadySent ? 'streaming_tokens_tail' : 'streaming_tokens',
        status: streamedTokensAlreadySent
          ? `Diffusion du complément (${nWords} fragment(s))…`
          : `Diffusion de la réponse (${nWords} fragment(s))…`,
      })
      for (const w of words) {
        if (w) {
          send({ token: w })
          if (delayMsPerToken > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMsPerToken))
          }
        }
      }
    }
    await logInferenceOnce({
      status: 'ok',
      data,
      pipelineTrace,
      workerId: primaryWorkerPeerId || workerPeerId || null,
      runtime: benchmarkRuntimeBackend || null,
    })
    send({
      requestId,
      done: true,
      workerPeerId,
      primaryWorkerPeerId,
      latencyMs,
      tokensIn,
      tokensOut,
      promptTokens,
      completionTokens,
      totalTokens,
      p2pMessagesIn,
      p2pMessagesOut,
      vpsDelegateMs,
      workerComputeMs,
      computeTimeMs,
      routingPath,
      schedulerWarmupSent,
      schedulerWorkersUsed,
      shardSessionId,
      pipelineTrace,
      pipelineWorkers,
      quicUsed,
      quicAvailable,
      kvCacheUsed,
      hiddenTransport,
      avgMsPerToken,
      hotPathTps,
      decodeMode,
      stopReason,
      prefixCacheHit,
      prefixCacheTokens,
      setupMs,
      benchmarkActualTps,
      pingMs,
      relayMs,
      genControl,
      requestedQuantization,
      effectiveQuantization,
      quantizationFallbackReason,
      poolPreference,
      poolClass,
      requestedPoolClass,
      actualPoolClass,
      poolFallbackReason,
      batching,
      overlap,
      runtimeBackendPerWorker,
      weightQuantizationPerWorker,
      attentionBackendPerWorker,
      mode:
        routingPath.length > 1
          ? `Pipeline Daisy Chain (${routingPath.length} nœuds)`
          : traceLayout === 'worker_only_pipeline'
            ? 'Pipeline P2P natif (worker)'
            : 'Pipeline P2P natif',
      worker,
    })
    chatSucceeded = true
  } catch (e) {
    clearProgressTimer()
    if (e.name === 'AbortError') {
      await logInferenceOnce({ status: 'failed', error: 'timeout_or_client_closed' })
      send({ requestId, error: 'Timeout P2P (600 s) ou fermeture de la connexion.' })
    } else {
      const msgRaw = typeof e?.message === 'string' ? e.message : ''
      const causeCode = typeof e?.cause?.code === 'string' ? e.cause.code : ''
      const tech = msgRaw ? `${msgRaw}${causeCode ? ` (${causeCode})` : ''}` : causeCode || String(e ?? '')
      const unreachable =
        /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(
          `${msgRaw} ${causeCode}`,
        )
      const publicError = unreachable
        ? `Échec de connexion au daemon initiateur (${initiatorChatUrl}). Sur le VPS exécutez : curl -sfS '${initiatorChatUrl}/api/status'. Vérifiez systemd (vryx-initiator, vryx-inference-stage1) et VRYX_INITIATOR_CHAT_URL pour le process Node (même localhost que Rust). Technique : ${tech || 'inconnu'}`
        : tech || 'Erreur initiateur P2P.'
      await logInferenceOnce({ status: 'failed', error: publicError })
      send({
        requestId,
        error: unreachable
          ? publicError
          : publicError,
      })
    }
  } finally {
    clearProgressTimer()
    clearTimeout(timer)
    clearInterval(keepAliveInterval)
    p2pTokenStreams.delete(streamId)
    if (reservation.jobId) await releaseWorkerReservation(reservation.jobId, chatSucceeded ? 'released' : 'failed').catch(() => {})
    pipelineChatEnd(req.user.id)
  }
  res.end()
})

adminRouter.get('/node/status', async (_req, res) => {
  try {
    const status = await nodeMonitor.getStatus()
    res.json(status)
  } catch (e) {
    console.error('admin/node/status', e)
    res.status(500).json({ error: 'Erreur lecture statut nœud.' })
  }
})

adminRouter.get('/initiator/status', async (_req, res) => {
  try {
    const [statusRes, peersRes] = await Promise.allSettled([
      fetch(`${VRYX_INITIATOR_CHAT_URL}/api/status`, { headers: { Accept: 'application/json' } }),
      fetch(`${VRYX_INITIATOR_CHAT_URL}/api/tp-peers`, { headers: { Accept: 'application/json' } }),
    ])
    const readJson = async (settled) => {
      if (settled.status !== 'fulfilled') {
        return { ok: false, error: String(settled.reason?.message || settled.reason) }
      }
      const response = settled.value
      const body = await response.json().catch(() => null)
      return { ok: response.ok, status: response.status, body }
    }
    const [status, tpPeers] = await Promise.all([readJson(statusRes), readJson(peersRes)])
    res.json({
      ok: Boolean(status.ok),
      initiatorChatUrl: VRYX_INITIATOR_CHAT_URL,
      status,
      tpPeers,
    })
  } catch (e) {
    console.error('admin/initiator/status', e)
    res.status(500).json({ ok: false, error: 'Erreur lecture statut initiateur.' })
  }
})

adminRouter.get('/node/workers', async (_req, res) => {
  try {
    const workers = await nodeMonitor.getWorkers()
    res.json({ workers, count: workers.length })
  } catch (e) {
    console.error('admin/node/workers', e)
    res.status(500).json({ error: 'Erreur lecture workers.' })
  }
})

adminRouter.get('/node/history', async (req, res) => {
  const limit = Math.max(10, Math.min(720, Number(req.query.limit) || 240))
  res.json({
    points: nodeMonitor.getHistory(limit),
    tests: nodeMonitor.getTestHistory(),
  })
})

const testBodySchema = z.object({
  parallel: z.number().int().min(1).max(64).optional(),
  repeat: z.number().int().min(1).max(200).optional(),
  stress: z.boolean().optional(),
})

adminRouter.post('/node/test', async (req, res) => {
  const parsed = testBodySchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ error: 'Paramètres invalides.' })
  try {
    const report = await nodeMonitor.runOneShotTest({
      stress: false,
      parallel: parsed.data.parallel ?? 1,
      repeat: parsed.data.repeat ?? 5,
    })
    res.json({ report })
  } catch (e) {
    console.error('admin/node/test', e)
    res.status(500).json({ error: 'Erreur exécution test.' })
  }
})

adminRouter.post('/node/stress', async (req, res) => {
  const parsed = testBodySchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ error: 'Paramètres invalides.' })
  try {
    const report = await nodeMonitor.runOneShotTest({
      stress: true,
      parallel: parsed.data.parallel ?? 8,
      repeat: parsed.data.repeat ?? 50,
    })
    res.json({ report })
  } catch (e) {
    console.error('admin/node/stress', e)
    res.status(500).json({ error: 'Erreur exécution stress test.' })
  }
})

app.use('/api/admin', adminRouter)

/**
 * Endpoint interne : renvoie les peer IDs des workers actifs (récents).
 * Accessible UNIQUEMENT en localhost (127.0.0.1 / ::1), pas de JWT requis.
 * Utilisé par inference_server.py pour la découverte auto des pairs TP.
 */
/**
 * Endpoint interne : sert les fichiers de poids de modèle (shard) pour le Pipeline Parallelism.
 * Les workers téléchargent leurs couches directement depuis le VPS via HTTPS, sans passer par le relay P2P.
 * Accessible uniquement depuis localhost (Python VPS).
 */
app.use('/api/internal/shard-serve', requireWorkerSecret, express.static(process.env.VRYX_SHARD_BASE_DIR || '/var/lib/vryx-shards', {
  dotfiles: 'deny',
  maxAge: 0,
  setHeaders(res, filePath) {
    const lower = String(filePath || '').toLowerCase()
    if (lower.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json')
    } else if (lower.endsWith('.bin') || lower.endsWith('.safetensors')) {
      res.setHeader('Content-Type', 'application/octet-stream')
    }
    res.setHeader('Cache-Control', 'no-store')
  },
}))

app.get('/api/internal/live-peers', async (req, res) => {
  const ip = req.socket.remoteAddress || req.ip || ''
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  if (!isLocal) {
    return res.status(403).json({ ok: false, error: 'Réservé localhost' })
  }
  const token = req.headers['x-internal-token'] || ''
  if (token !== 'vryx-internal-localhost') {
    return res.status(403).json({ ok: false, error: 'Token interne requis' })
  }
  try {
    const recentSec = Math.max(5, Math.min(120, Number(process.env.WORKER_LIVE_SEC) || 30))
    const [rows] = await pool.query(
      `SELECT peer_id
       FROM workers
       WHERE mode = 'worker'
         AND last_heartbeat_at >= DATE_SUB(NOW(), INTERVAL :sec SECOND)
       ORDER BY last_heartbeat_at DESC
       LIMIT 16`,
      { sec: recentSec }
    )
    const peers = (rows || []).map((r) => r.peer_id).filter(Boolean)
    return res.json({ ok: true, peers, count: peers.length, liveSec: recentSec })
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
})

async function start() {
  console.log('Attente de la base de données…')
  await waitForDatabase()
  await ensureTable()
  await ensureWorkersTable()
  await ensureWorkerReservationsTable()
  await ensureWorkerCommandsTable()
  await ensureWorkerBenchmarkRunsTable()
  await ensureInferenceRequestLogsTable()
  await ensureWorkerTokenLedgerTable()
  await ensureP2pChatSessionsTable()
  await ensureApiKeysTable()
  await ensureApiKeyUsageTable()
  await ensureBillingTables()
  await ensureEnterpriseQuoteRequestsTable()
  await ensurePricingAndModelCatalogTables(pool, PRICING_FALLBACK)
  await ensureForcedAdmins()
  nodeMonitor.startSampling()
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`API Vryx sur http://127.0.0.1:${PORT}`)
  })
}

start().catch((err) => {
  console.error('Impossible de démarrer le serveur ou la base :', err.message)
  const msg = String(err.message)
  if (msg.includes('Access denied')) {
    console.error(
      '\nAstuce : vérifiez DB_USER / DB_PASSWORD / DB_NAME dans server/.env. ' +
        'Avec Docker : docker compose --env-file server/.env up -d. ' +
        'Mot de passe changé après la première init : docker compose down -v puis recréez le conteneur.\n',
    )
  } else if (
    msg.includes('Connection lost') ||
    msg.includes('server closed the connection') ||
    msg.includes('ECONNREFUSED') ||
    err.code === 'ECONNREFUSED'
  ) {
    console.error(
      '\nAstuce : attendez que MariaDB soit prêt (docker compose ps → healthy), ou vérifiez DB_HOST / DB_PORT ' +
        '(ex. 3307 si 3306 est pris). Lancez d’abord : docker compose --env-file server/.env up -d\n',
    )
  }
  process.exit(1)
})
