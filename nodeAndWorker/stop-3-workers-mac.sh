#!/bin/bash
# Arrête les workers lancés par start-3-workers-mac.sh (via fichier PID ou ports).

set -euo pipefail

PIDS_FILE="/tmp/vryx-mac-workers.pids"
LEGACY_PIDS_FILE="/tmp/vryx-mac-3-workers.pids"

if [[ -f "${PIDS_FILE}" ]]; then
  echo "[*] Arrêt des PID listés dans ${PIDS_FILE}…"
  while read -r pid; do
    [[ -z "${pid}" ]] && continue
    kill "${pid}" 2>/dev/null || true
  done < "${PIDS_FILE}"
  rm -f "${PIDS_FILE}"
fi

if [[ -f "${LEGACY_PIDS_FILE}" ]]; then
  echo "[*] Arrêt des PID listés dans ${LEGACY_PIDS_FILE}…"
  while read -r pid; do
    [[ -z "${pid}" ]] && continue
    kill "${pid}" 2>/dev/null || true
  done < "${LEGACY_PIDS_FILE}"
  rm -f "${LEGACY_PIDS_FILE}"
fi

echo "[*] Libération des ports 50052–50060, 3031–3039, 4021–4029…"
for p in 50052 50053 50054 50055 50056 50057 50058 50059 50060 3031 3032 3033 3034 3035 3036 3037 3038 3039 4021 4022 4023 4024 4025 4026 4027 4028 4029; do
  lsof -ti:"${p}" | xargs kill -9 2>/dev/null || true
done

echo "[*] Arrêt des rust-daemon worker résiduels…"
pkill -9 -f 'rust-daemon --mode worker' 2>/dev/null || true
pkill -9 -f 'vryx-rust-daemon.*--mode worker' 2>/dev/null || true
sleep 1

echo "[OK] Terminé."
