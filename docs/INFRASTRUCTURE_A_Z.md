# Vryx — Infrastructure de bout en bout (A à Z)

> **Document de référence.** Toujours aligné sur le code source. Mis à jour : mai 2026.

---

## Sommaire

1. [Vue d'ensemble en une phrase](#1-vue-densemble-en-une-phrase)
2. [Arborescence du monorepo](#2-arborescence-du-monorepo)
3. [Couche données — MariaDB](#3-couche-données--mariadb)
4. [Site web — React + Express](#4-site-web--react--express)
5. [Contrat réseau — gRPC (proto)](#5-contrat-réseau--grpc-proto)
6. [Daemon Rust — libp2p + Axum](#6-daemon-rust--libp2p--axum)
7. [Inférence Python — Orchestrateur & Workers](#7-inférence-python--orchestrateur--workers)
8. [Flux complet d'un chat P2P](#8-flux-complet-dun-chat-p2p)
9. [Services en production (VPS)](#9-services-en-production-vps)
10. [Variables d'environnement](#10-variables-denvironnement)
11. [Déploiement](#11-déploiement)
12. [Diagnostics courants](#12-diagnostics-courants)

---

## 1. Vue d'ensemble en une phrase

**Vryx** est un réseau DePIN : les utilisateurs contribuent leurs GPU/CPU via un **daemon Rust** (libp2p P2P), l'inférence LLM est distribuée en **pipeline parallèle** sur plusieurs workers coordonnés par un **orchestrateur Python** gRPC, et un **site React + API Express** gère l'identité, les workers, et l'administration.

---

## 2. Arborescence du monorepo

```
Vryx/
├── .gitignore
├── Cargo.toml / Cargo.lock          # Workspace Rust (membre : nodeAndWorker/rust-daemon)
├── website_deploy.py                # Déploiement front + API Node → VPS via SSH
├── vps_deploy.py                    # Déploiement bootstrap + daemon Rust → VPS
├── README.md
├── rapport.md                       # Journal de mises à jour et résultats TPS
│
├── docs/                            # Documentation technique
│   ├── INFRASTRUCTURE_A_Z.md        # Ce fichier
│   ├── ANALYSE_PIPELINE_P2P_TPS_2026-05-14.md
│   └── INFRASTRUCTURE_QWEN2_05B_PIPELINE_ET_CHANGEMENTS.md
│
├── website/
│   ├── src/                         # React 19 + Vite + TypeScript + Tailwind 4
│   │   ├── App.tsx                  # Routeur principal
│   │   ├── pages/                   # Pages publiques + admin
│   │   ├── components/admin/        # Composants admin (chat P2P, graphe pool, etc.)
│   │   ├── lib/                     # api.ts, sessions.ts
│   │   └── context/AuthContext.tsx
│   ├── server/src/
│   │   ├── index.js                 # API Express principale (auth, DB, admin, proxy P2P)
│   │   └── node-monitor.js          # Métriques système / processus pour l'admin
│   ├── docker/                      # MariaDB (docker-compose + init.sql)
│   └── package.json
│
├── nodeAndWorker/
│   ├── proto/vryx.proto             # Contrat gRPC
│   ├── rust-daemon/src/main.rs      # Daemon Rust unique (initiateur / worker / bootstrap)
│   ├── python-inference/
│   │   ├── inference_server.py      # Serveur gRPC stage 1 et stage 2
│   │   ├── distributed_llm_orchestrator.py  # Orchestrateur pipeline P2P
│   │   ├── shard_runtime.py         # Runtime shards PyTorch / MLX côté worker
│   │   ├── mlx_backend.py           # Backend MLX (Apple Silicon)
│   │   ├── batching.py              # Continuous batching et micro-batch
│   │   ├── vllm_backend.py          # Backend vLLM (préparé, Nvidia)
│   │   └── weight_quant.py          # Quantification q4
│   └── scripts/                     # Benchmarks, comparaisons, smoke tests VPS
│
└── AppMacos/                        # Client Electron (monitoring nœud local)
```

---

## 3. Couche données — MariaDB

Schéma **créé et migré automatiquement** au démarrage de `website/server/src/index.js`. Les migrations sont additive (colonnes ajoutées si absentes, jamais supprimées).

### Table `users`

| Colonne | Type | Rôle |
|---------|------|------|
| `id` | BIGINT AUTO_INCREMENT PK | Identifiant |
| `email` | VARCHAR(255) UNIQUE | Adresse e-mail |
| `password_hash` | VARCHAR(255) | bcrypt |
| `is_admin` | TINYINT(1) | Droits admin |
| `last_login_at` | TIMESTAMP | Dernière connexion |
| `created_at` | TIMESTAMP | Inscription |
| `updated_at` | TIMESTAMP | Dernière modification |

### Table `workers`

| Colonne | Type | Rôle |
|---------|------|------|
| `id` | BIGINT AUTO_INCREMENT PK | — |
| `peer_id` | VARCHAR(255) UNIQUE | PeerId libp2p |
| `mode` | ENUM('worker','initiator','bootstrap') | Rôle dans le réseau |
| `grpc_port` | INT | Port gRPC local |
| `p2p_port` | INT | Port libp2p |
| `public_ip` | VARCHAR(45) | IP vue depuis l'extérieur |
| `version` | VARCHAR(50) | Version du daemon |
| `p2p_peers` | INT | Pairs P2P actifs au dernier heartbeat |
| `tokens_generated` | BIGINT | Total généré |
| `tokens_in` | BIGINT | Tokens reçus en entrée |
| `tokens_out` | BIGINT | Tokens envoyés en sortie |
| `model` | VARCHAR(200) | Modèle déclaré |
| `user_id` | BIGINT | Lien compte utilisateur (optionnel) |
| `gpu_name` | VARCHAR(100) | Nom GPU |
| `gpu_vram_mb` | BIGINT | VRAM GPU (Mo) |
| `runtime_backend` | VARCHAR(40) | `pytorch`, `mlx`, `vllm` |
| `weight_quantization` | VARCHAR(40) | `fp16`, `int8`, `q4` |
| `supports_q4_weights` | TINYINT(1) | Capacité q4 |
| `supports_mlx` | TINYINT(1) | Capacité MLX |
| `supports_vllm` | TINYINT(1) | Capacité vLLM |
| `last_heartbeat_at` | TIMESTAMP | Dernier ping |
| `first_seen_at` | TIMESTAMP | Premier enregistrement |

### Table `p2p_chat_sessions`

| Colonne | Type | Rôle |
|---------|------|------|
| `id` | VARCHAR(80) PK | Identifiant session |
| `user_id` | BIGINT FK → users | Admin auteur |
| `prompt` | MEDIUMTEXT | Message envoyé |
| `response` | MEDIUMTEXT | Réponse générée |
| `session_json` | LONGTEXT | Objet session complet (métriques, trace pipeline) |
| `created_at` | TIMESTAMP | Création |
| `updated_at` | TIMESTAMP | Dernière MAJ |

---

## 4. Site web — React + Express

### 4.1 Frontend (React 19 + Vite + Tailwind 4)

**Routes principales (`website/src/App.tsx`) :**

| Route | Page |
|-------|------|
| `/` | Accueil |
| `/workers`, `/clients` | Contributeurs / développeurs |
| `/race-pool`, `/simulateur`, `/comparatif` | Storytelling DePIN |
| `/compte`, `/panel/modeles` | Espace utilisateur |
| `/connexion`, `/inscription` | Auth |
| `/admin` | Tableau de bord admin |
| `/admin/utilisateurs` | Gestion utilisateurs |
| `/admin/noeud` | Nœud + monitoring temps réel |
| `/admin/chat-p2p` | **Chat P2P** (SSE, métriques pipeline) |
| `/admin/workers`, `/admin/workers/:peerId` | Workers |
| `/admin/sessions`, `/admin/sessions/:sessionId` | Sessions P2P historisées |

**Composants admin notables :**

| Composant | Rôle |
|-----------|------|
| `AdminP2PChatPanel.tsx` | Chat SSE, contrôle `maxNewTokens` (32–1024), quantification, pool preference, bulles messages, métriques |
| `PoolNetworkGraph.tsx` | Graphe topologie pool (react-force-graph) |
| `WorkerComputeReport.tsx` | Barres métriques par round (TPS, latences) |
| `AdminShell.tsx` | Layout sidebar admin |
| `ConfirmDialog.tsx` | Dialogues de confirmation (sans `alert()` navigateur) |

**Bibliothèque `website/src/lib/` :**

- `api.ts` — `apiJson()` wrapper fetch avec gestion erreurs/cookies.
- `sessions.ts` — Lecture/écriture sessions localStorage **et** API DB (`saveSessionToDb`, `fetchSessionsFromDb`, etc.).

### 4.2 API Express (`website/server/src/index.js`)

**Middlewares :** Helmet, CORS configurable (`CORS_ORIGIN`), `express.json`, cookies (`cookie-parser`), JWT, rate-limiting.

#### Routes publiques

| Méthode | Chemin | Rôle |
|---------|--------|------|
| `GET` | `/api/health` | Santé |
| `POST` | `/api/auth/register` | Inscription |
| `POST` | `/api/auth/login` | Connexion (cookie JWT) |
| `POST` | `/api/auth/logout` | Déconnexion |
| `GET` | `/api/auth/me` | Session courante |
| `POST` | `/api/workers/heartbeat` | Enregistrement / mise à jour worker en DB |
| `GET` | `/api/workers/status` | Workers actifs (seuil `WORKER_OFFLINE_SEC`) |

#### Routes internes (accès restreint)

| Méthode | Chemin | Rôle |
|---------|--------|------|
| `GET` | `/api/internal/live-peers` | Workers récents pour l'orchestrateur Python (localhost + header) |
| `USE` | `/api/internal/shard-serve` | Fichiers statiques shards (`VRYX_SHARD_BASE_DIR`) |

#### Routes admin (`/api/admin/*` — nécessitent `requireAdmin`)

| Méthode | Chemin | Rôle |
|---------|--------|------|
| `GET` | `/site/stats` | Statistiques site |
| `GET` | `/users` | Liste utilisateurs |
| `PATCH` | `/users/:id/admin` | Promotion admin |
| `DELETE` | `/users/:id` | Suppression compte |
| `GET` | `/workers/live` | Workers très récents (`WORKER_LIVE_SEC`) |
| `GET` | `/workers/registered` | Historique complet workers |
| `POST` | `/workers/:peerId/actions` | Actions sur worker (disconnect / change_pool) |
| `GET` | `/pool/snapshot` | Snapshot topologie pool + graphe |
| `GET` | `/pool/stream` | **SSE** topologie pool en direct |
| `GET/POST/DELETE` | `/sessions`, `/sessions/:id` | Sessions chat P2P (DB) |
| `POST` | `/p2p/chat/stream` | **SSE chat P2P** → proxy vers initiateur Rust |
| `GET` | `/node/status`, `/node/workers`, `/node/history` | Métriques nœud via `node-monitor` |
| `POST` | `/node/test`, `/node/stress` | Tests charge |

> **Note :** `/api/admin/chat/stream` renvoie `410 Gone` — route supprimée (remplacée par `/p2p/chat/stream`).

### 4.3 Module `node-monitor.js`

Inspecte les processus `rust-daemon` / `inference_server.py`, agrège CPU/RAM/GPU (nvidia-smi, rocm-smi, repli lspci), maintient un historique glissant, et expose des endpoints test/stress. Conçu pour être **non-bloquant** si aucun daemon n'est présent.

---

## 5. Contrat réseau — gRPC (proto)

**Fichier :** `nodeAndWorker/proto/vryx.proto`

**Service `InferenceService` :**

| RPC | Arguments | Retour | Rôle |
|-----|-----------|--------|------|
| `Process` | `TensorData` | `ProcessedTensorData` | Inférence principale (tokenIds, hiddenStates, compteurs tokens, trace pipeline) |
| `ReportCapabilities` | `WorkerCapabilities` | `CapabilitiesAck` | Enregistrement capacités worker |
| `PingShardRuntime` | `ShardInit` | `ActivationTensor` | Warmup / ping |

**Messages clés :** `ShardInit`, `ShardLoad`, `ForwardPass`, `ShardUnload` — cycle de vie d'un shard éphémère.

**Limites de message :** jusqu'à **1 Go** côté Rust (tonic) et Python (grpc.aio) pour accommoder les tranches de poids et les grands tenseurs.

---

## 6. Daemon Rust — libp2p + Axum

**Fichier :** `nodeAndWorker/rust-daemon/src/main.rs`  
**Binaire :** un seul binaire, trois modes (`--mode worker | initiator | bootstrap`).

### 6.1 Composants internes

| Composant | Description |
|-----------|-------------|
| `vryx_codec` | Codec JSON request-response libp2p, limite **512 Mo** par message |
| `VryxBehaviour` | NetworkBehaviour composite : TCP, Noise, Yamux, Kademlia, identify, relay, DCUtR, AutoNAT, mDNS, request-response |
| `GRPC_CHANNELS` | Cache statique de canaux tonic (`OnceLock`) — évite de re-créer la connexion gRPC à chaque requête |
| `call_local_inference` | Appel gRPC vers Python local avec **4 tentatives** et purge de cache sur erreur transport |
| `routing_path_from_trace` | Extraction du `routing_path` depuis le JSON trace pour les réponses HTTP |
| `env_u64_clamped` | Lecture variable d'env avec clamp min/max |

### 6.2 Routes Axum (mode initiateur)

| Méthode | Chemin | Rôle |
|---------|--------|------|
| `GET` | `/api/status` | Statut nœud (peer_id, connexions, compteurs tokens, dernière trace shard) |
| `GET` | `/api/tp-peers` | Topologie peers / layout hint pour l'UI |
| `POST` | `/api/chat` | **Chat LLM** — relaie vers gRPC Python stage 1 |
| `POST` | `/api/p2p/relay` | **Relais P2P** — transmet un `TensorRequest` au peer cible via libp2p |

### 6.3 Fonctionnement Daisy Chain

```
Initiateur Rust
  → POST /api/p2p/relay {target: worker1}
    → libp2p request-response → Worker1 Rust
      → gRPC Python stage 2 → forward couches 0-15
      → TensorResponse hidden_states
  → POST /api/p2p/relay {target: worker2}
    → libp2p request-response → Worker2 Rust
      → gRPC Python stage 2 → forward couches 16-31 + lm_head
      → TensorResponse next_token_id
  → Boucle jusqu'à EOS ou MAX_NEW_TOKENS
```

### 6.4 Reconnexion gRPC automatique

Après un redémarrage de `inference_server.py`, le canal tonic en cache devient invalide. `call_local_inference` purge le cache et réessaie jusqu'à 4 fois avec backoff (200 ms, 600 ms, 1000 ms, 1400 ms) sur toute erreur transport (connection refused, broken pipe, cancelled, unavailable, etc.).

---

## 7. Inférence Python — Orchestrateur & Workers

### 7.1 `inference_server.py` — Serveur gRPC

Point d'entrée CLI : `python inference_server.py --stage {1|2} --port {port}`.

**Stage 1 (VPS / initiateur) :**
- Reçoit `TensorData` depuis le Rust local.
- Délègue à `distributed_llm_orchestrator.run_pipeline_chat()`.
- Renvoie la réponse JSON sérialisée (tokens, métriques, `pipeline_trace_json`).

**Stage 2 (worker) :**
- Reçoit les dtypes : `vryx.shard.init`, `vryx.shard.load`, `vryx.shard.forward`, `vryx.shard.unload`, `vryx.mlx_lm.generate`.
- Délègue à `shard_runtime` ou à `mlx_lm_direct_generate` (chemin `mlx_lm_direct_p2p`).

### 7.2 `distributed_llm_orchestrator.py` — Cœur du pipeline

**Responsabilités :**

1. **Découverte de workers** : sonde `/api/internal/live-peers` (Node local), puis `/api/workers/status` (catalogue public), puis `/api/tp-peers` (initiateur Rust) — avec filtres modèle, VRAM, runtime.

2. **Découpe du modèle** : calcule la répartition des couches Transformer entre les workers disponibles.

3. **Init des shards** : envoie `vryx.shard.init` + `vryx.shard.load` (poids float16 numpy en base64) via relais P2P à chaque worker.

4. **Boucle autorégressive** : tokenise le prompt, envoie les token_ids au premier worker, reçoit `next_token_id` du dernier, accumule jusqu'à EOS ou `MAX_NEW_TOKENS`.

5. **Micro-batching** : avec un seul worker et greedy (température ≤ 0), envoie un `micro_decode_budget` pour générer plusieurs tokens par aller-retour WAN → réduit la latence perçue.

6. **Chemin `mlx_lm_direct_p2p`** : activé par `VRYX_MLX_LM_DIRECT=1`. Court-circuite le pipeline shard : envoie directement une requête de génération complète au worker cible via `vryx.mlx_lm.generate` (utilise `mlx-lm` officiel). Atteint **25+ TPS** sur Qwen3.5 9B avec Apple Silicon.

### 7.3 `shard_runtime.py` — Runtime côté worker

Gère le cycle de vie des shards éphémères (`PipelineShard`, `EphemeralShardSession`). Backends :

| Backend | Classe | Usage |
|---------|--------|-------|
| PyTorch | `PyTorchBackend` | GPU Nvidia / CPU |
| MLX | `MLXBackend` (mlx_backend.py) | Apple Silicon |
| vLLM | `VLLMBackend` (vllm_backend.py) | Nvidia haute performance (préparé) |

**`mlx_lm_direct_generate`** : génération directe via la bibliothèque officielle `mlx-lm` (cache par modèle, `mlx_lm.generate`). Contourne le pipeline shard custom pour `Qwen3.5 9B`.

### 7.4 `mlx_backend.py` — Backend MLX

- Implémentation native Metal/MLX des forwards d'attention (GQA, RoPE, biaises q/k/v/o).
- Quantification int8/q4 des poids et des hidden states pour réduire la bande passante.
- Variable `VRYX_ENABLE_MLX_RUNTIME` requise pour activation.

### 7.5 `batching.py` — Continuous batching

`BatchQueue` + `BatchItem` + `BatchFuture` : file d'attente de requêtes de décodage. Actif avec `VRYX_CONTINUOUS_BATCHING=1`.

---

## 8. Flux complet d'un chat P2P

```
┌────────────────────────────────────────────────────────────────────┐
│ Navigateur (admin)                                                 │
│  POST /api/admin/p2p/chat/stream                                   │
│  {prompt, maxNewTokens, quantization, pool_preference}             │
└────────────────────────┬───────────────────────────────────────────┘
                         │ SSE (text/event-stream)
┌────────────────────────▼───────────────────────────────────────────┐
│ API Express (Node.js PM2 :4000)                                    │
│  • Vérifie JWT admin                                               │
│  • Envoie des événements SSE de progression au navigateur          │
│  • Fetch POST → http://127.0.0.1:3031/api/chat (initiateur Rust)   │
└────────────────────────┬───────────────────────────────────────────┘
                         │ HTTP JSON
┌────────────────────────▼───────────────────────────────────────────┐
│ Daemon Rust — Initiateur (:3031)                                   │
│  • Reçoit la requête chat                                          │
│  • Pré-fetch workers depuis /api/workers/status si nécessaire      │
│  • Appel gRPC → Python stage 1 (:50051)                            │
└────────────────────────┬───────────────────────────────────────────┘
                         │ gRPC Process(TensorData)
┌────────────────────────▼───────────────────────────────────────────┐
│ Python Stage 1 — Orchestrateur (:50051)                            │
│  • Découverte workers (live-peers → status → tp-peers)             │
│  • Découpe modèle en N shards selon workers disponibles            │
│  • Init shards : vryx.shard.init + vryx.shard.load via relais P2P  │
│                                                                    │
│  Si VRYX_MLX_LM_DIRECT=1 :                                         │
│  • POST relais → vryx.mlx_lm.generate → worker cible              │
│  • Reçoit texte complet, ~25 TPS (Qwen3.5 9B MLX)                 │
│                                                                    │
│  Sinon (pipeline standard) :                                       │
│  • Boucle autorégressive token par token (ou micro-batch N tokens) │
│  • POST relais → worker1 → … → workerN → next_token_id            │
└────────────────────────┬───────────────────────────────────────────┘
                         │ POST /api/p2p/relay (HTTP)
┌────────────────────────▼───────────────────────────────────────────┐
│ Daemon Rust — Initiateur (relais)                                  │
│  • TensorRequest → libp2p request-response → Worker(s)            │
└────────────────────────┬───────────────────────────────────────────┘
                         │ libp2p
┌────────────────────────▼───────────────────────────────────────────┐
│ Daemon Rust — Worker (:p2p_port)                                   │
│  • Reçoit TensorRequest                                            │
│  • Appel gRPC → Python stage 2 (:50052)                            │
│  • Renvoie TensorResponse (hidden_states ou next_token_id)         │
└────────────────────────┬───────────────────────────────────────────┘
                         │ gRPC Process(TensorData)
┌────────────────────────▼───────────────────────────────────────────┐
│ Python Stage 2 — Worker (:50052)                                   │
│  • shard_runtime : forward des couches assignées                   │
│  • Backend : PyTorch / MLX / mlx-lm direct                        │
└────────────────────────────────────────────────────────────────────┘
```

**Retour :** le chemin inverse remonte jusqu'à l'orchestrateur, qui construit le JSON final (`pipeline_trace_json`, TPS, latences). L'API Express enrichit avec les données DB du worker et stream la réponse mot par mot en SSE au navigateur.

---

## 9. Services en production (VPS)

### systemd

| Unité | ExecStart | Rôle |
|-------|-----------|------|
| `vryx-bootstrap.service` | `rust-daemon --mode bootstrap --p2p-port 9090` | Nœud d'entrée DHT stable |
| `vryx-initiator.service` | `rust-daemon --mode initiator --api-port 3031 --grpc-port 50051` | API chat + relais P2P |
| `vryx-inference-stage1.service` | `inference_server.py --stage 1 --port 50051` | Orchestrateur Python |

**Drop-in actif sur `vryx-inference-stage1` :**
```ini
# /etc/systemd/system/vryx-inference-stage1.service.d/zzzzz-mlx-lm-direct.conf
[Service]
Environment=VRYX_MLX_LM_DIRECT=1
Environment=VRYX_DIST_MODEL=Qwen/Qwen3.5-9B
Environment=VRYX_DIST_MIN_WORKERS=1
Environment=VRYX_DIST_MAX_WORKERS=1
Environment=VRYX_DIST_MAX_TOKENS=512
Environment=VRYX_POOL_PREFERENCE=auto
```

### PM2

| App | Fichier | Rôle |
|-----|---------|------|
| `vryx-api` | `website/server/src/index.js` | API Express + front statique |

**Commandes utiles :**
```bash
pm2 status
pm2 logs vryx-api --lines 100
pm2 restart vryx-api

systemctl status vryx-initiator vryx-inference-stage1
journalctl -u vryx-inference-stage1 -n 50 -f
```

### Nginx

Proxy TLS → PM2 Node `:4000`. La configuration n'est pas versionnée dans ce dépôt.

---

## 10. Variables d'environnement

### API Node (`website/server/env.example`)

| Variable | Défaut | Rôle |
|----------|--------|------|
| `PORT` | `4000` | Port Express |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | — | MariaDB |
| `JWT_SECRET` | — | **Obligatoire** |
| `JWT_EXPIRES_DAYS` | `7` | Durée cookie JWT |
| `ADMIN_EMAILS` | — | CSV emails promus admin au démarrage |
| `CORS_ORIGIN` | — | Origines autorisées |
| `VRYX_INITIATOR_CHAT_URL` | `http://127.0.0.1:3031` | URL daemon Rust initiateur |
| `VRYX_ALLOWED_INITIATOR_CHAT_PREFIXES` | — | CSV préfixes autorisés pour surcharge URL |
| `WORKER_LIVE_SEC` | `15` | Seuil « live » pour `/workers/live` |
| `WORKER_OFFLINE_SEC` | `90` | Seuil « offline » pour `/workers/status` |
| `VRYX_SHARD_BASE_DIR` | `/var/tmp/vryx-shards` | Répertoire shards statiques |

### Orchestrateur Python (sélection)

| Variable | Défaut | Rôle |
|----------|--------|------|
| `VRYX_DIST_MODEL` | `Qwen/Qwen3.5-9B` | Modèle HuggingFace |
| `VRYX_DIST_MAX_TOKENS` | `512` | Tokens max générés |
| `VRYX_P2P_RELAY_URL` | `http://127.0.0.1:3031` | URL relais Rust |
| `VRYX_API_URL` | — | URL API publique (heartbeats, catalogue) |
| `VRYX_MLX_LM_DIRECT` | `0` | `1` = chemin `mlx_lm_direct_p2p` (Qwen3.5 9B, 25+ TPS) |
| `VRYX_DIST_MIN_WORKERS` | `1` | Workers minimum pour démarrer |
| `VRYX_DIST_MAX_WORKERS` | `4` | Workers maximum dans la Daisy Chain |
| `VRYX_DECODE_MICROBATCH` | `1` | Micro-batching activé |
| `VRYX_DECODE_MICROBATCH_CAP` | `32` | Tokens par aller-retour WAN max |
| `VRYX_CONTINUOUS_BATCHING` | `0` | Batching continu multi-sessions |
| `VRYX_WORKER_KV_CACHE` | `0` | KV cache inter-tours |
| `VRYX_DIST_TIMEOUT_SEC` | `600` | Timeout pipeline global |
| `VRYX_PIPELINE_STEP_TIMEOUT_SEC` | `600` | Timeout par étape |

### Daemon Rust (CLI)

Les paramètres sont principalement en **arguments CLI** (`clap`) : `--mode`, `--grpc-port`, `--p2p-port`, `--api-port`, `--bootstrap-node`, `--api-url`, `--model`, `--node-key-file`.

---

## 11. Déploiement

### Site + API Node

```bash
python3 website_deploy.py
```

Le script :
1. `npm run build` en local (React).
2. SSH vers le VPS (`ubuntu@51.222.26.225`).
3. Copie `dist/` et `server/` via SFTP.
4. `npm install --production` sur le serveur.
5. `pm2 restart vryx-api`.
6. Vérifie `/api/health`.

### Orchestrateur Python

```bash
sshpass -p '…' ssh ubuntu@51.222.26.225
scp distributed_llm_orchestrator.py ubuntu@51.222.26.225:/opt/vryx/python-inference/
sudo systemctl restart vryx-inference-stage1
```

### Daemon Rust

```bash
python3 vps_deploy.py
# Ou manuellement :
cargo build --release
scp target/release/rust-daemon ubuntu@51.222.26.225:/opt/vryx/
sudo systemctl restart vryx-initiator
```

---

## 12. Diagnostics courants

### Chat P2P — « fetch failed » ou « Erreur P2P »

Le proxy Node vers l'initiateur Rust a échoué.

```bash
# Sur le VPS :
curl -sfS http://127.0.0.1:3031/api/status
systemctl status vryx-initiator vryx-inference-stage1
journalctl -u vryx-inference-stage1 -n 30
```

Vérifier `VRYX_INITIATOR_CHAT_URL` dans `.env` du serveur Node.

### API — 502 Bad Gateway

Node (PM2) ne répond pas.

```bash
pm2 status
pm2 logs vryx-api --lines 50
curl -sfS http://127.0.0.1:4000/api/health
pm2 restart vryx-api
```

Causes fréquentes : `JWT_SECRET` absent, erreur d'import JS, port 4000 déjà utilisé.

### API — 429 Too Many Requests (connexion)

Rate limiter (20 req/min sur `/api/admin/p2p/chat/stream`). Patienter 1 minute.

### Orchestrateur — workers non trouvés

```bash
# Vérifier le catalogue depuis le VPS :
curl -sfS http://127.0.0.1:4000/api/internal/live-peers \
  -H "X-Internal-Token: $(grep VRYX_INTERNAL_TOKEN /opt/vryx/server/.env | cut -d= -f2)"
curl -sfS https://vryx.eu/api/workers/status | python3 -m json.tool | head -30
```

### Daemon Rust — reconnexion gRPC

Si `inference_server.py` a été redémarré, le canal tonic en cache peut être invalide. Le daemon effectue **4 tentatives automatiques** avec purge du cache. Si le problème persiste : `systemctl restart vryx-initiator`.

### VPS — espace disque épuisé (shards)

```bash
du -sh /var/tmp/vryx-shards/
sudo rm -rf /var/tmp/vryx-shards/*
sudo systemctl restart vryx-inference-stage1
```
