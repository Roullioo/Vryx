import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function safeData(data) {
  if (!data || typeof data !== 'object') return data ?? null
  const clone = JSON.parse(JSON.stringify(data))
  for (const key of Object.keys(clone)) {
    if (/password|secret|token|authorization|cookie|key/i.test(key)) clone[key] = '[redacted]'
  }
  return clone
}

async function runCommand(command, args, timeout = 3500) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      stdout: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || '').trim(),
    }
  }
}

export function createObservability({ serviceName = 'vryx-api', maxEvents = 500 } = {}) {
  const events = []
  let lastAlertAt = 0
  const alertWebhookUrl = String(process.env.VRYX_ALERT_WEBHOOK_URL || '').trim()
  const emitAlert = async (event) => {
    if (!alertWebhookUrl || !/^https?:\/\//i.test(alertWebhookUrl)) return
    const now = Date.now()
    if (now - lastAlertAt < 30_000) return
    lastAlertAt = now
    try {
      await fetch(alertWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: serviceName, event }),
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(3500) : undefined,
      })
    } catch {
      /* alerting must never break the API */
    }
  }
  const push = (event) => {
    const next = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      service: serviceName,
      ts: new Date().toISOString(),
      ...event,
      data: safeData(event.data),
    }
    events.unshift(next)
    if (events.length > maxEvents) events.length = maxEvents
    if (next.level === 'error' || next.level === 'fatal') void emitAlert(next)
  }

  process.on('unhandledRejection', (reason) => {
    push({ level: 'error', scope: 'process', message: 'Unhandled rejection', data: { reason: String(reason?.message || reason) } })
  })
  process.on('uncaughtException', (error) => {
    push({ level: 'fatal', scope: 'process', message: 'Uncaught exception', data: { error: String(error?.message || error) } })
  })

  return {
    record(level, scope, message, data = null) {
      push({ level, scope, message, data })
    },
    list({ limit = 100, level = '' } = {}) {
      const filtered = level ? events.filter((event) => event.level === level) : events
      return filtered.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
    },
    summary() {
      const lastHour = Date.now() - 60 * 60 * 1000
      const recent = events.filter((event) => Date.parse(event.ts) >= lastHour)
      return {
        totalBuffered: events.length,
        lastHour: recent.length,
        errorsLastHour: recent.filter((event) => event.level === 'error' || event.level === 'fatal').length,
        warningsLastHour: recent.filter((event) => event.level === 'warn').length,
        alertingEnabled: Boolean(alertWebhookUrl),
        lastError: events.find((event) => event.level === 'error' || event.level === 'fatal') || null,
      }
    },
  }
}

export function registerObservabilityMiddleware(app, observability) {
  app.use((req, res, next) => {
    const startedAt = Date.now()
    const requestId = req.headers['x-request-id'] || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    req.requestId = String(requestId)
    res.setHeader('x-request-id', requestId)
    res.on('finish', () => {
      const latencyMs = Date.now() - startedAt
      if (res.statusCode >= 500) {
        observability.record('error', 'http', `${req.method} ${req.path} -> ${res.statusCode}`, {
          requestId,
          statusCode: res.statusCode,
          latencyMs,
          path: req.path,
          method: req.method,
          userId: req.user?.id,
        })
      } else if (latencyMs > 10_000 && req.path.startsWith('/api/')) {
        observability.record('warn', 'http', `Slow API request ${req.method} ${req.path}`, {
          requestId,
          statusCode: res.statusCode,
          latencyMs,
          path: req.path,
        })
      }
    })
    next()
  })
}

export function registerObservabilityRoutes(router, observability) {
  router.get('/observability/events', (req, res) => {
    res.json({
      ok: true,
      summary: observability.summary(),
      events: observability.list({ limit: req.query.limit, level: req.query.level }),
    })
  })

  router.get('/observability/health', async (_req, res) => {
    const [pm2, systemdApi, systemdInitiator, disk] = await Promise.all([
      runCommand('bash', ['-lc', 'command -v pm2 >/dev/null 2>&1 && pm2 jlist || echo "[]"']),
      runCommand('systemctl', ['is-active', 'vryx-api.service']),
      runCommand('systemctl', ['is-active', 'vryx-initiator.service']),
      runCommand('df', ['-h', '/']),
    ])
    res.json({
      ok: true,
      sampledAt: new Date().toISOString(),
      alerts: {
        pm2Available: pm2.ok,
        apiSystemd: systemdApi.stdout || systemdApi.error,
        initiatorSystemd: systemdInitiator.stdout || systemdInitiator.error,
      },
      pm2,
      systemd: {
        api: systemdApi,
        initiator: systemdInitiator,
      },
      disk,
      eventSummary: observability.summary(),
    })
  })
}
