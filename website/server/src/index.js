import 'dotenv/config'
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
import { handleChatStream, ollamaChatComplete, ollamaGenerate, ollamaHealth } from './chat.js'

const PORT = Number(process.env.PORT) || 4000
/** URL de l'API Axum du daemon initiateur (chat P2P). */
const VRYX_INITIATOR_CHAT_URL = (process.env.VRYX_INITIATOR_CHAT_URL || 'http://127.0.0.1:3031').replace(/\/$/, '')
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
  max: 15,
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

const WORKER_OFFLINE_SEC = 90

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
})

const workerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de heartbeats.' },
})

const delegateBodySchema = z.object({
  prompt: z.string().min(1).max(500_000),
  model: z.string().max(120).optional(),
})

const delegateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes de délégation.' },
})

/**
 * Les workers (PC des contributeurs) appellent cette route : l’inférence Ollama
 * s’exécute uniquement sur ce serveur (VPS). Aucun modèle n’est requis sur la machine du worker.
 * Authentification : en-tête X-Vryx-Inference-Delegate = WORKER_INFERENCE_DELEGATE_SECRET (serveur).
 */
app.post('/api/workers/inference-delegate', delegateLimiter, async (req, res) => {
  const expected = process.env.WORKER_INFERENCE_DELEGATE_SECRET
  if (!expected || String(expected).length < 16) {
    return res.status(503).json({
      error:
        'Délégation inférence désactivée : définissez WORKER_INFERENCE_DELEGATE_SECRET (≥ 16 caractères) sur le VPS.',
    })
  }
  const got = String(req.headers['x-vryx-inference-delegate'] || '')
  if (got !== expected) {
    return res.status(403).json({ error: 'Refusé.' })
  }
  const parsed = delegateBodySchema.safeParse(req.body || {})
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0] || 'Corps invalide.'
    return res.status(400).json({ error: first })
  }
  try {
    const r = await ollamaChatComplete(parsed.data.prompt, {
      // Le modèle est imposé côté VPS (OLLAMA_MODEL). Les workers ne choisissent
      // jamais le modèle, afin d'éviter tout téléchargement ou 404 côté Ollama.
      timeout: 300_000,
    })
    const promptTokens = r.promptEvalCount
    const completionTokens = r.evalCount
    const totalTokens =
      promptTokens + completionTokens > 0 ? promptTokens + completionTokens : 0
    return res.json({
      ok: true,
      response: r.text ?? '',
      promptTokens,
      completionTokens,
      totalTokens,
      vpsOllamaDurationNs: r.totalDurationNs,
    })
  } catch (e) {
    console.error('workers/inference-delegate', e)
    return res.status(502).json({ ok: false, error: e.message || 'Ollama indisponible.' })
  }
})

app.post('/api/workers/heartbeat', workerLimiter, async (req, res) => {
  const parsed = heartbeatBodySchema.safeParse(req.body)
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0] || 'Données invalides.'
    return res.status(400).json({ error: first })
  }
  const { peer_id, mode, grpc_port, p2p_port, version, p2p_peers, tokens_generated, model, user_id } = parsed.data
  const public_ip =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  try {
    await pool.query(
      `INSERT INTO workers (peer_id, mode, grpc_port, p2p_port, public_ip, version, p2p_peers, tokens_generated, model, user_id)
       VALUES (:peer_id, :mode, :grpc_port, :p2p_port, :public_ip, :version, :p2p_peers, :tokens_generated, :model, :user_id)
       ON DUPLICATE KEY UPDATE
         mode = VALUES(mode),
         grpc_port = VALUES(grpc_port),
         p2p_port = VALUES(p2p_port),
         public_ip = VALUES(public_ip),
         version = VALUES(version),
         p2p_peers = VALUES(p2p_peers),
         tokens_generated = tokens_generated + VALUES(tokens_generated),
         model = VALUES(model),
         user_id = IF(VALUES(user_id) > 0, VALUES(user_id), user_id),
         last_heartbeat_at = CURRENT_TIMESTAMP`,
      { peer_id, mode, grpc_port: grpc_port ?? null, p2p_port: p2p_port ?? null,
        public_ip, version: version ?? null,
        p2p_peers: p2p_peers ?? 0, tokens_generated: tokens_generated ?? 0, model: model ?? null,
        user_id: user_id && user_id > 0 ? user_id : null },
    )
    return res.json({ ok: true })
  } catch (e) {
    console.error('workers/heartbeat', e)
    return res.status(500).json({ error: 'Erreur enregistrement worker.' })
  }
})

// ── Public SSE chat endpoint (used by WorkersPage demo) ──────────────────────
const chatLimiter = rateLimit({ windowMs: 60_000, max: 20, message: { error: 'Trop de requêtes.' } })
app.post('/api/chat/stream', chatLimiter, handleChatStream)

app.get('/api/chat/health', async (_req, res) => {
  const h = await ollamaHealth()
  res.json(h)
})

app.get('/api/workers/status', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT peer_id, mode, grpc_port, p2p_port, public_ip, version,
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
              w.model, w.last_heartbeat_at AS lastHeartbeatAt,
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
      `SELECT peer_id, mode, grpc_port, p2p_port, public_ip, version,
              p2p_peers, tokens_generated, model,
              last_heartbeat_at AS lastHeartbeatAt, first_seen_at AS firstSeenAt,
              TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS secondsSinceHeartbeat
       FROM workers ORDER BY last_heartbeat_at DESC LIMIT :limit`,
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
        model: r.model ?? null,
        lastHeartbeatAt: r.lastHeartbeatAt,
        firstSeenAt: r.firstSeenAt,
        online: Number(r.secondsSinceHeartbeat) <= WORKER_OFFLINE_SEC,
        secondsSinceHeartbeat: Number(r.secondsSinceHeartbeat),
      })),
    })
  } catch (e) {
    console.error('admin/workers/registered', e)
    return res.status(500).json({ error: 'Erreur lecture workers.' })
  }
})

adminRouter.get('/node/ollama', async (_req, res) => {
  const h = await ollamaHealth()
  res.json(h)
})

/** Visibilité scheduler / runtime shard éphémère (stub documenté côté API). */
adminRouter.get('/p2p/shard-runtime', (_req, res) => {
  res.json({
    ok: true,
    mode: 'ephemeral_ram',
    tensorParallel: true,
    description:
      'Les workers exécutent des dtypes vryx.shard.* en RAM via le serveur gRPC Python ; le modèle complet reste sur le VPS (Ollama + délégation).',
  })
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
  const timer = setTimeout(() => ctrl.abort(), 120_000)
  req.on('close', () => {
    clearTimeout(timer)
    ctrl.abort()
  })
  try {
    const r = await fetch(`${VRYX_INITIATOR_CHAT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.trim() }),
      signal: ctrl.signal,
    })
    const text = await r.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      send({ error: 'Réponse initiateur invalide.' })
      return res.end()
    }
    if (!r.ok) {
      send({ error: data?.error || `HTTP ${r.status}` })
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
    let worker = null
    if (workerPeerId) {
      const [rows] = await pool.query(
        `SELECT w.peer_id AS peerId, w.mode, w.grpc_port AS grpcPort, w.p2p_port AS p2pPort,
                w.public_ip AS publicIp, w.version, w.p2p_peers AS p2pPeers,
                w.tokens_generated AS tokensGenerated, w.tokens_in AS tokensIn, w.tokens_out AS tokensOut,
                w.model, w.last_heartbeat_at AS lastHeartbeatAt,
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
          lastHeartbeatAt: row.lastHeartbeatAt,
          secondsSinceHeartbeat: Number(row.secondsSinceHeartbeat),
          ownerEmail: row.ownerEmail ?? null,
          online: Number(row.secondsSinceHeartbeat) <= WORKER_OFFLINE_SEC,
        }
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
    for (const w of words) {
      if (w) send({ token: w })
    }
    send({
      done: true,
      workerPeerId,
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
      schedulerWarmupSent,
      schedulerWorkersUsed,
      shardSessionId,
      mode: 'P2P / Ollama (VPS)',
      worker,
    })
  } catch (e) {
    if (e.name !== 'AbortError') send({ error: e.message || 'Erreur initiateur P2P.' })
  } finally {
    clearTimeout(timer)
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

async function start() {
  console.log('Attente de la base de données…')
  await waitForDatabase()
  await ensureTable()
  await ensureWorkersTable()
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
