#!/bin/bash
# Arrête les 3 workers lancés par start-3-workers-mac.sh (via fichier PID ou ports).

set -euo pipefail

PIDS_FILE="/tmp/vryx-mac-3-workers.pids"

if [[ -f "${PIDS_FILE}" ]]; then
  echo "[*] Arrêt des PID listés dans ${PIDS_FILE}…"
  while read -r pid; do
    [[ -z "${pid}" ]] && continue
    kill "${pid}" 2>/dev/null || true
  done < "${PIDS_FILE}"
  rm -f "${PIDS_FILE}"
fi

echo "[*] Libération des ports 50052–50054, 3031–3033, 4021–4023…"
for p in 50052 50053 50054 3031 3032 3033 4021 4022 4023; do
  lsof -ti:"${p}" | xargs kill -9 2>/dev/null || true
done

echo "[OK] Terminé."
