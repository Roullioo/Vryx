#!/bin/bash
# Lance des workers Vryx en mode Velocity MLX (Apple Silicon).
# Active les kernels Metal natifs pour le forward pass Qwen3.5.
#
# Usage : ./start-3-workers-mlx.sh
# Arrêt  : ./stop-3-workers-mac.sh  (même script qu'avant)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"
VENV_PATH="${PYTHON_DIR}/venv"
DAEMON_BIN="${SCRIPT_DIR}/target/release/rust-daemon"
PREBUILT_DAEMON_BIN="${SCRIPT_DIR}/bin/darwin-arm64/rust-daemon"
RUNTIME_DAEMON_BIN="${TMPDIR:-/tmp}/vryx-rust-daemon"
KEYS_DIR="${SCRIPT_DIR}/.vryx-keys-mac"

BOOTSTRAP_NODE="${VRYX_BOOTSTRAP_NODE:-/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz}"
# Aligné avec le stage1 VPS (Qwen3.5-9B) ; override avec VRYX_WORKER_MODEL si besoin.
MODEL_ID="${VRYX_WORKER_MODEL:-Qwen/Qwen3.5-9B}"
API_URL="${VRYX_WORKER_API_URL:-https://vryx.eu}"
# Défaut 1 worker : un seul processus Python+Rust+MLX évite la saturation RAM unifiée (Mac 16–24 Go).
# Daisy Chain multi-GPU : export VRYX_WORKER_COUNT=3
WORKER_COUNT="${VRYX_WORKER_COUNT:-1}"
# Pic RAM : éviter de lancer deux chargements MLX quasi simultanés (OOM sur Mac 16–24 Go).
# Pause entre le démarrage de chaque worker (secondes). Défaut : 25 si ≥2 workers, sinon 3.
if [[ -n "${VRYX_INTER_WORKER_START_DELAY_SEC:-}" ]]; then
  INTER_WORKER_DELAY="${VRYX_INTER_WORKER_START_DELAY_SEC}"
elif [[ "${WORKER_COUNT}" -ge 2 ]]; then
  # Pic RAM : chaque nouveau worker charge MLX ; 35 s limite les chevauchements sur 16 Go.
  INTER_WORKER_DELAY=35
else
  INTER_WORKER_DELAY=3
fi
# 1 = refuse le fallback PyTorch : les workers annoncés MLX doivent réellement tourner en MLX.
MLX_STRICT="${VRYX_MLX_STRICT:-1}"
CLEAR_WORKER_CACHE="${VRYX_CLEAR_WORKER_CACHE:-0}"
MLX_CACHE_DIR="${VRYX_WORKER_SHARD_CACHE_DIR:-${HOME}/.vryx-worker-shards-mlx}"
# Workers Mac Velocity = shards distribués par défaut. Sans ces garde-fous,
# inference_server démarre un préwarm MLX direct résident et peut OOM sur M1 16GB
# avant même le premier vryx.shard.init.
WORKER_SHARD_ONLY="${VRYX_WORKER_SHARD_ONLY:-1}"
EXPECT_MODEL_SHARDS_ONLY="${VRYX_EXPECT_MODEL_SHARDS_ONLY:-${WORKER_SHARD_ONLY}}"
DISABLE_MLX_LM_DIRECT="${VRYX_DISABLE_MLX_LM_DIRECT:-${WORKER_SHARD_ONLY}}"
if [[ -n "${VRYX_MLX_PREWARM:-}" ]]; then
  MLX_PREWARM="${VRYX_MLX_PREWARM}"
elif [[ "${WORKER_SHARD_ONLY}" == "1" || "${WORKER_SHARD_ONLY}" == "true" ]]; then
  MLX_PREWARM=0
else
  MLX_PREWARM=1
fi
# QUIC P2P caché : 0 par défaut sur Mac (moins de cas « processus UE » / blocages au démarrage).
WORKER_HIDDEN_QUIC="${VRYX_WORKER_HIDDEN_QUIC:-0}"
# Bench WAN stable : éviter d'apprendre des IP privées distantes (les circuits relay restent autorisés).
WORKER_FILTER_PRIVATE_IDENTIFY_ADDRS="${VRYX_P2P_FILTER_PRIVATE_IDENTIFY_ADDRS:-1}"
# Bench WAN stable : éviter les doubles chemins TCP/QUIC qui font churner le relay.
WORKER_P2P_LISTEN_QUIC="${VRYX_P2P_LISTEN_QUIC:-0}"
WORKER_SECRET="${VRYX_WORKER_SECRET:-${WORKER_SECRET:-}}"
# Démarrage direct par défaut : le double-fork reste disponible, mais il a créé
# des états UE persistants sur certains shells macOS.
USE_SETSID="${VRYX_USE_SETSID:-0}"

case "${WORKER_COUNT}" in
  1) DEFAULT_MLX_MAX_SHARD_GB=24 ;;
  2) DEFAULT_MLX_MAX_SHARD_GB=14 ;;
  *) DEFAULT_MLX_MAX_SHARD_GB=12 ;;
esac
MLX_MAX_SHARD_GB="${VRYX_MLX_MAX_SHARD_GB:-${DEFAULT_MLX_MAX_SHARD_GB}}"

memory_guard() {
  if [[ "${VRYX_SKIP_MEMORY_GUARD:-0}" == "1" || "${VRYX_SKIP_MEMORY_GUARD:-0}" == "true" ]]; then
    echo "[!] Garde-fou mémoire désactivé (VRYX_SKIP_MEMORY_GUARD) : risque de saturation RAM / swap."
    echo "    Préférez VRYX_WORKER_COUNT=1 ou 2 plutôt que de désactiver la garde."
    return 0
  fi
  VRYX_WORKER_COUNT="${WORKER_COUNT}" VRYX_WORKER_MODEL="${MODEL_ID}" python3 - <<'PY'
import os
import re
import subprocess
import sys

workers = int(os.environ.get("VRYX_WORKER_COUNT", "1"))
model = os.environ.get("VRYX_WORKER_MODEL", "").lower()

def sysctl_int(name: str) -> int:
    return int(subprocess.check_output(["sysctl", "-n", name], text=True).strip())

def vm_stat() -> tuple[float, float]:
    page_size = 4096
    total = sysctl_int("hw.memsize") / (1024 ** 3)
    try:
        raw = subprocess.check_output(["vm_stat"], text=True)
    except Exception:
        return total, 0.0
    m = re.search(r"page size of (\d+) bytes", raw)
    if m:
        page_size = int(m.group(1))
    pages = {}
    for line in raw.splitlines():
        if ":" not in line:
            continue
        key, val = line.split(":", 1)
        val = val.strip().strip(".").replace(".", "")
        try:
            pages[key.strip()] = int(val)
        except ValueError:
            pass
    available_pages = (
        pages.get("Pages free", 0)
        + pages.get("Pages inactive", 0)
        + pages.get("Pages speculative", 0)
        + pages.get("Pages purgeable", 0)
    )
    return total, available_pages * page_size / (1024 ** 3)

budget_override = os.environ.get("VRYX_MEMORY_GUARD_REQUIRED_GB", "").strip()
if budget_override:
    required = float(budget_override)
elif "qwen3.5-9b" in model or "qwen/qwen3.5-9b" in model:
    # 1 worker : une seule copie « chaude » ; 2–3 workers : pics de chargement qui se cumulent.
    required = {1: 18.0, 2: 30.0, 3: 42.0}.get(workers, 42.0 + max(0, workers - 3) * 8.0)
elif any(x in model for x in ("0.5b", "0.6b", "1.5b", "1.8b")):
    # Petits Qwen (~1–4 Go HF) partitionnés : budget par worker plus modeste sans exiger SKIP.
    per_worker = float(os.environ.get("VRYX_MEMORY_GUARD_SMALL_MODEL_GB_PER_WORKER", "1.25"))
    required = max(4.0, per_worker * workers)
else:
    required = max(8.0, 8.0 * workers)

total_gb, available_gb = vm_stat()
print(f"[*] Mémoire Mac : total={total_gb:.1f}GB, disponible≈{available_gb:.1f}GB, requis≈{required:.1f}GB pour {workers} worker(s).")
if available_gb < required:
    print(
        "[ERREUR] Mémoire disponible insuffisante pour ce profil MLX. "
        "Fermez les apps lourdes ou réduisez VRYX_WORKER_COUNT. "
        "Override possible avec VRYX_MEMORY_GUARD_REQUIRED_GB ou VRYX_SKIP_MEMORY_GUARD=1.",
        file=sys.stderr,
    )
    sys.exit(42)
PY
}

disk_guard() {
  local required_gb
  case "${WORKER_COUNT}" in
    1) required_gb="${VRYX_REQUIRED_DISK_GB:-28}" ;;
    2) required_gb="${VRYX_REQUIRED_DISK_GB:-26}" ;;
    *) required_gb="${VRYX_REQUIRED_DISK_GB:-24}" ;;
  esac
  VRYX_REQUIRED_DISK_GB="${required_gb}" VRYX_CACHE_DIR="${MLX_CACHE_DIR}" python3 - <<'PY'
import os
import shutil
import sys

cache_dir = os.environ["VRYX_CACHE_DIR"]
required = float(os.environ["VRYX_REQUIRED_DISK_GB"])
usage = shutil.disk_usage(cache_dir)
free = usage.free / (1024 ** 3)
print(f"[*] Disque cache MLX : libre≈{free:.1f}GB, requis≈{required:.1f}GB ({cache_dir}).")
if free < required:
    print(
        "[ERREUR] Espace disque insuffisant pour préparer les shards MLX. "
        "Nettoyez le cache avec VRYX_CLEAR_WORKER_CACHE=1 ou libérez du disque.",
        file=sys.stderr,
    )
    sys.exit(43)
PY
}

if [[ ! -f "${DAEMON_BIN}" && -x "${PREBUILT_DAEMON_BIN}" ]]; then
  mkdir -p "${SCRIPT_DIR}/target/release"
  cp "${PREBUILT_DAEMON_BIN}" "${DAEMON_BIN}"
fi

if [[ ! -f "${DAEMON_BIN}" || "${SCRIPT_DIR}/rust-daemon/src/main.rs" -nt "${DAEMON_BIN}" || "${SCRIPT_DIR}/rust-daemon/Cargo.toml" -nt "${DAEMON_BIN}" ]]; then
  echo "[*] Compilation du daemon Rust…"
  (cd "${SCRIPT_DIR}/rust-daemon" && CARGO_TARGET_DIR=/tmp/vryx-rust-target CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 cargo build --release --locked --message-format short)
  mkdir -p "${SCRIPT_DIR}/target/release"
  cp /tmp/vryx-rust-target/release/rust-daemon "${DAEMON_BIN}"
fi
cp "${DAEMON_BIN}" "${RUNTIME_DAEMON_BIN}"
chmod +x "${RUNTIME_DAEMON_BIN}"
xattr -c "${RUNTIME_DAEMON_BIN}" 2>/dev/null || true

if [[ ! -d "${VENV_PATH}" ]]; then
  echo "[*] Création du venv Python…"
  python3 -m venv "${VENV_PATH}"
  source "${VENV_PATH}/bin/activate"
  pip install -q -r "${PYTHON_DIR}/requirements.txt"
else
  source "${VENV_PATH}/bin/activate"
fi

# Vérifier que MLX est installé
if ! "${VENV_PATH}/bin/python3" -c "import mlx.core" 2>/dev/null; then
  echo "[*] Installation de MLX…"
  "${VENV_PATH}/bin/pip" install -q mlx mlx-lm
fi

mkdir -p "${KEYS_DIR}"
mkdir -p "${MLX_CACHE_DIR}"

if [[ "${CLEAR_WORKER_CACHE}" == "1" || "${CLEAR_WORKER_CACHE}" == "true" ]]; then
  echo "[*] Nettoyage cache workers MLX : ${MLX_CACHE_DIR}"
  rm -rf "${MLX_CACHE_DIR:?}/"*
fi

echo "[*] Arrêt des anciens workers…"
pkill -9 -f 'rust-daemon --mode worker' 2>/dev/null || true
pkill -9 -f 'vryx-rust-daemon --mode worker' 2>/dev/null || true
pkill -9 -f 'inference_server.py --port 5005[2-9]' 2>/dev/null || true
sleep 1
for p in 50052 50053 50054 50055 50056 50057 50058 50059 50060 3031 3032 3033 3034 3035 3036 3037 3038 3039 4021 4022 4023 4024 4025 4026 4027 4028 4029; do
  lsof -ti:"${p}" | xargs kill -9 2>/dev/null || true
done
sleep 2
memory_guard
disk_guard

PIDS_FILE="/tmp/vryx-mac-workers.pids"
rm -f "${PIDS_FILE}"

start_one() {
  local n="$1"
  local grpc api p2p
  grpc=$((50051 + n))
  api=$((3030 + n))
  p2p=$((4020 + n))

  local keyfile="${KEYS_DIR}/worker-${n}.key"
  local log_py="/tmp/vryx-mac-mlx-worker${n}-python.log"
  local log_rs="/tmp/vryx-mac-mlx-worker${n}-rust.log"
  : > "${log_py}"
  : > "${log_rs}"

  echo "[+] Worker MLX ${n} : gRPC ${grpc}, API ${api}, P2P ${p2p}"

  # Variables Velocity MLX
  VRYX_ENABLE_MLX_RUNTIME=1 \
  VRYX_ENABLE_MLX_KERNELS=1 \
  VRYX_WORKER_MODEL="${MODEL_ID}" \
  VRYX_WORKER_SHARD_ONLY="${WORKER_SHARD_ONLY}" \
  VRYX_EXPECT_MODEL_SHARDS_ONLY="${EXPECT_MODEL_SHARDS_ONLY}" \
  VRYX_DISABLE_MLX_LM_DIRECT="${DISABLE_MLX_LM_DIRECT}" \
  VRYX_MLX_PREWARM="${MLX_PREWARM}" \
  VRYX_MLX_WEIGHT_DTYPE="${VRYX_MLX_WEIGHT_DTYPE:-fp16}" \
  VRYX_MLX_MAX_SHARD_GB="${MLX_MAX_SHARD_GB}" \
  VRYX_MLX_SCAN_BACKEND="${VRYX_MLX_SCAN_BACKEND:-chunked}" \
  VRYX_MLX_SCAN_STRICT="${VRYX_MLX_SCAN_STRICT:-0}" \
  VRYX_MLX_STRICT="${MLX_STRICT}" \
  VRYX_DISABLE_PYTORCH_FALLBACK="${MLX_STRICT}" \
  VRYX_RUNTIME_BACKEND=mlx \
  VRYX_SUPPORTS_MLX=1 \
  VRYX_SUPPORTS_Q4_WEIGHTS=1 \
  VRYX_WORKER_SHARD_CACHE_DIR="${MLX_CACHE_DIR}" \
  VRYX_WEIGHT_QUANTIZATION="${VRYX_WEIGHT_QUANTIZATION:-q4}" \
  VRYX_WORKER_KV_CACHE=true \
  VRYX_HIDDEN_TRANSPORT="${VRYX_HIDDEN_TRANSPORT:-fp16}" \
  VRYX_HIDDEN_QUIC="${WORKER_HIDDEN_QUIC}" \
  VRYX_PERSISTENT_RELAY=1 \
  VRYX_PIPELINE_CHAIN_MODE="${VRYX_PIPELINE_CHAIN_MODE:-initiator_sequential}" \
  VRYX_PREFIX_CACHE=1 \
  VRYX_SAMPLING_TEMPERATURE=0.0 \
  VRYX_SAMPLING_TOP_P=0.75 \
  VRYX_SAMPLING_TOP_K=20 \
  VRYX_REPETITION_PENALTY=1.0 \
  VRYX_REPETITION_GUARD=true \
  MALLOC_ARENA_MAX=2 \
  OMP_NUM_THREADS=1 \
  PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0 \
  PYTHONUNBUFFERED=1 nohup "${VENV_PATH}/bin/python3" "${PYTHON_DIR}/inference_server.py" \
    --port "${grpc}" \
    --stage 2 \
    --model "${MODEL_ID}" \
    >> "${log_py}" 2>&1 &
  py_pid=$!
  echo "${py_pid}" >> "${PIDS_FILE}"
  disown -h "${py_pid}" 2>/dev/null || true

  # Laisser gRPC Python écouter avant le daemon (sinon connection refused sur 127.0.0.1:grpc_port).
  sleep 3

  daemon_cmd=(
    "${RUNTIME_DAEMON_BIN}"
    --mode worker
    --grpc-port "${grpc}"
    --p2p-port "${p2p}"
    --api-port "${api}"
    --bootstrap-node "${BOOTSTRAP_NODE}"
    --api-url "${API_URL}"
    --model "${MODEL_ID}"
    --node-key-file "${keyfile}"
  )
  if [[ "${USE_SETSID}" == "1" || "${USE_SETSID}" == "true" ]]; then
    daemon_cmd=(perl "${SCRIPT_DIR}/scripts/exec-setsid.pl" "${daemon_cmd[@]}")
  fi
  nohup env \
    "VRYX_WORKER_SECRET=${WORKER_SECRET}" \
    VRYX_RUNTIME_BACKEND=mlx \
    VRYX_WORKER_SHARD_ONLY="${WORKER_SHARD_ONLY}" \
    VRYX_EXPECT_MODEL_SHARDS_ONLY="${EXPECT_MODEL_SHARDS_ONLY}" \
    VRYX_DISABLE_MLX_LM_DIRECT="${DISABLE_MLX_LM_DIRECT}" \
    VRYX_MLX_PREWARM="${MLX_PREWARM}" \
    VRYX_SUPPORTS_MLX=1 \
    VRYX_SUPPORTS_Q4_WEIGHTS=1 \
    VRYX_MLX_WEIGHT_DTYPE="${VRYX_MLX_WEIGHT_DTYPE:-fp16}" \
    VRYX_MLX_MAX_SHARD_GB="${MLX_MAX_SHARD_GB}" \
    VRYX_MLX_SCAN_BACKEND="${VRYX_MLX_SCAN_BACKEND:-chunked}" \
    VRYX_MLX_SCAN_STRICT="${VRYX_MLX_SCAN_STRICT:-0}" \
    VRYX_MLX_STRICT="${MLX_STRICT}" \
    VRYX_DISABLE_PYTORCH_FALLBACK="${MLX_STRICT}" \
    VRYX_WEIGHT_QUANTIZATION="${VRYX_WEIGHT_QUANTIZATION:-q4}" \
    VRYX_HIDDEN_QUIC="${WORKER_HIDDEN_QUIC}" \
    VRYX_P2P_FILTER_PRIVATE_IDENTIFY_ADDRS="${WORKER_FILTER_PRIVATE_IDENTIFY_ADDRS}" \
    VRYX_P2P_LISTEN_QUIC="${WORKER_P2P_LISTEN_QUIC}" \
    VRYX_P2P_REQUEST_TIMEOUT_S=3600 \
    VRYX_P2P_IDLE_TIMEOUT_S=900 \
    "${daemon_cmd[@]}" \
    >> "${log_rs}" 2>&1 &
  rs_pid=$!
  echo "${rs_pid}" >> "${PIDS_FILE}"
  disown -h "${rs_pid}" 2>/dev/null || true
  # Laisser le P2P se lier avant le worker suivant (évite SIGKILL / course au démarrage sur Mac).
  sleep 2
}

for i in $(seq 1 "${WORKER_COUNT}"); do
  start_one "${i}"
  if [[ "${i}" -lt "${WORKER_COUNT}" ]]; then
    echo "[*] Pause ${INTER_WORKER_DELAY}s avant le worker $((i + 1)) (limite pic RAM / MLX)…"
    sleep "${INTER_WORKER_DELAY}"
  fi
done

echo ""
echo "[OK] ${WORKER_COUNT} workers MLX lancés (Metal / Apple Silicon, strict=${MLX_STRICT}, poids=${VRYX_MLX_WEIGHT_DTYPE:-fp16}, shard_max=${MLX_MAX_SHARD_GB}GB, scan=${VRYX_MLX_SCAN_BACKEND:-chunked}, shard_only=${WORKER_SHARD_ONLY}, direct_mlx_disabled=${DISABLE_MLX_LM_DIRECT}, prewarm=${MLX_PREWARM}, setsid=${USE_SETSID}, pause_inter_workers=${INTER_WORKER_DELAY}s)."
echo "    Logs Python : /tmp/vryx-mac-mlx-worker{1..${WORKER_COUNT}}-python.log"
echo "    Logs Rust   : /tmp/vryx-mac-mlx-worker{1..${WORKER_COUNT}}-rust.log"
echo "    Greedy MLX rapide : pénalité répétition 1.0 ; QUIC P2P caché désactivé par défaut."
echo "      Réactiver QUIC : VRYX_WORKER_HIDDEN_QUIC=1 $0"
echo ""
echo "    Pour tout arrêter : ./stop-3-workers-mac.sh"
echo ""
