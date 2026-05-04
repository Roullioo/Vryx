#!/usr/bin/env bash
# =============================================================
#  test_local_p2p.sh — Test E2E complet du pipeline P2P en local
#  Lance 2 workers + 1 initiator sur la même machine via mDNS.
#
#  Usage: ./test_local_p2p.sh [prompt]
#  Exemple: ./test_local_p2p.sh "What is the capital of France?"
# =============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON="${SCRIPT_DIR}/target/release/rust-daemon"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"
VENV_PATH="${PYTHON_DIR}/venv"
PROMPT="${1:-What is 2 plus 2? Answer briefly.}"

# Couleurs
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "\n${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Vryx P2P AI — Test Local (2 Workers)  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}\n"

# ── Vérifications ──────────────────────────────────────────────
if [ ! -f "${DAEMON}" ]; then
    echo -e "${YELLOW}[*] Compilation du daemon Rust...${NC}"
    cd "${SCRIPT_DIR}" && cargo build --release -p rust-daemon
fi

if [ ! -d "${VENV_PATH}/bin" ]; then
    echo -e "${YELLOW}[!] Venv Python manquant. Créez-le avec:${NC}"
    echo "    python3 -m venv ${VENV_PATH}"
    echo "    source ${VENV_PATH}/bin/activate && pip install -r ${PYTHON_DIR}/requirements.txt"
    exit 1
fi

source "${VENV_PATH}/bin/activate"

# ── Nettoyage des anciens processus ───────────────────────────
echo "[*] Nettoyage des anciens processus..."
pkill -f "inference_server.py" 2>/dev/null || true
pkill -f "rust-daemon" 2>/dev/null || true
sleep 1

# ── Démarrage des serveurs gRPC ────────────────────────────────
echo -e "${GREEN}[1/4] Démarrage inference stage 1 (port 50051)...${NC}"
python3 "${PYTHON_DIR}/inference_server.py" --port 50051 --stage 1 \
    > /tmp/vryx_stage1.log 2>&1 &
STAGE1_PID=$!

echo -e "${GREEN}[2/4] Démarrage inference stage 2 (port 50052)...${NC}"
python3 "${PYTHON_DIR}/inference_server.py" --port 50052 --stage 2 \
    > /tmp/vryx_stage2.log 2>&1 &
STAGE2_PID=$!

# ── Attente des ports gRPC ─────────────────────────────────────
wait_port() {
    local port=$1 label=$2
    for i in $(seq 1 60); do
        python3 -c "import socket,sys; s=socket.socket(); s.settimeout(1); r=s.connect_ex(('127.0.0.1',${port})); s.close(); sys.exit(0 if r==0 else 1)" 2>/dev/null \
            && echo -e "${GREEN}[OK] ${label} prêt sur :${port} (${i}x2s)${NC}" && return 0
        echo -n "."
        sleep 2
    done
    echo -e "\n${RED}[ERREUR] Timeout sur :${port}${NC}"
    exit 1
}

wait_port 50051 "Stage 1"
wait_port 50052 "Stage 2"

# ── Démarrage des daemons P2P ──────────────────────────────────
echo -e "\n${GREEN}[3/4] Démarrage daemon P2P Worker (port 4002, api 3031)...${NC}"
"${DAEMON}" --mode worker --grpc-port 50052 --p2p-port 4002 --api-port 3031 \
    > /tmp/vryx_worker_daemon.log 2>&1 &
WORKER_PID=$!
sleep 2

echo -e "${GREEN}[4/4] Démarrage daemon P2P Initiator (port 4003, api 3030)...${NC}"
"${DAEMON}" --mode initiator --grpc-port 50051 --p2p-port 4003 --api-port 3030 \
    > /tmp/vryx_initiator_daemon.log 2>&1 &
INIT_PID=$!

# ── Attente de la découverte mDNS ─────────────────────────────
echo "[*] Attente de la découverte mDNS (max 15s)..."
for i in $(seq 1 15); do
    grep -q "mDNS découvert\|worker découvert\|Kad découvert" /tmp/vryx_initiator_daemon.log 2>/dev/null \
        && echo -e "${GREEN}[OK] Worker découvert via mDNS!${NC}" && break
    echo -n "."
    sleep 1
done
echo ""

# Afficher les PeerIDs
WORKER_PEER=$(grep "PeerId :" /tmp/vryx_worker_daemon.log 2>/dev/null | head -1 | awk '{print $NF}')
INIT_PEER=$(grep "PeerId :" /tmp/vryx_initiator_daemon.log 2>/dev/null | head -1 | awk '{print $NF}')
echo -e "${CYAN}Worker  PeerId: ${WORKER_PEER}${NC}"
echo -e "${CYAN}Initiat PeerId: ${INIT_PEER}${NC}"

# ── Test de l'inférence ────────────────────────────────────────
echo -e "\n${YELLOW}╔══════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║  Envoi du prompt via API P2P...          ║${NC}"
echo -e "${YELLOW}║  Prompt: \"${PROMPT:0:38}\"${NC}"
echo -e "${YELLOW}╚══════════════════════════════════════════╝${NC}"

sleep 1
RESP=$(curl -s -X POST http://127.0.0.1:3030/api/chat \
    -H "Content-Type: application/json" \
    -d "{\"prompt\": \"${PROMPT}\"}")
echo "API response: ${RESP}"

echo -e "\n${CYAN}[*] Génération en cours (15s max)...${NC}"
sleep 15

echo -e "\n${GREEN}═══ Tokens générés (log initiator) ═══${NC}"
# Extract just the tokens printed by the initiator
grep "Réponse P2P" /tmp/vryx_initiator_daemon.log | \
    grep -oP '\(\K[0-9]+(?= bytes)' | head -3 || true
tail -30 /tmp/vryx_initiator_daemon.log | grep -v "Réponse\|Requête\|gRPC\|Pair\|écoute" || true

echo -e "\n${GREEN}═══ Worker stats ═══${NC}"
echo "Requêtes traitées: $(grep -c 'gRPC local OK' /tmp/vryx_worker_daemon.log 2>/dev/null || echo 0)"

# ── Statut API ─────────────────────────────────────────────────
echo -e "\n${CYAN}═══ Status API ═══${NC}"
curl -s http://127.0.0.1:3030/api/status | python3 -m json.tool 2>/dev/null || true
curl -s http://127.0.0.1:3031/api/status | python3 -m json.tool 2>/dev/null || true

# ── Cleanup ────────────────────────────────────────────────────
cleanup() {
    echo -e "\n${YELLOW}[*] Arrêt de tous les processus...${NC}"
    kill "${STAGE1_PID}" "${STAGE2_PID}" "${WORKER_PID}" "${INIT_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo -e "\n${GREEN}✓ Test terminé. Appuyez sur Ctrl+C pour arrêter.${NC}"
wait
