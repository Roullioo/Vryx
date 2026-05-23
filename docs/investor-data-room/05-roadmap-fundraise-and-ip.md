# 05 - Roadmap, Fundraise And IP

## 24-Month Roadmap

| Period | Product Milestones | Business Milestones |
| --- | --- | --- |
| 0-3 months | Security hardening, stable golden path, staging money path, worker payout ledger, data room. | Investor demo, LOIs, first paid pilots. |
| 3-6 months | Production Stripe, worker onboarding, private pool MVP, observability v2. | 3-5 design partners, first recurring revenue. |
| 6-12 months | Multi-worker routing, queue system, reputation scoring, SLA dashboards. | Enterprise private pool contracts, channel partners. |
| 12-18 months | Fine-tuning/RAG workflows, customer project workspaces, stronger compliance. | Mid-market expansion, larger annual contracts. |
| 18-24 months | Multi-region EU capacity, worker marketplace, advanced routing by cost/latency/privacy. | Strategic partnerships and scaled B2B pipeline. |

## Demo Scope

The current investor demo should be framed as a serious staging environment, not as a full banking-production environment.

Keep active for demo:

| Brick | Why it matters |
| --- | --- |
| Dynamic pricing | Proves the economic model is data-driven. |
| Admin Pricing | Proves the business can tune model economics. |
| API keys | Proves the developer product surface. |
| Admin credits | Replaces live Stripe in staging. |
| Credit debit | Proves billable consumption. |
| `api_key_usage` | Proves usage accounting. |
| `worker_payout_ledger` | Proves worker revenue sharing. |
| Redis/Valkey | Proves scalability and coordination readiness. |
| systemd workers | Proves worker operation survives sessions/reboots. |
| Readiness / Network | Proves runtime status and golden path evidence. |
| Green CI | Proves repository quality. |
| Demo video | Compresses proof for investors. |

Defer to production/post-demo roadmap:

| Topic | Reason |
| --- | --- |
| Stripe live | Required for real payments, not for staging proof. |
| Apple notarization | Required for broad macOS worker distribution. |
| Windows signing | Required for broad Windows worker distribution. |
| Google OAuth production | Useful, but not mandatory if admin email/password access works. |
| Signed worker auto-update | Required before public worker rollout. |
| Real bank payouts | Required before paying external workers. |
| VAT and legal invoices | Required before real commercial billing. |

Investor wording:

> The economic flow is validated in staging through admin credits and ledger writes. Stripe live, real invoicing and signed worker app distribution are the next production steps.

## Use Of Funds

Indicative allocation:

| Category | Allocation | Purpose |
| --- | --- | --- |
| Engineering infra/security | 35% | Hardening, audits, routing, reliability, observability. |
| Product worker/API/billing | 25% | Signed app, onboarding, pricing, Stripe production, payouts. |
| Go-to-market B2B | 20% | Design partners, pilots, enterprise sales, technical presales. |
| Legal/compliance/audit | 10% | DPA, security review, contracts, data protection. |
| Operations and reserve capacity | 10% | VPS/cloud, managed services, benchmark GPU reserve. |

## Hiring Plan

| Role | Timing | Why |
| --- | --- | --- |
| Senior backend/infrastructure engineer | First hire | Split API, billing, queues, reliability. |
| Rust/P2P engineer | Early | Harden worker networking and routing. |
| Product/full-stack engineer | Early | Worker onboarding and admin/customer UX. |
| Security/compliance advisor | Fractional | B2B diligence, audit prep, DPA and controls. |
| Founder-led sales or technical AE | After pilots | Convert private pool and custom AI opportunities. |

## Intellectual Property Status

| Area | Status |
| --- | --- |
| Application code | Proprietary Vryx repo. |
| Worker app | Proprietary Electron app built from repo source. |
| Routing/orchestration | Proprietary integration around Rust/libp2p, API scheduler and worker scoring. |
| Billing/pricing ledgers | Proprietary business logic and schema. |
| ML runtimes | Uses third-party open-source/runtime dependencies. |
| Models | Third-party model licenses must be respected per selected model. |
| Brand | Vryx trademark status should be checked and filed if not already done. |

## Dependency Inventory

High-level dependency categories:

- frontend: React, Vite, TypeScript, Tailwind, lucide;
- backend: Node.js, Express, mysql2, Zod, JWT, bcrypt, Stripe, Redis/BullMQ;
- database: MariaDB;
- coordination: Redis/Valkey;
- P2P: Rust, libp2p, Axum;
- inference: Python, gRPC, MLX, llama.cpp, vLLM-compatible paths;
- desktop: Electron;
- ops: PM2, Nginx, systemd, GitHub Actions.

Due diligence action: export exact dependency lists from package-lock, Cargo.lock and Python requirement files into a versioned dependency appendix before sharing the full room externally.

## Fundraise Narrative

The round funds a transition:

```text
Advanced working prototype
-> secure B2B infrastructure
-> repeatable golden path
-> signed worker distribution
-> paid enterprise pilots
-> private pool revenue
```

This is not a pure R&D round. The core technical thesis is implemented. The next capital should convert proof into reliability, compliance and revenue.
