#!/usr/bin/env bash
# Stack locale ultra-minimal : 1 worker + 1 initiateur (même topologie que test_worker_only_llm.sh).
#
# Usage :
#   ./quick-local-p2p.sh start    # démarre tout, laisse tourner en arrière-plan
#   ./quick-local-p2p.sh stop   # tue ces processus
#   ./quick-local-p2p.sh status # curl initiateur /api/status
#
# Env utiles :
#   VRYX_QUICK_MODEL   modèle HF ( défaut Qwen/Qwen2-0.5B-Instruct )
#   VRYX_QUICK_LOG_DIR répertoire des logs
#   VRYX_DIST_MAX_NEW_TOKENS  défaut 32 (réponses plus courtes que l’ancien 48 sans export)
#
# Lance aussi ``scripts/shard_serve_local.py`` (port 18765) pour les URLs shard :
# sinon le worker télécharge depuis vryx.eu et `/api/chat` reste bloqué sans API Express.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"
VENV_PATH="${PYTHON_DIR}/venv"
DAEMON="${SCRIPT_DIR}/target/release/rust-daemon"
LOG_DIR="${VRYX_QUICK_LOG_DIR:-/tmp/vryx-quick-stack}"
PIDS_FILE="/tmp/vryx-quick-stack.pids"
MODEL_QUICK="${VRYX_QUICK_MODEL:-Qwen/Qwen2-0.5B-Instruct}"
SHARD_SERVE_PORT="${VRYX_SHARD_SERVE_PORT:-18765}"

quick_stop() {
  echo "[*] Arrêt stack locale (workers + initiateurs locaux)…"
  pkill -f "shard_serve_local.py" 2>/dev/null || true
  pkill -f "inference_server.py.*--port 50052" 2>/dev/null || true
  pkill -f "inference_server.py.*--port 50051" 2>/dev/null || true
  pkill -f "rust-daemon.*--grpc-port 50052" 2>/dev/null || true
  pkill -f "rust-daemon.*--grpc-port 50051" 2>/dev/null || true
  sleep 1
  rm -f "${PIDS_FILE}"
}

CMD="${1:-start}"
case "${CMD}" in
  stop)
    quick_stop
    exit 0
    ;;
  status)
    curl -sfS -m 3 "http://127.0.0.1:3030/api/status" | head -c 2000 || {
      echo "Initiateur http://127.0.0.1:3030 injoignable (lancer ./quick-local-p2p.sh start ?)" >&2
      exit 1
    }
    echo
    exit 0
    ;;
  start)
    ;;
  *)
    echo "usage: ${0##*/} start|stop|status" >&2
    exit 1
    ;;
esac

if [[ ! -x "${VENV_PATH}/bin/python" ]]; then
  echo "Venv manquant : ${VENV_PATH}. Crée-le puis pip install -r python-inference/requirements.txt" >&2
  exit 1
fi
if [[ ! -f "${DAEMON}" ]]; then
  echo "Binaire Rust manquant : ${DAEMON}. Lance : (cd '${SCRIPT_DIR}/rust-daemon' && cargo build --release)" >&2
  exit 1
fi

quick_stop
mkdir -p "${LOG_DIR}"
rm -f "${PIDS_FILE}"

PY="${VENV_PATH}/bin/python"

# Shards HTTP local : sans cela les workers tentent https://vryx.eu → 404 et /api/chat reste bloqué.
export VRYX_SHARD_BASE_DIR="${LOG_DIR}/shards"
mkdir -p "${VRYX_SHARD_BASE_DIR}"
export VRYX_SHARD_SERVE_PORT="${SHARD_SERVE_PORT}"
export VRYX_SHARD_DOWNLOAD_BASE_URL="http://127.0.0.1:${SHARD_SERVE_PORT}"
PYTHONUNBUFFERED=1 "${PY}" "${SCRIPT_DIR}/scripts/shard_serve_local.py" \
  >"${LOG_DIR}/shard-serve.log" 2>&1 &
echo "$!:shard-serve ${VRYX_SHARD_DOWNLOAD_BASE_URL}" >>"${PIDS_FILE}"
sleep 0.5

export VRYX_DIST_MODEL="${MODEL_QUICK}"
export VRYX_WORKER_ONLY_LLM=1
export VRYX_P2P_RELAY_URL="http://127.0.0.1:3030"
export VRYX_POOL_PREFERENCE="${VRYX_POOL_PREFERENCE:-velocity_mlx}"
export VRYX_DECODE_MICROBATCH_CAP="${VRYX_DECODE_MICROBATCH_CAP:-32}"
export VRYX_DIST_MAX_NEW_TOKENS="${VRYX_DIST_MAX_NEW_TOKENS:-32}"
export VRYX_PIPELINE_CHAIN_MODE="${VRYX_PIPELINE_CHAIN_MODE:-initiator_sequential}"

# Apple Silicon : MLX par défaut (refus fallback → logs worker « mlx_unavailable », alors VRYX_QUICK_USE_PYTORCH=1).
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" && "${VRYX_QUICK_USE_PYTORCH:-0}" != "1" ]]; then
  export VRYX_RUNTIME_BACKEND="${VRYX_RUNTIME_BACKEND:-mlx}"
  export VRYX_ENABLE_MLX_RUNTIME="${VRYX_ENABLE_MLX_RUNTIME:-1}"
  export VRYX_ENABLE_MLX_KERNELS="${VRYX_ENABLE_MLX_KERNELS:-1}"
  export VRYX_MLX_STRICT="${VRYX_MLX_STRICT:-1}"
fi

PYTHONUNBUFFERED=1 "${PY}" "${PYTHON_DIR}/inference_server.py" --port 50052 --stage 2 --model "${MODEL_QUICK}" \
  >"${LOG_DIR}/worker-python.log" 2>&1 &
echo "$!:python worker stage2" >>"${PIDS_FILE}"

"${DAEMON}" --mode worker --grpc-port 50052 --p2p-port 4002 --api-port 3031 \
  >"${LOG_DIR}/worker-rust.log" 2>&1 &
echo "$!:rust worker" >>"${PIDS_FILE}"

WORKER_PEER=""
for _ in $(seq 1 40); do
  WORKER_PEER=$(grep -oE '12D3Koo[A-Za-z0-9]+' "${LOG_DIR}/worker-rust.log" 2>/dev/null | head -1 || true)
  [[ -n "${WORKER_PEER}" ]] && break
  sleep 0.5
done
if [[ -z "${WORKER_PEER}" ]]; then
  echo "Impossible de lire le PeerId worker. ${LOG_DIR}/worker-rust.log :" >&2
  tail -30 "${LOG_DIR}/worker-rust.log" >&2
  exit 1
fi
echo "[+] PeerId worker : ${WORKER_PEER}"
export VRYX_DIST_PEER_IDS="${WORKER_PEER}"
export VRYX_TP_PEER_IDS="${WORKER_PEER}"

PYTHONUNBUFFERED=1 "${PY}" "${PYTHON_DIR}/inference_server.py" --port 50051 --stage 1 \
  >"${LOG_DIR}/stage1-python.log" 2>&1 &
echo "$!:python stage1" >>"${PIDS_FILE}"

for _ in $(seq 1 40); do
  "${PY}" -c "import socket;s=socket.socket();s.settimeout(0.3);r=s.connect_ex(('127.0.0.1',50051));s.close();raise SystemExit(0 if r==0 else 1)" 2>/dev/null && break
  sleep 0.3
done

"${DAEMON}" --mode initiator --grpc-port 50051 --p2p-port 4003 --api-port 3030 \
  >"${LOG_DIR}/initiator-rust.log" 2>&1 &
echo "$!:rust initiator" >>"${PIDS_FILE}"

sleep 0.8
if curl -sfS -m 2 "http://127.0.0.1:3030/api/status" >/dev/null; then
  echo "[+] Initiateur OK : GET http://127.0.0.1:3030/api/status"
else
  echo "[!] Initiateur pas encore prêt (HTTP). Voir ${LOG_DIR}/initiator-rust.log"
fi

echo
echo "Logs : ${LOG_DIR}"
echo "PIDs : ${PIDS_FILE}"
echo "Tester : curl -sS http://127.0.0.1:3030/api/status"
echo "Chat     : curl -sS -X POST http://127.0.0.1:3030/api/chat -H 'Content-Type: application/json' -d '{\"prompt\":\"Dis bonjour en une phrase.\",\"max_new_tokens\":24}'"
echo "Bench TPS : ${PY} \"${SCRIPT_DIR}/scripts/bench_local_chat_tps.py\""
