# Rapport optimisation TPS — pipeline MLX Qwen3.6-35B (M1 + M4)

Date : 23 mai 2026

## Avant

| Métrique | Valeur observée |
|----------|-----------------|
| TPS global (4 tokens) | **~0,031 tok/s** |
| TPS décode (hors prefill) | **~0,051 tok/s** |
| Goulot | **M1** (~18–19 s/token sur couches 0–9) |
| M4 (couches 10–39 + lm_head) | ~0,29–0,32 s/token MLX pur |
| Micro-décodage multi-worker | **Désactivé** (`len(routing_path) == 1` seulement) |
| Scan linear attention | Souvent **chunked Python** (boucle sur L) |
| Conv1d linear_attn | **Boucle Python** sur la taille du kernel |
| MoE | **8 appels séquentiels** expert par token |
| Activations | **fp32** forcé dans le forward |
| `mx.eval` | **Chaque couche** (sync Metal agressive) |

## Après (optimisations code déployées)

### 1. `mlx_backend.py` — calcul M1/M4

- **`VRYX_MLX_COMPUTE_DTYPE=fp16`** (défaut) : activations internes en fp16 au lieu de fp32.
- **`VRYX_MLX_SCAN_BACKEND=metal`** par défaut si Metal disponible : scan Gated Delta via kernel Metal (supprime la boucle Python sur L).
- **`_causal_conv1d_mlx`** : `mx.conv1d` depthwise + padding causal (plus de `stack` Python sur le kernel).
- **`_moe_mlp`** : chemin **vectorisé** (matmul batch sur les `top_k` experts) quand les poids ne sont pas quantifiés.
- **`VRYX_MLX_EVAL_EVERY_LAYERS`** : défaut = **toutes les couches du shard** en décode (`seq_len=1`) pour réduire les sync Metal inter-couches.
- Logs layer progress : défaut **0** (moins d’I/O console).

### 2. `distributed_llm_orchestrator.py` — pipeline M1→M4

- **`VRYX_PIPELINE_DECODE_MICROBATCH=1`** : micro-décodage **greedy** sur chaîne **M1→M4** dans **une seule étape** orchestrateur (`_relay_pipeline_step`), jusqu’à `VRYX_DECODE_MICROBATCH_CAP` tokens par aller-retour VPS.
- **`eos_token_id`** propagé dans les payloads décode.
- Drop-in VPS **`98-qwen36-multiworker-tps.conf`** : modèle `Qwen/Qwen3.6-35B-A3B`, 2 workers, ordre peers fixe, `int8` hidden, timeouts 900 s, `VRYX_RELAY_HTTP_KEEPALIVE=0` sur forwards longs.

### 3. `rust-daemon` — initiateur systemd

- **`VRYX_INITIATOR_TTY=0`** : plus de panic au démarrage headless (flush stdin sur service systemd).
- Drop-in **`98-headless.conf`** sur `vryx-initiator.service`.

### 4. Déploiement

- VPS : `scripts/deploy-vps-runtime.sh` (stage1 + binaire Rust OK).
- Mac M4 local : runtime App Vryx + sources repo mis à jour.
- Mac M1 (ngrok) : fichiers Python copiés ; **tunnel ngrok coupé** au moment du rapport → worker M1 injoignable.

## Impact attendu (ordre de grandeur)

| Levier | Effet attendu |
|--------|----------------|
| Metal scan + fp16 + eval groupé | **−30 à −60 %** latence M1 par token (selon couches linear_attn) |
| MoE vectorisé | **−20 à −40 %** sur couches MoE M1 |
| Pipeline micro-batch ×8 | **÷ jusqu’à 8** les allers-retours VPS **si greedy** (même coût GPU/token, moins de overhead réseau/orchestrateur) |
| Conv1d native | Gain modeste mais stable sur chaque couche linear |

**Objectif réaliste** après reprise des 2 workers P2P : passer de **~0,03 tok/s** vers **~0,15–0,4 tok/s** (4–12×) selon RTT ngrok et charge MoE ; viser plus haut en rapprochant M1 du réseau VPS ou en rééquilibrant les couches (plus de layers sur M4).

## Validation investisseur (nuance)

| Bloc | Note | Commentaire |
|------|------|-------------|
| Diagnostic bottleneck | 90 | M1 ≈ slowest worker → plafond théorique ~1/18 s ≈ **0,055 tok/s** sans changement compute ou allocation |
| Optimisations MLX | 85 | Bons leviers ; **preuve chiffrée absente** tant que P2P vide |
| Microbatch pipeline | 88 | Réduit surtout **overhead VPS** ; ne supprime pas le compute M1/token |
| Fix systemd headless | 95 | `VRYX_INITIATOR_TTY=0` — correctif exploitation |
| Preuve bench Qwen3.6 multi-worker | **35** | `peers: []` → mesure « aucun worker », pas le TPS optimisé |
| Robustesse réseau | 40 | ngrok M1 fragile ; initiateur/tp-peers instables |

**Conclusion :** optimisation **code/runtime livrée** ; **gain TPS réel non prouvé**. Prochaine étape = connectivité (`count >= 2` sur `/api/tp-peers`), puis bench **1 token → 4 tokens → 16**, avec trace séparée `M1 worker_compute_ms` / `M4 worker_compute_ms` / `relay_ms` / `microbatch_size`.

**Scheduler (chantier suivant, après preuve) :** allocation **speed-aware** (pas seulement VRAM) — ex. `layers ∝ measured_tps`, seuil `VRYX_MIN_WORKER_TPS_FOR_35B`, historique par couple worker+modèle.

## État infra au moment du rapport

| Composant | État |
|-----------|------|
| `vryx-inference-stage1` | **active** (drop-in Qwen3.6 multi-worker) |
| `vryx-initiator` | **active** (headless) |
| Worker M4 (`12D3KooWJGeD…`) | Process actif, **0 connexion P2P** |
| Worker M1 (ngrok) | **Tunnel refusé** — à rétablir |
| Disque VPS | Nettoyé (~5 Go libres après purge caches/sync dupliqués) |

## Variables recommandées (workers M1 + M4)

```bash
export VRYX_ENABLE_MLX_RUNTIME=1
export VRYX_ENABLE_MLX_KERNELS=1
export VRYX_MLX_SCAN_BACKEND=metal
export VRYX_MLX_COMPUTE_DTYPE=fp16
export VRYX_MLX_EVAL_EVERY_LAYERS=10
export VRYX_HIDDEN_TRANSPORT=int8
export VRYX_SAMPLING_TEMPERATURE=0
export VRYX_PIPELINE_DECODE_MICROBATCH=1
export VRYX_DECODE_MICROBATCH_CAP=16
```

## Prochaines actions automatiques (quand M1 ngrok revient)

1. Redémarrer worker M1 avec bootstrap VPS (`51.222.26.225:4001`).
2. Vérifier `curl http://127.0.0.1:3031/api/tp-peers` sur le VPS → **count ≥ 2**.
3. Bench : `VRYX_BENCH_MODEL=Qwen/Qwen3.6-35B-A3B VRYX_BENCH_TOKENS=4 VRYX_BENCH_FORCE_DISTRIBUTED=1` via `bench_vps_chat_tps.py`.
4. Comparer `decode_only_tps` et `pipeline_micro_decode` dans la trace.

## Fichiers modifiés

- `nodeAndWorker/python-inference/mlx_backend.py`
- `nodeAndWorker/python-inference/distributed_llm_orchestrator.py`
- `nodeAndWorker/rust-daemon/src/main.rs`
- `deploy/systemd/vryx-inference-stage1.service.d/98-qwen36-multiworker-tps.conf`
- `deploy/systemd/vryx-initiator.service.d/98-headless.conf`
