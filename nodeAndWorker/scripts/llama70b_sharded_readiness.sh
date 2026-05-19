#!/usr/bin/env bash
# Préflight Llama 2 70B distribué : ne charge pas le modèle sur le VPS.
# Il vérifie l'espace, les services, les workers live, puis prépare/valide les commandes de test shard-only.

set -euo pipefail

VPS_SSH="${VPS_SSH:-ubuntu@51.222.26.225}"
: "${SSHPASS:?Set SSHPASS before running the VPS readiness check.}"
MODEL_ID="${VRYX_LLAMA70B_MODEL:-meta-llama/Llama-2-70b-hf}"
SHARD_DIR="${VRYX_SHARD_BASE_DIR:-/var/lib/vryx-shards}"
SNAPSHOT_DIR="${VRYX_MODEL_SNAPSHOT_DIR:-/var/lib/vryx-models/llama2-70b-hf}"
MIN_FREE_GB="${VRYX_LLAMA70B_MIN_FREE_GB:-160}"

SSH=(sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=12 "$VPS_SSH")

echo "[1/5] Services et disque VPS"
"${SSH[@]}" bash <<REMOTE
set -euo pipefail
echo "host=\$(hostname)"
systemctl is-active --quiet vryx-bootstrap.service && echo "bootstrap=active" || echo "bootstrap=inactive"
systemctl is-active --quiet vryx-initiator.service && echo "initiator=active" || echo "initiator=inactive"
systemctl is-active --quiet vryx-inference-stage1.service && echo "stage1=active" || echo "stage1=inactive"
systemctl is-active --quiet mysql.service && echo "mysql=active" || echo "mysql=inactive"
sudo mkdir -p "$SHARD_DIR" "$SNAPSHOT_DIR"
sudo chown -R ubuntu:ubuntu "$SHARD_DIR" "$SNAPSHOT_DIR" 2>/dev/null || true
df -h "$SHARD_DIR" "$SNAPSHOT_DIR"
free_gb=\$(df -BG --output=avail "$SHARD_DIR" | tail -1 | tr -dc '0-9')
if [ "\${free_gb:-0}" -lt "$MIN_FREE_GB" ]; then
  echo "[WARN] espace libre insuffisant pour 70B confortable: \${free_gb}GB < ${MIN_FREE_GB}GB"
else
  echo "[OK] espace libre shard: \${free_gb}GB"
fi
REMOTE

echo "[2/5] Workers live et VRAM allouée"
"${SSH[@]}" "DATA=\$(curl -fsS http://127.0.0.1:4000/api/workers/status) python3 - <<'PY'
import json, os
data = json.loads(os.environ.get('DATA') or '{}')
workers = [w for w in data.get('workers', []) if w.get('mode') == 'worker']
live = [w for w in workers if int(w.get('secondsSinceHeartbeat') or 999999) <= 45]
total_gb = sum(float(w.get('allocatedVramMb') or 0) / 1024 for w in live)
print(json.dumps({
  'workers_live': len(live),
  'allocated_vram_gb': round(total_gb, 2),
  'models': sorted(set(str(w.get('model') or '') for w in live)),
  'workers': [
    {
      'peer': str(w.get('peerId'))[:16],
      'gpu': w.get('gpuName'),
      'allocated_gb': round(float(w.get('allocatedVramMb') or 0) / 1024, 2),
      'backend': w.get('runtimeBackend'),
      'model': w.get('model'),
    }
    for w in live
  ],
}, ensure_ascii=False, indent=2))
if len(live) < 2:
  print('[WARN] 70B shardé réaliste: prévoir plusieurs workers live.')
if total_gb < 46:
  print('[WARN] Q4 70B confortable: viser 46GB+ cumulés, plus KV/cache.')
PY"

echo "[3/5] Snapshot modèle"
"${SSH[@]}" bash <<REMOTE
set -euo pipefail
if [ -f "$SNAPSHOT_DIR/config.json" ]; then
  echo "[OK] config présente: $SNAPSHOT_DIR/config.json"
else
  echo "[WARN] snapshot absent ou incomplet: $SNAPSHOT_DIR"
fi
find "$SNAPSHOT_DIR" -maxdepth 1 -type f \( -name '*.safetensors' -o -name '*.json' -o -name 'tokenizer*' \) -printf '%f %s\n' 2>/dev/null | head -40 || true
REMOTE

echo "[4/5] Commandes de préparation sans charger le modèle complet"
cat <<EOF
# Télécharger uniquement les fichiers nécessaires côté VPS (avec HF_TOKEN en env, sans charger en RAM):
HF_TOKEN='***' VRYX_MODEL_SNAPSHOT_DIR='$SNAPSHOT_DIR' \\
python3 nodeAndWorker/scripts/download_llama2_70b_prep.py \\
  --model '$MODEL_ID' \\
  --local-dir '$SNAPSHOT_DIR' \\
  --patterns '*.json,*.safetensors,tokenizer*,*.model,*.tiktoken,merges.txt,vocab.*,special_tokens_map.json,generation_config.json' \\
  --print-model-info

# Démarrer stage1 en mode shard-only 70B:
VRYX_DIST_MODEL='$MODEL_ID' \\
VRYX_MODEL_SNAPSHOT_DIR='$SNAPSHOT_DIR' \\
VRYX_MODEL_LOCAL_ONLY=1 \\
VRYX_WORKER_ONLY_LLM=1 \\
VRYX_MLX_LM_DIRECT=0 \\
VRYX_PARALLEL_SHARD_INIT=1 \\
VRYX_PARALLEL_SHARD_INIT_MAX=4 \\
VRYX_SHARD_BASE_DIR='$SHARD_DIR' \\
sudo systemctl restart vryx-inference-stage1 vryx-initiator
EOF

echo "[5/5] Test prêt"
echo "Quand les workers déclarent $MODEL_ID, lance:"
echo "  VRYX_RUN_P2P_SMOKE=1 VRYX_RUN_TPS_BENCH=1 scripts/vryx-e2e-reproducible.sh"
