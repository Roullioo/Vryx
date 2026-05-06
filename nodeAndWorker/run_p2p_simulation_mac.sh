#!/usr/bin/env bash
# =============================================================================
# Simulation P2P locale (Mac) — bootstrap dédié (4001) + worker + initiateur (comme en prod).
# Usage : ./run_p2p_simulation_mac.sh ["votre prompt"]
# Prérequis : cargo build --release -p rust-daemon, venv python-inference/venv
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON="${SCRIPT_DIR}/target/release/rust-daemon"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"
if [ -x "${PYTHON_DIR}/venv/bin/python3" ]; then
  VENV_PATH="${PYTHON_DIR}/venv"
elif [ -x "${PYTHON_DIR}/.venv/bin/python3" ]; then
  VENV_PATH="${PYTHON_DIR}/.venv"
else
  VENV_PATH="${PYTHON_DIR}/venv"
fi
PROMPT="${1:-Réponds par une phrase courte de salutation en français.}"

SESSION_DIR="${SCRIPT_DIR}/logs/sim-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${SESSION_DIR}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log() { echo -e "$*" | tee -a "${SESSION_DIR}/console.txt"; }

CLEANED=0
cleanup() {
  [ "${CLEANED}" = "1" ] && return
  CLEANED=1
  log "\n${YELLOW}[arrêt] Fermeture des processus de simulation…${NC}"
  kill "${STAGE1_PID:-0}" "${STAGE2_PID:-0}" "${BOOT_PID:-0}" "${WORKER_PID:-0}" "${INIT_PID:-0}" 2>/dev/null || true
  sleep 1
  pkill -f "inference_server.py --port 50051" 2>/dev/null || true
  pkill -f "inference_server.py --port 50052" 2>/dev/null || true
  pkill -f "${DAEMON} --mode bootstrap --p2p-port 4001" 2>/dev/null || true
  pkill -f "${DAEMON} --mode worker --grpc-port 50052" 2>/dev/null || true
  pkill -f "${DAEMON} --mode initiator --grpc-port 50051" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

log "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
log "${CYAN}  Vryx — simulation P2P locale (bootstrap + worker + initiateur)${NC}"
log "${CYAN}  Dossier de session : ${SESSION_DIR}${NC}"
log "${CYAN}═══════════════════════════════════════════════════════════════${NC}"

if [ ! -f "${DAEMON}" ]; then
  log "${YELLOW}[*] Compilation du daemon Rust…${NC}"
  (cd "${SCRIPT_DIR}" && cargo build --release -p rust-daemon)
fi

if [ ! -x "${VENV_PATH}/bin/python3" ]; then
  log "${RED}[!] Venv manquant : ${VENV_PATH}${NC}"
  log "    python3 -m venv ${VENV_PATH} && source ${VENV_PATH}/bin/activate && pip install -r ${PYTHON_DIR}/requirements.txt"
  exit 1
fi

PY="${VENV_PATH}/bin/python3"

log "\n${GREEN}[1/7] Nettoyage ports gRPC, APIs libp2p (4001–4003, …)…${NC}"
for p in 50051 50052 3030 3031 3055 4001 4002 4003; do
  lsof -ti:"${p}" | xargs kill -9 2>/dev/null || true
done
sleep 1

log "${GREEN}[2/7] Démarrage Python gRPC stage 1 (50051) et stage 2 (50052)…${NC}"
# cwd = python-inference (imports vryx_pb2 relatif au dossier)
( cd "${PYTHON_DIR}" && exec env PYTHONUNBUFFERED=1 "${PY}" inference_server.py --port 50051 --stage 1 \
  >>"${SESSION_DIR}/python_stage1.log" 2>&1 ) &
STAGE1_PID=$!
( cd "${PYTHON_DIR}" && exec env PYTHONUNBUFFERED=1 "${PY}" inference_server.py --port 50052 --stage 2 \
  >>"${SESSION_DIR}/python_stage2.log" 2>&1 ) &
STAGE2_PID=$!

wait_port() {
  local port=$1 name=$2
  local i
  for i in $(seq 1 45); do
    if "${PY}" -c "import socket,sys; s=socket.socket(); s.settimeout(0.5); r=s.connect_ex(('127.0.0.1',${port})); s.close(); sys.exit(0 if r==0 else 1)" 2>/dev/null; then
      log "${GREEN}[OK] ${name} écoute sur le port ${port}${NC}"
      return 0
    fi
    sleep 1
  done
  log "${RED}[ERREUR] Timeout ${name} :${port}${NC}"
  exit 1
}

wait_port 50051 "gRPC stage 1"
wait_port 50052 "gRPC stage 2"

log "${GREEN}[3/7] Daemon Rust bootstrap seul (P2P 4001, sans gRPC)…${NC}"
( cd "${SCRIPT_DIR}" && exec "${DAEMON}" --mode bootstrap --p2p-port 4001 --api-port 3055 \
  >>"${SESSION_DIR}/rust_bootstrap.log" 2>&1 ) &
BOOT_PID=$!

BOOTSTRAP_PEER_ID=""
for _ in $(seq 1 30); do
  BOOTSTRAP_PEER_ID=$(grep 'PeerId' "${SESSION_DIR}/rust_bootstrap.log" | head -1 | sed -n 's/.*PeerId : \(.*\)/\1/p' | tr -d '\r' || true)
  if [ -n "${BOOTSTRAP_PEER_ID}" ]; then
    break
  fi
  sleep 1
done
if [ -z "${BOOTSTRAP_PEER_ID}" ]; then
  log "${RED}[ERREUR] PeerId bootstrap introuvable (rust_bootstrap.log).${NC}"
  exit 1
fi
BOOTSTRAP_MULTIADDR="/ip4/127.0.0.1/tcp/4001/p2p/${BOOTSTRAP_PEER_ID}"
echo "${BOOTSTRAP_MULTIADDR}" >"${SESSION_DIR}/bootstrap_multiaddr.txt"
log "${CYAN}    Multiaddr bootstrap : ${BOOTSTRAP_MULTIADDR}${NC}"

log "${GREEN}[4/7] Daemon Rust worker → bootstrap (P2P 4002, API 3031)…${NC}"
( cd "${SCRIPT_DIR}" && exec "${DAEMON}" --mode worker --grpc-port 50052 --p2p-port 4002 --api-port 3031 \
  --bootstrap-node "${BOOTSTRAP_MULTIADDR}" \
  >>"${SESSION_DIR}/rust_worker.log" 2>&1 ) &
WORKER_PID=$!
sleep 3

log "${GREEN}[5/7] Daemon Rust initiateur → bootstrap (P2P 4003, API 3030)…${NC}"
( cd "${SCRIPT_DIR}" && exec "${DAEMON}" --mode initiator --grpc-port 50051 --p2p-port 4003 --api-port 3030 \
  --bootstrap-node "${BOOTSTRAP_MULTIADDR}" \
  >>"${SESSION_DIR}/rust_initiator.log" 2>&1 ) &
INIT_PID=$!

log "${YELLOW}[6/7] Attente liaison P2P (statut initiateur, max 60 s)…${NC}"
LINKED=0
for _ in $(seq 1 60); do
  CONN=$(curl -sS -m 2 http://127.0.0.1:3030/api/status 2>/dev/null | "${PY}" -c "import sys,json; d=json.load(sys.stdin); print(d.get('active_connections',0))" 2>/dev/null || echo 0)
  if [ "${CONN:-0}" -ge 1 ] 2>/dev/null; then
    LINKED=1
    log "${GREEN}[OK] Connexions actives sur l’initiateur : ${CONN}${NC}"
    break
  fi
  sleep 1
done
if [ "${LINKED}" -eq 0 ]; then
  log "${YELLOW}[!] Toujours 0 connexion sur /api/status — chat peut échouer ; vérifiez rust_initiator.log${NC}"
fi

WORKER_PEER=$(grep -E "PeerId|Identification|P2P" "${SESSION_DIR}/rust_worker.log" 2>/dev/null | head -8 || true)
INIT_PEER=$(grep -E "PeerId|Identification|P2P|bootstrap" "${SESSION_DIR}/rust_initiator.log" 2>/dev/null | head -12 || true)
echo "${WORKER_PEER}" >"${SESSION_DIR}/peer_worker_snippet.txt"
echo "${INIT_PEER}" >"${SESSION_DIR}/peer_initiator_snippet.txt"

log "\n${CYAN}[7/7] Appel POST http://127.0.0.1:3030/api/chat${NC}"
printf '%s' "${PROMPT}" >"${SESSION_DIR}/prompt.txt"
# Échappement minimal JSON pour le prompt
PROMPT_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' <"${SESSION_DIR}/prompt.txt")
set +e
curl -sS -m 120 -X POST http://127.0.0.1:3030/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":${PROMPT_JSON}}" \
  | tee "${SESSION_DIR}/api_chat_response.json"
CURL_RC=$?
set -e
log "\n${YELLOW}(curl exit=${CURL_RC})${NC}"

sleep 3

log "\n${CYAN}── Statuts API ──${NC}"
curl -sS -m 5 http://127.0.0.1:3030/api/status | tee "${SESSION_DIR}/status_initiator.json" || true
log ""
curl -sS -m 5 http://127.0.0.1:3031/api/status | tee "${SESSION_DIR}/status_worker.json" || true
log ""
curl -sS -m 5 http://127.0.0.1:3055/api/status | tee "${SESSION_DIR}/status_bootstrap.json" || true

# Rapport Markdown
REPORT="${SESSION_DIR}/RAPPORT_SIMULATION.md"
{
  echo "# Rapport simulation P2P locale"
  echo ""
  echo "**Date** : $(date -Iseconds)"
  echo "**Bootstrap** : $(cat "${SESSION_DIR}/bootstrap_multiaddr.txt")"
  echo "**Prompt** : $(cat "${SESSION_DIR}/prompt.txt")"
  echo ""
  echo "## Réponse API (/api/chat)"
  echo '```json'
  cat "${SESSION_DIR}/api_chat_response.json"
  echo ''
  echo '```'
  echo ""
  echo "## Extraits PeerId (worker)"
  echo '```'
  cat "${SESSION_DIR}/peer_worker_snippet.txt"
  echo '```'
  echo ""
  echo "## Extraits PeerId (initiateur)"
  echo '```'
  cat "${SESSION_DIR}/peer_initiator_snippet.txt"
  echo '```'
  echo ""
  echo "## Fin du log bootstrap Rust (40 lignes)"
  echo '```'
  tail -40 "${SESSION_DIR}/rust_bootstrap.log"
  echo '```'
  echo ""
  echo "## Fin du log initiateur Rust (80 lignes)"
  echo '```'
  tail -80 "${SESSION_DIR}/rust_initiator.log"
  echo '```'
  echo ""
  echo "## Fin du log worker Rust (80 lignes)"
  echo '```'
  tail -80 "${SESSION_DIR}/rust_worker.log"
  echo '```'
  echo ""
  echo "## Fin Python stage 1 (40 lignes)"
  echo '```'
  tail -40 "${SESSION_DIR}/python_stage1.log"
  echo '```'
  echo ""
  echo "## Fin Python stage 2 (40 lignes)"
  echo '```'
  tail -40 "${SESSION_DIR}/python_stage2.log"
  echo '```'
  echo ""
  echo "## Interprétation rapide"
  echo ""
  echo "- **Bootstrap dédié (4001)** : l’initiateur ne doit pas utiliser le worker comme bootstrap, sinon le worker est exclu du sélecteur de chat côté Rust."
  echo "- **Réponse \`ok:true\` avec texte \`[vryx.shard] erreur\`** : la couche P2P et le hop worker ont bien fonctionné, mais le **runtime shard / tenseurs** sur le worker n’a pas de charge utile valide pour ce scénario (poids éphémères non chargés). C’est attendu pour une simulation courte sans modèle shard configuré."
  echo "- **Fichiers de statut** : \`status_bootstrap.json\` (port 3055), \`status_initiator.json\` (3030), \`status_worker.json\` (3031)."
} >"${REPORT}"

log "\n${GREEN}✓ Rapport écrit : ${REPORT}${NC}"
log "${GREEN}✓ Tous les journaux bruts sont dans : ${SESSION_DIR}${NC}"
