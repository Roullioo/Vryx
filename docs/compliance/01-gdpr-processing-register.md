# 01 - GDPR Processing Register

This register is the operational baseline for Article 30-style GDPR documentation. It should be reviewed by counsel or a DPO before being shared as a contractual artifact.

## Controller / Processor Roles

| Context | Customer Role | Vryx Role | Notes |
| --- | --- | --- | --- |
| Customer account and billing | Independent controller | Independent controller | Vryx manages its own customer relationship and billing. |
| API inference prompts/responses | Controller | Processor | Customer determines content and purpose of prompts. |
| Private Pool / Custom AI project | Controller | Processor | DPA should define project instructions, retention and subprocessors. |
| Worker payout and fraud prevention | N/A or independent controller | Controller | Worker data is processed for platform operation and payouts. |
| Public network status | Controller | Controller | Only redacted aggregate data should be public. |

## Processing Activities

| Activity | Purpose | Data Categories | Legal Basis | Retention |
| --- | --- | --- | --- | --- |
| Account creation | Provide access to Vryx | Email, password hash, role, timestamps | Contract | Account lifetime plus legal limits |
| Session auth | Secure access | Session token, IP-derived security logs, user agent | Contract / legitimate interest | Session lifetime, security logs 180 days |
| API key management | Authenticate API usage | API key hash, prefix, creation/revocation, last use | Contract | Account lifetime or until revoked |
| Inference request handling | Provide AI response | Prompt, response, model, parameters, request ID | Contract / customer instruction | Default 30 days, no-retention optional |
| Usage metering | Bill and monitor service | Tokens, latency, status, model, cost | Contract / legitimate interest | Usage ledger retained for billing/audit |
| Credit billing | Process payments and balance | Checkout IDs, ledger entries, amounts, invoices | Contract / legal obligation | Accounting legal retention |
| Worker orchestration | Route jobs and monitor capacity | Peer ID, heartbeat, capabilities, model, uptime, errors | Legitimate interest / contract | Live state short TTL, snapshots as operational records |
| Worker payouts | Pay contributors | Peer ID, usage allocation, payout amount, status | Contract / legal obligation | Accounting legal retention |
| Enterprise quotes | Sales and project qualification | Company, contact, requirements, estimated budget, notes | Legitimate interest / pre-contract | Sales cycle plus deletion on request |
| Security logs | Detect abuse and incidents | Request IDs, IP-derived metadata, auth failures, admin actions | Legitimate interest | 180 days by default |
| Benchmarks/readiness | Prove platform health | Model, TPS, TTFT, latency, status, error class | Legitimate interest | 12 months unless artifact policy differs |

## Data Subject Categories

- customer account users;
- customer end users whose data may be included in prompts or datasets;
- worker operators;
- enterprise prospects;
- administrators and internal operators.

## Recipients And Subprocessors

| Recipient | Role | Data Shared |
| --- | --- | --- |
| Hosting provider | Infrastructure subprocessor | Server, DB, logs, backups depending on deployment |
| Stripe | Payment processor | Payment and invoice data |
| Email/DNS provider | Infrastructure subprocessor | Contact and routing metadata if used |
| Observability provider | Optional subprocessor | Logs and metrics if enabled |
| External workers | Conditional subprocessor | Inference payload fragments only when the customer plan permits external workers |

For sensitive clients, the DPA should restrict processing to internal capacity or dedicated/private workers.

## International Transfers

Default target: EU-hosted processing where possible.

If any subprocessor or worker can access data outside the EEA, the contract must define:

- transfer mechanism;
- Standard Contractual Clauses where needed;
- client approval process;
- private-pool/no-external-worker alternative.

