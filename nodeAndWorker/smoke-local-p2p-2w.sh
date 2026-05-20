#!/usr/bin/env bash
# Smoke test P2P local sans modèle lourd.
# Lance 2 workers + 1 initiateur, puis vérifie un vrai relay P2P vryx.ping.peer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_DIR="${SCRIPT_DIR}/python-inference"
VENV_PATH="${PYTHON_DIR}/venv"
DAEMON="${SCRIPT_DIR}/target/release/rust-daemon"
LOG_DIR="${VRYX_SMOKE_LOG_DIR:-/tmp/vryx-p2p-smoke-2w}"
PIDS_FILE="${LOG_DIR}/pids"
WORKER_COUNT="${VRYX_SMOKE_WORKER_COUNT:-2}"

if [[ -x "${VENV_PATH}/bin/python" ]]; then
  PY="${VENV_PATH}/bin/python"
else
  PY="${VRYX_PYTHON_BIN:-$(command -v python3 || true)}"
fi

if [[ -z "${PY:-}" || ! -x "${PY}" ]]; then
  echo "Python introuvable. Crée ${VENV_PATH} ou exporte VRYX_PYTHON_BIN=/chemin/python3" >&2
  exit 1
fi
if [[ ! -x "${DAEMON}" ]]; then
  echo "Binaire Rust manquant: ${DAEMON}. Lance: (cd '${SCRIPT_DIR}/rust-daemon' && cargo build --release)" >&2
  exit 1
fi

stop_stack() {
  if [[ -f "${PIDS_FILE}" ]]; then
    while read -r pid _; do
      [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true
    done <"${PIDS_FILE}"
  fi
  for p in 3030 3031 3032 3033 4002 4003 4004 4005 50051 50052 50053 50054; do
    lsof -ti:"${p}" | xargs kill -9 2>/dev/null || true
  done
  wait 2>/dev/null || true
}

wait_port() {
  local port="$1" label="$2"
  for _ in $(seq 1 80); do
    "${PY}" -c "import socket; s=socket.socket(); s.settimeout(.25); r=s.connect_ex(('127.0.0.1',${port})); s.close(); raise SystemExit(0 if r == 0 else 1)" 2>/dev/null && return 0
    sleep 0.25
  done
  echo "Timeout port ${port} (${label})" >&2
  return 1
}

json_get() {
  "${PY}" - "$1" <<'PY'
import json, sys, urllib.request
with urllib.request.urlopen(sys.argv[1], timeout=3) as r:
    print(r.read().decode())
PY
}

relay_ping() {
  local peer="$1"
  "${PY}" - "$peer" <<'PY'
import base64, json, sys, urllib.request
peer = sys.argv[1]
payload = {
    "target_peer": peer,
    "dtype": "vryx.ping.peer",
    "data_b64": base64.b64encode(json.dumps({"smoke": True, "peer": peer}).encode()).decode(),
    "session_id": "local-smoke-p2p",
    "persistent_relay": True,
}
req = urllib.request.Request(
    "http://127.0.0.1:3030/api/p2p/relay",
    data=json.dumps(payload).encode(),
    headers={"content-type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=10) as r:
    data = json.loads(r.read().decode())
if not data.get("ok"):
    raise SystemExit(json.dumps(data, ensure_ascii=False))
decoded = base64.b64decode(data.get("data_b64") or "").decode(errors="replace")
inner = json.loads(decoded)
if not inner.get("ok") or inner.get("peer_stage") != 2:
    raise SystemExit(decoded)
print(json.dumps({
    "peer": peer,
    "relay_ms": data.get("relay_ms"),
    "transport": data.get("connection_transport"),
    "worker_reply": inner,
}, ensure_ascii=False))
PY
}

mkdir -p "${LOG_DIR}"
stop_stack
rm -f "${PIDS_FILE}"
if [[ "${VRYX_SMOKE_KEEP_ALIVE:-0}" != "1" ]]; then
  trap stop_stack EXIT
fi

echo "[1/4] Démarrage ${WORKER_COUNT} workers locaux"
for i in $(seq 1 "${WORKER_COUNT}"); do
  grpc=$((50051 + i))
  api=$((3030 + i))
  p2p=$((4001 + i))
  PYTHONUNBUFFERED=1 VRYX_WORKER_SHARD_ONLY=1 "${PY}" "${PYTHON_DIR}/inference_server.py" --port "${grpc}" --stage 2 --model "smoke-local" \
    >"${LOG_DIR}/worker-${i}-python.log" 2>&1 &
  pid=$!
  echo "${pid} worker-${i}-python" >>"${PIDS_FILE}"
  disown "${pid}" 2>/dev/null || true
  wait_port "${grpc}" "worker-${i}-grpc"
  "${DAEMON}" --mode worker --grpc-port "${grpc}" --p2p-port "${p2p}" --api-port "${api}" \
    >"${LOG_DIR}/worker-${i}-rust.log" 2>&1 &
  pid=$!
  echo "${pid} worker-${i}-rust" >>"${PIDS_FILE}"
  disown "${pid}" 2>/dev/null || true
done

echo "[2/4] Démarrage initiateur local"
PYTHONUNBUFFERED=1 VRYX_STAGE1_PREWARM=0 "${PY}" "${PYTHON_DIR}/inference_server.py" --port 50051 --stage 1 \
  >"${LOG_DIR}/stage1-python.log" 2>&1 &
pid=$!
echo "${pid} stage1-python" >>"${PIDS_FILE}"
disown "${pid}" 2>/dev/null || true
wait_port 50051 "stage1-grpc"
"${DAEMON}" --mode initiator --grpc-port 50051 --p2p-port 4005 --api-port 3030 \
  >"${LOG_DIR}/initiator-rust.log" 2>&1 &
pid=$!
echo "${pid} initiator-rust" >>"${PIDS_FILE}"
disown "${pid}" 2>/dev/null || true
wait_port 3030 "initiator-api"

echo "[3/4] Attente découverte P2P"
peers_json='{"peers":[]}'
for _ in $(seq 1 80); do
  peers_json="$(json_get http://127.0.0.1:3030/api/tp-peers 2>/dev/null || echo '{"peers":[]}')"
  count="$("${PY}" -c 'import json,sys; print(len(json.load(sys.stdin).get("peers") or []))' <<<"${peers_json}")"
  [[ "${count}" -ge "${WORKER_COUNT}" ]] && break
  sleep 0.5
done

echo "${peers_json}" >"${LOG_DIR}/peers.json"
count="$("${PY}" -c 'import json,sys; print(len(json.load(sys.stdin).get("peers") or []))' <<<"${peers_json}")"
if [[ "${count}" -lt "${WORKER_COUNT}" ]]; then
  echo "Découverte incomplète (${count}/${WORKER_COUNT}). Logs: ${LOG_DIR}" >&2
  exit 1
fi

echo "[4/4] Ping relay P2P vers chaque worker"
"${PY}" -c 'import json,sys; [print(p) for p in json.load(open(sys.argv[1])).get("peers", [])]' "${LOG_DIR}/peers.json" |
while read -r peer; do
  relay_ping "${peer}"
done

echo "[OK] Smoke P2P local réussi (${WORKER_COUNT} workers). Logs: ${LOG_DIR}"
