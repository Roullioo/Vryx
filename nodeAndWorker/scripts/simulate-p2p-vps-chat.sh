#!/usr/bin/env bash
# Simulation bout en bout : API admin sur le VPS (comme le panneau « Chat P2P »)
# → daemon initiateur → orchestrateur Python → ton worker (MLX) déjà connecté en P2P.
#
# Prérequis côté Mac :
#   1 worker suffit (défaut scripts MLX) : ./start-3-workers-mlx.sh
#   Ne pas utiliser VRYX_SKIP_MEMORY_GUARD sauf debug court.
#
# Prérequis côté VPS (après déploiement du code à jour) :
#   Le stage1 Python charge distributed_llm_orchestrator avec VRYX_DIST_MIN_WORKERS défaut = 1.
#   Pour forcer 3 workers en prod : export VRYX_DIST_MIN_WORKERS=3 dans l’unité systemd du serveur d’inférence.
#
# Variables :
#   VPS_SSH, SSHPASS, VRYX_SMOKE_TIMEOUT_SEC, VPS_REMOTE_SERVER_DIR (voir test-p2p-smoke-vps.sh)
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[*] Simulation Chat P2P admin (même chemin que le panneau web) via SSH sur le VPS."
echo "[*] Vérifie que ton worker MLX tourne (./start-3-workers-mlx.sh) et que le heartbeat arrive sur vryx.eu."
echo ""
exec "${SCRIPT_DIR}/test-p2p-smoke-vps.sh"
