#!/usr/bin/env bash
set -euo pipefail

# Prépare un disque additionnel pour le cache HF / shards VRYX (sans toucher au disque système).
#
# Usage :
#   sudo ./setup_vps_storage.sh
#   sudo ./setup_vps_storage.sh /dev/sdb /mnt/vryx-storage

DEVICE="${1:-/dev/sdb}"
MOUNT_POINT="${2:-/mnt/vryx-storage}"
PARTITION="${3:-${DEVICE}1}"
FS_LABEL="vryx-storage"
HF_DIR="vryx-hf"
SHARD_DIR="vryx-shards"

if [[ $EUID -ne 0 ]]; then
  echo "[ERR] exécuter en root/sudo" >&2
  exit 2
fi

if [[ ! -b "$DEVICE" ]]; then
  echo "[ERR] Device introuvable: $DEVICE" >&2
  exit 3
fi

echo "[*] Device cible : $DEVICE"
lsblk -f "$DEVICE"

if mountpoint -q "$MOUNT_POINT"; then
  CURRENT="$(findmnt -no SOURCE,TARGET "$MOUNT_POINT")"
  echo "[OK] $MOUNT_POINT déjà monté ($CURRENT)"
  mkdir -p "$MOUNT_POINT/$HF_DIR" "$MOUNT_POINT/$SHARD_DIR"
  echo "[OK] Répertoires prêts: $MOUNT_POINT/$HF_DIR, $MOUNT_POINT/$SHARD_DIR"
  exit 0
fi

if ! lsblk -n "$DEVICE" -o TYPE | awk '{print $1}' | grep -q '^part$'; then
  if ! command -v parted >/dev/null 2>&1; then
    echo "[ERR] parted manquant : installe 'parted' pour partitionner $DEVICE" >&2
    exit 5
  fi
  echo "[*] Aucune partition detectée, création d'une partition ext4 sur $DEVICE"
  parted -s "$DEVICE" mklabel gpt
  parted -s "$DEVICE" mkpart primary ext4 1MiB 100%
  partprobe "$DEVICE"
  sleep 2
fi

if [[ ! -b "$PARTITION" ]]; then
  PARTITION="$(lsblk -n -l "$DEVICE" | awk '/part/ {print $1; exit}' | sed 's|^|/dev/|')"
fi

if [[ ! -b "$PARTITION" ]]; then
  echo "[ERR] Partition introuvable sur $DEVICE" >&2
  exit 4
fi

if [[ -z "$(lsblk -n -o FSTYPE "$PARTITION")" ]]; then
  echo "[*] mkfs ext4 sur $PARTITION"
  mkfs.ext4 -F -L "$FS_LABEL" "$PARTITION"
else
  echo "[OK] FS déjà présente sur $PARTITION -> $(lsblk -n -o FSTYPE "$PARTITION")"
fi

mkdir -p "$MOUNT_POINT"
if ! mountpoint -q "$MOUNT_POINT"; then
  echo "[*] Montage de $PARTITION sur $MOUNT_POINT"
  mount "$PARTITION" "$MOUNT_POINT"
fi

mkdir -p "$MOUNT_POINT/$HF_DIR" "$MOUNT_POINT/$SHARD_DIR"
if [[ ! -L /var/lib/vryx-shards ]] || [[ "$(readlink -f /var/lib/vryx-shards)" != "$MOUNT_POINT/$SHARD_DIR" ]]; then
  echo "[*] Lien /var/lib/vryx-shards -> $MOUNT_POINT/$SHARD_DIR"
  rm -rf /var/lib/vryx-shards
  ln -s "$MOUNT_POINT/$SHARD_DIR" /var/lib/vryx-shards
fi

echo "[*] Enregistrement persistant"
UUID="$(blkid -s UUID -o value "$PARTITION")"
if ! grep -q "$MOUNT_POINT" /etc/fstab; then
  echo "UUID=$UUID $MOUNT_POINT ext4 defaults,nofail 0 2" >> /etc/fstab
fi

chown -R ubuntu:ubuntu "$MOUNT_POINT/$HF_DIR" "$MOUNT_POINT/$SHARD_DIR"
echo "[OK] Storage prêt : $MOUNT_POINT"
df -h "$MOUNT_POINT"
