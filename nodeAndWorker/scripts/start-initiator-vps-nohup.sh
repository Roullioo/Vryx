#!/usr/bin/env bash
# Démarre sur le VPS (même hôte que vryx-api) l'inférence stage 1 + rust-daemon
# mode initiator, pour que Node puisse joindre http://127.0.0.1:3031 (VRYX_INITIATOR_CHAT_URL).
#
# Prérequis : répertoire nodeAndWorker déployé, venv python-inference, binaire target/release/rust-daemon.
# Usage : depuis nodeAndWorker : ./scripts/start-initiator-vps-nohup.sh
# Si systemd (vryx-initiator.service) écoute déjà le même port depuis /home/ubuntu/apps/vryx/nodeAndWorker,
# ne pas lancer une seconde instance (conflits sur 127.0.0.1:3031). Préférer systemd pour la prod VPS.
set -euo pipefail

BOOTSTRAP="${VRYX_BOOTSTRAP_NODE:-/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz}"
GRPC_PORT="${VRYX_INITIATOR_GRPC_PORT:-50051}"
API_PORT="${VRYX_INITIATOR_API_PORT:-3031}"
API_URL="${VRYX_INITIATOR_API_URL:-https://vryx.eu}"
MODEL_ID="${VRYX_INITIATOR_MODEL:-Qwen/Qwen3.5-9B}"
P2P_PORT="${VRYX_INITIATOR_P2P_PORT:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"
LOG_DIR="${SCRIPT_DIR}/logs"
mkdir -p "${LOG_DIR}"

VENV_PATH=""
if [ -d "${PYTHON_DIR}/.venv" ]; then
  VENV_PATH="${PYTHON_DIR}/.venv"
elif [ -d "${PYTHON_DIR}/venv" ]; then
  VENV_PATH="${PYTHON_DIR}/venv"
else
  echo "[!] Aucun venv dans ${PYTHON_DIR} (.venv ou venv). Créez-le et installez requirements.txt." >&2
  exit 1
fi

DAEMON_BIN="${SCRIPT_DIR}/target/release/rust-daemon"
if [ ! -x "${DAEMON_BIN}" ]; then
  echo "[!] Binaire manquant : ${DAEMON_BIN}. Compilez : (cd ${SCRIPT_DIR}/rust-daemon && cargo build --release)" >&2
  exit 1
fi

echo "[*] Arrêt des anciens processus initiator (ports ${GRPC_PORT} stage 1, API ${API_PORT})…"
pkill -f "inference_server.py --port ${GRPC_PORT} --stage 1" 2>/dev/null || true
pkill -f "rust-daemon.*--mode initiator.*--api-port ${API_PORT}" 2>/dev/null || true
sleep 1
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${API_PORT}/tcp" 2>/dev/null || true
  fuser -k "${GRPC_PORT}/tcp" 2>/dev/null || true
fi
sleep 1

# shellcheck source=/dev/null
source "${VENV_PATH}/bin/activate"

export VRYX_SHARD_READY_POLL_SEC="${VRYX_SHARD_READY_POLL_SEC:-0.75}"
export VRYX_SHARD_READY_POLL_SLOW_SEC="${VRYX_SHARD_READY_POLL_SLOW_SEC:-5}"
export VRYX_PREFIX_CACHE="${VRYX_PREFIX_CACHE:-1}"
# Optionnel VPS (2+ workers Daisy Chain) si RAM et /var/tmp le permettent :
# export VRYX_PARALLEL_SHARD_INIT=1
# export VRYX_PARALLEL_SHARD_INIT_MAX=2

echo "[*] inference_server.py stage 1 sur ${GRPC_PORT} (logs: ${LOG_DIR}/initiator-inference.log)"
PYTHONUNBUFFERED=1 nohup python3 "${PYTHON_DIR}/inference_server.py" --port "${GRPC_PORT}" --stage 1 \
  >>"${LOG_DIR}/initiator-inference.log" 2>&1 &
INFERENCE_PID=$!

echo "[*] Attente gRPC ${GRPC_PORT}…"
for i in $(seq 1 45); do
  if python3 -c "
import socket, sys
s = socket.socket()
s.settimeout(1)
r = s.connect_ex(('127.0.0.1', int('${GRPC_PORT}')))
s.close()
sys.exit(0 if r == 0 else 1)
" 2>/dev/null; then
    echo "[OK] gRPC prêt"
    break
  fi
  if [ "${i}" -eq 45 ]; then
    echo "[ERREUR] Timeout gRPC. Voir ${LOG_DIR}/initiator-inference.log" >&2
    kill "${INFERENCE_PID}" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

P2P_EXTRA=()
if [ "${P2P_PORT}" != "0" ]; then
  P2P_EXTRA=(--p2p-port "${P2P_PORT}")
fi

echo "[*] rust-daemon initiator API ${API_PORT} (logs: ${LOG_DIR}/initiator-daemon.log)"
PYTHONUNBUFFERED=1 nohup "${DAEMON_BIN}" \
  --mode initiator \
  --grpc-port "${GRPC_PORT}" \
  "${P2P_EXTRA[@]}" \
  --bootstrap-node "${BOOTSTRAP}" \
  --api-port "${API_PORT}" \
  --api-url "${API_URL}" \
  --model "${MODEL_ID}" \
  >>"${LOG_DIR}/initiator-daemon.log" 2>&1 &
echo "[+] Lancé. Vérifier : curl -sS http://127.0.0.1:${API_PORT}/api/status (champ orchestrator_health si mode initiateur) ; curl -sS http://127.0.0.1:${API_PORT}/api/tp-peers"
