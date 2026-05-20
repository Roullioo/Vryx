#!/bin/bash
# Lance des workers Vryx sur macOS (Python stage 2 + daemon Rust chacun).
# Par défaut : 1 worker (RAM). Ports : gRPC 50052+, API Axum 3031+, libp2p 4021+.
# Multi-workers : export VRYX_WORKER_COUNT=4
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
WORKER_COUNT="${VRYX_WORKER_COUNT:-1}"

if [[ ! -f "${DAEMON_BIN}" || "${SCRIPT_DIR}/rust-daemon/src/main.rs" -nt "${DAEMON_BIN}" || "${SCRIPT_DIR}/rust-daemon/Cargo.toml" -nt "${DAEMON_BIN}" ]]; then
  echo "[*] Compilation du daemon Rust…"
  (cd "${SCRIPT_DIR}/rust-daemon" && CARGO_TARGET_DIR=/tmp/vryx-rust-target CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 cargo build --release --locked --message-format short)
  mkdir -p "${SCRIPT_DIR}/target/release"
  cp /tmp/vryx-rust-target/release/rust-daemon "${DAEMON_BIN}"
fi

if [[ ! -x "${VENV_PATH}/bin/python" ]]; then
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

echo "[*] Arrêt des anciens workers sur les ports 50052–50060 / 3031–3039 / 4021–4029…"
for p in 50052 50053 50054 50055 50056 50057 50058 50059 50060 3031 3032 3033 3034 3035 3036 3037 3038 3039 4021 4022 4023 4024 4025 4026 4027 4028 4029; do
  lsof -ti:"${p}" | xargs kill -9 2>/dev/null || true
done

PIDS_FILE="/tmp/vryx-mac-workers.pids"
rm -f "${PIDS_FILE}"

start_one() {
  local n="$1"
  local grpc api p2p
  grpc=$((50051 + n))
  api=$((3030 + n))
  p2p=$((4020 + n))

  local keyfile="${KEYS_DIR}/worker-${n}.key"
  local log_py="/tmp/vryx-mac-worker${n}-python.log"
  local log_rs="/tmp/vryx-mac-worker${n}-rust.log"

  echo "[+] Worker ${n} : gRPC ${grpc}, API ${api}, P2P ${p2p}"

  VRYX_WORKER_KV_CACHE=true \
  VRYX_HIDDEN_TRANSPORT=int8 \
  VRYX_HIDDEN_QUIC=1 \
  VRYX_PERSISTENT_RELAY=1 \
  VRYX_PIPELINE_CHAIN_MODE="${VRYX_PIPELINE_CHAIN_MODE:-initiator_sequential}" \
  VRYX_PREFIX_CACHE=1 \
  PYTHONUNBUFFERED=1 nohup "${VENV_PATH}/bin/python" "${PYTHON_DIR}/inference_server.py" \
    --port "${grpc}" \
    --stage 2 \
    --model "${MODEL_ID}" \
    >> "${log_py}" 2>&1 &
  echo "$!" >> "${PIDS_FILE}"

  sleep 0.5

  VRYX_HIDDEN_QUIC=1 \
  VRYX_P2P_REQUEST_TIMEOUT_S=3600 \
  VRYX_P2P_IDLE_TIMEOUT_S=900 \
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

for i in $(seq 1 "${WORKER_COUNT}"); do
  start_one "${i}"
  sleep 1
done

echo ""
echo "[OK] ${WORKER_COUNT} workers lancés (${WORKER_COUNT}× Python gRPC + ${WORKER_COUNT}× Rust P2P)."
echo "    PIDs enregistrés dans ${PIDS_FILE}"
echo "    Journaux : /tmp/vryx-mac-worker{1..${WORKER_COUNT}}-{python,rust}.log"
echo "    API locales : http://127.0.0.1:3031 … $((3030 + WORKER_COUNT)) (GET /api/status)"
echo ""
echo "    Pour tout arrêter : ./stop-3-workers-mac.sh"
echo ""
