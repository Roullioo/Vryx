import crypto from 'node:crypto'
import { getRedis, isRedisReady, redisKey } from './redis-client.js'

export async function acquireWorkerLock(peerId, ttlMs = 180_000) {
  if (!peerId) return { ok: false, token: null, degraded: true }
  if (!isRedisReady()) return { ok: true, token: 'no-redis', degraded: true }
  const token = crypto.randomUUID()
  const result = await getRedis().set(redisKey(`lock:worker:${peerId}`), token, {
    NX: true,
    PX: Math.max(1000, Math.floor(ttlMs)),
  })
  return result === 'OK' ? { ok: true, token, degraded: false } : { ok: false, token: null, degraded: false }
}

export async function releaseWorkerLock(peerId, token) {
  if (!peerId || !token || token === 'no-redis' || !isRedisReady()) return 0
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `
  return getRedis().eval(script, {
    keys: [redisKey(`lock:worker:${peerId}`)],
    arguments: [token],
  })
}
