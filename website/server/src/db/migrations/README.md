# Database migrations

The canonical SQL migrations currently live in `website/server/migrations`.

This directory exists as the future import boundary for server-owned database helpers and migration runners. Keep financial and audit schema changes in versioned SQL files first; do not rely only on boot-time `CREATE TABLE` blocks for investor-facing due diligence.
