#!/usr/bin/env bash
# Reproductible local/VPS smoke suite for VRYX.
# Local checks always run. Authenticated account checks run when VRYX_TEST_EMAIL/PASSWORD are set.
# P2P VPS smoke runs when VRYX_RUN_P2P_SMOKE=1.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/7] Web build"
npm --prefix website run build

echo "[2/7] Server syntax"
node --check website/server/src/index.js

echo "[3/7] Desktop build"
npm --prefix AppMacos run build

echo "[4/8] Python inference syntax"
python3 -m py_compile \
  nodeAndWorker/python-inference/inference_server.py \
  nodeAndWorker/python-inference/distributed_llm_orchestrator.py \
  nodeAndWorker/python-inference/shard_runtime.py \
  nodeAndWorker/python-inference/mlx_backend.py \
  nodeAndWorker/python-inference/gguf_mlx_backend.py

echo "[5/8] GGUF lazy shard unit tests"
PYTHONPATH=nodeAndWorker/python-inference python3 nodeAndWorker/python-inference/test_gguf_mlx_backend.py

echo "[6/8] Rust daemon check"
if [[ "${VRYX_SKIP_RUST_CHECK:-0}" == "1" ]]; then
  echo "[skip] VRYX_SKIP_RUST_CHECK=1"
else
  timeout "${VRYX_RUST_CHECK_TIMEOUT_SEC:-420}" cargo check --manifest-path nodeAndWorker/rust-daemon/Cargo.toml
fi

echo "[7/8] Account/API metrics smoke"
if [[ -n "${VRYX_E2E_BASE_URL:-}" || -n "${VRYX_TEST_EMAIL:-}" ]]; then
  node website/server/scripts/account-metrics-e2e.mjs
else
  echo "[skip] Set VRYX_E2E_BASE_URL plus optional VRYX_TEST_EMAIL/VRYX_TEST_PASSWORD to test a running API."
fi

echo "[8/8] VPS P2P smoke"
if [[ "${VRYX_RUN_P2P_SMOKE:-0}" == "1" ]]; then
  if [[ "${VRYX_RUN_P2P_STREAM_E2E:-1}" == "1" ]]; then
    node website/server/scripts/p2p-stream-e2e.mjs
  fi
  if [[ "${VRYX_RUN_WORKER_COMMAND_E2E:-0}" == "1" ]]; then
    node website/server/scripts/worker-command-e2e.mjs
  fi
  : "${SSHPASS:?Set SSHPASS to run the real VPS P2P smoke.}"
  VPS_SSH="${VPS_SSH:-ubuntu@51.222.26.225}" nodeAndWorker/scripts/test-p2p-smoke-vps.sh
  if [[ "${VRYX_RUN_TPS_BENCH:-0}" == "1" ]]; then
    sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no "$VPS_SSH" \
      "cd /var/www/vryx && VRYX_BENCH_TOKENS='64,128,256' VRYX_BENCH_TARGET_TPS='50' python3 nodeAndWorker/scripts/bench_vps_chat_tps.py"
  fi
else
  echo "[skip] Set VRYX_RUN_P2P_SMOKE=1 to run the real VPS worker path."
fi

echo "[OK] VRYX reproducible checks completed."
