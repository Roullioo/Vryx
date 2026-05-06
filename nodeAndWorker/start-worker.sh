#!/bin/bash

# Vryx Worker Startup Script (macOS Edition)
# Usage: ./start-worker.sh --model "google/gemma-2-2b-it"

MODEL_ID="unsloth/gemma-2-9b-it"
GRPC_PORT=50052
API_PORT=3031
BOOTSTRAP_NODE="/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz"
API_URL="https://vryx.eu"

USER_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --model) MODEL_ID="$2"; shift 2 ;;
    --port|--grpc-port) GRPC_PORT="$2"; shift 2 ;;
    --api-port) API_PORT="$2"; shift 2 ;;
    --bootstrap-node) BOOTSTRAP_NODE="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --user-id) USER_ID="$2"; shift 2 ;;
    --mode) shift 2 ;;
    *) shift ;;
  esac
done

clear
echo "  +------------------------------------------+"
echo "  |         Vryx Worker Launcher             |"
echo "  |            (macOS Edition)               |"
echo "  +------------------------------------------+"
echo ""

# 0. Nettoyage des processus fantômes
echo "[*] Nettoyage des anciens processus Vryx sur ports ${GRPC_PORT} et ${API_PORT}..."
lsof -ti:${GRPC_PORT} | xargs kill -9 2>/dev/null
lsof -ti:${API_PORT} | xargs kill -9 2>/dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"
VENV_PATH="${PYTHON_DIR}/venv"

if [ ! -d "$VENV_PATH" ]; then
    echo "[*] Création de l'environnement virtuel Python..."
    python3 -m venv "$VENV_PATH"
    source "$VENV_PATH/bin/activate"
    pip install grpcio grpcio-tools > /dev/null 2>&1
else
    source "$VENV_PATH/bin/activate"
fi

echo "[+] Environnement Python prêt."

# 2. Serveur gRPC worker : segments de pipeline P2P natifs (routing_path / Daisy Chain), sans Web2.
echo "[*] Lancement du serveur gRPC d'inférence (stage 2, P2P natif)..."
PYTHONUNBUFFERED=1 python3 "${PYTHON_DIR}/inference_server.py" \
    --port "$GRPC_PORT" \
    --stage 2 \
    --model "$MODEL_ID" &
INFERENCE_PID=$!

# 3. Lancement du Daemon Rust (P2P)
cd "${SCRIPT_DIR}/rust-daemon"
DAEMON_BIN="../target/release/rust-daemon"
if [ ! -f "${DAEMON_BIN}" ]; then
    echo "[!] Daemon binaire non trouvé. Compilation..."
    cargo build --release
fi

"${DAEMON_BIN}" \
    --mode worker \
    --grpc-port "$GRPC_PORT" \
    --api-port "$API_PORT" \
    --bootstrap-node "$BOOTSTRAP_NODE" \
    --api-url "$API_URL" \
    --model "$MODEL_ID" \
    ${USER_ID:+--user-id "$USER_ID"} > >(tee -a "${SCRIPT_DIR}/worker_daemon.log") 2>&1 &
RUST_PID=$!

echo ""
echo "[SUCCESS] Worker Vryx macOS est maintenant en ligne !"
echo "          ID Processus : Inférence ($INFERENCE_PID) | P2P ($RUST_PID)"
echo "          Suivez l'activité sur : https://vryx.eu/admin"
echo ""
echo "          Appuyez sur Ctrl+C pour arrêter le nœud."

# Capture de l'arrêt pour tuer les sous-processus
trap "echo '[*] Arrêt en cours...'; kill $INFERENCE_PID $RUST_PID; exit" INT TERM

wait
