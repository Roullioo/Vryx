import crypto from 'node:crypto'

export function tokenMatchesSecret(token, secret) {
  const tokenBuf = Buffer.from(String(token || ''))
  const secretBuf = Buffer.from(String(secret || ''))
  if (tokenBuf.length === 0 || tokenBuf.length !== secretBuf.length) return false
  return crypto.timingSafeEqual(tokenBuf, secretBuf)
}

export function sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex')
}
