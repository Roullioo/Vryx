# Security Architecture Vryx

Version: 2026-05-21  
Scope: API Express, workers desktop, daemon Rust/libp2p, runtime Python/gRPC, dashboard admin, public Live Network.

## Executive Summary

Vryx manipule des ressources sensibles: identites clients, cles API, workers externes, routes P2P, runtime gRPC, metriques d'inference et donnees de facturation. La posture cible est fail-closed en production:

- l'API ne demarre pas sans `JWT_SECRET` robuste;
- les routes workers exigent un secret global ou un secret worker rotate;
- `ALLOW_UNSECURE_WORKERS=1` est ignore en production;
- les cookies doivent etre `Secure` en production;
- les endpoints publics exposent uniquement des agregats et identifiants redacted;
- les vues completes restent reservees aux administrateurs.

## Assets Protected

| Asset | Risk | Protection |
| --- | --- | --- |
| JWT sessions | Account takeover | `JWT_SECRET` >= 32 chars, cookies HttpOnly/SameSite/Secure en prod |
| Worker registry | Enumeration peers/IP/ports | `/api/workers/status` authentifie, public status redacted |
| Worker commands | Remote action abuse | Admin-only commands + worker secret on ACK/heartbeat |
| Shard files | Model exfiltration | `/api/internal/shard-serve` behind worker secret |
| Admin dashboard | Operational leakage | `requireAdmin` on `/api/admin/*` |
| Public Live Network | Competitive/sensitive leakage | No full peer IDs, no IPs, no ports, no per-worker token totals by default |

## Trust Zones

1. Public web: `GET /api/health`, `/api/public/*`.
2. Client account/API: authenticated account routes and OpenAI-compatible API keys.
3. Worker plane: `/api/workers/*`, shard download, worker heartbeat and discovery.
4. Admin plane: `/api/admin/*`, commands, readiness, raw worker inventory.
5. Local runtime plane: Rust initiator + Python gRPC on localhost/VPS private process boundary.

## Production Gates

The API validates security-critical configuration at startup:

- `JWT_SECRET` must exist and be at least 32 chars.
- `NODE_ENV=production` requires `VRYX_WORKER_SECRET` or `WORKER_INFERENCE_DELEGATE_SECRET`.
- `NODE_ENV=production` requires `COOKIE_SECURE=true`.
- `NODE_ENV=production` rejects localhost/wildcard `CORS_ORIGIN`.
- `ALLOW_UNSECURE_WORKERS=1` is ignored in production.

## Worker Authentication

Workers authenticate with `Authorization: Bearer <secret>` or `x-worker-token`.

Accepted production paths:

- global worker secret: `VRYX_WORKER_SECRET` or legacy `WORKER_INFERENCE_DELEGATE_SECRET`;
- per-worker rotated secret stored as hash in `workers.worker_secret_hash`;
- next secret during rotation in `workers.worker_next_secret_hash`.

Routes protected by worker auth include:

- `POST /api/workers/heartbeat`;
- `GET /api/workers/status`;
- `/api/internal/shard-serve/*`.

## Public Redaction Policy

`GET /api/public/network-status` is the public Live Network endpoint. By default it exposes:

- aggregate worker counts;
- aggregate token windows;
- aggregate latency/TPS/TTFT;
- model readiness;
- redacted worker aliases like `wrk_<hash>`.

It does not expose by default:

- full peer IDs;
- IP addresses;
- P2P/gRPC ports;
- exact heartbeat ages;
- exact per-worker token totals;
- raw capability/machine JSON.

Set `VRYX_PUBLIC_EXPOSE_WORKER_DETAILS=1` only for controlled internal environments.

## Abuse Controls

Implemented:

- auth/login rate limits;
- worker heartbeat rate limits;
- admin ping and chat rate limits;
- JSON body limit configurable via `VRYX_JSON_BODY_LIMIT`, defaulting to `1mb` in production;
- CSRF origin/referer checks use exact origin matching, not prefix matching.

Next controls to add before enterprise rollout:

- per-API-key quota enforcement before inference dispatch;
- per-worker anomaly scoring;
- queue backpressure for hot models;
- request payload class limits by route;
- suspicious worker quarantine state.

## Runtime Isolation

The Rust initiator and Python runtime are intended to run behind localhost/VPS boundaries:

- public users call the Express API;
- Express calls the Rust initiator;
- the Rust initiator orchestrates workers and gRPC runtime;
- shard downloads require worker auth.

Production deployment should enforce host firewall rules so gRPC/runtime ports are reachable only from localhost or approved private interfaces.

## Logging And Audit

Current logs cover:

- auth errors;
- worker heartbeat failures;
- worker command ACK/failure state;
- inference request logs;
- production readiness metrics.

Audit roadmap:

- immutable admin action log;
- worker secret rotation audit;
- API-key usage ledger with billing event IDs;
- security event export to SIEM/log storage;
- incident timeline template.

## Compliance Roadmap

Required before regulated B2B:

- GDPR processing register;
- no-retention mode per project/API key;
- customer data deletion workflow;
- DPA template;
- model/data terms inventory;
- incident response procedure;
- worker participation terms and payout/KYC thresholds.

## Investor Evidence Checklist

- Public Live Network endpoint returns redacted data.
- Admin readiness endpoint returns full production-readiness score.
- Golden path benchmark artifacts are stored by CI/staging.
- CI includes backend, frontend, Rust, Python and security scans.
- Data room links this document, readiness scorecards, benchmark exports and deployment topology.
