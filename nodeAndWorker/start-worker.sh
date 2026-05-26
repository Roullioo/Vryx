#!/bin/bash

# Vryx Worker Startup Script (macOS Edition)
# Usage: ./start-worker.sh --model "google/gemma-2-2b-it"

# Aligné sur le stage1 prod (VPS) : Qwen3.5-9B + port P2P annoncé dans les heartbeats.
MODEL_ID="${VRYX_WORKER_MODEL:-${VRYX_MODEL_ID:-Qwen/Qwen3.5-9B}}"
GRPC_PORT=50052
API_PORT=3031
P2P_PORT=4021
BOOTSTRAP_NODE="/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz"
API_URL="https://vryx.eu"

USER_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --model) MODEL_ID="$2"; shift 2 ;;
    --port|--grpc-port) GRPC_PORT="$2"; shift 2 ;;
    --api-port) API_PORT="$2"; shift 2 ;;
    --p2p-port) P2P_PORT="$2"; shift 2 ;;
    --bootstrap-node) BOOTSTRAP_NODE="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --user-id) USER_ID="$2"; shift 2 ;;
    --node-key-file) NODE_KEY_FILE_OVERRIDE="$2"; shift 2 ;;
    --mode) shift 2 ;;
    *) shift ;;
  esac
done

if [ -n "${TERM:-}" ] && [ "${TERM}" != "dumb" ] && [ -t 1 ] && command -v clear >/dev/null 2>&1; then
    clear
fi
echo "  +------------------------------------------+"
echo "  |         Vryx Worker Launcher             |"
echo "  |            (macOS Edition)               |"
echo "  +------------------------------------------+"
echo ""
echo "[*] Modèle : ${MODEL_ID}  |  gRPC : ${GRPC_PORT}  |  P2P TCP/QUIC : ${P2P_PORT}  |  API locale : ${API_PORT}"
if [ "${VRYX_WORKER_SHARD_ONLY:-0}" = "1" ] && [ -z "${VRYX_RUNTIME_BACKEND:-}" ]; then
    export VRYX_RUNTIME_BACKEND="mlx"
fi
if [ "${VRYX_WORKER_SHARD_ONLY:-0}" = "1" ] && [ "${VRYX_RUNTIME_BACKEND:-}" = "mlx" ]; then
    export VRYX_ENABLE_MLX_RUNTIME="${VRYX_ENABLE_MLX_RUNTIME:-1}"
    export VRYX_MLX_PREFETCH_SHARD_WEIGHTS="${VRYX_MLX_PREFETCH_SHARD_WEIGHTS:-1}"
    export VRYX_MLX_PREFETCH_ON_BUILD="${VRYX_MLX_PREFETCH_ON_BUILD:-1}"
    export VRYX_MLX_LOCAL_GGUF_CACHE="${VRYX_MLX_LOCAL_GGUF_CACHE:-1}"
    export VRYX_GGUF_LOCAL_CACHE_DIR="${VRYX_GGUF_LOCAL_CACHE_DIR:-${VRYX_WORKER_SHARD_CACHE_DIR:-${HOME}/.cache/vryx/shards}/gguf-cache}"
    if [ -z "${VRYX_GGUF_LOCAL_SOURCE_PATH:-}" ] && [ -n "${VRYX_MODEL_CACHE_DIR:-}" ] && [ -f "${VRYX_MODEL_CACHE_DIR}/gguf/qwen36-35b-iq4-xs.gguf" ]; then
        export VRYX_GGUF_LOCAL_SOURCE_PATH="${VRYX_MODEL_CACHE_DIR}/gguf/qwen36-35b-iq4-xs.gguf"
    fi
    case "$(printf '%s' "$MODEL_ID" | tr '[:upper:]' '[:lower:]')" in
        *llama*70b*)
            export VRYX_ENABLE_LLAMA_MLX_SHARD="${VRYX_ENABLE_LLAMA_MLX_SHARD:-1}"
            export VRYX_DISABLE_PYTORCH_FALLBACK="${VRYX_DISABLE_PYTORCH_FALLBACK:-1}"
            ;;
    esac
fi
echo "[*] Mémoire worker : ${VRYX_WORKER_MEMORY_LIMIT_GB:-auto} Go (${VRYX_WORKER_MEMORY_LIMIT_PERCENT:-auto}%)  |  backend : ${VRYX_RUNTIME_BACKEND:-mlx_lm}  |  cache : ${VRYX_MODEL_CACHE_DIR:-défaut}"
if [ "${VRYX_WORKER_LOAD_MODE:-}" = "full" ]; then
    echo "[*] Mode full local actif : le worker charge le modèle complet si la mémoire allouée le permet."
elif [ "${VRYX_WORKER_SHARD_ONLY:-0}" = "1" ]; then
    echo "[*] Mode shard-only actif : aucun téléchargement/chargement direct du modèle complet."
fi
echo ""

LOCK_DIR="/tmp/vryx-worker-${GRPC_PORT}-${API_PORT}-${P2P_PORT}.lock"
LOCK_WAIT_SEC="${VRYX_WORKER_LOCK_WAIT_SEC:-20}"
acquire_worker_lock() {
    local waited=0
    while ! mkdir "$LOCK_DIR" 2>/dev/null; do
        local owner=""
        [ -f "$LOCK_DIR/pid" ] && owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
        if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
            rm -rf "$LOCK_DIR" 2>/dev/null || true
            continue
        fi
        if [ "$waited" -ge "$LOCK_WAIT_SEC" ]; then
            echo "[!] Un lancement worker est déjà en cours sur ces ports (lock: ${LOCK_DIR})."
            echo "    PID détenteur : ${owner:-inconnu}. Relance ignorée pour éviter deux serveurs sur le même gRPC."
            exit 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    echo "$$" > "$LOCK_DIR/pid"
}

cleanup_children() {
    echo "[*] Arrêt des sous-processus worker..."
    if [ -n "${INFERENCE_PID:-}" ]; then
        kill "$INFERENCE_PID" 2>/dev/null || true
        wait "$INFERENCE_PID" 2>/dev/null || true
    fi
    if [ -n "${RUST_PID:-}" ]; then
        kill "$RUST_PID" 2>/dev/null || true
        wait "$RUST_PID" 2>/dev/null || true
    fi
    rm -rf "$LOCK_DIR" 2>/dev/null || true
}

kill_port() {
    local port="$1"
    for _ in 1 2 3 4 5; do
        local pids
        pids="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
        if [ -z "$pids" ]; then
            return 0
        fi
        kill -9 $pids 2>/dev/null || true
        sleep 0.2
    done
    lsof -tiTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 && return 1
    return 0
}

# 0. Nettoyage des processus fantômes
acquire_worker_lock
echo "[*] Nettoyage des anciens processus Vryx sur ports ${GRPC_PORT}, ${API_PORT} et ${P2P_PORT}..."
if ! kill_port "$GRPC_PORT" || ! kill_port "$API_PORT" || ! kill_port "$P2P_PORT"; then
    echo "[!] Impossible de libérer les ports requis. Vérifiez les processus Vryx actifs."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"
VENV_PATH="${PYTHON_DIR}/venv"

if [ ! -d "$VENV_PATH" ]; then
    echo "[*] Création de l'environnement virtuel Python..."
    python3 -m venv "$VENV_PATH"
    source "$VENV_PATH/bin/activate"
    python3 -m pip install --upgrade pip > /dev/null 2>&1
    pip install -r "${PYTHON_DIR}/requirements.txt"
else
    source "$VENV_PATH/bin/activate"
fi
python3 - <<'PY' >/dev/null 2>&1 || pip install -r "${PYTHON_DIR}/requirements.txt"
import gguf, numpy
PY

echo "[+] Environnement Python prêt."

# 2. Serveur gRPC worker : segments de pipeline P2P natifs (routing_path / Daisy Chain), sans Web2.
echo "[*] Lancement du serveur gRPC d'inférence (stage 2, P2P natif)..."
PYTHONUNBUFFERED=1 python3 "${PYTHON_DIR}/inference_server.py" \
    --port "$GRPC_PORT" \
    --stage 2 \
    --model "$MODEL_ID" &
INFERENCE_PID=$!
trap "cleanup_children; exit" INT TERM EXIT

# 3. Lancement du Daemon Rust (P2P)
cd "${SCRIPT_DIR}/rust-daemon"
DAEMON_BIN="../target/release/rust-daemon"
if [ -x "../bin/darwin-arm64/rust-daemon" ]; then
    DAEMON_BIN="../bin/darwin-arm64/rust-daemon"
fi
if [ ! -f "${DAEMON_BIN}" ]; then
    echo "[!] Daemon binaire non trouvé. Compilation..."
    cargo build --release
    DAEMON_BIN="../target/release/rust-daemon"
fi

mkdir -p "${SCRIPT_DIR}/.vryx-keys"
NODE_KEY_FILE="${NODE_KEY_FILE_OVERRIDE:-${VRYX_NODE_KEY_FILE:-${SCRIPT_DIR}/.vryx-keys/worker.node.key}}"

# QUIC + relais persistant : meilleure traversée NAT vers le bootstrap VPS.
# Le chemin prod Qwen3.5 passe par mlx-lm officiel direct ; l'annoncer dans le heartbeat
# évite que le scheduler classe le worker Mac dans le pool PyTorch lent.
VRYX_RUNTIME_BACKEND="${VRYX_RUNTIME_BACKEND:-mlx_lm}" \
VRYX_SUPPORTS_MLX="${VRYX_SUPPORTS_MLX:-1}" \
VRYX_SUPPORTS_Q4_WEIGHTS="${VRYX_SUPPORTS_Q4_WEIGHTS:-1}" \
VRYX_LLAMA_CPP_KEEP_ALIVE="${VRYX_LLAMA_CPP_KEEP_ALIVE:-24h}" \
VRYX_LLAMA_CPP_PREWARM="${VRYX_LLAMA_CPP_PREWARM:-1}" \
VRYX_LLAMA_CPP_NUM_CTX="${VRYX_LLAMA_CPP_NUM_CTX:-4096}" \
VRYX_LLAMA_CPP_NUM_BATCH="${VRYX_LLAMA_CPP_NUM_BATCH:-1024}" \
VRYX_HIDDEN_QUIC=1 VRYX_PERSISTENT_RELAY=1 \
"${DAEMON_BIN}" \
    --mode worker \
    --grpc-port "$GRPC_PORT" \
    --p2p-port "$P2P_PORT" \
    --api-port "$API_PORT" \
    --bootstrap-node "$BOOTSTRAP_NODE" \
    --api-url "$API_URL" \
    --model "$MODEL_ID" \
    --node-key-file "$NODE_KEY_FILE" \
    ${USER_ID:+--user-id "$USER_ID"} > >(tee -a "${SCRIPT_DIR}/worker_daemon.log") 2>&1 &
RUST_PID=$!

echo ""
echo "[SUCCESS] Worker Vryx macOS est maintenant en ligne !"
echo "          ID Processus : Inférence ($INFERENCE_PID) | P2P ($RUST_PID)"
echo "          Suivez l'activité sur : https://vryx.eu/admin"
echo ""
echo "          Appuyez sur Ctrl+C pour arrêter le nœud."

wait "$RUST_PID"
RUST_CODE=$?
echo "[!] Daemon Rust arrêté avec code ${RUST_CODE}; arrêt du serveur d'inférence."
exit "$RUST_CODE"
