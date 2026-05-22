import { createClient } from 'redis'

const REDIS_URL = String(process.env.REDIS_URL || '').trim()
const REDIS_ENABLED = process.env.REDIS_ENABLED === '1' && REDIS_URL
const REDIS_REQUIRED_IN_PROD = process.env.REDIS_REQUIRED_IN_PROD === '1'
const REDIS_CACHE_PREFIX = String(process.env.REDIS_CACHE_PREFIX || 'vryx').replace(/:+$/, '') || 'vryx'

let redis = null
let redisReady = false
let initPromise = null

export function redisKey(key) {
  const clean = String(key || '').replace(/^:+/, '')
  return `${REDIS_CACHE_PREFIX}:${clean}`
}

export async function initRedis() {
  if (!REDIS_ENABLED) {
    console.log('[redis] disabled')
    return null
  }
  if (initPromise) return initPromise

  redis = createClient({
    url: REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => Math.min(1000 + retries * 100, 10_000),
    },
  })

  redis.on('error', (err) => {
    redisReady = false
    console.error('[redis] error', err?.message || err)
  })
  redis.on('ready', () => {
    redisReady = true
    console.log('[redis] ready')
  })
  redis.on('end', () => {
    redisReady = false
  })

  initPromise = redis.connect().then(() => redis)
  return initPromise
}

export function getRedis() {
  return redis
}

export function isRedisReady() {
  return Boolean(redis && redisReady)
}

export function isRedisRequiredInProd() {
  return REDIS_REQUIRED_IN_PROD
}
