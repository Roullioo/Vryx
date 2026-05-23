# Vryx Investor Data Room

Last updated: 2026-05-23

## Executive Summary

Vryx is a distributed AI inference infrastructure company. The product combines an OpenAI-compatible API, a desktop worker network, a Rust/libp2p coordination layer, Python/gRPC inference runtimes, MariaDB billing ledgers, Redis/Valkey coordination, and investor-readiness dashboards.

The investment thesis is simple: Vryx turns distributed compute into measurable, billable AI capacity.

## What This Folder Contains

| File | Purpose |
| --- | --- |
| `01-technical-architecture.md` | Plain-English architecture, trust zones, runtime flow and deployment model. |
| `02-business-model-and-pricing.md` | Offers, target buyers, pricing logic, margins and monetization loop. |
| `03-readiness-benchmarks-and-traction.md` | Golden path, benchmarks, workers live, product proof and traction evidence. |
| `04-security-compliance-and-risk.md` | Security posture, compliance plan, risks and mitigations. |
| `05-roadmap-fundraise-and-ip.md` | 24-month roadmap, use of funds, IP status and dependency inventory. |
| `06-video-proof-checklist.md` | Demo video plan and evidence checklist for a 3-5 minute investor walkthrough. |

## Live Product Proof

| Surface | What It Proves |
| --- | --- |
| `/network` | Public redacted network status, workers, models and live proof. |
| `/admin/production-readiness` | Golden path score, blockers, warnings and technical evidence. |
| `/admin/observability` | PM2/systemd health, runtime checks, structured events. |
| `/admin/parametres/pricing` | Dynamic pricing controlled from admin. |
| `/compte` | Customer credits, API keys, usage and billing. |
| `/admin/enterprise` | B2B pipeline, LOI/pilot tracking and project conversion. |

## Existing Source Documents

These files contain the deeper technical source material:

- `docs/INFRASTRUCTURE_A_Z.md`
- `docs/SECURITY_ARCHITECTURE_VRYX.md`
- `docs/BILLING_MONEY_PATH.md`
- `docs/GOLDEN_PATH_PRODUCTION_READINESS.md`
- `docs/PRODUCTION_READINESS_SCORECARD.md`
- `docs/WORKER_ONBOARDING_INVESTOR.md`
- `docs/WORKER_RELEASE_RUNBOOK.md`
- `docs/COMPLIANCE_AND_DATA_PROTECTION.md`
- `docs/COMMERCIAL_PROOF_PIPELINE.md`
- `docs/ENTERPRISE_OFFERS.md`

## Due Diligence Status

| Area | Current Status | Next Evidence To Add |
| --- | --- | --- |
| Product | Working web app, admin, account and network pages | 3-5 minute demo video |
| API | OpenAI-compatible API, API keys and usage logging | Public sample request/response capture |
| Billing | Credits, Stripe test flow, API usage cost, worker payout ledger | Stripe production validation |
| Workers | Desktop app, live heartbeats, two VPS workers as systemd services | Signed worker release |
| Benchmarks | Golden path and staging bench workflows | 100-request success proof artifact |
| Security | Worker auth, admin/public split, startup gates, security docs | External audit or penetration test |
| CI | Investor CI, Rust Linux CI, security CI, release workflow | Persisted green run screenshots |
| Commercial | Enterprise configurator and CRM-style admin pipeline | Signed LOIs or paid pilot documents |

## Demo Scope Statement

For the investor demo, Vryx should be presented as a staging-grade billable infrastructure proof:

> The economic flow is validated in staging through admin credits and ledger writes. Stripe live, real invoicing and signed worker app distribution are the next production steps.

This keeps the claim precise. The demo must keep dynamic pricing, API keys, credit debit, `api_key_usage`, `worker_payout_ledger`, Redis/Valkey, systemd workers, readiness/network proof, CI and video evidence active. Stripe live, VAT invoices, real bank payouts, app signing/notarization and signed auto-update remain production/post-demo roadmap items.

## Investor Narrative

Vryx is past the "idea" stage. The repo contains a functioning technical stack, billing primitives, worker orchestration, readiness scoring and operational dashboards. The fundraising round is designed to fund the transition from advanced prototype to production-grade B2B infrastructure:

1. harden security and compliance;
2. ship signed worker apps;
3. prove daily golden path reliability;
4. convert first B2B pilots;
5. expand worker capacity and enterprise private pools.
