#!/usr/bin/env bash
# ==============================================================
#  Vryx Initiator (Chat) -- inference stage 1 + daemon initiator
#
#  Usage :
#    ./start-initiator.sh          # port P2P aleatoire
#    ./start-initiator.sh 4003     # port P2P fixe
#
#  Pre-requis : un worker doit etre connecte au bootstrap
#  (lancez start-worker.sh dans un autre terminal).
# ==============================================================
set -euo pipefail

BOOTSTRAP="/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz"
GRPC_PORT=50051
P2P_PORT="${1:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"

export VRYX_DIST_TIMEOUT_SEC="${VRYX_DIST_TIMEOUT_SEC:-600}"
export VRYX_PIPELINE_STEP_TIMEOUT_SEC="${VRYX_PIPELINE_STEP_TIMEOUT_SEC:-600}"
export VRYX_P2P_REQUEST_TIMEOUT_S="${VRYX_P2P_REQUEST_TIMEOUT_S:-3600}"
export VRYX_P2P_IDLE_TIMEOUT_S="${VRYX_P2P_IDLE_TIMEOUT_S:-900}"
# Chaîne W1→W2 directe dans le même profil Daisy (moins de sauts WAN sur l’initiateur).
export VRYX_PIPELINE_CHAIN_MODE="${VRYX_PIPELINE_CHAIN_MODE:-initiator_sequential}"
export VRYX_PERSISTENT_RELAY="${VRYX_PERSISTENT_RELAY:-1}"
export VRYX_HIDDEN_TRANSPORT="${VRYX_HIDDEN_TRANSPORT:-int8}"
export VRYX_WORKER_KV_CACHE="${VRYX_WORKER_KV_CACHE:-true}"
export VRYX_HIDDEN_QUIC="${VRYX_HIDDEN_QUIC:-1}"
export VRYX_PREFIX_CACHE="${VRYX_PREFIX_CACHE:-1}"
# Réduction latence « shard ready » (orchestrateur) ; ancien comportement équivalent ~2 s :
export VRYX_SHARD_READY_POLL_SEC="${VRYX_SHARD_READY_POLL_SEC:-0.75}"
export VRYX_SHARD_READY_POLL_SLOW_SEC="${VRYX_SHARD_READY_POLL_SLOW_SEC:-5}"
# VPS multi-workers : peut augmenter RAM/I/O si activé :
# export VRYX_PARALLEL_SHARD_INIT=1
# export VRYX_PARALLEL_SHARD_INIT_MAX=2

echo ""
echo "  +------------------------------------------+"
echo "  |        Vryx Initiator (Chat)             |"
echo "  +------------------------------------------+"
echo ""

# ---- Venv Python -----------------------------------------------
VENV_PATH=""
if [ -d "${PYTHON_DIR}/.venv" ]; then
    VENV_PATH="${PYTHON_DIR}/.venv"
elif [ -d "${PYTHON_DIR}/venv" ]; then
    VENV_PATH="${PYTHON_DIR}/venv"
fi

if [ -z "${VENV_PATH}" ]; then
    echo "[setup] Creation du venv Python..."
    python3 -m venv "${PYTHON_DIR}/.venv"
    VENV_PATH="${PYTHON_DIR}/.venv"
    source "${VENV_PATH}/bin/activate"
    echo "[setup] Installation des dependances Python..."
    pip install -q -r "${PYTHON_DIR}/requirements.txt"
else
    source "${VENV_PATH}/bin/activate"
fi

echo "[*] Python venv actif : ${VENV_PATH}"

# ---- Inference server stage 1 ----------------------------------
echo "[*] Demarrage inference server stage 1 sur port ${GRPC_PORT}..."
python3 "${PYTHON_DIR}/inference_server.py" --port "${GRPC_PORT}" --stage 1 &
INFERENCE_PID=$!
echo "    -> PID ${INFERENCE_PID}"

echo "[*] Attente du serveur gRPC (chargement modele GPT-2, env. 10-30 s)..."
for i in $(seq 1 30); do
    if python3 -c "
import socket, sys
s = socket.socket()
s.settimeout(1)
r = s.connect_ex(('127.0.0.1', ${GRPC_PORT}))
s.close()
sys.exit(0 if r == 0 else 1)
" 2>/dev/null; then
        echo "[OK] gRPC pret sur port ${GRPC_PORT}"
        break
    fi
    if [ "${i}" -eq 30 ]; then
        echo "[ERREUR] Timeout gRPC."
        kill "${INFERENCE_PID}" 2>/dev/null || true
        exit 1
    fi
    sleep 2
done

# ---- Build Rust ------------------------------------------------
# Tentative de trouver protoc dans le venv (fourni par torch)
if [ -z "${PROTOC:-}" ]; then
    for PYVER_DIR in "${VENV_PATH}/lib"/python*/site-packages/torch/bin; do
        POTENTIAL_PROTOC="${PYVER_DIR}/protoc"
        if [ -f "${POTENTIAL_PROTOC}" ]; then
            export PROTOC="${POTENTIAL_PROTOC}"
            echo "[*] Utilisation de protoc : ${PROTOC}"
            break
        fi
    done
fi

if [ ! -f "${SCRIPT_DIR}/target/release/rust-daemon" ] \
    || [ "${SCRIPT_DIR}/rust-daemon/src/main.rs" -nt "${SCRIPT_DIR}/target/release/rust-daemon" ] \
    || [ "${SCRIPT_DIR}/rust-daemon/Cargo.toml" -nt "${SCRIPT_DIR}/target/release/rust-daemon" ]; then
    echo "[*] Compilation du daemon Rust..."
    (cd "${SCRIPT_DIR}/rust-daemon" && CARGO_TARGET_DIR=/tmp/vryx-rust-target CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 cargo build --release --locked --message-format short)
    mkdir -p "${SCRIPT_DIR}/target/release"
    cp /tmp/vryx-rust-target/release/rust-daemon "${SCRIPT_DIR}/target/release/rust-daemon"
else
    echo "[*] Daemon Rust deja compile, passage au demarrage..."
fi
DAEMON_BIN="${SCRIPT_DIR}/target/release/rust-daemon"

P2P_ARG=""
if [ "${P2P_PORT}" != "0" ]; then
    P2P_ARG="--p2p-port ${P2P_PORT}"
fi

echo ""
echo "[*] Demarrage du daemon Vryx en mode initiator"
echo "    bootstrap : ${BOOTSTRAP}"
echo "    gRPC port : ${GRPC_PORT} (stage 1)"
echo ""
echo "  Attendez le message [P2P] Vryx worker decouvert puis tapez votre message."
echo ""

cleanup() {
    echo ""
    echo "[*] Arret des processus..."
    kill "${INFERENCE_PID}" 2>/dev/null || true
    exit 0
}
trap cleanup INT TERM

"${DAEMON_BIN}" \
    --mode initiator \
    --grpc-port "${GRPC_PORT}" \
    ${P2P_ARG} \
    --bootstrap-node "${BOOTSTRAP}"
