import rateLimit from 'express-rate-limit'

export function createRateLimiters() {
  return {
    authLimiter: rateLimit({
      windowMs: 15 * 60_000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Trop de tentatives. Réessayez plus tard.' },
    }),
    loginLimiter: rateLimit({
      windowMs: 15 * 60_000,
      max: 40,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Trop de tentatives de connexion. Réessayez plus tard.' },
    }),
    enterpriseQuoteLimiter: rateLimit({
      windowMs: 60 * 60_000,
      max: 12,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Trop de demandes Enterprise. Réessayez plus tard.' },
    }),
    accountChatLimiter: rateLimit({
      windowMs: 60_000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Trop de messages. Patientez un instant.' },
    }),
    workerLimiter: rateLimit({
      windowMs: 60_000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Trop de heartbeats.' },
    }),
    adminWorkerPingLimiter: rateLimit({
      windowMs: 60_000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Trop de mesures de latence. Réessayez dans une minute.' },
    }),
    chatLimiter: rateLimit({
      windowMs: 60_000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Trop de requêtes.' },
    }),
  }
}
