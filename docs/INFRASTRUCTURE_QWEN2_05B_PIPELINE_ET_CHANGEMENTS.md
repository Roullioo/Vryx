# Infrastructure Vryx — fonctionnement complet et changements (référence Qwen2 0.5B)

**Objectif de ce document :** une vue **d’ensemble lisible** du pipeline P2P worker-only / Daisy Chain, puis un **inventaire structuré des évolutions** depuis l’usage intensif de **`Qwen/Qwen2-0.5B-Instruct`** comme modèle de référence pour les tests stage 1 et les workers distants (sans prétendre remplacer tous les détails de [`docs/INFRASTRUCTURE_A_Z.md`](INFRASTRUCTURE_A_Z.md) ni [`nodeAndWorker/INFRASTRUCTURE_VRYX.md`](../nodeAndWorker/INFRASTRUCTURE_VRYX.md)).

**Dernière consolidation :** mai 2026 (code + rapports du dépôt).

---

## Table des matières

1. [Principe et acteurs](#1-principe-et-acteurs)
2. [Chemin produit : admin chat P2P natif](#2-chemin-produit--admin-chat-p2p-natif)
3. [Worker-only : stage 1 Python, initiateur Rust, worker distant](#3-worker-only--stage-1-python-initiateur-rust-worker-distant)
4. [Téléchargement des shards (`shard-serve`) et annuaire des peers](#4-téléchargement-des-shards-shard-serve-et-annuaire-des-peers)
5. [Modèle `Qwen/Qwen2-0.5B-Instruct` dans la stack](#5-modèle-qwenqwen2-05b-instruct-dans-la-stack)
6. [Débit (TPS) — ce qui est mesuré et où sont les goulots](#6-débit-tps--ce-qui-est-mesuré-et-où-sont-les-goulots)
7. [Changements récents depuis l’orientation « Qwen2 0.5B »](#7-changements-récents-depuis-lorientation-qwen2-05b-code--outillage)
8. [Fichiers et commandes utiles](#8-fichiers-et-commandes-utiles)

---

## 1. Principe et acteurs

**Vryx** combine :

- Un **site web** (React, API Node.js, MariaDB) pour comptes, admin, heartbeats workers.
- Des **daemons Rust** (`rust-daemon`) avec **libp2p** (TCP, QUIC selon build, mDNS en LAN, bootstrap possible vers un nœud public).
- Des serveurs **Python gRPC** (`inference_server.py`) en **stage 1** (côté hôte initiateur — souvent VPS) ou **stage 2** (worker GPU / Mac).

Le **pipeline distribué** ne charge **pas le modèle complet sur le VPS** : le stage 1 tient tokenizer + configs + slicing des poids sur disque ; les workers reçoivent des **shards** (tranches de couches), font les forwards (**PyTorch**, **MLX** sur Apple Silicon, ou chemins préparés vLLM), et renvoient des **états intermédiaires** jusqu’à la tête **`lm_head`** sur le dernier segment.

Contrat réseau : proto **gRPC** [`nodeAndWorker/proto/vryx.proto`](../nodeAndWorker/proto/vryx.proto).

---

## 2. Chemin produit : admin chat P2P natif

1. Navigateur (**admin**) → **`POST /api/admin/p2p/chat/stream`** (Express, [`website/server/src/index.js`](../website/server/src/index.js)), authentifié admin.
2. Node ouvre une **SSE** vers le navigateur (`text/event-stream`) et, en interne, appelle l’**initiateur Rust** (`fetch` configurable : **`VRYX_INITIATOR_CHAT_URL`**), souvent **`http://127.0.0.1:3031`** sur l’hôte où tourne Node / PM2 ou derrière **`host.docker.internal`** si Docker.
3. **`POST /api/chat`** du daemon **initiator** Axum agrège **`prompt`**, **`quantization`/`hidden_transport`** (`fp16`, `int8`, `q4`), **`pool_preference`** (`auto`, `velocity_mlx`, …), éventuellement **`max_new_tokens`**, puis relaie au **stage 1 gRPC**.
4. Le stage 1 Python exécute l’**orchestrateur** (**`distributed_llm_orchestrator.maybe_run_worker_only_chat`**) si **`VRYX_WORKER_ONLY_LLM=1`** : découvre les peers, init shards, boucle de décodage via **`POST /api/p2p/relay`** sur le même initiateur.
5. Le Rust **réexpédie** les payloads vers le **worker** en **P2P** (circuits libp2p).
6. Quand le JSON final remonte jusqu’à Node, SSE envoie le texte (+ métriques). Tant que l’étape 4 n’a pas fini **tout** le calcul, la phase **`awaiting_initiator`** peut sembler très longue (messages de statut côté serveur Node toutes les ~2 s).

**Routes Node utiles hors admin :**

- **`GET /api/internal/live-peers`** — pairs workers pour découverte locale (avec garde‑fous localhost + jeton interne).
- **`/api/internal/shard-serve/...`** — fichiers shards statiques (Express `express.static`), important en prod quand **`VRYX_API_URL`** est privé mais les GPU doivent **télécharger** manifestes `.json` et binaires.

---

## 3. Worker-only : stage 1 Python, initiateur Rust, worker distant

Résumé du flux **`maybe_run_worker_only_chat`** :

1. **`_discover_live_peers()`** construit une liste non vide ou échoue tôt avec une erreur explicite. **Priorité** : variable **`VRYX_DIST_PEER_IDS`** (liste **`peerId`** séparés par virgule), puis tentative **`/api/internal/live-peers`**, puis **`GET {RELAY_URL}/api/tp-peers`**, puis registre **public** (`/api/workers/status`, etc.).
2. **`run_pipeline_chat`** : prépare les **sessions** shard, construit URLs **`download_url`** (base **`_worker_shard_download_base_url()`**, **`VRYX_SHARD_DOWNLOAD_BASE_URL`** explicite prioritaire sur **`VRYX_API_URL` / fallback public** — voir orchestrateur).
3. **Boucle de décodage** (voir §7) : à chaque tour relais le worker peut renvoyer plusieurs jetons (**micro-batch greedy**) ; gardes (**EOS**, **stop_token_ids**, **repetition_guard**, borne **`max_new_tokens`**, **`min(MAX_NEW_TOKENS, valeur requête)`**).
4. Résultat : texte UTF‑8 et **`pipeline_trace_json`** riches (relay ms, quantization effective, pooling, benchmarks).

**Ports typiques** (`quick-local-p2p.sh`, `test_worker_only_llm.sh`) :

| Service | Port (exemple) |
|---------|----------------|
| Worker Python gRPC | 50052 |
| Worker daemon Axum | 3031 |
| Worker libp2p | 4002 |
| Initiator Python gRPC | 50051 |
| Initiator Axum **`/api/chat`** | 3030 |
| Initiator libp2p | 4003 |
| Serveur fichiers shards local | 18765 |
| Racine shards disque | `VRYX_SHARD_BASE_DIR` |

### Chaîne relais (`VRYX_PIPELINE_CHAIN_MODE`) et placement de l’initiateur

- **Défaut code** : **`initiator_sequential`** ([`distributed_llm_orchestrator.py`](../nodeAndWorker/python-inference/distributed_llm_orchestrator.py) — variable **`PIPELINE_CHAIN_MODE`**). Les scripts [`start-initiator.sh`](../nodeAndWorker/start-initiator.sh), [`start-3-workers-mac.sh`](../nodeAndWorker/start-3-workers-mac.sh) et [`start-3-workers-mlx.sh`](../nodeAndWorker/start-3-workers-mlx.sh) réexportent la même valeur par défaut.
- **Rôle** : pour une **Daisy Chain multi-workers**, les forwards **`hidden_states`** peuvent transiter **worker → worker** via le relais initiateur **sans** repasser par le processus Python stage 1 à chaque hop intermédiaire (selon la topologie effective du relais). Le mode alternatif **`vps_sequential`** n’apparaît dans le dépôt que comme **option** dans l’orchestrateur ; **aucun script shell livré ne le force par défaut** — pour réduire la latence perçue « tout repasse par Paris », privilégier **`initiator_sequential`** (déjà le cas) **et** rapprocher **physiquement** le couple **daemon Rust initiateur + stage 1 Python** des workers (ex. **même Mac / même LAN** que dans [`quick-local-p2p.sh`](../nodeAndWorker/quick-local-p2p.sh)), puis pointer **`VRYX_P2P_RELAY_URL`** (stage 1) et **`VRYX_INITIATOR_CHAT_URL`** (Node admin) vers cet hôte.
- **Rappel** : le navigateur admin parle toujours à **Node** ; seul le déplacement de l’**initiateur Rust** (+ éventuellement du **stage 1** sur la même machine) réduit RTT **P2P** et **HTTP relay** jusqu’aux workers.

---

## 4. Téléchargement des shards (`shard-serve`) et annuaire des peers

Sans un **serveur HTTP** joignable par le worker sur **`/api/internal/shard-serve/<session>/...`**, les workers peuvent retomber sur **`https://vryx.eu/...`** avec **manifeste absent (404)** et bloquer le pipeline. D’où :

- **Prod** : Express ou Nginx sert **`VRYX_SHARD_BASE_DIR`**.
- **Local** : **`scripts/shard_serve_local.py`** + **`export VRYX_SHARD_DOWNLOAD_BASE_URL=http://127.0.0.1:<port>`** (voir **`quick-local-p2p.sh`**).

**Piège corrigé dans les scripts** : `maybe_run_worker_only_chat` passe par **`_discover_live_peers`** qui lit **`VRYX_DIST_PEER_IDS`** en premier. **`VRYX_TP_PEER_IDS`** sert surtout le **tensor parallel** — les deux variables sont désormais posées ensemble dans **`test_worker_only_llm.sh`** et **`quick-local-p2p.sh`**.

---

## 5. Modèle `Qwen/Qwen2-0.5B-Instruct` dans la stack

- **Runtime PyTorch shard** : tranche **`_Qwen2WorkerSlice`** dans [`shard_runtime.py`](../nodeAndWorker/python-inference/shard_runtime.py) (`Qwen2DecoderLayer`, `Qwen2RMSNorm`, RoPE selon transformers).
- **Défaut code sans environnement** : dans l’orchestrateur, `MODEL_ID` reste défini comme **`os.environ.get("VRYX_DIST_MODEL", "Qwen/Qwen3.5-9B")`** — le **0.5B** doit être forcé via **`VRYX_DIST_MODEL`** (stage 1) et **`--model`** cohérent côté worker annoncé.
- **Heuristiques coupe workers** (`_default_max_workers_for_model`) incluent motifs **`0.5b`** / **`qwen2.5-0.5b`**.
- Les traces **`benchmark`** reflètent surtout **RTT relay × nombre de tours** × **temps MLX/PyTorch** ; elles sont comparables uniquement avec la même topo réseau et le même **`decode_cap`**.

---

## 6. Débit (TPS) — ce qui est mesuré et où sont les goulots

Sur **WAN** avec logs stage 1 observés (**Qwen2 0.5B**, un worker, Daisy Chain courte) :

- ordre **~2 TPS au mieux** sur la partie **complétion** lorsqu’un **nouveau jeton imposait un aller-retour relais (~460–525 ms/token)** avant micro-batch bien exploité bout-en-bout.

**Limite physique** : tout chemin où **chaque jeton exige une requête relais jusqu’à l’initiateur** borne le TPS par **inverse de la RTT** ; **`> 10 TPS`** sur tout le trajet admin→VPS→P2P→worker WAN est en général **hors réalisme sans LAN, batching très agressif ou speculative forte**.

Les changements **`VRYX_DECODE_MICROBATCH*`** réduisent le **nombre de tours relay par jetons générés** (greedy, KV, mono-hop).

---

## 7. Changements récents depuis l’orientation « Qwen2 0.5B » (code + outillage)

Complément direct à **`rapport.md`** (SSE admin, `fp16`, `max_new_tokens`).

### Orchestrateur [`distributed_llm_orchestrator.py`](../nodeAndWorker/python-inference/distributed_llm_orchestrator.py)

- **`VRYX_DECODE_MICROBATCH`** (défaut actif sauf désactivation **0/off**) et **`VRYX_DECODE_MICROBATCH_CAP`** (défaut **32**, max 64) : champ **`micro_decode_budget`** dans le payload pipeline.
- Boucle **`while len(generated_ids) < decode_cap`** + borne **`relay_iteration_guard`** au lieu du **`for range(decode_cap)`** qui perdait les jetons supplémentaires par réponse relay.
- Consommation des réponses **`decode_microbatch`**, **`candidate_token_ids`**, **`accepted_token_count`** (y compris sans speculative heads uniquement).
- **`_relay_try_http_keepalive`** + **`http.client`** en **thread-local** pour **`http://`** ; repli **`urllib`**.
- Découverte peers secours (**`/api/workers/status`**) documentée dans l’entête du module.

### Worker MLX [`mlx_backend.py`](../nodeAndWorker/python-inference/mlx_backend.py)

- Boucle greedy locale après **`lm_head`** (conditions : **`temperature ≤ 0`**, **`micro_decode_budget > 1`**, KV, **`single_token_stateful`**, etc.) avec **`mlx_run_transformer`** ; métadonnées **`decode_microbatch`**, **`accepted_token_count`** ; plafond **`VRYX_DECODE_MICROBATCH_CAP`** aligné sur l’orchestrateur (défaut **32**).

### Sélection backend MLX strict [`shard_runtime.py`](../nodeAndWorker/python-inference/shard_runtime.py)

- **`VRYX_MLX_STRICT=1`** (ou historique **`VRYX_DISABLE_PYTORCH_FALLBACK=1`**) : backend demandé **`mlx`** — **aucun** fallback **`PyTorchBackend`** silencieux si MLX est indisponible ou à l’import ; erreur explicite ou backend MLX « dur » qui échouera au forward.

### Scripts et QA

| Fichier | Rôle |
|---------|------|
| [`nodeAndWorker/quick-local-p2p.sh`](../nodeAndWorker/quick-local-p2p.sh) | Shard HTTP local ; **`VRYX_DIST_PEER_IDS`** ; **MLX défaut Darwin arm64** ; **`VRYX_DECODE_MICROBATCH_CAP` 32** ; **`POOL_PREFERENCE`** **velocity_mlx** par défaut. Pour **MLX strict** sans PyTorch de secours : **`export VRYX_MLX_STRICT=1`** sur le worker (voir **`shard_runtime._select_backend`**). |
| [`nodeAndWorker/scripts/bench_local_chat_tps.py`](../nodeAndWorker/scripts/bench_local_chat_tps.py) | Bench **TPS** `POST /api/chat` avec warmup ; avertit si peu de **`completion_tokens`**. |
| [`nodeAndWorker/python-inference/test_orchestrator_smoke_aggregate.py`](../nodeAndWorker/python-inference/test_orchestrator_smoke_aggregate.py) | Smoke **unittest** (motifs + logique agrégation). |
| [`nodeAndWorker/test_worker_only_llm.sh`](../nodeAndWorker/test_worker_only_llm.sh) | **`VRYX_DIST_PEER_IDS`** ajouté. |
| [`RAPPORT_DEPLOY_TESTS_WORKER_ONLY.md`](../RAPPORT_DEPLOY_TESTS_WORKER_ONLY.md) | Section smoke ; **`quick-local-p2p`** ; variables micro-batch. |

---

## 8. Fichiers et commandes utiles

**Documentation transversale (détail)**  

- [`docs/INFRASTRUCTURE_A_Z.md`](INFRASTRUCTURE_A_Z.md)  
- [`nodeAndWorker/INFRASTRUCTURE_VRYX.md`](../nodeAndWorker/INFRASTRUCTURE_VRYX.md)  

**Exemple minimal local avec 0.5B**

```bash
cd nodeAndWorker
export VRYX_DIST_MODEL=Qwen/Qwen2-0.5B-Instruct
./quick-local-p2p.sh start
curl -sfS http://127.0.0.1:3030/api/status
./scripts/bench_local_chat_tps.py
./quick-local-p2p.sh stop
```

**Variables critiques worker-only hors prod**

```bash
export VRYX_WORKER_ONLY_LLM=1
export VRYX_DIST_MODEL=Qwen/Qwen2-0.5B-Instruct
export VRYX_DIST_PEER_IDS='<peerId>'
export VRYX_SHARD_DOWNLOAD_BASE_URL=http://127.0.0.1:18765    # avec shard_serve_local
export VRYX_P2P_RELAY_URL=http://127.0.0.1:3030
export VRYX_PIPELINE_CHAIN_MODE=initiator_sequential
export VRYX_RUNTIME_BACKEND=mlx
export VRYX_MLX_STRICT=1
export VRYX_ENABLE_MLX_RUNTIME=1
export VRYX_ENABLE_MLX_KERNELS=1
# Option charge mémoire : export VRYX_DECODE_MICROBATCH_CAP=64
```

---

*En cas de divergence entre anciens fichiers ponctuels et le comportement observé au runtime, faire foi au **code** dans `python-inference/` et aux trois documents listés §8.*
