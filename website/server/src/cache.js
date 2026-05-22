import { getRedis, isRedisReady, redisKey } from './redis-client.js'

export async function getJsonCache(key) {
  if (!isRedisReady()) return null
  const raw = await getRedis().get(redisKey(key))
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function setJsonCache(key, value, ttlSec = 30) {
  if (!isRedisReady()) return
  await getRedis().set(redisKey(key), JSON.stringify(value), { EX: Math.max(1, Math.floor(ttlSec)) })
}

export async function delCache(patternOrKey) {
  if (!isRedisReady()) return 0
  const key = redisKey(patternOrKey)
  if (!key.includes('*')) return getRedis().del(key)
  let deleted = 0
  for await (const match of getRedis().scanIterator({ MATCH: key, COUNT: 100 })) {
    deleted += await getRedis().del(match)
  }
  return deleted
}

export async function cachedJson(key, ttlSec, loader) {
  const cached = await getJsonCache(key)
  if (cached) return cached
  const value = await loader()
  await setJsonCache(key, value, ttlSec)
  return value
}
