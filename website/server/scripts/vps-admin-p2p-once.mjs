#!/usr/bin/env node
/**
 * Sur le VPS : lit /var/www/vryx/server/.env, signe un JWT admin, appelle
 * POST http://127.0.0.1:4000/api/admin/p2p/chat/stream et affiche les lignes SSE.
 * Usage : node vps-admin-p2p-once.mjs
 */
import fs from 'node:fs'
import mysql from 'mysql2/promise'
import jwt from 'jsonwebtoken'

const ENV_PATH = process.env.VRYX_SERVER_ENV || '/var/www/vryx/server/.env'
const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:4000').replace(/\/$/, '')
const PROMPT =
  process.env.PROMPT ||
  'Réponds par une seule phrase en français : quel est le capital de la France ?'
const POOL_PREFERENCE = process.env.POOL_PREFERENCE || 'velocity_mlx'
const QUANTIZATION = process.env.QUANTIZATION || 'q4'

function parseEnv(p) {
  const raw = fs.readFileSync(p, 'utf8')
  const out = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

const env = parseEnv(ENV_PATH)
if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET manquant ou trop court dans', ENV_PATH)
  process.exit(1)
}

const pool = await mysql.createPool({
  host: env.DB_HOST || '127.0.0.1',
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
})

const [rows] = await pool.query(
  'SELECT id, email FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1',
)
await pool.end()

if (!rows?.[0]) {
  console.error('Aucun utilisateur admin en base.')
  process.exit(2)
}

const sub = String(rows[0].id)
const email = rows[0].email
const token = jwt.sign({ sub, email }, env.JWT_SECRET, {
  expiresIn: '1h',
  issuer: 'velocity-api',
  audience: 'velocity-web',
})

const body = JSON.stringify({
  prompt: PROMPT,
  quantization: QUANTIZATION,
  pool_preference: POOL_PREFERENCE,
})

const r = await fetch(`${API_BASE}/api/admin/p2p/chat/stream`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Cookie: `velocity_token=${token}`,
  },
  body,
})

const ct = r.headers.get('content-type') || ''
console.error('HTTP', r.status, ct)

if (!r.ok) {
  const errText = await r.text()
  process.stderr.write(errText)
  if (!errText.endsWith('\n')) process.stderr.write('\n')
  process.exit(1)
}

// Stream SSE : évite de tout bufferiser en RAM côté VPS (await r.text() sur longues sessions).
if (!r.body) {
  console.error('Réponse sans corps lisible.')
  process.exit(1)
}
const reader = r.body.getReader()
const dec = new TextDecoder()
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  if (value && value.byteLength) process.stdout.write(dec.decode(value, { stream: true }))
}
process.stdout.write('\n')
