const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''

export function apiUrl(path: string): string {
  if (path.startsWith('http')) return path
  const p = path.startsWith('/') ? path : `/${path}`
  return `${base}${p}`
}

/** Texte d’erreur lisible (Express, rate-limit v7, proxy HTML, etc.). */
function parseApiError(status: number, body: unknown, rawText: string): string {
  if (typeof body === 'object' && body !== null) {
    const o = body as Record<string, unknown>
    if (typeof o.error === 'string' && o.error.trim()) return o.error.trim()
    if (typeof o.message === 'string' && o.message.trim()) return o.message.trim()
    const msg = o.message
    if (typeof msg === 'object' && msg !== null && 'error' in msg) {
      const e = (msg as { error: unknown }).error
      if (typeof e === 'string' && e.trim()) return e.trim()
    }
  }
  if (status === 429) {
    return 'Trop de tentatives. Patientez quelques minutes avant de réessayer.'
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'Le serveur est temporairement indisponible. Réessayez dans un instant.'
  }
  const t = rawText.trim()
  if (t && t.length < 400 && !t.startsWith('<')) {
    return t
  }
  return `Réponse inattendue du serveur (code ${status}).`
}

export async function apiJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    })
  } catch {
    return { ok: false, status: 0, error: 'Connexion au serveur impossible pour le moment.' }
  }
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: parseApiError(res.status, body, text) }
  }
  return { ok: true, data: body as T }
}
