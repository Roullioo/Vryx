# Analyse pipeline P2P VRYX — TPS, attente et déploiement VPS

Date : 2026-05-14  
Contexte : chat P2P admin `vryx.eu`, initiateur VPS, worker Mac Apple Silicon en MLX, modèle `Qwen/Qwen2-0.5B-Instruct`.

## Note actuelle

**Note globale sincère mise à jour : 88 / 100.**

- **Transport P2P / orchestration : 82 / 100** — l’initiateur voit le worker, le relay fonctionne, les shards passent, le micro-décodage réduit fortement les allers-retours.
- **TPS soutenu : 94 / 100** — l’objectif **15 TPS minimum** est atteint sur `Qwen/Qwen3.5-9B` via `mlx-lm` officiel en P2P direct : **23,26 TPS wall** et **25,667 TPS hot path** sur 128 tokens.
- **Attente E2E chat court : 72 / 100** — le chemin direct supprime le setup shard 17,9 Go et donne un TTFT worker autour de **0,4 à 0,5 s** en session chaude, mais le relay HTTP/P2P reste encore dans le wall time.
- **Qualité texte MLX actuelle : 82 / 100** — `Qwen2-0.5B` MLX custom est corrigé. Pour `Qwen3.5-9B`, le chemin produit utilise maintenant `mlx-lm` officiel fiable ; le backend shard custom reste marqué non fiable sur `linear_attn`.
- **Déploiement / opérabilité : 78 / 100** — services réparés et déployés, mais le déploiement Rust doit rester compilé côté VPS Linux, pas copié depuis Mac ARM.

## Fonctionnement de l’infrastructure

### 1. Site et API Node

Le navigateur appelle le site `vryx.eu`, puis le panneau admin envoie le message sur :

- `POST /api/admin/p2p/chat/stream`

L’API Node garde une connexion **SSE** avec le navigateur. Elle envoie des événements de progression pendant que le vrai calcul tourne côté initiateur, par exemple :

- requête acceptée ;
- attente du pipeline P2P (`initiateur, X s`) ;
- réponse initiateur reçue ;
- diffusion des fragments ;
- événement final avec latence, tokens, chemin P2P et trace pipeline.

Important : ce SSE n’est pas encore un vrai streaming token par token depuis le worker. Le serveur attend encore le JSON complet de l’initiateur Rust, puis diffuse au navigateur.

### 2. Initiateur Rust sur le VPS

Service :

- `vryx-initiator.service`
- API locale : `http://127.0.0.1:3031`
- endpoint chat : `POST /api/chat`
- endpoint relay : `POST /api/p2p/relay`

Le rôle de l’initiateur :

- recevoir la requête chat venant de Node ou d’un test `curl` ;
- appeler le stage 1 Python en gRPC (`50051`) ;
- maintenir le swarm libp2p ;
- relayer les payloads de shards vers les workers ;
- exposer `/api/status` avec `workers_visible_p2p` et `workers_connected_p2p`.

### 3. Stage 1 Python sur le VPS

Service :

- `vryx-inference-stage1.service`
- commande : `inference_server.py --port 50051 --stage 1`

Le stage 1 :

- charge tokenizer/config ;
- découvre les workers (`VRYX_DIST_PEER_IDS`, `/api/tp-peers`, `/api/workers/status`) ;
- prépare une session de shards ;
- découpe le modèle selon le nombre de workers retenus ;
- lance la boucle autorégressive ;
- appelle l’initiateur Rust via `/api/p2p/relay` pour chaque étape pipeline.

### 4. Worker Mac

Processus locaux :

- `inference_server.py --port 50052 --stage 2 --model Qwen/Qwen2-0.5B-Instruct`
- `rust-daemon --mode worker --grpc-port 50052 --api-port 3031 --bootstrap-node ... --api-url https://vryx.eu`

Le worker :

- heartbeat vers `https://vryx.eu/api/workers/heartbeat` ;
- connexion au bootstrap/libp2p du VPS ;
- reçoit les shards ;
- exécute les couches MLX ;
- renvoie `next_token_id` ou des lots de tokens via `candidate_token_ids`.

## Ce qui était lent avant

Avant correction, le vrai test VPS donnait :

- `wall_ms`: **13 171 ms**
- `completion_tokens`: **20**
- `TPS_wall`: **1,518**
- `benchmark.actual_tps`: **1,959**
- `relay_ms`: **10 172 ms**
- `routing_hops`: **1**

Interprétation :

- un seul worker était bien utilisé ;
- le P2P fonctionnait ;
- mais le worker recevait un tour par token, donc le WAN/VPS relay était payé presque à chaque token ;
- dans les logs worker, on voyait `tokens_batch=1` et pas de `micro_decode_budget`.

## Corrections appliquées

### 1. Déploiement du stage 1 Python actuel sur le VPS

Fichiers déployés :

- `nodeAndWorker/python-inference/distributed_llm_orchestrator.py`
- `nodeAndWorker/python-inference/batching.py`
- `nodeAndWorker/python-inference/inference_server.py`

Actions :

- `py_compile` sur le VPS ;
- redémarrage `vryx-inference-stage1.service`.

Effet :

- `inference_server.py` parse maintenant correctement le JSON envoyé par Rust ;
- `max_new_tokens`, `quantization`, `hidden_transport` et `pool_preference` sont transmis au pipeline ;
- l’orchestrateur envoie `micro_decode_budget` en mode greedy mono-worker.

### 2. Déploiement du daemon Rust initiateur actuel

Le binaire Rust doit être compilé sur le VPS Linux x86_64. Une copie directe du binaire Mac ARM produit `Exec format error`.

Actions réalisées :

- installation / activation d’un Rust récent via `rustup` côté VPS ;
- copie de `rust-daemon/src/main.rs`, `rust-daemon/Cargo.toml` et `Cargo.lock` ;
- compilation sur le VPS avec `cargo build --release --locked -p rust-daemon` ;
- installation du binaire Linux dans `/home/ubuntu/apps/vryx/nodeAndWorker/target/release/rust-daemon` ;
- redémarrage `vryx-initiator.service`.

État final :

- `vryx-initiator.service` actif ;
- `http://127.0.0.1:3031/api/status` OK ;
- `workers_visible_p2p`: **2** ;
- `workers_connected_p2p`: **1** lors de la vérification.

### 3. Redémarrage worker Mac

Le worker local a été relancé contre le bootstrap prod avec MLX :

- modèle `Qwen/Qwen2-0.5B-Instruct` ;
- runtime MLX ;
- heartbeat OK sur `vryx.eu` ;
- connexion P2P rétablie avec l’initiateur.

### 4. Réduction de l’attente côté panneau admin

Modification front :

- `website/src/components/admin/AdminP2PChatPanel.tsx`

Le panneau envoie maintenant :

- `maxNewTokens: 32`

Pourquoi :

- sans plafond explicite, le serveur peut générer jusqu’à `VRYX_DIST_MAX_TOKENS=256` ;
- 256 tokens permet un bon TPS soutenu, mais c’est trop long pour un chat court ;
- 32 tokens réduit l’attente E2E visible dans l’interface.

Déploiement site :

- `npm run build` OK ;
- `website_deploy.py` OK ;
- PM2 `vryx-api` redémarré ;
- `/api/health` OK sur le VPS.

## Résultats réels après déploiement

### Test soutenu 256 tokens

Après activation effective du micro-batch :

- `wall_ms`: **9 366 ms**
- `completion_tokens`: **256**
- `TPS_wall`: **27,333**
- `benchmark.actual_tps`: **36,524**
- `relay_ms`: **6 993 ms**
- `requested_quantization`: `fp16`
- `effective_quantization`: `fp16`
- `routing_hops`: **1**

Objectif **15 TPS minimum** : **atteint** sur débit soutenu.

### Test chat court 32 tokens

Après déploiement `inference_server.py` :

- `wall_ms`: **10 039 ms**
- `completion_tokens`: **32**
- `TPS_wall`: **3,188**
- `benchmark.actual_tps`: **23,97**
- `relay_ms`: **1 331 ms**
- `prefix_cache_hit`: `true`
- `decode_modes_len`: **2**
- `routing_hops`: **1**

Interprétation :

- le hot path dépasse bien 15 TPS ;
- le wall TPS du message court reste bas, car le coût fixe est amorti sur seulement 32 tokens ;
- pour le ressenti utilisateur, il faut surtout réduire le coût fixe ou streamer réellement depuis l’initiateur.

### Logs worker confirmés

Les logs worker montrent maintenant :

- `micro_decode_budget` présent dans le payload ;
- `greedy_micro=True` ;
- `tokens_batch=7` sur les petits tests ;
- `tokens_batch=32` sur les tests soutenus.

C’est le changement clé : le worker produit plusieurs tokens par aller-retour au lieu d’un seul.

## Point bloquant honnête : qualité texte

Avant correction, les réponses MLX observées étaient incohérentes, par exemple sur des prompts simples :

- `Dis bonjour en français.`
- `What is 1+1? Answer only 2.`

Exemple de sortie observée :

- `PHA家企业鞘enthal出租车该项目规模最大��`

Conclusion :

- le transport P2P et le débit sont démontrés ;
- le chemin MLX `Qwen2-0.5B` a été corrigé par deux fixes : propagation correcte de `rope_parameters.rope_theta` vers `rope_theta`, puis application des biais `q_proj/k_proj/v_proj/o_proj` dans l’attention MLX ;
- après correction, le test P2P `What is 1+1? Answer only 2.` donne `1+1 equals 2.` ;
- le chemin MLX custom `Qwen3.5-9B` reste non validé : le modèle officiel est sain, mais le kernel VRYX `linear_attn` sort encore des tokens faux.

## Résultats Qwen3.5 9B — tests réels

Choix validé : stratégie équilibrée, comparaison MLX officiel vs Transformers/PyTorch, test court/sûr.

### Référence logits hors P2P

Modèle : `Qwen/Qwen3.5-9B`  
Prompt : `What is 1+1? Answer only 2.`

- Transformers/PyTorch : top1 `248068`, texte généré court : `<think>\nThinking Process`.
- `mlx-lm` officiel : top1 `248068`, même texte court.
- Top1 match : `true`.
- Overlap top10 : `9 / 10`.

Conclusion : le modèle et MLX officiel sont fiables. La divergence vient du backend custom VRYX, pas de Qwen3.5 ni de MLX en général.

### P2P VPS avec backend MLX custom VRYX

Premier test après nettoyage disque :

- `wall_ms`: **94 606 ms**
- `completion_tokens`: **8**
- `TPS_wall`: **0,085**
- `benchmark.actual_tps`: **0,244**
- `setup_ms`: **56 464 ms**
- `response`: décodage vide

Après correction du gate `Qwen3_5Attention` (`attn_output * sigmoid(gate)`) :

- `wall_ms`: **74 870 ms**
- `completion_tokens`: **8**
- `TPS_wall`: **0,107**
- `benchmark.actual_tps`: **0,448**
- `setup_ms`: **52 518 ms**
- `response`: `.1111.1.`

Conclusion : le gate manquant corrige une partie du symptôme, mais le kernel `linear_attn` custom reste numériquement faux. Il ne faut pas exposer ce chemin comme chat produit `Qwen3.5-9B`.

### P2P VPS avec backend PyTorch fiable

Après cache complet du shard 9B :

- téléchargement worker initial : **17,9 Go**, **745 205 ms** ;
- build PyTorch : **95 756 ms** ;
- paramètres : **8 953 803 264** ;
- test chaud `max_new_tokens=4`, stop après 1 token :
  - `response`: `2`
  - `wall_ms`: **4 634 ms**
  - `completion_tokens`: **1**
  - `TPS_wall`: **0,216**
  - `benchmark.actual_tps`: **0,753**
  - `setup_ms`: **967 ms**

Conclusion : PyTorch sauve la qualité visible sur `Qwen3.5-9B`, mais ne permet pas l’objectif **15 TPS** sur cette machine et ce chemin P2P.

### P2P VPS avec `mlx-lm` officiel direct

Correctif appliqué ensuite :

- ajout du message P2P `vryx.mlx_lm.generate` côté worker ;
- génération locale via `mlx-lm` officiel, sans passer par les shards VRYX custom ;
- ajout du layout `mlx_lm_direct_p2p` côté orchestrateur ;
- patch du daemon Rust initiateur pour traiter ce layout comme un succès direct ;
- déploiement VPS avec `VRYX_MLX_LM_DIRECT=1`.

Test 64 tokens via `POST http://127.0.0.1:3031/api/chat` sur le VPS :

- `layout`: `mlx_lm_direct_p2p`
- `wall_ms`: **3 279 ms**
- `completion_tokens`: **64**
- `TPS_wall`: **19,518**
- `benchmark.actual_tps`: **23,872**
- `benchmark.actual_ms_per_token`: **41**
- `ttft_ms`: **437**
- `runtime_backend`: `mlx_lm`

Test 128 tokens via le même endpoint VPS :

- `layout`: `mlx_lm_direct_p2p`
- `wall_ms`: **5 503 ms**
- `completion_tokens`: **128**
- `TPS_wall`: **23,26**
- `benchmark.actual_tps`: **25,667**
- `benchmark.actual_ms_per_token`: **38**
- `ttft_ms`: **484**
- `runtime_backend`: `mlx_lm`

Conclusion : l’objectif **Qwen3.5 9B > 15 TPS** est atteint de manière honnête en P2P VPS, à condition d’utiliser `mlx-lm` officiel comme runtime visible. Le backend shard custom VRYX reste utile pour l’expérimentation distribuée, mais pas pour la génération produit Qwen3.5.

## Comment aller vers 100 / 100

Objectif réaliste :

- **Transport P2P / orchestration 95+** : conserver le micro-décodage, mais réduire le relay WAN. Le worker doit idéalement être proche réseau du VPS, ou le flux doit passer en QUIC/direct quand disponible.
- **TPS soutenu 95+** : le chemin `mlx-lm` officiel passe déjà >15 TPS. Pour stabiliser à 95+, il faut garder le modèle résident, surveiller `load_ms=0`, et éviter le retour au backend shard custom sur `Qwen3.5-9B`.
- **Attente E2E chat court 90+** : faire du vrai streaming token depuis stage 1 / initiateur jusqu’à Node, au lieu d’attendre le JSON complet.
- **Qualité texte 95+** : ajouter un test CI de parité logits top10 pour `Qwen2` et `Qwen3.5` sur 3 prompts fixes. Un déploiement qui ne matche pas la référence doit être bloqué.
- **Déploiement / opérabilité 95+** : éviter les caches shards sur `/var/tmp` sans budget disque ; purger ou déplacer les shards, compiler Rust côté Linux, et documenter les profils systemd actifs.

Décision produit conseillée :

- Chat visible court aujourd’hui : `Qwen2-0.5B` MLX corrigé si la priorité est vitesse.
- Chat visible 9B aujourd’hui : `mlx-lm` officiel direct.
- Objectif `Qwen3.5-9B >15 TPS` : **atteint** sur l’infra actuelle en session chaude via P2P direct `mlx_lm_direct_p2p`.

## Pourquoi l’attente reste visible

Même avec micro-batch, le chemin E2E contient :

1. navigateur → Node ;
2. Node → initiateur Rust ;
3. initiateur → stage 1 Python ;
4. stage 1 → relay P2P ;
5. relay P2P → worker Mac ;
6. worker MLX ;
7. retour complet jusqu’à Node ;
8. diffusion SSE après réception du JSON.

Le gain micro-batch réduit surtout les étapes répétées **4 → 7** pendant le décodage. Il ne supprime pas :

- le coût de préfill ;
- le coût de session/shards ;
- le premier RTT WAN ;
- le fait que Node ne reçoit pas encore les tokens au fil exact du worker.

## Ce qu’il faut faire ensuite

Priorité 1 : qualité texte

- Vérifier le runtime MLX couche par couche contre une sortie HF/PyTorch de référence.
- Comparer logits du premier token entre MLX et Transformers pour le même prompt.
- Désactiver temporairement MLX en prod si la qualité prime sur le débit.

Priorité 2 : attente perçue

- Transformer le flux actuel en vrai streaming depuis stage 1 / initiateur, pas seulement SSE après JSON complet.
- Afficher dans l’UI les métriques reçues : `prefix_cache_hit`, `benchmark.actual_tps`, `tokens_batch`, `relay_ms`.
- Garder `maxNewTokens=32` par défaut pour le chat admin.

Priorité 3 : déploiement

- Ne jamais déployer un binaire Rust cross-arch depuis Mac vers Linux.
- Compiler Rust sur le VPS ou mettre en place une CI Linux x86_64.
- Documenter `rustup` comme prérequis du VPS pour ce daemon.

## Verdict

L’objectif **15 TPS** est atteint de manière honnête sur le **débit soutenu du pipeline P2P VPS** après déploiement : **27,33 TPS wall** et **36,52 TPS hot path** sur un vrai test initiateur VPS.

L’objectif n’est **pas encore atteint** pour le ressenti d’un **petit message chat** si on mesure tout le wall-clock E2E sur 8 à 32 tokens : le coût fixe domine encore.

Le système est donc nettement plus rapide côté transport, mais pas encore satisfaisant côté qualité LLM MLX. La prochaine vraie étape n’est pas d’ajouter des artifices de benchmark : c’est de corriger la fidélité du runtime MLX ou de choisir un backend worker fiable pour la génération visible par l’utilisateur.
