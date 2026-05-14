#!/usr/bin/env bash
# Test léger : une seule commande SSH vers le VPS (aucun worker / cargo sur cette machine).
# Timeout court par défaut (3 min) pour éviter les sessions bloquées.
#
# Prérequis : workers MLX déjà démarrés ailleurs (ex. ton Mac), initiateur VPS joignable.
# Usage :
#   export VPS_SSH=ubuntu@51.222.26.225
#   ./scripts/test-p2p-smoke-vps.sh
#
# Optionnel : SSHPASS si tu n’as pas de clé SSH (ne pas committer le mot de passe).

set -euo pipefail
VPS_SSH="${VPS_SSH:-ubuntu@51.222.26.225}"
REMOTE_DIR="${VPS_REMOTE_SERVER_DIR:-/var/www/vryx/server}"
TIMEOUT_SEC="${VRYX_SMOKE_TIMEOUT_SEC:-420}"
PROMPT="${VRYX_SMOKE_PROMPT:-Réponds en une courte phrase en français : capitale de la France ?}"

SSH_BASE=(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=12 "${VPS_SSH}")
if [[ -n "${SSHPASS:-}" ]]; then
  SSH_CMD=(sshpass -p "${SSHPASS}" "${SSH_BASE[@]}")
else
  SSH_CMD=("${SSH_BASE[@]}")
fi

SCRIPT="${REMOTE_DIR}/scripts/vps-admin-p2p-once.mjs"
PQ=$(printf '%q' "${PROMPT}")
SQ=$(printf '%q' "${SCRIPT}")

echo "[*] Smoke P2P : ${VPS_SSH} (timeout ${TIMEOUT_SEC}s, sortie tronquée à 80 lignes)."
# Heredoc sans quotes sur REMOTE : expansion locale de $(printf '%q' …) puis stdin
# distant = script bash valide (évite la fragmentation des args par ssh).
"${SSH_CMD[@]}" bash <<REMOTE
export PROMPT=${PQ}
export QUANTIZATION=q4
export POOL_PREFERENCE=velocity_mlx
timeout ${TIMEOUT_SEC} node ${SQ} 2>&1 | head -80
REMOTE

echo "[*] Fin smoke."
