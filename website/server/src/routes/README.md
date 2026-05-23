# Vryx server routes

This directory is the target boundary for the Express route split.

The monolithic `src/index.js` still wires the current production routes while the highest-risk cross-cutting code is being extracted first:

- `middlewares/auth.js`: session, admin and API key guards.
- `middlewares/csrf.js`: browser mutation protection.
- `middlewares/rate-limit.js`: abuse controls.
- `services/billing.js`: token and euro calculations.
- `services/security.js`: timing-safe secret comparisons.

Next route modules should be moved in this order:

1. `routes/auth.js` for login, Google OAuth, signup and logout.
2. `routes/account.js` for account, sessions, billing and API keys.
3. `routes/openai.js` for OpenAI-compatible inference endpoints.
4. `routes/workers.js` for worker registration, heartbeat, commands and scheduler-facing APIs.
5. `routes/admin.js` for admin-only dashboards, pricing, readiness and observability.
