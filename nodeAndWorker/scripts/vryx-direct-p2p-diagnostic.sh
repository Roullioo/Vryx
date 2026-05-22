#!/usr/bin/env bash
set -euo pipefail

P2P_PORT="${VRYX_P2P_PORT:-4021}"
EXTERNAL_P2P_PORT="${VRYX_EXTERNAL_P2P_PORT:-$P2P_PORT}"
PUBLIC_IP_SERVICE="${VRYX_PUBLIC_IP_SERVICE:-https://api.ipify.org}"
APPLY_UPNP="${VRYX_APPLY_UPNP:-0}"

log() {
  printf '%s\n' "$*"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

lan_ip() {
  if command_exists ip; then
    ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'
    return
  fi
  if command_exists route && command_exists ifconfig; then
    local iface
    iface="$(route get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
    if [ -n "${iface:-}" ]; then
      ifconfig "$iface" 2>/dev/null | awk '/inet /{print $2; exit}'
      return
    fi
  fi
}

listen_state() {
  if command_exists lsof; then
    lsof -nP -iTCP:"$P2P_PORT" -sTCP:LISTEN 2>/dev/null || true
    lsof -nP -iUDP:"$P2P_PORT" 2>/dev/null || true
    return
  fi
  if command_exists ss; then
    ss -lntup 2>/dev/null | awk -v port=":$P2P_PORT" '$0 ~ port {print}'
    return
  fi
  if command_exists netstat; then
    netstat -an 2>/dev/null | awk -v port=".$P2P_PORT|:$P2P_PORT" '$0 ~ port {print}'
  fi
}

public_ip() {
  if command_exists curl; then
    curl -fsS --max-time 5 "$PUBLIC_IP_SERVICE" 2>/dev/null || true
  fi
}

apply_upnp() {
  local ip="$1"
  if [ "$APPLY_UPNP" != "1" ]; then
    log "upnp=skipped set VRYX_APPLY_UPNP=1 to request router mapping"
    return
  fi
  if ! command_exists upnpc; then
    log "upnp=unavailable missing upnpc"
    return
  fi
  upnpc -a "$ip" "$P2P_PORT" "$EXTERNAL_P2P_PORT" TCP || true
  upnpc -a "$ip" "$P2P_PORT" "$EXTERNAL_P2P_PORT" UDP || true
  upnpc -l | awk -v port="$EXTERNAL_P2P_PORT" '$0 ~ port {print}'
}

LAN_IP="$(lan_ip || true)"
PUBLIC_IP="$(public_ip || true)"

log "vryx_direct_p2p_diagnostic"
log "p2p_port=$P2P_PORT"
log "external_p2p_port=$EXTERNAL_P2P_PORT"
log "lan_ip=${LAN_IP:-unknown}"
log "public_ip=${PUBLIC_IP:-unknown}"
log "listener_state:"
listen_state || true
log "router_mapping:"
if [ -n "${LAN_IP:-}" ]; then
  apply_upnp "$LAN_IP"
else
  log "upnp=skipped no_lan_ip"
fi
log "remote_probe_tcp=nc -vz -w 5 ${PUBLIC_IP:-PUBLIC_IP} $EXTERNAL_P2P_PORT"
log "remote_probe_udp=nmap -sU -p $EXTERNAL_P2P_PORT ${PUBLIC_IP:-PUBLIC_IP}"
log "worker_env_after_verified=VRYX_ROUTE_MODE=direct_tcp VRYX_DIRECT_READY=1 VRYX_DIRECT_PUBLIC_IP=${PUBLIC_IP:-PUBLIC_IP} VRYX_DIRECT_PUBLIC_PORT=$EXTERNAL_P2P_PORT VRYX_DIRECT_PROOF_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
