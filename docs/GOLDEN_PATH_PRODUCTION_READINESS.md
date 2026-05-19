# Vryx Golden Path Production Readiness

Le chemin de référence officiel est volontairement étroit :

```text
Qwen/Gemma 35B Q4
-> 1 worker M4 Max
-> llama.cpp
-> stream token stable
-> métriques complètes
-> dashboard live
```

## Contrat runtime

Chaque requête inference doit produire :

- `request_id`
- `model`
- `quantization`
- `runtime`
- `worker_id`
- `ttft_ms`
- `decode_tps`
- `latency_ms`
- `total_duration_ms`
- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `cost_eur`
- `error` si échec

Une réponse vide n'est jamais un succès. Si le worker renvoie zéro token et aucun texte, l'API doit répondre avec une erreur structurée `empty_worker_response`.

## Endpoints admin

- `GET /api/admin/inference/recent?limit=80`
- `GET /api/admin/inference/summary?hours=24`

La synthèse expose `p50/p95/p99` pour latence et TTFT, le taux de succès, et les TPS decode.

## Benchmark reproductible

Sur le VPS :

```bash
cd /var/www/vryx
VRYX_BENCH_MODEL=gemma4:31b \
VRYX_BENCH_QUANT=q4 \
VRYX_BENCH_POOL=auto \
VRYX_BENCH_TARGET_TPS=10 \
VRYX_BENCH_TOKENS=128,256 \
VRYX_BENCH_PROMPT="Écris une longue liste de mots français simples séparés par des virgules. Ne conclus pas. Continue jusqu’à atteindre la limite de génération." \
python3 nodeAndWorker/scripts/bench_vps_chat_tps.py
```

Critères minimum golden path :

- aucune réponse vide ;
- `target_reached=true` pour 10 TPS ;
- TTFT présent ou dérivable ;
- runtime `llama_cpp` ;
- modèle `gemma4:31b` ou Qwen/Gemma 35B Q4 explicitement chargé.

## Priorités restantes

1. Sortir du relay P2P quand possible : TCP/UDP `4021` mappé vers le worker.
2. Garder un seul runtime golden path : `llama.cpp` Q4.
3. Refuser scheduler si heartbeat stale, worker busy/loading/running, commande pending, ou modèle incompatible.
4. Exposer les mêmes métriques dans le dashboard live.
