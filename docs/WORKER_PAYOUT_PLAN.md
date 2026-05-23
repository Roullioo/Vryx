# Vryx worker payout plan

This document defines the production payout model for Vryx workers. MariaDB is the source of truth. Redis/Valkey and queues may accelerate payout jobs, but balances, payable rows, approvals, invoices and paid status must remain auditable in SQL.

## Goals

- Pay only real, successful compute contribution.
- Keep Vryx margin positive after worker share, payment reserve and platform costs.
- Separate compute workers, relay workers, test workers, unstable workers, premium workers and dedicated B2B workers.
- Give admins a clear pending -> approved -> paid workflow.
- Hold suspicious rows before they become payable.
- Require KYC, tax or banking evidence once payout thresholds justify it.

## Worker classes

| Class | Purpose | Default multiplier | Payout behavior |
| --- | --- | ---: | --- |
| `compute` | Standard inference worker | 1.00 | Normal payout when request succeeds. |
| `relay` | Routing, bootstrap or relay capacity | 0.10 | Paid only for operational value, not full inference value. |
| `test` | Demo, QA, staging or internal worker | 0.00 | Ledger can prove activity, but payout is void. |
| `unstable` | Worker with low health, stale heartbeat or errors | 0.25 | Discounted and usually reviewed. |
| `premium` | High-value model, strong uptime or premium hardware | 1.15 | Bonus payout when quality is high. |
| `dedicated_b2b` | Enterprise/private pool capacity | 1.25 | Highest multiplier, tied to SLA and contract terms. |

The `workers.worker_payout_class` column stores the admin classification. If a worker is unhealthy, the server can temporarily infer `unstable` even if the stored class is `compute`.

## Ledger lifecycle

`worker_payout_ledger.status` supports:

- `pending`: successful usage created a payout row, awaiting settlement review.
- `payable`: the row passed automatic checks and can be included in a payout batch.
- `approved`: admin approved the row for payout.
- `paid`: payout has been sent and `paid_at` is set.
- `fraud_review`: row is held because a quality or anti-fraud flag was detected.
- `void`: no payout due, usually failed request, blocked worker, test worker or cancellation.

Rows include:

- customer cost;
- worker share percent actually applied;
- payout amount;
- pricing snapshot;
- worker class;
- quality, availability, latency and success scores;
- fraud flags;
- invoice reference;
- payout batch id;
- approval and paid timestamps.

## Formula

For each successful API usage:

```text
allocated_customer_cost = usage_cost / selected_workers
base_worker_share = pricing_config.workerRewardSharePercent
effective_share = base_worker_share * class_multiplier * quality_score
payout_eur = allocated_customer_cost * effective_share
```

The effective share is capped at 80%. Failed, cancelled or blocked paths must not produce payable payout.

The quality score combines:

- worker health score;
- heartbeat freshness;
- request success;
- model match;
- runtime state.

This keeps a worker from being paid only because it claimed tokens. Availability, reliability and model value matter.

## Minimum withdrawal and KYC

Default thresholds:

- minimum withdrawal: `25 EUR`;
- KYC review threshold: `1000 EUR` over a 30-day period.

These values are configurable with:

- `VRYX_WORKER_MIN_WITHDRAWAL_EUR`;
- `VRYX_WORKER_KYC_MONTHLY_THRESHOLD_EUR`.

Workers can have a custom `payout_min_withdrawal_eur`. Admins can set `kyc_status` to `required`, `submitted`, `approved` or `rejected`.

## Anti-fraud controls

The server writes `fraud_flags_json` when it sees:

- stale heartbeat;
- low health score;
- model mismatch;
- manual payout hold;
- no historical token production;
- test worker;
- unstable worker;
- blocked payout.

Suspicious rows go to `fraud_review` or `void`. Admins can later approve, mark payable, void or paid.

Future controls:

- hardware attestation;
- signed worker builds;
- impossible TPS/latency detection;
- duplicate worker identity detection;
- replay protection for payout events;
- payout anomaly alerts;
- country and tax rule checks.

## Admin and API surface

Admin endpoints:

- `GET /api/admin/worker-payouts`
- `GET /api/admin/worker-payouts?status=pending`
- `PATCH /api/admin/worker-payouts/:id`

Worker inventory includes payout metadata:

- `workerPayoutClass`;
- `payoutStatus`;
- `kycStatus`;
- `payoutMinWithdrawalEur`;
- pending and 24h payout amounts.

## Due diligence statement

Vryx records every worker payout from a successful usage row with immutable pricing context, quality factors, fraud flags and settlement status. Workers are not paid only by token count: payout depends on model value, class, success, health, freshness and admin review.
