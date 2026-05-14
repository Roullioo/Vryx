#!/usr/bin/env bash
# Profil « TPS max » sur un seul Mac : un seul couple Python+Rust+MLX = un seul hop P2P (latence min).
# Le modèle doit rentrer en RAM unifiée (ex. Qwen2-0.5B). Aligner VRYX_DIST_MAX_WORKERS=1 sur le VPS.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export VRYX_WORKER_MODEL="${VRYX_WORKER_MODEL:-Qwen/Qwen2-0.5B-Instruct}"
export VRYX_WORKER_COUNT=1
export VRYX_MEMORY_GUARD_REQUIRED_GB="${VRYX_MEMORY_GUARD_REQUIRED_GB:-6}"
export VRYX_MLX_MAX_SHARD_GB="${VRYX_MLX_MAX_SHARD_GB:-24}"
export VRYX_REQUIRED_DISK_GB="${VRYX_REQUIRED_DISK_GB:-8}"
export VRYX_INTER_WORKER_START_DELAY_SEC="${VRYX_INTER_WORKER_START_DELAY_SEC:-3}"
export VRYX_MLX_SCAN_BACKEND="${VRYX_MLX_SCAN_BACKEND:-metal}"

exec "${SCRIPT_DIR}/start-3-workers-mlx.sh"
