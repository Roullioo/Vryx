#!/usr/bin/env bash
set -euo pipefail

MOUNT_POINT="${1:-/var/lib/vryx-shards}"
MIN_MB="${VRYX_MIN_SHARD_FREE_MB:-10240}"

if [[ ! -d "$MOUNT_POINT" ]]; then
  mkdir -p "$MOUNT_POINT"
fi

AVAIL_MB="$(df -Pm "$MOUNT_POINT" | tail -n 1 | awk '{print $4}')"
if [[ -z "${AVAIL_MB}" ]] || ! [[ "$AVAIL_MB" =~ ^[0-9]+$ ]]; then
  echo "[ERR] Impossible de lire l'espace disque sur ${MOUNT_POINT}" >&2
  df -P "$MOUNT_POINT" >&2
  exit 1
fi

if (( AVAIL_MB < MIN_MB )); then
  echo "[ERR] Pas assez d'espace disque pour le cache shards (${AVAIL_MB} MB < ${MIN_MB} MB) sur ${MOUNT_POINT}" >&2
  exit 1
fi
