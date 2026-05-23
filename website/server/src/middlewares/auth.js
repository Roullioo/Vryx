export function createSessionAuthMiddleware({ cookieName, legacyCookieName, verifyToken }) {
  return function sessionAuthMiddleware(req, res, next) {
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]
    const token = bearer || req.cookies?.[cookieName] || req.cookies?.[legacyCookieName]
    if (!token) {
      req.user = null
      return next()
    }
    const decoded = verifyToken(token)
    if (!decoded || typeof decoded.sub !== 'string') {
      req.user = null
      return next()
    }
    req.user = { id: decoded.sub, email: decoded.email }
    next()
  }
}

export function createRequireAuth({ pool, clearAuthCookie }) {
  return async function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise.' })
    try {
      const [rows] = await pool.query('SELECT id, email, is_admin AS isAdmin FROM users WHERE id = :id LIMIT 1', {
        id: req.user.id,
      })
      if (!rows[0]) {
        clearAuthCookie(res)
        return res.status(401).json({ error: 'Session invalide.' })
      }
      req.user.email = rows[0].email
      req.user.isAdmin = Boolean(rows[0].isAdmin)
      next()
    } catch (e) {
      console.error('requireAuth', e)
      res.status(500).json({ error: 'Erreur de vérification de la session.' })
    }
  }
}

export function createRequireAdmin({ pool }) {
  return async function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise.' })
    try {
      const [rows] = await pool.query('SELECT is_admin FROM users WHERE id = :id LIMIT 1', { id: req.user.id })
      if (!rows[0] || !rows[0].is_admin) {
        return res.status(403).json({ error: 'Accès réservé aux administrateurs.' })
      }
      req.user.isAdmin = true
      next()
    } catch (e) {
      console.error('requireAdmin', e)
      res.status(500).json({ error: 'Erreur de vérification des droits.' })
    }
  }
}

export function createRequireApiKey({ pool, apiKeyHash }) {
  return async function requireApiKey(req, res, next) {
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    if (!bearer || !bearer.startsWith('vel_sk_')) {
      return res.status(401).json({
        error: {
          message: 'Clé API Vryx requise. Utilisez Authorization: Bearer vel_sk_live_...',
          type: 'invalid_request_error',
        },
      })
    }
    try {
      const keyHash = apiKeyHash(bearer)
      const [rows] = await pool.query(
        `SELECT k.id, k.user_id AS userId, u.email
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = :keyHash
           AND k.revoked_at IS NULL
         LIMIT 1`,
        { keyHash },
      )
      const hit = rows[0]
      if (!hit) {
        return res.status(401).json({
          error: { message: 'Clé API Vryx invalide ou révoquée.', type: 'invalid_request_error' },
        })
      }
      await pool.query('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = :id', { id: hit.id })
      req.apiUser = { id: String(hit.userId), email: hit.email, keyId: String(hit.id) }
      return next()
    } catch (e) {
      console.error('api key auth', e)
      return res.status(500).json({
        error: { message: 'Erreur de vérification de la clé API.', type: 'server_error' },
      })
    }
  }
}
