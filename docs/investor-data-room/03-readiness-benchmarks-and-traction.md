# 03 - Readiness, Benchmarks And Traction

## What Vryx Must Prove

For investor diligence, Vryx must show that the network is real, measurable and repeatable:

- workers are live;
- an API request returns a non-empty answer;
- tokens, latency, TTFT and TPS are measured;
- the request has a calculated cost;
- billing and payout ledgers are written;
- the same golden path can run again tomorrow.

## Golden Path

The official demo path:

1. Open the public network page.
2. Show readiness score and current blockers/warnings.
3. Show at least two active workers.
4. Run or display a real benchmark.
5. Send an OpenAI-compatible API request.
6. Show the AI response.
7. Show usage cost and pricing snapshot.
8. Show customer credit debit.
9. Show worker payout pending.
10. Show CI/benchmark evidence.

## Target Metrics

| Metric | Target |
| --- | --- |
| Golden path requests | 100 |
| Success rate | 99% or better |
| Empty responses | 0 |
| TPS p50 | At least 10 TPS |
| TTFT p95 | Less than 10 seconds |
| Usage cost | Non-zero and auditable |
| Worker payout | Created only for successful usage |

## Product Evidence

| Evidence | Location |
| --- | --- |
| Public network status | `/network` |
| Public redacted API | `/api/public/network-status` |
| Golden path public status | `/api/public/golden-path-status` |
| Admin readiness | `/admin/production-readiness` |
| Admin inference metrics | `/api/admin/inference/summary?hours=24` |
| Admin billing proof | `/api/admin/billing/proof` |
| Observability health | `/admin/observability` |

## CI Evidence

The repo contains workflows intended for investor due diligence:

- frontend React/Vite build;
- backend API tests;
- Rust format, clippy, tests and Linux release build;
- Python tests;
- Electron worker smoke build;
- dependency and secret scans;
- P2P staging bench;
- worker release build and checksums.

## Traction Evidence To Collect

| Evidence | Owner | Status |
| --- | --- | --- |
| 3-5 minute investor demo video | Founder/product | To produce |
| 100-request golden path artifact | Engineering | Target evidence |
| Signed letters of interest | Sales/founder | To collect |
| Paid pilot agreement | Sales/founder | To collect |
| Worker release screenshots | Product | To collect |
| CI green run screenshots | Engineering | To export |

## Current Commercial Funnel

The product already has an Enterprise path:

- `/enterprise`: B2B configurator and quote entry point;
- `/admin/enterprise`: request qualification, LOI/pilot tracking and project conversion;
- `enterprise_quote_requests`: quote source table;
- `enterprise_customer_projects`: customer project source table.

Reference templates:

- `docs/LETTER_OF_INTEREST_TEMPLATE.md`
- `docs/PAID_PILOT_TEMPLATE.md`
- `docs/COMMERCIAL_PROOF_PIPELINE.md`

