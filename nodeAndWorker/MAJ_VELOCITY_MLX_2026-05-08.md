# Mise à jour Velocity MLX — 8 mai 2026

Ce document résume la grosse mise à jour effectuée sur l’infrastructure Vryx Velocity : passage vers des runtimes natifs, préparation des pools rapides, meilleure observabilité du chat P2P et correction des blocages d’inférence.

## Objectif

L’objectif est de transformer le réseau Vryx en pipeline d’inférence distribué réellement exploitable :

- Le VPS orchestre, tokenise, distribue les shards et agrège la réponse.
- Les workers exécutent les calculs GPU/Metal.
- Le modèle n’est pas exécuté par le VPS.
- Les sessions utilisent au minimum deux workers compatibles.
- Les métriques réelles remontent dans le chat P2P, les workers, les sessions et le graphe réseau.

## Changements majeurs

### Runtime MLX pour Apple Silicon

Un backend `mlx` a été ajouté pour remplacer le chemin PyTorch sur Mac quand `VRYX_RUNTIME_BACKEND=mlx`.

Travail réalisé :

- Chargement des poids de shards en tableaux MLX.
- Exécution stricte MLX avec `VRYX_DISABLE_PYTORCH_FALLBACK=1`.
- Détection des blocs Qwen3.5 `linear_attn`.
- Implémentation des primitives MLX : RMSNorm, SiLU, RoPE, MLP, GQA, causal Conv1D, recurrent state.
- Exposition des métriques `linear_attn_ready`, `state_bytes`, `memory_mode`, `runtime_backend`, `weight_quantization`.

### Kernel Qwen3.5 Linear Attention / SSM

Le verrou principal était le chemin Qwen3.5, qui n’utilise pas uniquement une attention classique. Le backend MLX contient maintenant un chemin dédié pour :

- `linear_attn.in_proj_qkv`
- convolution causale 1D
- état récurrent par session
- decode O(1) avec état conservé
- fallback interdit en mode strict

Résultat : le chemin MLX ne tombe plus silencieusement sur PyTorch. Si MLX échoue, le worker renvoie une erreur explicite.

### Pools de workers

Les workers sont classés en pools :

- `velocity_mlx` pour les workers Apple Silicon MLX.
- `velocity_vllm` pour le futur chemin Nvidia vLLM.
- `legacy_pytorch` pour l’ancien runtime.

Le chat P2P permet de choisir :

- `Auto`
- `Velocity MLX`
- `Legacy PyTorch`

L’orchestrateur sélectionne une pool homogène et expose :

- `pool_class`
- `pool_preference`
- `pool_fallback_reason`
- `runtime_backend_per_worker`
- `weight_quantization_per_worker`
- `attention_backend_per_worker`

### Quantification 4-bit / 8-bit

Le chat P2P permet maintenant de demander :

- `int8`
- `q4`

La première étape concerne le transport des hidden states. La seconde étape prépare la quantification des poids (`GGUF K-Quants`, `EXL2`, `AWQ/GPTQ` selon runtime).

Si un worker ne supporte pas `q4`, l’orchestrateur repasse en `int8` et expose `quantization_fallback_reason`.

### Continuous Batching et overlap

La logique de batching continu a été préparée :

- file `BatchQueue`
- trace `batching`
- activation conditionnelle quand `linear_attn_ready=true`

L’overlap calcul/réseau est préparé côté trace :

- `compute_overlap_pct`
- `network_hidden_ms`
- `enabled`

La phase suivante consiste à exécuter un vrai double buffering sur les workers.

### QUIC natif

Le daemon Rust a été configuré pour utiliser `libp2p-quic` :

- transport QUIC UDP
- écoute `/udp/{port}/quic-v1`
- traces `quic_available`, `quic_used`, `quic_fallback`

L’objectif est de réduire la latence inter-workers et d’éviter que la Daisy Chain soit ralentie par TCP quand QUIC est disponible.

### Safetensors et cold start

Les shards workers utilisent un cache séparé et persistant :

- `VRYX_WORKER_SHARD_CACHE_DIR`
- nettoyage contrôlé via `VRYX_CLEAR_WORKER_CACHE`
- réduction des rechargements inutiles

Le but est d’éviter de recharger et reconstruire les mêmes shards à chaque session.

## Observabilité ajoutée

Les métriques suivantes remontent maintenant dans le chat P2P, les sessions et les panneaux workers :

- `compute_time_ms`
- `routing_path`
- `quicUsed`
- `kvCacheUsed`
- `hiddenTransport`
- `avgMsPerToken`
- `hotPathTps`
- `stopReason`
- `prefixCacheHit`
- `prefixCacheTokens`
- `setupMs`
- `benchmarkActualTps`
- `genControl`
- `requestedQuantization`
- `effectiveQuantization`
- `quantizationFallbackReason`
- `poolClass`
- `poolPreference`
- `poolFallbackReason`
- `batching`
- `overlap`

Le graphe réseau affiche les workers connectés par pool et évite les workers déconnectés pour ne pas casser la lisibilité.

## Correctifs de stabilité

### Anti-blocage du chat P2P

Le daemon Rust avait un état global `ChatState::Generating`. Une session lente ou bloquée pouvait empêcher toute nouvelle requête.

Correctifs :

- file d’attente FIFO pour les messages reçus pendant une génération
- timeout périodique par heartbeat
- reset automatique si plus aucun worker actif
- limite configurable `VRYX_CHAT_QUEUE_MAX`
- timeout Stage 1 configurable `VRYX_STAGE1_TIMEOUT_S`

### Filtrage des workers incompatibles

Le problème constaté ce soir venait d’un point précis : des peers étaient visibles côté P2P, mais ils annonçaient un autre modèle (`unsloth/gemma-2-9b-it`) alors que la session demandait `Qwen/Qwen3.5-9B`.

Correctif :

- l’orchestrateur filtre maintenant les workers par modèle annoncé
- les peers incompatibles sont ignorés
- si moins de deux workers compatibles restent disponibles, le chat répond immédiatement avec une erreur claire
- le VPS ne lance pas de session lente sur une pool invalide

Variable :

```bash
VRYX_REQUIRE_WORKER_MODEL_MATCH=true
```

## État actuel

Ce qui est livré :

- infrastructure Daisy Chain native
- pools MLX / PyTorch
- métriques enrichies
- choix 4-bit / 8-bit
- backend MLX strict
- kernel linear attention Qwen3.5 fonctionnel
- watchdog anti-session bloquée
- filtrage des workers incompatibles

Ce qui reste à optimiser pour atteindre 15 TPS :

- vrai scan parallèle Metal pour le recurrent state MLX
- double buffering calcul/réseau
- vLLM / TensorRT-LLM côté Nvidia
- PagedAttention complet
- quantification poids 4-bit réelle en production

## Schéma simplifié

```text
Navigateur Admin
    |
    v
API Node /api/admin/p2p/chat/stream
    |
    v
Initiateur Rust /api/chat
    |
    v
Orchestrateur Python Stage 1
    |
    +--> Sélection pool compatible Qwen/Qwen3.5-9B
    |
    v
Worker 1 ──hidden states──> Worker 2 ──hidden states──> Worker N
    |
    v
Réponse token par token + métriques
```

## Commandes utiles

```bash
# Tester l’initiateur
curl -s http://127.0.0.1:3031/api/status

# Tester le chat directement côté VPS
curl -s -H 'Content-Type: application/json' \
  -d '{"prompt":"Salut","quantization":"int8","pool_preference":"auto"}' \
  http://127.0.0.1:3031/api/chat

# Voir les workers live
curl -s http://127.0.0.1:4000/api/workers/status
```

## Conclusion

Cette mise à jour transforme Vryx d’un prototype P2P fonctionnel vers une architecture Velocity : workers persistants, pools homogènes, métriques exploitables, MLX strict et garde-fous contre les sessions bloquées.

Le verrou restant n’est plus l’orchestration : c’est le kernel MLX Metal parallèle pour le state Qwen3.5, qui doit remplacer le scan encore trop coûteux sur les vrais shards 9B.
