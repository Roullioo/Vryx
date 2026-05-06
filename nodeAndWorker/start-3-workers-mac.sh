#!/bin/bash
# Lance 3 workers Vryx sur macOS (Python stage 2 + daemon Rust chacun).
# Ports distincts : gRPC 50052–50054, API Axum 3031–3033, libp2p 4021–4023.
#
# Optionnel :
#   export VRYX_WORKER_MODEL="unsloth/gemma-2-9b-it"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"
VENV_PATH="${PYTHON_DIR}/venv"
DAEMON_BIN="${SCRIPT_DIR}/target/release/rust-daemon"
KEYS_DIR="${SCRIPT_DIR}/.vryx-keys-mac"

BOOTSTRAP_NODE="${VRYX_BOOTSTRAP_NODE:-/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz}"
MODEL_ID="${VRYX_WORKER_MODEL:-unsloth/gemma-2-9b-it}"
API_URL="${VRYX_WORKER_API_URL:-https://vryx.eu}"

if [[ ! -f "${DAEMON_BIN}" ]]; then
  echo "[*] Compilation du daemon Rust…"
  (cd "${SCRIPT_DIR}/rust-daemon" && cargo build --release)
fi

if [[ ! -d "${VENV_PATH}" ]]; then
  echo "[*] Création du venv Python…"
  python3 -m venv "${VENV_PATH}"
  # shellcheck source=/dev/null
  source "${VENV_PATH}/bin/activate"
  pip install -q -r "${PYTHON_DIR}/requirements.txt"
else
  # shellcheck source=/dev/null
  source "${VENV_PATH}/bin/activate"
fi

mkdir -p "${KEYS_DIR}"

echo "[*] Arrêt des anciens workers sur les ports 50052–50054 / 3031–3033 / 4021–4023…"
for p in 50052 50053 50054 3031 3032 3033 4021 4022 4023; do
  lsof -ti:"${p}" | xargs kill -9 2>/dev/null || true
done

PIDS_FILE="/tmp/vryx-mac-3-workers.pids"
rm -f "${PIDS_FILE}"

start_one() {
  local n="$1"
  local grpc api p2p
  case "${n}" in
    1) grpc=50052; api=3031; p2p=4021 ;;
    2) grpc=50053; api=3032; p2p=4022 ;;
    3) grpc=50054; api=3033; p2p=4023 ;;
    *) echo "[!] Index worker invalide"; exit 1 ;;
  esac

  local keyfile="${KEYS_DIR}/worker-${n}.key"
  local log_py="/tmp/vryx-mac-worker${n}-python.log"
  local log_rs="/tmp/vryx-mac-worker${n}-rust.log"

  echo "[+] Worker ${n} : gRPC ${grpc}, API ${api}, P2P ${p2p}"

  PYTHONUNBUFFERED=1 nohup python3 "${PYTHON_DIR}/inference_server.py" \
    --port "${grpc}" \
    --stage 2 \
    --model "${MODEL_ID}" \
    >> "${log_py}" 2>&1 &
  echo "$!" >> "${PIDS_FILE}"

  sleep 0.5

  nohup "${DAEMON_BIN}" \
    --mode worker \
    --grpc-port "${grpc}" \
    --p2p-port "${p2p}" \
    --api-port "${api}" \
    --bootstrap-node "${BOOTSTRAP_NODE}" \
    --api-url "${API_URL}" \
    --model "${MODEL_ID}" \
    --node-key-file "${keyfile}" \
    >> "${log_rs}" 2>&1 &
  echo "$!" >> "${PIDS_FILE}"
}

for i in 1 2 3; do
  start_one "${i}"
  sleep 1
done

echo ""
echo "[OK] 3 workers lancés (6 processus : 3× Python gRPC + 3× Rust P2P)."
echo "    PIDs enregistrés dans ${PIDS_FILE}"
echo "    Journaux : /tmp/vryx-mac-worker{1,2,3}-{python,rust}.log"
echo "    API locales : http://127.0.0.1:3031 … 3033 (GET /api/status)"
echo ""
echo "    Pour tout arrêter : ./stop-3-workers-mac.sh"
echo ""
