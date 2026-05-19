#!/usr/bin/env bash
set -euo pipefail

HOST="${VRYX_VPS_HOST:-51.222.26.225}"
USER="${VRYX_VPS_USER:-ubuntu}"
REMOTE_ROOT="${VRYX_REMOTE_ROOT:-/home/${USER}/apps/vryx}"
STAGE1_DROPIN="${VRYX_STAGE1_DROPIN:-95-prod-qwen35.conf}"
SSH_BASE=(ssh -o StrictHostKeyChecking=no "${USER}@${HOST}")
SCP_BASE=(scp -o StrictHostKeyChecking=no)

if [[ -n "${SSHPASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
  SSH_BASE=(sshpass -e "${SSH_BASE[@]}")
  SCP_BASE=(sshpass -e "${SCP_BASE[@]}")
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive="$(mktemp -t vryx-runtime.XXXXXX.tar.gz)"
trap 'rm -f "$archive"' EXIT

(
  cd "$repo_root"
  tar -czf "$archive" \
    --exclude='nodeAndWorker/rust-daemon/target' \
    --exclude='nodeAndWorker/python-inference/venv' \
    --exclude='nodeAndWorker/python-inference/__pycache__' \
    --exclude='nodeAndWorker/python-inference/.pytest_cache' \
    Cargo.toml Cargo.lock \
    nodeAndWorker/Cargo.toml nodeAndWorker/Cargo.lock \
    nodeAndWorker/rust-daemon \
    nodeAndWorker/proto \
    nodeAndWorker/python-inference \
    nodeAndWorker/scripts \
    deploy/systemd
)

remote_archive="/tmp/$(basename "$archive")"
"${SCP_BASE[@]}" "$archive" "${USER}@${HOST}:${remote_archive}"

"${SSH_BASE[@]}" "REMOTE_ROOT='${REMOTE_ROOT}' ARCHIVE='${remote_archive}' STAGE1_DROPIN='${STAGE1_DROPIN}' bash -se" <<'REMOTE'
set -euo pipefail
mkdir -p "$REMOTE_ROOT"
tar -xzf "$ARCHIVE" -C "$REMOTE_ROOT"
rm -f "$ARCHIVE"

cd "$REMOTE_ROOT/nodeAndWorker"
if [[ ! -d python-inference/venv ]]; then
  python3 -m venv python-inference/venv
fi
python-inference/venv/bin/python3 - <<'PY' >/dev/null 2>&1 || \
  python-inference/venv/bin/python3 -m pip install 'gguf>=0.10.0' sentencepiece tiktoken certifi
import gguf, sentencepiece, tiktoken, certifi
PY
python-inference/venv/bin/python3 -m py_compile \
  python-inference/distributed_llm_orchestrator.py \
  python-inference/inference_server.py \
  python-inference/shard_runtime.py \
  python-inference/mlx_backend.py \
  python-inference/gguf_mlx_backend.py
python3 -m py_compile scripts/bench_vps_chat_tps.py

if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  cargo_bin="$HOME/.cargo/bin/cargo"
else
  cargo_bin="$(command -v cargo)"
fi
"$cargo_bin" build --release -p rust-daemon

sudo install -d -m 0755 /etc/systemd/system/vryx-inference-stage1.service.d
sudo install -d -m 0755 /etc/systemd/system/vryx-initiator.service.d
sudo install -d -m 0755 /usr/local/bin
sudo install -m 0755 "$REMOTE_ROOT/nodeAndWorker/scripts/vryx_stage1_shard_preflight.sh" /usr/local/bin/vryx-shard-preflight
sudo rm -f /etc/systemd/system/vryx-inference-stage1.service.d/*.conf
sudo rm -f /etc/systemd/system/vryx-inference-stage1.service.d/*.conf.disabled
sudo rm -f /etc/systemd/system/vryx-initiator.service.d/*.conf
DROPIN_PATH="$REMOTE_ROOT/deploy/systemd/vryx-inference-stage1.service.d/${STAGE1_DROPIN}"
if [[ ! -f "$DROPIN_PATH" ]]; then
  echo "[ERR] Drop-in stage1 introuvable: ${STAGE1_DROPIN}" >&2
  exit 10
fi
sudo install -m 0644 "$DROPIN_PATH" \
  /etc/systemd/system/vryx-inference-stage1.service.d/"${STAGE1_DROPIN}"
sudo install -m 0644 "$REMOTE_ROOT/deploy/systemd/vryx-initiator.service.d/95-prod-network.conf" \
  /etc/systemd/system/vryx-initiator.service.d/95-prod-network.conf

sudo systemctl daemon-reload
sudo systemctl restart vryx-inference-stage1
sudo systemctl restart vryx-initiator
systemctl is-active vryx-inference-stage1
systemctl is-active vryx-initiator
curl -sfS http://127.0.0.1:3031/api/status >/dev/null
REMOTE
