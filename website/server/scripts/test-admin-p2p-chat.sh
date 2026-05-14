#!/usr/bin/env bash
# Teste le même flux que le panel admin : POST /api/admin/p2p/chat/stream (SSE).
#
# Prérequis :
#   - API Velocity en cours (ex. cd website/server && node src/index.js avec .env valide)
#   - MariaDB joignable (DB_USER / DB_PASSWORD)
#   - Compte admin : e-mail listé dans ADMIN_EMAILS au premier démarrage, ou is_admin=1 en base
#   - Daemon initiateur joignable (VRYX_INITIATOR_CHAT_URL dans .env du serveur, ex. http://127.0.0.1:3090)
#
# Usage :
#   export API_BASE=http://127.0.0.1:4000
#   export ADMIN_EMAIL='ton@email.com'
#   export ADMIN_PASSWORD='TonMotDePasse10+'
#   ./scripts/test-admin-p2p-chat.sh
#
# Première utilisation : créer le compte si besoin (inscription) puis relancer avec login.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${SERVER_DIR}"

API_BASE="${API_BASE:-http://127.0.0.1:4000}"
API_BASE="${API_BASE%/}"
JAR="${TMPDIR:-/tmp}/vryx-admin-p2p-cookies.txt"
PROMPT="${PROMPT:-Réponds par une seule phrase en français : quel est le capital de la France ?}"
POOL_PREFERENCE="${POOL_PREFERENCE:-velocity_mlx}"
QUANTIZATION="${QUANTIZATION:-q4}"

if [[ -z "${ADMIN_EMAIL:-}" || -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "Définissez ADMIN_EMAIL et ADMIN_PASSWORD (compte admin Velocity)." >&2
  exit 1
fi

login_json="$(curl -sS -c "${JAR}" -b "${JAR}" -X POST "${API_BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" || true)"

if echo "${login_json}" | grep -q '"isAdmin":true'; then
  echo "Connexion admin OK."
elif echo "${login_json}" | grep -q '"isAdmin":false'; then
  echo "Ce compte n'est pas administrateur. Ajoutez l'e-mail dans ADMIN_EMAILS puis redémarrez l'API, ou promouvez is_admin en base." >&2
  exit 1
else
  echo "Échec login (compte absent ?). Essayez l'inscription une fois :" >&2
  echo "  curl -sS -c ${JAR} -b ${JAR} -X POST ${API_BASE}/api/auth/register -H 'Content-Type: application/json' -d '{\"email\":\"...\",\"password\":\"...\"}'" >&2
  echo "Réponse : ${login_json}" >&2
  exit 1
fi

echo "--- SSE /api/admin/p2p/chat/stream (comme le panel, pool ${POOL_PREFERENCE}) ---"
PAYLOAD="$(PROMPT="${PROMPT}" POOL_PREFERENCE="${POOL_PREFERENCE}" QUANTIZATION="${QUANTIZATION}" node -e "console.log(JSON.stringify({prompt: process.env.PROMPT || '', quantization: process.env.QUANTIZATION || 'fp16', pool_preference: process.env.POOL_PREFERENCE || 'velocity_mlx'}))")"
curl -sS -N -m 180 -c "${JAR}" -b "${JAR}" -X POST "${API_BASE}/api/admin/p2p/chat/stream" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "${PAYLOAD}"

echo ""
echo "--- Fin ---"
