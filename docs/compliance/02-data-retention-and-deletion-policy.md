# 02 - Data Retention And Deletion Policy

## Policy Goal

Vryx should keep only the data needed to provide the service, secure the platform, bill correctly and satisfy legal obligations. Sensitive enterprise clients must have a no-retention option.

## Retention Matrix

| Data | Default Retention | No-Retention Mode | Deletion Owner |
| --- | --- | --- | --- |
| Account profile | Account lifetime | Same | Support/admin |
| API keys | Until revoked/account deletion | Same, key hashes retained only while active | Customer/admin |
| Prompts | 30 days maximum by default | Not stored after request completion | Product/API |
| Responses | 30 days maximum by default | Not stored after request completion | Product/API |
| Inference metrics | 12 months aggregate/technical | Retain request ID, model, tokens, cost, latency, status only | Engineering |
| Billing ledger | Legal accounting retention | Same | Finance/admin |
| Stripe events | Legal/accounting retention | Same | Finance/admin |
| Worker heartbeats | Short live TTL plus operational snapshots | Same, no customer content | Engineering |
| Worker payout ledger | Legal/accounting retention | Same | Finance/admin |
| Enterprise quote data | Sales cycle plus legitimate follow-up | Same unless client requests deletion | Sales/admin |
| Datasets | Project duration plus agreed retention | Deleted after job/project completion | Project owner |
| Security logs | 180 days default | Same, without prompt/response content | Security/admin |
| Backups | 30-90 days target | Same, deletion propagates by backup expiry | Ops |

## Customer Deletion Flow

1. Authenticate the requester.
2. Identify scope: account, API key, project, dataset, prompt history, enterprise quote.
3. Check legal holds: invoices, ledger, security incident, fraud investigation.
4. Delete or anonymize eligible data from primary stores.
5. Revoke API keys and sessions where relevant.
6. Queue deletion from object storage or project folders.
7. Record deletion evidence: requester, scope, timestamp, operator, result.
8. Confirm completion to customer.

## No-Retention Mode

No-retention mode means:

- prompts and responses are processed in memory and not persisted as plain text;
- logs keep only request ID, model, token counts, latency, cost, status and error class;
- admin UI must not expose prompt/response content;
- datasets are isolated per project and deleted on agreed schedule;
- external workers are disabled unless explicitly allowed by contract;
- support debugging uses synthetic or customer-approved repro data.

## Technical Requirements

Product backlog requirements:

- customer/project retention flag;
- per-request no-retention enforcement;
- deletion job with audit trail;
- dataset deletion command;
- admin access log for viewing sensitive project data;
- backup expiry documentation;
- export endpoint for customer usage and ledger data.

## Evidence For Enterprise Buyers

Vryx should be able to provide:

- retention matrix;
- deletion procedure;
- deletion attestation template;
- no-retention architecture note;
- backup retention statement;
- subprocessors list.

