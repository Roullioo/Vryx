# Stabilisation pipeline P2P VRYX et cadrage 70B

## Position technique

La complexité du pipeline est volontaire : un réseau type Petals simple peut tomber à très bas TPS parce qu'il attend des hops lents, sans stratégie forte de warmup, cache, pool et sélection. VRYX garde donc l'architecture P2P + shards + workers spécialisés, mais doit rendre le chemin de production plus déterministe.

## Stabilisation prioritaire

1. **Un chemin rapide par modèle**
   - Petits modèles compatibles worker complet : `mlx_lm_direct_p2p`.
   - Gros modèles 70B+ : `worker_only_sharded`, pas de fallback vers génération complète.
   - Interdire les bascules silencieuses qui changent qualité/TPS sans le dire.

2. **Admission control sans file lente**
   - Éviter une FIFO générale : elle rend le chat imprévisible si une longue génération bloque devant.
   - Utiliser un bail court par worker (`lease`) côté orchestrateur : un worker est réservé uniquement pendant la génération active.
   - Si le worker répond `busy`, il est marqué `busy_until` et retiré du pool quelques secondes.
   - Si un worker équivalent existe : reroute immédiate. Sinon : micro-attente bornée (quelques centaines de ms à quelques secondes), puis erreur claire avec `retry_after_ms`.
   - Timeout séparé : acquisition du bail, chargement shard, premier token, génération.

3. **Sessions shard persistantes**
   - Réutiliser la même session shard tant que modèle, quantization, allocation VRAM et peer set ne changent pas.
   - Fingerprint canonique dans la trace pour savoir si on réutilise vraiment le cache.

4. **Métriques obligatoires**
   - TTFT, TPS actif, p50/p95 latency, p50/p95 ping, uptime worker.
   - Coût / million tokens, rewards workers, marge brute estimée.
   - Toutes les traces doivent porter `model_id`, `pool_class`, `runtime_backend`, `quantization_effective`.

5. **Tests reproductibles**
   - Build/check local.
   - API health + account metrics.
   - Smoke VPS P2P.
   - Bench TPS avec warmup et budgets tokens fixes.

## Cadrage Llama 2 70B shardé

Objectif : ne jamais charger le modèle complet sur le VPS. Le VPS garde config/tokenizer/index et sert des ranges ou shards. Les workers téléchargent uniquement la partie correspondant à leur VRAM allouée.

### Préconditions

- Stockage VPS disponible : viser 160 Go libres minimum pour snapshot + shards temporaires.
- Workers live : au moins 2 workers, idéalement 4+.
- VRAM allouée cumulée :
  - Q4 : viser 46 Go+ pour les poids, plus marge KV/cache.
  - Q8 : viser 80 Go+.
  - FP16 : irréaliste pour un petit pool.
- Tous les workers doivent déclarer le même modèle `meta-llama/Llama-2-70b-hf`.

### Commandes

Préflight :

```bash
nodeAndWorker/scripts/llama70b_sharded_readiness.sh
```

Téléchargement snapshot contrôlé côté VPS :

```bash
HF_TOKEN='***' VRYX_MODEL_SNAPSHOT_DIR='/var/lib/vryx-models/llama2-70b-hf' \
python3 nodeAndWorker/scripts/download_llama2_70b_prep.py \
  --model meta-llama/Llama-2-70b-hf \
  --local-dir /var/lib/vryx-models/llama2-70b-hf \
  --print-model-info
```

Mode stage1 pour test shard-only :

```bash
VRYX_DIST_MODEL='meta-llama/Llama-2-70b-hf'
VRYX_MODEL_SNAPSHOT_DIR='/var/lib/vryx-models/llama2-70b-hf'
VRYX_MODEL_LOCAL_ONLY=1
VRYX_WORKER_ONLY_LLM=1
VRYX_MLX_LM_DIRECT=0
VRYX_PARALLEL_SHARD_INIT=1
VRYX_PARALLEL_SHARD_INIT_MAX=4
VRYX_SHARD_BASE_DIR='/var/lib/vryx-shards'
```

Test final :

```bash
VRYX_RUN_P2P_SMOKE=1 VRYX_RUN_TPS_BENCH=1 scripts/vryx-e2e-reproducible.sh
```

## Critère de succès ce soir

- Le VPS ne dépasse pas son budget RAM pendant préparation.
- Chaque worker affiche le nombre de couches assignées et la taille GB du shard chargé.
- Premier token inférieur à un budget défini après warmup.
- Pas de `mlx_lm_busy`, pas de timeout relay sur requête courte.
- Trace finale avec p50/p95, TPS actif et coût estimé.

## Cible modèle

À terme, le chemin stable doit être cadré autour d'un seul modèle cible principal. Pour VRYX, la cible produit sera Llama 4 quand l'écosystème de poids/quantization sera stable et exploitable en shard-only. En attendant, les benchmarks publics restent explicitement nommés par modèle réel (`Qwen 9B`, `Qwen 35B`, etc.) pour éviter les comparaisons floues.
