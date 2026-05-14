#!/usr/bin/env bash
# Smoke test Daisy Chain à 6 workers MLX, petit Qwen (~1 Go HF).
#
# Flux réel : le modèle HF est sur le VPS ; chaque worker reçoit shard.init/load (HTTPS depuis
# l’API) puis construit MLX en RAM / cache disque local et reste prêt pour shard.forward via P2P.
#
# Côté VPS (vryx-inference-stage1), aligner AU MINIMUM :
#   même VRYX_DIST_MODEL que VRYX_WORKER_MODEL ci-dessous
# Recommandé (mono-machine plusieurs processus worker) :
#   VRYX_DIST_USE_ALL_COMPATIBLE_PEERS=1
#   VRYX_DIST_HARD_CAP_PEERS ≥ nombre de workers lancés ici (défaut script apply : 24)
# Optionnel foyer unique : VRYX_DIST_SINGLE_NODE_PUBLIC_IP=<IP publique des heartbeats>
#
# Déploiement : scripts/apply-vps-stage1-smoke-6workers.sh
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export VRYX_WORKER_MODEL="${VRYX_WORKER_MODEL:-Qwen/Qwen2-0.5B-Instruct}"
export VRYX_WORKER_COUNT="${VRYX_WORKER_COUNT:-6}"

# RAM totale indicative pour les 6 couples Python+Rust+MLX (voir garde Mémoire petits modèles).
export VRYX_MEMORY_GUARD_REQUIRED_GB="${VRYX_MEMORY_GUARD_REQUIRED_GB:-8}"
export VRYX_MLX_MAX_SHARD_GB="${VRYX_MLX_MAX_SHARD_GB:-2}"

export VRYX_REQUIRED_DISK_GB="${VRYX_REQUIRED_DISK_GB:-8}"
export VRYX_INTER_WORKER_START_DELAY_SEC="${VRYX_INTER_WORKER_START_DELAY_SEC:-40}"

exec "${SCRIPT_DIR}/start-3-workers-mlx.sh"
