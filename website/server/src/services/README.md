# Vryx server services

Services contain business logic that should be testable without Express route wiring.

Current extracted services:

- `billing.js`: shared token and euro calculations.
- `security.js`: timing-safe comparisons and hashing helpers.

Target services:

- `billing.js`: credits, usage, Stripe, invoices and worker payout ledger writes.
- `workers.js`: worker health, capabilities, live state and payout allocation.
- `scheduler.js`: worker selection, reservation and backpressure.
- `inference.js`: OpenAI-compatible request orchestration and streaming.
- `security.js`: secrets, internal tokens, request validation and abuse controls.
