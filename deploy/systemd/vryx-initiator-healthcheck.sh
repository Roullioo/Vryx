#!/usr/bin/env bash
set -euo pipefail

URL="${VRYX_INITIATOR_HEALTH_URL:-http://127.0.0.1:3031/api/status}"

if curl -fsS --max-time 3 "${URL}" >/dev/null; then
  exit 0
fi

echo "[vryx] initiator API unhealthy (${URL}); restarting vryx-initiator.service" >&2
systemctl restart vryx-initiator.service
sleep 2
curl -fsS --max-time 5 "${URL}" >/dev/null
