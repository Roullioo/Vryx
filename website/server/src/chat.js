/**
 * chat.js — Streaming chat via Ollama sur le VPS uniquement.
 * Les workers utilisent /api/workers/inference-delegate : aucun modèle sur les PC des contributeurs.
 *
 * Ollama REST : POST /api/chat (NDJSON en streaming pour le front admin).
 */

import { createServer } from 'node:http'

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:2b'

/**
 * POST /api/chat (non stream) — texte + métriques tokens réelles Ollama.
 * @returns {{ text: string, promptEvalCount: number, evalCount: number, totalDurationNs: number|null }}
 */
export async function ollamaChatComplete(
  prompt,
  { systemPrompt = null, timeout = 120_000, model: modelOverride = null } = {},
) {
  const messages = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: prompt })

  const model = modelOverride || OLLAMA_MODEL

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText)
      throw new Error(`Ollama ${res.status}: ${err}`)
    }
    const j = await res.json()
    const raw = j.message?.content ?? j.response ?? ''
    const text = typeof raw === 'string' ? raw : ''
    const promptEvalCount = Number(j.prompt_eval_count ?? 0) || 0
    const evalCount = Number(j.eval_count ?? 0) || 0
    const totalDurationNs = j.total_duration != null ? Number(j.total_duration) : null
    return { text, promptEvalCount, evalCount, totalDurationNs }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

/** POST a prompt to Ollama and return the full text (non-streaming helper). */
export async function ollamaGenerate(
  prompt,
  { stream = false, systemPrompt = null, timeout = 120_000, model: modelOverride = null } = {},
) {
  if (stream) {
    const messages = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
    messages.push({ role: 'user', content: prompt })
    const model = modelOverride || OLLAMA_MODEL
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText)
        throw new Error(`Ollama ${res.status}: ${err}`)
      }
      return res
    } catch (e) {
      clearTimeout(timer)
      throw e
    }
  }
  const r = await ollamaChatComplete(prompt, { systemPrompt, timeout, model: modelOverride })
  return r.text
}

/** Check if Ollama is reachable and the model is available. */
export async function ollamaHealth() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const j = await res.json()
    const models = (j.models || []).map((m) => m.name)
    const loaded = models.some((m) => m.startsWith(OLLAMA_MODEL.split(':')[0]))
    return { ok: true, models, modelReady: loaded, model: OLLAMA_MODEL }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * Middleware-style SSE streaming handler.
 * Route: POST /api/admin/chat/stream   body: { prompt, system? }
 */
export async function handleChatStream(req, res) {
  const { prompt, system } = req.body || {}
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'prompt requis' })
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // disable nginx buffering
  res.flushHeaders()

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (res.flush) res.flush()
  }

  try {
    const messages = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: prompt })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    req.on('close', () => controller.abort())

    const ollamaRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!ollamaRes.ok) {
      const err = await ollamaRes.text().catch(() => ollamaRes.statusText)
      send({ error: `Ollama: ${err}` })
      return res.end()
    }

    const reader = ollamaRes.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          const token = j.message?.content ?? ''
          if (token) send({ token })
          if (j.done) {
            send({ done: true, eval_count: j.eval_count, eval_duration: j.eval_duration })
          }
        } catch { /* ignore non-JSON */ }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      send({ error: e.message })
    }
  }

  res.end()
}
