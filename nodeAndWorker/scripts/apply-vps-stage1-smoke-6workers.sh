#!/usr/bin/env bash
# Drop-in systemd (zzz-*) pour stage1 : petit modèle test + Daisy Chain alignée sur tes workers locaux.
# Par défaut : VRYX_DIST_USE_ALL_COMPATIBLE_PEERS=1 jusqu’à VRYX_DIST_HARD_CAP_PEERS.
# Optionnel : VRYX_DIST_SINGLE_NODE_PUBLIC_IP pour ne prendre que les heartbeats depuis cette IP.
#
# Exemple :
#   export VPS_SSH=ubuntu@51.222.26.225
#   export SSHPASS='…'
#   export VRYX_DIST_HARD_CAP_PEERS=12
#   ./scripts/apply-vps-stage1-smoke-6workers.sh
#
set -euo pipefail

MODEL="${VRYX_DIST_MODEL:-${VRYX_WORKER_MODEL:-Qwen/Qwen2-0.5B-Instruct}}"
VPS="${VPS_SSH:-ubuntu@51.222.26.225}"
MIN="${VRYX_DIST_MIN_WORKERS:-1}"
USE_ALL="${VRYX_DIST_USE_ALL_COMPATIBLE_PEERS:-1}"
HARD_CAP="${VRYX_DIST_HARD_CAP_PEERS:-24}"
NODE_IP="${VRYX_DIST_SINGLE_NODE_PUBLIC_IP:-}"

SSH_ARGS=(-o StrictHostKeyChecking=no -o ConnectTimeout=15 "${VPS}")
if [[ -n "${SSHPASS:-}" ]]; then
  SSH=(sshpass -p "${SSHPASS}" ssh "${SSH_ARGS[@]}")
else
  SSH=(ssh "${SSH_ARGS[@]}")
fi

echo "[*] Drop-in smoke stage1 @ ${VPS}"
echo "    MODEL=${MODEL} MIN_WORKERS=${MIN}"
echo "    USE_ALL_COMPATIBLE_PEERS=${USE_ALL} HARD_CAP=${HARD_CAP}"
[[ -n "${NODE_IP}" ]] && echo "    SINGLE_NODE_PUBLIC_IP=${NODE_IP}"

"${SSH[@]}" bash -s -- "${MODEL}" "${MIN}" "${USE_ALL}" "${HARD_CAP}" "${NODE_IP}" <<'REMOTE'
set -euo pipefail
MODEL="$1"
MIN="$2"
USE_ALL="$3"
HARD_CAP="$4"
NODE_IP="${5:-}"
sudo mkdir -p /etc/systemd/system/vryx-inference-stage1.service.d
{
  echo '[Service]'
  echo "Environment=VRYX_DIST_MODEL=${MODEL}"
  echo "Environment=VRYX_DIST_MIN_WORKERS=${MIN}"
  echo "Environment=VRYX_DIST_USE_ALL_COMPATIBLE_PEERS=${USE_ALL}"
  echo "Environment=VRYX_DIST_HARD_CAP_PEERS=${HARD_CAP}"
  if [[ -n "${NODE_IP}" ]]; then
    echo "Environment=VRYX_DIST_SINGLE_NODE_PUBLIC_IP=${NODE_IP}"
  fi
} | sudo tee /etc/systemd/system/vryx-inference-stage1.service.d/zzz-force-smoke-6w.conf >/dev/null
sudo rm -f /etc/systemd/system/vryx-inference-stage1.service.d/99-smoke-daisy6.conf 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl restart vryx-inference-stage1
sleep 2
systemctl --no-pager -l status vryx-inference-stage1 | head -26
systemctl show vryx-inference-stage1 -p Environment --value | tr ' ' '\n' | grep VRYX_DIST_
REMOTE
