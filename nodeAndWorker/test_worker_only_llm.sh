#!/usr/bin/env bash
# Test E2E : mode VRYX_WORKER_ONLY_LLM (pas d'Ollama, chaîne P2P workers).
# Prérequis : venv python-inference avec requirements installés.
# Optionnel : VRYX_TEST_CURL_TIMEOUT (défaut 180) si premier pull HF très lent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON="${SCRIPT_DIR}/target/release/rust-daemon"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"
VENV_PATH="${PYTHON_DIR}/venv"
PROMPT="${1:-Bonjour, test worker-only.}"
LOG_DIR="${TMPDIR:-/tmp}/vryx_worker_only_$$"
mkdir -p "$LOG_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${CYAN}=== Test worker-only LLM (P2P, sans Ollama stage 1) ===${NC}"

if [ ! -d "${VENV_PATH}/bin" ]; then
  echo -e "${RED}Venv manquant : ${VENV_PATH}${NC}"
  exit 1
fi
source "${VENV_PATH}/bin/activate"

if [ ! -f "${DAEMON}" ]; then
  echo "[*] cargo build --release …"
  (cd "${SCRIPT_DIR}" && cargo build --release -p rust-daemon)
fi

pkill -f "shard_serve_local.py" 2>/dev/null || true
pkill -f "inference_server.py.*50051" 2>/dev/null || true
pkill -f "inference_server.py.*50052" 2>/dev/null || true
pkill -f "rust-daemon.*--api-port 3030" 2>/dev/null || true
pkill -f "rust-daemon.*--api-port 3031" 2>/dev/null || true
sleep 1

PY="${VENV_PATH}/bin/python"
SHARD_SERVE_PORT="${VRYX_SHARD_SERVE_PORT:-18765}"
export VRYX_SHARD_BASE_DIR="${LOG_DIR}/shards"
mkdir -p "${VRYX_SHARD_BASE_DIR}"
export VRYX_SHARD_SERVE_PORT="${SHARD_SERVE_PORT}"
export VRYX_SHARD_DOWNLOAD_BASE_URL="http://127.0.0.1:${SHARD_SERVE_PORT}"
PYTHONUNBUFFERED=1 "${PY}" "${SCRIPT_DIR}/scripts/shard_serve_local.py" \
  >"${LOG_DIR}/shard-serve.log" 2>&1 &
SHARD_SERVE_PID=$!
sleep 0.5

export VRYX_DIST_MODEL="${VRYX_DIST_MODEL:-Qwen/Qwen2-0.5B-Instruct}"
export VRYX_PIPELINE_CHAIN_MODE="${VRYX_PIPELINE_CHAIN_MODE:-initiator_sequential}"

"${PY}" "${PYTHON_DIR}/inference_server.py" --port 50052 --stage 2 --model "${VRYX_DIST_MODEL}" \
  >"${LOG_DIR}/stage2.log" 2>&1 &
STAGE2_PID=$!

"${DAEMON}" --mode worker --grpc-port 50052 --p2p-port 4002 --api-port 3031 \
  >"${LOG_DIR}/worker_daemon.log" 2>&1 &
WORKER_PID=$!

echo "[*] Attente PeerId worker…"
WORKER_PEER=""
for _ in $(seq 1 40); do
  WORKER_PEER=$(grep -E "PeerId|Local peer id|local_peer_id" "${LOG_DIR}/worker_daemon.log" 2>/dev/null | head -1 | grep -oE '12D3Koo[a-zA-Z0-9]+' | head -1 || true)
  if [ -n "${WORKER_PEER}" ]; then break; fi
  sleep 0.5
done
if [ -z "${WORKER_PEER}" ]; then
  WORKER_PEER=$(grep -oE '12D3Koo[a-zA-Z0-9]+' "${LOG_DIR}/worker_daemon.log" 2>/dev/null | head -1 || true)
fi
if [ -z "${WORKER_PEER}" ]; then
  echo -e "${RED}Impossible de lire le PeerId worker. Log :${NC}"
  tail -40 "${LOG_DIR}/worker_daemon.log"
  kill "${STAGE2_PID}" "${WORKER_PID}" "${SHARD_SERVE_PID}" 2>/dev/null || true
  exit 1
fi
echo -e "${GREEN}Worker PeerId: ${WORKER_PEER}${NC}"

export VRYX_WORKER_ONLY_LLM=1
export VRYX_P2P_RELAY_URL="http://127.0.0.1:3030"
export VRYX_DIST_PEER_IDS="${WORKER_PEER}"
export VRYX_TP_PEER_IDS="${WORKER_PEER}"
export VRYX_DIST_MAX_NEW_TOKENS="${VRYX_DIST_MAX_NEW_TOKENS:-4}"

"${PY}" "${PYTHON_DIR}/inference_server.py" --port 50051 --stage 1 \
  >"${LOG_DIR}/stage1.log" 2>&1 &
STAGE1_PID=$!

wait_51() {
  for _ in $(seq 1 30); do
    "${PY}" -c "import socket;s=socket.socket();s.settimeout(0.5);import sys;r=s.connect_ex(('127.0.0.1',50051));s.close();sys.exit(0 if r==0 else 1)" && return 0
    sleep 0.3
  done
  return 1
}
wait_51 || { echo "Timeout gRPC 50051"; exit 1; }

"${DAEMON}" --mode initiator --grpc-port 50051 --p2p-port 4003 --api-port 3030 \
  >"${LOG_DIR}/initiator_daemon.log" 2>&1 &
INIT_PID=$!

echo "[*] Attente connexion P2P initiator ↔ worker (jusqu'à ~30 s, vérification toutes les 0,5 s)…"
CONNECTED=""
for _ in $(seq 1 60); do
  if grep -q "Connexion établie avec ${WORKER_PEER}" "${LOG_DIR}/initiator_daemon.log" 2>/dev/null; then
    CONNECTED=1
    break
  fi
  if grep -q "Connexion établie avec ${WORKER_PEER}" "${LOG_DIR}/worker_daemon.log" 2>/dev/null; then
    CONNECTED=1
    break
  fi
  sleep 0.5
done
if [ -z "${CONNECTED}" ]; then
  echo -e "${YELLOW}[!] Pas de ligne 'Connexion établie avec ${WORKER_PEER}' — on tente quand même le chat.${NC}"
  tail -25 "${LOG_DIR}/initiator_daemon.log"
fi
sleep 0.75

CURL_MAX="${VRYX_TEST_CURL_TIMEOUT:-180}"

cleanup() {
  kill "${STAGE1_PID}" "${STAGE2_PID}" "${WORKER_PID}" "${INIT_PID}" "${SHARD_SERVE_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo -e "${YELLOW}POST /api/chat (initiator 3030)…${NC}"
RESP=$(curl -sS -m "${CURL_MAX}" -X POST "http://127.0.0.1:3030/api/chat" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'prompt': sys.argv[1]}))" "${PROMPT}")")

echo "$RESP" | python3 -m json.tool >"${LOG_DIR}/chat_response.json" || echo "$RESP" >"${LOG_DIR}/chat_response.raw"

if echo "$RESP" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  echo -e "${GREEN}Réponse API : ok true${NC}"
else
  echo -e "${RED}Réponse API sans ok true${NC}"
  cat "${LOG_DIR}/chat_response.json" 2>/dev/null || echo "$RESP"
  exit 1
fi

if echo "$RESP" | grep -q "délégation VPS manquante"; then
  echo -e "${RED}ÉCHEC : le chemin stage2 délégué a été utilisé au lieu du worker-only court-circuité.${NC}"
  exit 1
fi

if echo "$RESP" | grep -q "worker_only_pipeline\|worker-only"; then
  echo -e "${GREEN}Trace ou texte worker-only détecté.${NC}"
fi

if ! echo "$RESP" | grep -q '"p2p_messages_out":0'; then
  echo -e "${YELLOW}[!] Attendu p2p_messages_out=0 après court-circuit worker-only.${NC}"
fi

echo -e "\n${CYAN}--- Extrait stage1 (orchestrateur) ---${NC}"
grep -E "worker-only|Worker-only|Requête|Réponse" "${LOG_DIR}/stage1.log" | tail -15 || tail -15 "${LOG_DIR}/stage1.log"

echo -e "\n${CYAN}--- Extrait worker gRPC ---${NC}"
grep -E "vryx\.dist|Shard dtype" "${LOG_DIR}/stage2.log" | tail -20 || tail -20 "${LOG_DIR}/stage2.log"

echo -e "\n${GREEN}Logs complets dans : ${LOG_DIR}${NC}"
echo "${LOG_DIR}" > /tmp/vryx_worker_only_last_logdir.txt
