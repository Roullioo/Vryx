# 03 - Security Controls And Access Logs

## Encryption In Transit

Required controls:

- HTTPS/TLS for public website and API;
- secure cookies in production;
- CORS restricted to known origins;
- gRPC and internal runtime ports bound to localhost or private network;
- worker communication authenticated with worker secret or per-worker credential;
- Stripe webhooks verified with signing secret.

## Encryption At Rest

Target controls:

- encrypted disk or managed encrypted database volume for MariaDB;
- encrypted backups;
- secrets kept in environment/secrets manager, never committed;
- API keys stored as hashes;
- sensitive datasets stored in isolated project paths or object storage with encryption;
- optional field-level encryption for enterprise datasets and prompt archives if retention is enabled.

## Access Control

| Surface | Control |
| --- | --- |
| Public pages | Redacted aggregate data only. |
| Account pages | JWT session required. |
| OpenAI-compatible API | API key required. |
| Worker routes | Worker secret/per-worker credential required. |
| Internal routes | Localhost plus internal token where applicable. |
| Admin routes | Authenticated user plus `is_admin` database role. |
| VPS/runtime | SSH restricted to approved operators. |

## Access Logs

Minimum log events:

- successful and failed admin login;
- admin access to workers, billing, enterprise quotes, pricing and readiness;
- pricing changes;
- credit adjustments;
- API key creation/revocation;
- dataset upload/delete;
- worker registration and suspicious worker quarantine;
- security setting changes;
- Stripe webhook replay or verification failure.

Logs should include:

- timestamp;
- actor user ID/email where available;
- request ID;
- source IP or trusted proxy metadata;
- action;
- resource ID;
- outcome;
- error class if failed.

Logs should not include:

- raw API keys;
- full secrets;
- payment card data;
- prompt/response content for no-retention clients;
- full worker private credentials.

## Monitoring And Alerting

Target alerts:

- repeated admin auth failures;
- many API key failures from one source;
- sudden spike in failed inference;
- worker heartbeat anomaly;
- public endpoint error spike;
- billing ledger write failure;
- payout ledger write failure;
- disk usage above threshold;
- Redis/Valkey unavailable when required;
- golden path regression.

## Audit Evidence

Before enterprise security review, prepare:

- current security architecture document;
- env/secrets rotation statement;
- PM2/systemd health screenshots;
- latest CI security runs;
- dependency audit output;
- access log sample with sensitive fields redacted;
- incident response procedure;
- backup and restore test result.

