import { getRedis, isRedisReady, redisKey } from './redis-client.js'

export async function claimIdempotencyKey(key, ttlSec) {
  if (!key) return { claimed: true, degraded: true }
  if (!isRedisReady()) return { claimed: true, degraded: true }
  const result = await getRedis().set(redisKey(`idem:${key}`), '1', {
    NX: true,
    EX: Math.max(1, Math.floor(ttlSec)),
  })
  return { claimed: result === 'OK', degraded: false }
}

export async function clearIdempotencyKey(key) {
  if (!key || !isRedisReady()) return 0
  return getRedis().del(redisKey(`idem:${key}`))
}
