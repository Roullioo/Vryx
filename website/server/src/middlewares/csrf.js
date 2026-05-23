function normalizedOrigin(value) {
  if (!value) return ''
  try {
    return new URL(String(value)).origin.toLowerCase()
  } catch {
    return ''
  }
}

export function createCsrfProtection({
  corsOrigins = [],
  cookieName = 'vryx_token',
  legacyCookieName = 'velocity_token',
  publicOrigins = ['https://vryx.eu', 'https://www.vryx.eu'],
} = {}) {
  const normalizedCorsOrigins = corsOrigins.map(normalizedOrigin).filter(Boolean)

  return function csrfProtection(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next()
    }

    const origin = req.headers.origin
    const referer = req.headers.referer
    const host = req.get('host') || ''
    const protocol = req.protocol || 'http'
    const localUrl = `${protocol}://${host}`
    const allowedOrigins = new Set([
      normalizedOrigin(localUrl),
      ...normalizedCorsOrigins,
      ...publicOrigins.map(normalizedOrigin),
    ].filter(Boolean))

    if (origin) {
      if (!allowedOrigins.has(normalizedOrigin(origin))) {
        return res.status(403).json({ error: 'CSRF Protection: Invalid request origin.' })
      }
    } else if (referer) {
      if (!allowedOrigins.has(normalizedOrigin(referer))) {
        return res.status(403).json({ error: 'CSRF Protection: Invalid request referer.' })
      }
    } else {
      const hasAuthCookie = req.cookies && (req.cookies[cookieName] || req.cookies[legacyCookieName])
      if (hasAuthCookie) {
        return res.status(403).json({ error: 'CSRF Protection: Missing request origin or referer.' })
      }
    }

    return next()
  }
}
