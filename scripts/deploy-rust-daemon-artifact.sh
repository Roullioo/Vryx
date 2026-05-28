#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 /path/to/vryx-daemon-linux-x86_64 [ssh-host]" >&2
  exit 2
fi

artifact="$1"
host="${2:-ubuntu@51.222.26.225}"
remote_tmp="/tmp/vryx-daemon-linux-x86_64.$$"
remote_bin="/home/ubuntu/apps/vryx/nodeAndWorker/target/release/rust-daemon"

if [[ ! -x "$artifact" ]]; then
  echo "artifact_missing_or_not_executable:$artifact" >&2
  exit 2
fi

scp "$artifact" "$host:$remote_tmp"
ssh "$host" "set -euo pipefail
  chmod +x '$remote_tmp'
  '$remote_tmp' --version >/tmp/vryx-daemon-version.txt 2>&1 || true
  sudo systemctl stop vryx-initiator || true
  mkdir -p \$(dirname '$remote_bin')
  cp '$remote_tmp' '$remote_bin'
  chmod +x '$remote_bin'
  rm -f '$remote_tmp'
  sudo systemctl start vryx-initiator
  sudo systemctl is-active vryx-initiator"
