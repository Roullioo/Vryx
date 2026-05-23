# 04 - Security, Compliance And Risk

## Security Positioning

Vryx must be presented as B2B infrastructure, not a toy AI app. The security model is therefore built around route separation, fail-closed production settings, worker authentication, redacted public proof and auditable money movement.

## Implemented Controls

| Area | Control |
| --- | --- |
| Sessions | JWT cookie session with secure production requirements. |
| Admin | Admin routes require user session plus admin role from database. |
| API keys | Raw keys are hashed; usage is scoped to the owning user. |
| Workers | Worker routes require global or per-worker secret validation. |
| Internal routes | Internal endpoints require localhost and internal token where applicable. |
| CSRF | Browser mutations are protected by origin/referer checks. |
| Rate limits | Auth, login, chat, worker heartbeat and enterprise quote limits. |
| Public network | Public endpoints are redacted and aggregate-oriented. |
| Billing | MariaDB ledgers are the source of truth for money. |
| Redis/Valkey | Used for cache/locks/idempotency, not final balances. |

## Trust Zones

| Zone | Examples | Data Exposure |
| --- | --- | --- |
| Public | `/network`, `/api/public/*` | Redacted aggregates only. |
| Customer | `/api/account/*`, API keys | Own balance, own usage, own keys. |
| Worker | heartbeats, shard serving, commands | Worker identity and capability data. |
| Internal runtime | gRPC, token stream callbacks | Orchestration metadata. |
| Admin | `/api/admin/*` | Full operational and billing details. |
| Data | MariaDB, Redis/Valkey | Source of truth and temporary state. |

## Compliance Direction

The repo includes draft materials for:

- data processing policy;
- DPA draft;
- incident response;
- worker terms;
- security architecture;
- retention and no-retention positioning.

Key next steps before enterprise contracts:

- finalize retention policy for prompts and responses;
- document subprocessors;
- add audit log exports;
- external penetration test;
- secrets manager migration;
- formal DPA review by counsel.

## Main Risks And Mitigations

| Risk | Why It Matters | Mitigation |
| --- | --- | --- |
| P2P reliability | Distributed workers can be unstable. | Relay fallback, worker health score, readiness gates, systemd workers. |
| Worker trust | External machines can be hostile or unreliable. | Auth, reputation, payout status, sandboxing plan, redacted public IDs. |
| Data privacy | API prompts may be sensitive. | No-retention option, private pools, retention policy, admin access controls. |
| Billing correctness | Incorrect ledgers undermine trust. | MariaDB source of truth, pricing snapshots, money-path tests. |
| Margin leakage | Wrong pricing can create losses. | Admin margin checks, dynamic pricing audit, payout limits. |
| Secret exposure | Shared secrets can compromise services. | Rotation policy, startup gates, CI secret scans. |
| Dependency risk | AI stack depends on fast-moving packages. | CI security scans, pinned versions, audit exceptions documented. |
| Demo instability | Investor demo can fail live. | Golden path score, 100-run proof, recorded video fallback. |

Reference: `docs/SECURITY_ARCHITECTURE_VRYX.md`.

