import 'dotenv/config'
import crypto from 'node:crypto'
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

const PORT = Number(process.env.PORT) || 4000
/** URL de l'API Axum du daemon initiateur (chat P2P). */
const VRYX_INITIATOR_CHAT_URL = (process.env.VRYX_INITIATOR_CHAT_URL || 'http://127.0.0.1:3031').replace(/\/$/, '')
/** Préfixes autorisés (CSV) pour `initiator_chat_url` dans POST /api/admin/p2p/chat/stream (orchestreur Edge). Vide = pas de surcharge. */
const VRYX_ALLOWED_INITIATOR_CHAT_PREFIXES = (process.env.VRYX_ALLOWED_INITIATOR_CHAT_PREFIXES || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean)

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
/** Adresses e-mail promues admin automatiquement à chaque démarrage. */
const FORCED_ADMIN_EMAILS = (
  process.env.ADMIN_EMAILS ||
  'julientruffier.dev@gmail.com,baptiste.peru@gmail.com'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_DAYS = Math.min(30, Math.max(1, Number(process.env.JWT_EXPIRES_DAYS) || 7))
const COOKIE_NAME = 'velocity_token'
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'
const NODE_ENV = process.env.NODE_ENV || 'development'
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'

/** Sessions chat P2P admin actives (animation « pipeline » sur le graphe). */
let pipelineChatSessions = 0
function pipelineChatBegin() {
  pipelineChatSessions += 1
}
function pipelineChatEnd() {
  pipelineChatSessions = Math.max(0, pipelineChatSessions - 1)
}
function isPipelineChatActive() {
  return pipelineChatSessions > 0
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET manquant ou trop court (minimum 32 caractères). Copiez server/env.example vers server/.env.')
  process.exit(1)
}

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
  if (!present.has('runtime_backend'))  await pool.query(`ALTER TABLE workers ADD COLUMN runtime_backend VARCHAR(40) NULL`)
  if (!present.has('weight_quantization')) await pool.query(`ALTER TABLE workers ADD COLUMN weight_quantization VARCHAR(40) NULL`)
  if (!present.has('supports_q4_weights')) await pool.query(`ALTER TABLE workers ADD COLUMN supports_q4_weights TINYINT(1) NOT NULL DEFAULT 0`)
  if (!present.has('supports_mlx'))     await pool.query(`ALTER TABLE workers ADD COLUMN supports_mlx TINYINT(1) NOT NULL DEFAULT 0`)
  if (!present.has('supports_vllm'))    await pool.query(`ALTER TABLE workers ADD COLUMN supports_vllm TINYINT(1) NOT NULL DEFAULT 0`)
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
    issuer: 'velocity-api',
    audience: 'velocity-web',
  })
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: 'velocity-api',
      audience: 'velocity-web',
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
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME]
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

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    ...(NODE_ENV === 'production' ? {} : { contentSecurityPolicy: false }),
  }),
)
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
  }),
)
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use(authMiddleware)

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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

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
    return res.status(201).json({ user: { id, email, isAdmin } })
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
    return res.json({ user: { id, email, isAdmin } })
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

// ===========================================================================
//                        ROUTES WORKERS (publiques + admin)
// ===========================================================================

/** Seuil présence dans `/api/workers/status` (utilisé par l’initiateur Rust pour re-découvrir les workers). Défaut 90 s peut exclure des nœuds domiciles encore joignables en P2P ; surcharger WORKER_OFFLINE_SEC (ex. 43200 pour 12 h). */
const WORKER_OFFLINE_SEC = Math.min(
  7 * 24 * 3600,
  Math.max(30, Number(process.env.WORKER_OFFLINE_SEC) || 90),
)

const GRAPH_ORCHESTRATOR_ID = 'vps-core'

function sanitizeGraphPoolGroupId(poolId) {
  return String(poolId || 'default')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 48)
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
    (w) => w.mode === 'worker' && Number(w.secondsSinceHeartbeat) <= WORKER_LIVE_SEC,
  )
  for (const w of workerRows) {
    const vramMb = Number(w.gpuVramMb) || 0
    const vramGb = Math.round((vramMb / 1024) * 10) / 10 || 0.5
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
      hardware: w.gpuName || 'GPU inconnu',
      vram: vramGb,
      val: Math.max(1, vramGb),
      shards,
      status,
      pingMs,
      vramMbTotal: vramMb > 0 ? vramMb : null,
      vramMbUsed: null,
      publicIp: w.publicIp ?? null,
      model: w.model ?? null,
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
  runtime_backend: z.string().max(40).nullable().optional(),
  weight_quantization: z.string().max(40).nullable().optional(),
  supports_q4_weights: z.boolean().optional().default(false),
  supports_mlx: z.boolean().optional().default(false),
  supports_vllm: z.boolean().optional().default(false),
})

const workerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de heartbeats.' },
})

app.post('/api/workers/heartbeat', workerLimiter, async (req, res) => {
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
    runtime_backend,
    weight_quantization,
    supports_q4_weights,
    supports_mlx,
    supports_vllm,
  } = parsed.data
  const hasGpuName = gpu_name !== undefined
  const hasGpuVram = gpu_vram_mb !== undefined
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
  const public_ip =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  try {
    await pool.query(
      `INSERT INTO workers (peer_id, mode, grpc_port, p2p_port, public_ip, version, p2p_peers, tokens_generated,
                            tokens_in, tokens_out, model, user_id, gpu_name, gpu_vram_mb,
                            runtime_backend, weight_quantization, supports_q4_weights, supports_mlx, supports_vllm)
       VALUES (:peer_id, :mode, :grpc_port, :p2p_port, :public_ip, :version, :p2p_peers, :tokens_generated,
               :tokens_in, :tokens_out, :model, :user_id, :gpu_name_ins, :gpu_vram_ins,
               :runtime_backend, :weight_quantization, :supports_q4_weights, :supports_mlx, :supports_vllm)
       ON DUPLICATE KEY UPDATE
         mode = VALUES(mode),
         grpc_port = VALUES(grpc_port),
         p2p_port = VALUES(p2p_port),
         public_ip = VALUES(public_ip),
         version = VALUES(version),
         p2p_peers = VALUES(p2p_peers),
         tokens_generated = tokens_generated + VALUES(tokens_generated),
         tokens_in = VALUES(tokens_in),
         tokens_out = VALUES(tokens_out),
         model = VALUES(model),
         user_id = IF(VALUES(user_id) > 0, VALUES(user_id), user_id),
         gpu_name = IF(:has_gpu_name, VALUES(gpu_name), gpu_name),
         gpu_vram_mb = IF(:has_gpu_vram, VALUES(gpu_vram_mb), gpu_vram_mb),
         runtime_backend = IF(:has_runtime_backend, VALUES(runtime_backend), runtime_backend),
         weight_quantization = IF(:has_weight_quantization, VALUES(weight_quantization), weight_quantization),
         supports_q4_weights = VALUES(supports_q4_weights),
         supports_mlx = VALUES(supports_mlx),
         supports_vllm = VALUES(supports_vllm),
         last_heartbeat_at = CURRENT_TIMESTAMP`,
      {
        peer_id,
        mode,
        grpc_port: grpc_port ?? null,
        p2p_port: p2p_port ?? null,
        public_ip,
        version: version ?? null,
        p2p_peers: p2p_peers ?? 0,
        tokens_generated: tokens_generated ?? 0,
        tokens_in: tokens_in ?? 0,
        tokens_out: tokens_out ?? 0,
        model: model ?? null,
        user_id: user_id && user_id > 0 ? user_id : null,
        gpu_name_ins: gpu_name ?? null,
        gpu_vram_ins: gpu_vram_mb ?? null,
        has_gpu_name: hasGpuName ? 1 : 0,
        has_gpu_vram: hasGpuVram ? 1 : 0,
        has_runtime_backend: shouldUpdateRuntimeBackend ? 1 : 0,
        has_weight_quantization: hasWeightQuantization ? 1 : 0,
        runtime_backend: normalizedRuntimeBackend,
        weight_quantization: hasWeightQuantization ? String(weight_quantization).trim().toLowerCase() : 'fp16',
        supports_q4_weights: supports_q4_weights ? 1 : 0,
        supports_mlx: supports_mlx ? 1 : 0,
        supports_vllm: supports_vllm ? 1 : 0,
      },
    )
    return res.json({ ok: true })
  } catch (e) {
    console.error('workers/heartbeat', e)
    return res.status(500).json({ error: 'Erreur enregistrement worker.' })
  }
})

// Limiteur partagé par le chat P2P admin (rate-limit côté initiateur).
const chatLimiter = rateLimit({ windowMs: 60_000, max: 20, message: { error: 'Trop de requêtes.' } })

app.get('/api/workers/status', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT peer_id, mode, grpc_port, p2p_port, public_ip, version,
              p2p_peers, tokens_generated, tokens_in, tokens_out, model,
              gpu_name AS gpuName, gpu_vram_mb AS gpuVramMb,
              runtime_backend AS runtimeBackend, weight_quantization AS weightQuantization,
              supports_q4_weights AS supportsQ4Weights, supports_mlx AS supportsMlx, supports_vllm AS supportsVllm,
              last_heartbeat_at AS lastHeartbeatAt, first_seen_at AS firstSeenAt,
              TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
       FROM workers
       WHERE TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) <= :offline
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
        runtimeBackend: r.runtimeBackend ?? 'pytorch',
        weightQuantization: r.weightQuantization ?? 'fp16',
        supportsQ4Weights: Boolean(r.supportsQ4Weights),
        supportsMlx: Boolean(r.supportsMlx),
        supportsVllm: Boolean(r.supportsVllm),
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

// ===========================================================================
//                            ROUTES ADMIN
// ===========================================================================

const adminRouter = express.Router()
adminRouter.use(requireAdmin)

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
        `SELECT id, email, is_admin AS isAdmin, created_at AS createdAt, last_login_at AS lastLoginAt
         FROM users WHERE LOWER(email) LIKE :q ORDER BY created_at DESC LIMIT 500`,
        { q: `%${search}%` },
      )
    } else {
      ;[rows] = await pool.query(
        `SELECT id, email, is_admin AS isAdmin, created_at AS createdAt, last_login_at AS lastLoginAt
         FROM users ORDER BY created_at DESC LIMIT 500`,
      )
    }
    res.json({
      users: rows.map((r) => ({
        id: String(r.id),
        email: r.email,
        isAdmin: !!r.isAdmin,
        createdAt: r.createdAt,
        lastLoginAt: r.lastLoginAt,
      })),
    })
  } catch (e) {
    console.error('admin/users', e)
    res.status(500).json({ error: 'Erreur lecture utilisateurs.' })
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
              w.runtime_backend AS runtimeBackend, w.weight_quantization AS weightQuantization,
              w.supports_q4_weights AS supportsQ4Weights, w.supports_mlx AS supportsMlx, w.supports_vllm AS supportsVllm,
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
        lastHeartbeatAt: r.lastHeartbeatAt,
        secondsSinceHeartbeat: Number(r.secondsSinceHeartbeat),
        ownerEmail: r.ownerEmail ?? null,
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
              w.runtime_backend AS runtimeBackend, w.weight_quantization AS weightQuantization,
              w.supports_q4_weights AS supportsQ4Weights, w.supports_mlx AS supportsMlx, w.supports_vllm AS supportsVllm,
              w.last_heartbeat_at AS lastHeartbeatAt, w.first_seen_at AS firstSeenAt,
              TIMESTAMPDIFF(SECOND, w.last_heartbeat_at, NOW()) AS secondsSinceHeartbeat,
              u.email AS ownerEmail
       FROM workers w
       LEFT JOIN users u ON u.id = w.user_id
       ORDER BY w.last_heartbeat_at DESC LIMIT :limit`,
      { limit },
    )
    const totalTokens = rows.reduce((s, r) => s + Number(r.tokens_generated || 0), 0)
    return res.json({
      totalTokensGenerated: totalTokens,
      workers: rows.map((r) => ({
        peerId: r.peer_id,
        mode: r.mode,
        grpcPort: r.grpc_port,
        p2pPort: r.p2p_port,
        publicIp: r.public_ip,
        version: r.version,
        p2pPeers: Number(r.p2p_peers || 0),
        tokensGenerated: Number(r.tokens_generated || 0),
        tokensIn: Number(r.tokens_in ?? 0),
        tokensOut: Number(r.tokens_out ?? 0),
        model: r.model ?? null,
        gpuName: r.gpuName ?? null,
        gpuVramMb: r.gpuVramMb != null ? Number(r.gpuVramMb) : null,
        lastHeartbeatAt: r.lastHeartbeatAt,
        firstSeenAt: r.firstSeenAt,
        online: Number(r.secondsSinceHeartbeat) <= WORKER_OFFLINE_SEC,
        secondsSinceHeartbeat: Number(r.secondsSinceHeartbeat),
        ownerEmail: r.ownerEmail ?? null,
      })),
    })
  } catch (e) {
    console.error('admin/workers/registered', e)
    return res.status(500).json({ error: 'Erreur lecture workers.' })
  }
})

adminRouter.post('/workers/:peerId/actions', async (req, res) => {
  const peerId = decodeURIComponent(String(req.params.peerId || ''))
  const action = req.body?.action
  if (!peerId) return res.status(400).json({ ok: false, error: 'peerId requis.' })
  if (action === 'disconnect') {
    return res.status(501).json({
      ok: false,
      error:
        'Déconnexion forcée à distance : non disponible pour le moment (aucun signal standard vers le worker). Prévoir une commande via le daemon initiateur.',
    })
  }
  if (action === 'change_pool') {
    return res.status(501).json({
      ok: false,
      error:
        'Changement de pool : réservé à une future API d’orchestration (placement dynamique des shards).',
    })
  }
  return res.status(400).json({ ok: false, error: 'Action inconnue.' })
})

/** Empreinte stable pour le SSE : ignore pingMs, sampledAt, tokens, etc. (sinon hash change à chaque tick DB). */
function stablePoolStreamHash(snap) {
  const liveWorkerPeerIds = (snap.registeredWorkers || [])
    .filter((w) => w.mode === 'worker' && Number(w.secondsSinceHeartbeat) <= WORKER_LIVE_SEC)
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
            w.runtime_backend AS runtimeBackend, w.weight_quantization AS weightQuantization,
            w.supports_q4_weights AS supportsQ4Weights, w.supports_mlx AS supportsMlx, w.supports_vllm AS supportsVllm,
            w.last_heartbeat_at AS lastHeartbeatAt, w.first_seen_at AS firstSeenAt,
            TIMESTAMPDIFF(SECOND, w.last_heartbeat_at, NOW()) AS secondsSinceHeartbeat,
            u.email AS ownerEmail
     FROM workers w
     LEFT JOIN users u ON u.id = w.user_id
     ORDER BY w.last_heartbeat_at DESC LIMIT 500`,
  )
  const registeredWorkers = registeredRows.map((r) => ({
    peerId: r.peer_id,
    mode: r.mode,
    grpcPort: r.grpc_port,
    p2pPort: r.p2p_port,
    publicIp: r.public_ip,
    version: r.version,
    p2pPeers: Number(r.p2p_peers || 0),
    tokensGenerated: Number(r.tokens_generated || 0),
    tokensIn: Number(r.tokens_in ?? 0),
    tokensOut: Number(r.tokens_out ?? 0),
    model: r.model ?? null,
    gpuName: r.gpuName ?? null,
    gpuVramMb: r.gpuVramMb != null ? Number(r.gpuVramMb) : null,
    lastHeartbeatAt: r.lastHeartbeatAt,
    firstSeenAt: r.firstSeenAt,
    online: Number(r.secondsSinceHeartbeat) <= WORKER_OFFLINE_SEC,
    secondsSinceHeartbeat: Number(r.secondsSinceHeartbeat),
    ownerEmail: r.ownerEmail ?? null,
  }))
  const liveWorkers = registeredWorkers.filter((w) => w.secondsSinceHeartbeat <= WORKER_LIVE_SEC)
  const workerPeers = liveWorkers.filter((w) => w.mode === 'worker').map((w) => w.peerId).sort()
  const totalVramMb = liveWorkers.reduce((s, w) => s + Number(w.gpuVramMb || 0), 0)
  const requiredModelVramMb = Number(process.env.VRYX_POOL_REQUIRED_VRAM_MB || 100 * 1024)
  const estimatedWorkersNeeded = totalVramMb > 0
    ? Math.max(1, Math.ceil(requiredModelVramMb / Math.max(1, totalVramMb / Math.max(1, liveWorkers.length))))
    : 0
  const sortedByVram = [...liveWorkers].sort((a, b) => Number(b.gpuVramMb || 0) - Number(a.gpuVramMb || 0))
  const poolId = workerPeers.length > 0 ? `pool-${workerPeers.join('|').slice(0, 10)}` : 'pool-empty'
  const assignments = workerPeers.map((peerId, rank) => {
    const w = liveWorkers.find((x) => x.peerId === peerId)
    return {
      peer: peerId,
      rank,
      role: rank === 0 ? 'embedding' : rank === workerPeers.length - 1 ? 'lm_head' : 'layers',
      gpu: w?.gpuName ?? null,
      vramMb: w?.gpuVramMb ?? null,
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
        ? { peerId: sortedByVram[0].peerId, gpuName: sortedByVram[0].gpuName, gpuVramMb: sortedByVram[0].gpuVramMb }
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
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (typeof res.flush === 'function') res.flush()
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
        res.write(': keepalive\n\n')
        if (typeof res.flush === 'function') res.flush()
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
  let maxNewTokens = null
  const rawCap = req.body?.maxNewTokens ?? req.body?.max_new_tokens
  const parsedCap =
    typeof rawCap === 'number' ? rawCap : typeof rawCap === 'string' ? Number(rawCap) : NaN
  if (Number.isFinite(parsedCap) && parsedCap >= 1 && parsedCap <= 4096) {
    maxNewTokens = Math.floor(parsedCap)
  }
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (typeof res.flush === 'function') res.flush()
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 600_000) // 10 minutes max
  
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
  pipelineChatBegin()
  /** Timer progression : l’initiateur Rust ne stream pas le JSON, on informe le client pendant l’attente. */
  let progressTimer = null
  const clearProgressTimer = () => {
    if (progressTimer) {
      clearInterval(progressTimer)
      progressTimer = null
    }
  }
  try {
    send({
      stage: 'queued',
      status: 'Requête acceptée, préparation de l’appel initiateur…',
    })
    const waitStartedAt = Date.now()
    progressTimer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - waitStartedAt) / 1000)
      send({
        stage: 'awaiting_initiator',
        status: `Attente du pipeline P2P (initiateur, ${elapsedSec} s)…`,
        elapsedSec,
      })
    }, 2000)

    const chatBody = {
      prompt: prompt.trim(),
      quantization: requestedQuantization,
      hidden_transport: requestedQuantization,
      pool_preference: poolPreference,
    }
    if (maxNewTokens != null) chatBody.max_new_tokens = maxNewTokens
    const chatPayload = JSON.stringify(chatBody)
    const callInitiatorChat = () =>
      fetch(`${initiatorChatUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: chatPayload,
        signal: ctrl.signal,
      })

    let r = await callInitiatorChat()
    clearProgressTimer()
    send({
      stage: 'http_headers',
      status: r.ok ? 'Réponse HTTP reçue, lecture du corps…' : `Réponse HTTP ${r.status}, lecture du corps…`,
    })
    let text = await r.text()

    /** L’initiateur Rust peut lancer « Pré-chat » + dial puis échouer tant que select! n’a pas traité ConnexionEstablished. Une seule retry API suffit pour la même requête. */
    let data
    try {
      data = JSON.parse(text)
    } catch {
      send({ error: 'Réponse initiateur invalide.' })
      return res.end()
    }
    const noWorkerTransient = () =>
      !r.ok &&
      typeof data?.error === 'string' &&
      (data.error.includes('worker P2P') ||
        data.error.includes('Aucun worker'))

    if (noWorkerTransient()) {
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
      text = await r.text()
      try {
        data = JSON.parse(text)
      } catch {
        send({ error: 'Réponse initiateur invalide (2ᵉ tentative).' })
        return res.end()
      }
    }

    send({ stage: 'parsed', status: 'Analyse du JSON initiateur terminée.' })
    if (!r.ok) {
      let detailError = typeof data?.error === 'string' ? data.error : `HTTP ${r.status}`
      if (
        typeof detailError === 'string' &&
        (detailError.includes('worker P2P') || detailError.includes('Aucun worker'))
      ) {
        try {
          const stRes = await fetch(`http://127.0.0.1:${PORT}/api/workers/status`, {
            headers: { Accept: 'application/json' },
          })
          const stBody = await stRes.json().catch(() => null)
          const workers = Array.isArray(stBody?.workers) ? stBody.workers : []
          const nWorker = workers.filter((w) => w.mode === 'worker').length
          detailError +=
            ` Contexte API : ${nWorker} ligne(s) mode worker dans GET /api/workers/status (${workers.length} entrée(s) dans la liste publique). Si ce nombre est supérieur à 0, le décalage vient très probablement du relais libp2p (consultez les logs initiateur : lignes « Pré-chat », « Dial » et « Connexion établie »). Réessayez après quelques secondes.`
        } catch {
          /* ignore diagnostic secondaire */
        }
      }
      const errComputeMs = Number(data?.compute_time_ms ?? data?.computeTimeMs ?? 0) || 0
      const errLatencyRaw = Number(data?.latency_ms ?? data?.latencyMs ?? 0) || 0
      send({
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
    const workerPeerId = data.worker_peer_id || data.workerPeerId || ''
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
    const primaryWorkerPeerId =
      String(data.primary_worker_peer_id ?? data.primaryWorkerPeerId ?? '') || workerPeerId || null
    const pipelineTrace = data.pipeline_trace ?? data.pipelineTrace ?? null
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
    const genControl = tr?.generation_control && typeof tr.generation_control === 'object' ? tr.generation_control : null
    const poolClass = String(data.pool_class ?? data.poolClass ?? tr?.pool_class ?? 'legacy_pytorch')
    const requestedPoolClass = String(tr?.requested_pool_class ?? data.requested_pool_class ?? data.requestedPoolClass ?? poolClass)
    const actualPoolClass = String(tr?.actual_pool_class ?? data.actual_pool_class ?? data.actualPoolClass ?? poolClass)
    const poolFallbackReason = tr?.pool_fallback_reason ?? data.pool_fallback_reason ?? data.poolFallbackReason ?? null
    const batching = tr?.batching && typeof tr.batching === 'object' ? tr.batching : null
    const overlap = tr?.overlap && typeof tr.overlap === 'object' ? tr.overlap : null
    const runtimeBackendPerWorker = tr?.runtime_backend_per_worker ?? null
    const weightQuantizationPerWorker = tr?.weight_quantization_per_worker ?? null
    const attentionBackendPerWorker = tr?.attention_backend_per_worker ?? null
    let worker = null
    if (workerPeerId) {
      try {
        const [rows] = await pool.query(
          `SELECT w.peer_id AS peerId, w.mode, w.grpc_port AS grpcPort, w.p2p_port AS p2pPort,
                  w.public_ip AS publicIp, w.version, w.p2p_peers AS p2pPeers,
                  w.tokens_generated AS tokensGenerated, w.tokens_in AS tokensIn, w.tokens_out AS tokensOut,
                  w.model, w.gpu_name AS gpuName, w.gpu_vram_mb AS gpuVramMb,
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
    const words = reply.length ? reply.split(/(\s+)/) : []
    const nWords = words.filter(Boolean).length
    // Pas de tempo artificielle : tout le goulot réseau+P2P est déjà résolu avant ce point ; diffusé en rafales au client.
    const delayMsPerToken = 0
    send({
      stage: 'streaming_tokens',
      status: `Diffusion de la réponse (${nWords} fragment(s))…`,
    })
    for (const w of words) {
      if (w) {
        send({ token: w })
        if (delayMsPerToken > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMsPerToken))
        }
      }
    }
    send({
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
  } catch (e) {
    clearProgressTimer()
    if (e.name === 'AbortError') {
      send({ error: 'Timeout P2P (600 s) ou fermeture de la connexion.' })
    } else {
      const msgRaw = typeof e?.message === 'string' ? e.message : ''
      const causeCode = typeof e?.cause?.code === 'string' ? e.cause.code : ''
      const tech = msgRaw ? `${msgRaw}${causeCode ? ` (${causeCode})` : ''}` : causeCode || String(e ?? '')
      const unreachable =
        /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(
          `${msgRaw} ${causeCode}`,
        )
      send({
        error: unreachable
          ? `Échec de connexion au daemon initiateur (${initiatorChatUrl}). Sur le VPS exécutez : curl -sfS '${initiatorChatUrl}/api/status'. Vérifiez systemd (vryx-initiator, vryx-inference-stage1) et VRYX_INITIATOR_CHAT_URL pour le process Node (même localhost que Rust). Technique : ${tech || 'inconnu'}`
          : tech || 'Erreur initiateur P2P.',
      })
    }
  } finally {
    clearProgressTimer()
    clearTimeout(timer)
    clearInterval(keepAliveInterval)
    pipelineChatEnd()
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
app.use('/api/internal/shard-serve', express.static(process.env.VRYX_SHARD_BASE_DIR || '/var/tmp/vryx-shards', {
  dotfiles: 'deny',
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('Content-Type', 'application/json')
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
  await ensureP2pChatSessionsTable()
  await ensureForcedAdmins()
  nodeMonitor.startSampling()
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`API Velocity sur http://127.0.0.1:${PORT}`)
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
