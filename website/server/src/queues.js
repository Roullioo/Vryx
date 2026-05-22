import { Queue } from 'bullmq'

const REDIS_URL = String(process.env.REDIS_URL || '').trim()
const QUEUES_ENABLED = process.env.REDIS_ENABLED === '1' && REDIS_URL && process.env.BULLMQ_ENABLED !== '0'

function connection() {
  const url = new URL(REDIS_URL)
  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname?.replace('/', '') || 0),
  }
}

function optionalQueue(name) {
  return QUEUES_ENABLED ? new Queue(name, { connection: connection() }) : null
}

export const stripeWebhookQueue = optionalQueue('vryx-stripe-webhooks')
export const workerPayoutQueue = optionalQueue('vryx-worker-payouts')
export const benchmarkQueue = optionalQueue('vryx-benchmarks')

export function areQueuesEnabled() {
  return QUEUES_ENABLED
}
