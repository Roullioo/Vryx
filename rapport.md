# Rapport : réduction du « mur » perçu (admin chat P2P)

## Mise à jour critique : TPS et latence pipeline P2P (15 mai 2026)

### Ce qu'il se passait avant

- Attente de **90+ secondes** avant toute réponse ou erreur sur le chat P2P.
- Cause racine : `workers_connected_p2p: 0` (worker visible via heartbeat mais P2P non connecté). L'orchestrateur Python appelait `_discover_live_peers()` qui retournait le worker depuis `/api/internal/live-peers` (heartbeat API). La relay HTTP vers ce worker était mise en file (`pending_relay_until_connected`) dans le Rust, sans jamais aboutir.
- Le heartbeat du Rust nettoie cette file seulement toutes les **30 s**, avec un minimum forcé à **45 s** (`relay_deadline.max(45)`), donc la requête attendait entre 45 s et 105 s avant un timeout.
- Les timeouts systèmd étaient tous à **600 s** (`VRYX_DIST_TIMEOUT_SEC`, `VRYX_PIPELINE_STEP_TIMEOUT_SEC`, `VRYX_STAGE1_TIMEOUT_S`) — de nombreux fichiers drop-in se réécrivaient les uns les autres (les fichiers `99-*` et `zzzz-*` écrasaient notre override `50-fast-timeouts.conf`).

### Ce qu'il se passe maintenant

- **Fail rapide** : `_discover_live_peers()` interroge d'abord `/api/tp-peers` (pairs P2P réellement dans le swarm libp2p). Si vide ET que l'endpoint répond, on retourne `[]` immédiatement — sans tomber sur les heartbeats API qui génèrent des relais impossibles.
- **Réponse en < 1 s** lorsque aucun worker P2P n'est connecté : `failure_stage: "discover_live_peers_empty"`, `latency_ms ≈ 7`.
- **Message d'erreur clair** côté front : `"Aucun worker P2P actif. Connectés P2P : 0 / Visibles via heartbeat : 2 / Déclarés API : 1. Relancez le daemon rust-daemon en mode worker sur la machine Apple Silicon."` — affiché en quelques secondes, pas après 90 s.
- **Override timeouts définitif** : fichier `zzzzzz-fast-fail.conf` (sort après tous les `zzzzz*`) sur le stage1 impose `VRYX_DIST_TIMEOUT_SEC=25`, `VRYX_PIPELINE_STEP_TIMEOUT_SEC=25`.
- **Bootstrap + initiateur redémarrés** pour forcer une nouvelle tentative de reconnexion P2P.

### Pour retrouver les TPS d'avant (25+ TPS)

Le worker Apple Silicon à 88.178.19.205 envoie des heartbeats API mais n'est **pas connecté P2P** (port 4021 injoignable depuis le VPS). Pour rétablir le TPS :

1. Sur la machine worker (Apple Silicon), depuis le dépôt : `cd nodeAndWorker && ./start-worker.sh` (défaut prod : modèle **Qwen/Qwen3.5-9B**, **--p2p-port 4021**, QUIC + relais, clé stable dans `.vryx-keys/worker.node.key`).
2. Vérifier que le worker dial bien le bootstrap : `/ip4/51.222.26.225/tcp/4001/p2p/12D3KooWLMT5gnTuCNkVewEhX8wcQ3spGFauT6XtcaBCs5N8n9Zz`
3. Vérifier dans `curl http://51.222.26.225:3031/api/status` que `workers_connected_p2p ≥ 1`.
4. Le modèle déclaré par le worker doit être `Qwen/Qwen3.5-9B` (correspond à `VRYX_DIST_MODEL`).

Le panneau admin **Chat P2P** inclut un encart dépliable avec la même commande.

## Mise à jour : Chat P2P UI responsive + budget tokens (15 mai 2026)

- **Plafond `max_new_tokens`** : interface jusqu’à **16 384** jetons (au lieu de 1 024), réglage par pas de **64** ; champ numérique + curseur. API Node : variable **`VRYX_P2P_ADMIN_MAX_NEW_TOKENS`** (défaut 16 384, bornée 256–65 536). Stage1 VPS : override **`zzzzzzz-dist-max-tokens.conf`** avec **`VRYX_DIST_MAX_TOKENS=16384`** (avant : 512) pour que l’orchestrateur Python honore la demande.
- **Page** `/admin/chat-p2p` : layout **mobile-first** (pile, boutons min. 44 px, détails techniques repliés), **XL** en deux colonnes (chat + sidebar). Le long bloc « Rôle de cette page » et le panneau **Runtime shard** ont été retirés au profit d’une **carte d’en-tête** (dégradé, compteur workers, liens).
- **Panneau** : en-tête compact, zone réglages scrollable, transport P2P en **snap horizontal** sur petit écran, pied de page avec **safe-area** iOS, fermeture **`</section>`** sémantique.

## Mise à jour : page Chat P2P allégée (15 mai 2026)

- Interface plus lisible : carte d’accueil avec badge workers live, accès **Supervision nœud** et **Flux technique** (repliable), colonnes **Dernier tour** et **Workers live** harmonisées.

## Mise à jour : Chat P2P « je ne peux pas parler » + test VPS (15 mai 2026)

### Ce qu’il se passait avant

- Sur le VPS, l’initiateur Rust répondait en **HTTP 404** sur `POST /api/chat/stream` : binaire **sans** la route NDJSON actuelle. Node retombait sur `POST /api/chat`, qui peut rester **bloqué très longtemps** si `workers_connected_p2p` reste à 0 (dial P2P vers les workers).
- Pendant tout ce temps, le front gardait **`loading === true`** : bouton d’envoi désactivé et **Entrée** ignorée (`send()` sort tout de suite), d’où l’impression de ne plus pouvoir « parler » au chat.
- Aucun moyen clair d’**interrompre** une requête côté navigateur ; pas de message explicite expliquant l’absence de `/api/chat/stream` sur l’initiateur.

### Ce qu’il se passe maintenant

- Le panneau admin affiche **« Annuler la requête »** pendant la génération : `AbortController` sur le `fetch` vers `/api/admin/p2p/chat/stream`, ce qui coupe la connexion, déclenche `req.close` côté Node (`ctrl.abort()` déjà câblé) et remet l’interface utilisable avec un message d’annulation.
- L’API Node envoie un événement SSE **`initiator_legacy`** dès qu’elle détecte un **404** sur l’appel stream vers l’initiateur, pour expliquer le basculement vers `/api/chat` et rappeler qu’un **rust-daemon** à jour expose le flux NDJSON.
- **Déploiement** : `website_deploy.py` (build local déjà fait, `VRYX_SKIP_BUILD=1`) vers `vryx.eu` / PM2 `vryx-api` exécuté avec succès.
- **Test réel** sur le VPS : `curl` vers `127.0.0.1:3031/api/chat/stream` → **404** ; statut initiateur avec `workers_visible_p2p: 5` mais **`workers_connected_p2p: 0`** : la latence vient du pipeline P2P, pas du formulaire du site. Pour un test bout-en-bout avec réponse rapide : reconnecter les workers au relais **ou** déployer l’initiateur **et** les workers alignés sur la branche courante.

### Prompt si l’erreur persiste après déploiement Rust

« Recompiler et redémarrer le service initiateur (`rust-daemon`) sur le VPS pour que `POST http://127.0.0.1:3031/api/chat/stream` renvoie 200 et du NDJSON, puis vérifier `workers_connected_p2p > 0` dans `GET /api/status`. »

## Mise à jour : objectifs 95+ transport, streaming, qualité et opérabilité (15 mai 2026)

### Ce qu’il se passait avant

- Le placement des workers compatibles pouvait encore repartir d’un ordre stable mais peu optimal pour le worker unique `mlx_lm_direct_p2p`; la proximité réseau VPS n’était pas systématiquement prioritaire avant le direct path.
- Le Chat P2P affichait un pseudo-streaming : Node attendait la réponse JSON complète de l’initiateur, puis découpait le texte en mots côté serveur.
- Le chemin `mlx-lm` officiel gardait déjà le modèle en cache, mais l’interface ne voyait pas explicitement `cache_hit`, `load_ms`, ni le statut résident.
- Aucun workflow CI ne bloquait une régression de parité logits `Transformers` vs `mlx-lm`.
- Les shards utilisaient encore `/var/tmp/vryx-shards` par défaut, sans profil systemd versionné ni garde disque explicite.

### Ce qu’il se passe maintenant

- Les workers sont retriés après mesure RTT VPS, avec un cap micro-batch dynamique (`VRYX_MICROBATCH_RTT_TARGET_MS`) pour garder le micro-décodage sans créer un gros bloc WAN sur lien lent.
- Le proto gRPC expose `ProcessStream`; le stage 1 pousse des `StreamChunk`, le daemon Rust expose `/api/chat/stream` en NDJSON, et Node retransmet les tokens en SSE sans attendre le vieux `/api/chat` JSON quand le stream natif est disponible.
- `mlx_lm_direct_p2p` remonte `mlx_lm_load_ms`, `cache_hit`, `cache_status`, `resident_model`, `model_cache_size` et bloque le fallback silencieux vers le shard custom sur Qwen3.5 quand `VRYX_MLX_LM_DIRECT=1`.
- La CI ajoute `logits-parity.yml` sur runner self-hosted Apple Silicon : 3 prompts fixes × Qwen2/Qwen3.5, top-10 exact obligatoire.
- Le build Rust Linux est vérifié par `rust-linux-build.yml`; les profils systemd prod sont versionnés dans `deploy/systemd/`.
- Le défaut shard passe à `/var/lib/vryx-shards`, avec check disque dans `website_deploy.py` et snippets `ExecStartPre`.

### Vérifications locales

- `python3 -m py_compile` sur orchestrateur, runtime shard, serveur gRPC, stubs générés et script logits : OK.
- `npm run build` dans `website/` : OK.
- `node --check website/server/src/index.js` : OK.
- `cargo check -p rust-daemon` : OK, uniquement warnings de dépréciation libp2p/yamux déjà non bloquants.

## Mise à jour : tokens, grand chat et sessions DB (14 mai 2026)

### Ce qu’il se passait avant

- Le panel Chat P2P envoyait toujours **32 tokens** de complétion (`maxNewTokens = 32`) : les réponses Qwen3.5 étaient cohérentes et rapides, mais coupées trop tôt.
- Le champ de saisie était un **input une ligne**, peu adapté aux prompts longs.
- Les sessions P2P étaient sauvegardées uniquement en **localStorage** : elles disparaissaient selon le navigateur et n’étaient pas réellement rattachées au compte admin en base.
- La page Chat P2P était contrainte par une largeur plus faible, avec un format moins confortable pour lire de longues générations et les métriques.

### Ce qu’il se passe maintenant

- Le Chat P2P expose un réglage **32 → 1 024 tokens**, avec **256 tokens par défaut** côté interface.
- Le stage 1 VPS est redéployé avec **`VRYX_DIST_MAX_TOKENS=512`** et `VRYX_MLX_LM_DIRECT=1`, donc les requêtes du site ne sont plus recoupées à 32 tokens.
- Test réel VPS via `/api/chat` avec `max_new_tokens=96` : **96 tokens générés**, `mlx_lm_direct_p2p`, **25,518 TPS hot path**, `latency_ms=6026`.
- Le prompt est maintenant une **zone multi-lignes** mobile-first, avec `Maj + Entrée` pour les retours ligne et `Entrée` pour envoyer.
- Les sessions sont créées en base dans **`p2p_chat_sessions`** et restent aussi copiées en local en secours. La page Sessions relit désormais la DB et les suppressions sont synchronisées.
- La page Chat P2P est passée en **grand format** (`max-w-384`, panneau plus haut, bulles plus larges, zone de messages plus grande).

### Déploiement

- Front + API Node déployés sur le VPS avec `website_deploy.py`; PM2 `vryx-api` redémarré et `/api/health` OK.
- `distributed_llm_orchestrator.py` redéployé sur le stage 1 VPS; `vryx-inference-stage1.service` redémarré et actif.

## Ce qu’il se passait avant

- **Blocage jusqu’à la fin de l’inférence** : le flux `/api/admin/p2p/chat/stream` attend la réponse JSON complète de l’initiateur Rust (`fetch` puis `await r.text()`). Tant que le pipeline P2P n’a pas fini tous les jetons prévus ou le stop, le front ne peut pas « voir » le texte comme un véritable flux token par token depuis le VPS.
- **Tempo SSE artificielle** : après coup, les fragments de texte étaient envoyés avec un délai par fragment ( quelques millisecondes par mot ), ce qui **allongeait encore** la durée après que le réseau a déjà tout calculé.
- **Initiateur Rust** : le champ **`fp16`** venant du site était **filtré** ; seuls `q4` et `int8` passaient, donc le corps JSON vers le stage 1 tombait implicitement sur **`int8`** au lieu du mode demandé.
- Pas de borne **optionnelle** de génération par requête depuis le panel : seul `VRYX_DIST_MAX_TOKENS` côté orchestrateur gérait la limite globale.

## Ce qu’il se passe maintenant

- **Fin de la temporisation factice** après réception du JSON (`delayMsPerToken = 0`) : une fois la réponse disponible, la diffusion SSE vers l’interface est sans attente additive.
- **`fp16` (ainsi que `q4` / `int8`) conservé** sur la chaîne initiateur → JSON envoyé au stage 1.
- **`max_new_tokens`** : le site peut passer `maxNewTokens` (ou `max_new_tokens`) dans le corps du POST `/api/admin/p2p/chat/stream`, relais vers `/api/chat` Rust puis stage 1 ; l’orchestrateur borne la boucle de décodage par `min(VRYX_DIST_MAX_TOKENS, valeur)`. Si le paramètre est absent, le comportement reste celui du plafond d’environnement.

## Points honnêtement hors scope de ce correctif

- **Réponse réellement « instantanée » (TTFT bas)** avant la fin physique du pipeline : il faudrait un **streaming HTTP/SSE continu** depuis l’orchestrateur via l’initiateur jusqu’à Node, alors qu’aujourd’hui l’interface attend un objet JSON terminé.

## Déploiement à prévoir pour profiter pleinement du correctif sur le VPS

- Redémarrer le serveur **website** (Node) avec le nouveau `index.js`.
- Déployer `distributed_llm_orchestrator.py` sur le worker stage 1 Py et redémarrer le service systemd associé.
- Recompiler ou redployer les binaires **initiateur** Rust où `/api/chat` est exposée, puis les relancer.

---

## Redémarrages et tests TPS (mai 2026)

### Actions réalisées

- Arrêt local des workers Mac : `nodeAndWorker/stop-3-workers-mac.sh`.
- Sur le VPS : `systemctl restart vryx-initiator` puis `systemctl restart vryx-inference-stage1` après déploiement d’une version à jour de `distributed_llm_orchestrator.py`.

### Mesures (logs stage 1 `/var/log/vryx-inference-stage1.log`)

Pour un **Mac worker distant** (MLX, modèle `Qwen/Qwen2-0.5B-Instruct`, **1 worker** couvrant tout le modèle, Daisy Chain à un hop) :

- Débit observé de l’ordre de **~460–525 ms par jeton de complétion** (ex. lignes du type « 21 tokens en ~10–11 s » ou « 51 tokens en ~25 s »).
- Cela correspond à environ **~1,9 à 2,2 TPS** (1000 / ms_par_tok), **sous le seuil de 10 TPS** demandé.

### Pourquoi dépasser 10 TPS « sur le fil » est irréaliste ici

- Le pipeline est **autorégressif** : chaque nouveau jeton passe par le VPS puis un **aller-retour réseau P2P relay** vers le worker. Sur un chemin **WAN + relais circuit**, **~500 ms par pas** est physiquement plausible.
- Monter à **> 10 TPS** (soit **< 100 ms/jeton** sur la chaîne complète) impliquerait typiquement au moins une des options suivantes :
  - worker **GPU dans le même réseau** que l’initiateur ;
  - **plusieurs jetons par étape** (décode batch côté worker) ;
  - **spéculation** avancée bout-en-bout (non opérationnelle en production sur ce stack).

### Optimisations code appliquées dans cette session

1. **Découverte des pairs** : si `/api/tp-peers` est vide mais que des workers existent sur **GET `{VRYX_API_URL}/api/workers/status`**, l’orchestrateur s’en sert (filtre `mode=worker` + même modèle). Désactivation : `VRYX_DIST_PUBLIC_REGISTRY_PEERS=0` et `VRYX_PUBLIC_WORKER_CATALOG=0`.
2. **Catalogue placement** : même source publique en secours pour le catalogue heartbeat lorsque `127.0.0.1:48953` ou `:4000` ne répond pas.
3. **`benchmark_hot_pool.py`** : `HF_HUB_DISABLE_PROGRESS_BARS=1` par défaut pour limiter les blocages de buffer liés aux barres tqdm en sortie capturée.

### Complément : micro-décodage WAN + agrégation côté orchestrateur (nouveau)

**Avant (comportement mesuré sur les logs stage 1)** : une boucle `for step in range(decode_cap)` imposait **un aller-retour relais par jeton** généré. Le worker MLX pouvait déjà calculer plusieurs pas greedy locaux (`candidate_token_ids`, `accepted_token_count`), mais l’orchestrateur ne consommait au final qu’un seul identifiant par tour — le débit utilisateur restait donc bridé à **~2 TPS** sur un chemin **~500 ms / RTT**.

**Maintenant** :

- Boucle **`while len(generated_ids) < decode_cap`** avec borne de sécurité sur le nombre de tours relais, pour que **plusieurs jetons acceptés par réponse worker** diminuent le nombre de round-trips.
- Envoi **`micro_decode_budget`** (plafonné par `VRYX_DECODE_MICROBATCH_CAP`, défaut **32**, max 64) lorsque : **un seul hop** dans `routing_path`, **KV cache** actif, **greedy** (`temperature ≤ 1e-9`), mode **single_token_stateful**. Désactivation : `VRYX_DECODE_MICROBATCH=0`.
- Agrégation des réponses **`decode_microbatch` / `candidate_token_ids`** sans exiger speculative heads « classiques ».
- Pour `RELAY_URL` en **`http://`**, tentative **`HTTPConnection` réutilisable (keep-alive)** en **thread-local** avant repli sur `urllib` (réduit un peu la latence amortie TLS/TCP pour les multiples POST vers le même hôte).

**Limite encore honnête** : le débit maximal reste celui du **compute MLX** × profondeur des pas locaux ; le gain WAN est proportionnel au nombre de jetons **réellement produits avant le prochain POST relais**. Vérifier après déploiement les lignes `[VPS] N tokens … (Xms/tok)` : `ms/tok` devrait baisser dès lors que `tokens_batch=` dans les logs MLX dépasse 1 régulièrement.

**Tests locaux (mai 2026)** : `cd nodeAndWorker/python-inference && PYTHONPATH=. python3 -m unittest test_orchestrator_smoke_aggregate -v` (**7** tests OK) ; **`python3 -m py_compile`** sur les modules d’inférence ; **`npm run build`** à la racine **`website`** OK. **`cargo test`** dans `rust-daemon` a échoué ici avec **SIGBUS / timeouts disque** sur la chaîne toolchain (erreur environnement locale, sans lien avec les changements Python). À relancer sur une machine où `cargo build` est déjà en cache ou avec plus d’espace / sans FS lent.

### Piste « fil » à marge (pas le facteur 5 visé)

- `VRYX_HIDDEN_TRANSPORT=int8` peut réduire un peu la charge sur le relay ; **la RTT et le compute par pas** dominent encore.

---

## Scripts locaux : attentes et bench plus courts (mai 2026)

### Avant

- **`test_worker_only_llm.sh`** : attente PeerId **30 × 1 s** ; P2P **60 × 1 s** ; **`sleep 2`** avant le chat ; **`curl -m 300`** ; **`VRYX_DIST_MAX_NEW_TOKENS=8`** fixe.
- **`quick-local-p2p.sh`** : **`sleep 2`** après l’initiateur ; plafond par défaut **`VRYX_DIST_MAX_NEW_TOKENS=48`**.
- **`bench_local_chat_tps.py`** : défaut **64** jetons, timeout HTTP **600 s**, prompt de mesure long (1 à 52).

### Maintenant

- **Test worker-only** : PeerId **40 × 0,5 s** ; P2P **60 × 0,5 s** (~30 s max au lieu de 60) ; **`sleep 0,75`** ; **`curl`** par défaut **180 s** (surcharge possible avec **`VRYX_TEST_CURL_TIMEOUT`** pour un premier téléchargement HF lent) ; **`VRYX_DIST_MAX_NEW_TOKENS`** par défaut **4** (surcharge **`VRYX_DIST_MAX_NEW_TOKENS`**).
- **Quick stack** : **`sleep 0,8`** ; défaut **`VRYX_DIST_MAX_NEW_TOKENS=32`** (toujours surchargeable).
- **Bench** : défaut **48** jetons, timeout HTTP **300 s** ; mode **`VRYX_BENCH_QUICK=1`** : **24** jetons, timeout **120 s**, prompt de mesure court (1 à 12), seuil d’avertissement TPS adapté ; **`VRYX_BENCH_HTTP_TIMEOUT`** et **`VRYX_BENCH_TOKENS`** restent prioritaires.

**Note** : le premier chargement HF / compilation MLX reste le goulot dominant ; ces changements réduisent surtout les **temps d’attente scriptés** et la **durée de génération de test**, pas la latence réseau WAN.

---

## Qualité MLX et test Qwen3.5 9B (mai 2026)

### Ce qu’il se passait avant

- Le backend MLX custom VRYX pouvait générer des tokens incohérents même quand le transport P2P était rapide.
- La config worker transmettait `rope_theta=10000` alors que Qwen2 expose `rope_parameters.rope_theta=1000000`.
- L’attention MLX ignorait les biais `q_proj/k_proj/v_proj/o_proj`.
- Sur Qwen3.5, le chemin `full_attention` séparait bien `[query, gate]`, mais n’appliquait pas `sigmoid(gate)` avant `o_proj`.

### Ce qu’il se passe maintenant

- `Qwen2-0.5B` MLX custom est corrigé : PyTorch et MLX VRYX sortent le même top token et des top logits alignés.
- Test P2P VPS Qwen2 après fix : réponse cohérente `1+1 equals 2.`.
- Qwen3.5 officiel est validé hors P2P : Transformers/PyTorch et `mlx-lm` ont le même top1 et `9/10` overlap top10.
- Qwen3.5 MLX custom VRYX reste non validé : le test P2P a encore produit `.1111.1.` après correction partielle.
- Qwen3.5 PyTorch P2P donne une réponse correcte (`2`) en passage chaud, mais reste trop lent pour l’objectif 15 TPS.

### Mesures Qwen3.5 sincères

- MLX custom P2P : **0,448 TPS hot path**, **0,107 TPS wall**, qualité incorrecte.
- PyTorch P2P chaud : **0,753 TPS hot path**, **0,216 TPS wall**, qualité correcte sur le prompt court.
- Téléchargement initial shard 9B worker PyTorch : **17,9 Go**, environ **745 s**.
- Build PyTorch 9B : environ **96 s**.

### Conclusion

Le correctif qualité est réel pour `Qwen2-0.5B`. Pour `Qwen3.5-9B`, l’objectif **>15 TPS** n’était pas atteint avec le backend shard custom ni avec PyTorch. Le chemin honnête vers le produit était donc d’intégrer `mlx-lm` officiel comme runtime worker 9B, ce qui est fait dans la section suivante.

---

## Qwen3.5 9B à plus de 15 TPS (mai 2026)

### Ce qu’il se passait avant

- Le chemin P2P passait par les shards VRYX custom et le kernel MLX `linear_attn`, qui n’était pas fidèle sur Qwen3.5.
- Le backend PyTorch était correct en qualité, mais trop lent : environ **0,753 TPS** hot path en test chaud court.
- Le premier chargement shard 9B imposait un transfert d’environ **17,9 Go** et pouvait dépasser 10 minutes.

### Ce qu’il se passe maintenant

- Nouveau chemin P2P direct : `vryx.mlx_lm.generate`.
- Le worker charge `Qwen/Qwen3.5-9B` avec `mlx-lm` officiel et génère localement.
- Le VPS Stage1 utilise `VRYX_MLX_LM_DIRECT=1`.
- Le daemon Rust initiateur accepte le layout `mlx_lm_direct_p2p` comme succès direct.

### Résultats réels VPS P2P

Test 64 tokens :

- `layout`: `mlx_lm_direct_p2p`
- `wall_ms`: **3 279 ms**
- `completion_tokens`: **64**
- `TPS_wall`: **19,518**
- `actual_tps`: **23,872**
- `ttft_ms`: **437**

Test 128 tokens :

- `layout`: `mlx_lm_direct_p2p`
- `wall_ms`: **5 503 ms**
- `completion_tokens`: **128**
- `TPS_wall`: **23,26**
- `actual_tps`: **25,667**
- `ttft_ms`: **484**

### Conclusion

Objectif **Qwen3.5 9B >15 TPS** atteint sur un vrai appel P2P VPS. Le chemin produit recommandé est `mlx-lm` officiel direct ; le backend shard MLX custom doit rester désactivé pour Qwen3.5 tant que sa `linear_attn` n’est pas alignée avec les logits de référence.

---

## Panneau admin « Zone de dialogue » P2P (mai 2026)

### Ce qu’il se passait avant

- La zone des messages restait visuellement petite : les réglages pipeline (transport, pool, budget) occupaient beaucoup de hauteur avec scroll interne, en plus du flux SSE fixe, ce qui multipliait les barres de défilement.
- Le texte des messages s’affichait en bloc brut (`whitespace-pre-wrap` seul), peu lisible pour les paragraphes et les listes.

### Ce qu’il se passe maintenant

- **Mobile / étroit** : les réglages du pipeline sont dans un accordéon « Réglages du pipeline », ce qui libère la hauteur pour la conversation.
- **Large écran** : les réglages restent visibles au-dessus du fil, dans une bande à hauteur plafonnée et scrollable si besoin.
- **Zone messages** : conteneur avec hauteur minimale plus généreuse (`min-h` en `dvh`) et enrobage `flex` correct (`min-h-0` sur le parent) pour que la liste des messages occupe l’espace disponible.
- **Flux temps réel** : repliable (`<details>`), avec la dernière ligne visible dans le résumé ; liste interne plus basse (`max-h-28` / `32`).
- **Contenu** : rendu via `FormattedMessageBody` (paragraphes séparés par une ligne vide, listes `-` / `*` / numérotées, liens stylés ; ton « self » pour les bulles utilisateur).

### Depuis cette évolution (Markdown + plein cadre)

- **Markdown** : titres (`#` à `######`), **gras**, *italique*, listes, citations, blocs de code, tableaux et GitHub Flavored Markdown (`remark-gfm`) via `react-markdown` et le composant `ChatMarkdown`.
- **Plein cadre** : page `Chat P2P` sans bandeau titre desktop ni padding du `main` ; panneau `layout="full"` en hauteur disponible ; colonne droite (trace + workers + liens) sur grand écran, empilée sous le chat sur mobile.

### Marque dans la barre latérale admin

- **Avant** : pastille « VX » et titre « Vryx Admin ».
- **Maintenant** : même pictogramme que le site public (`/logo-withoutbg.png` via `VryxLogo`) et libellé **Virtualized Remote Yield eXchange** à côté ; le pictogramme renvoie vers l’accueil (`/`).
- **Menu mobile (sidebar)** : le callback `onClose` était recréé à chaque rendu de `AdminShell`, ce qui relançait l’effet `useEffect` dans `Sidebar` et **refermait la sidebar tout de suite**. Stabilisation avec `useCallback` sur `closeSidebar`.
- **Hauteur admin + Chat P2P** : le shell utilisait seulement `min-h-dvh`, la colonne dépassait le viewport et le **scroll global** prenait le pas sur la zone messages (`overflow-y-auto`). Passage à **`h-dvh max-h-dvh overflow-hidden`** sur la racine admin, **`overflow-hidden`** sur la colonne principale, en-tête mobile en **`shrink-0`** (sans `sticky`), conteneur page Chat P2P **`min-w-0 overflow-hidden`**, zone messages avec **`touch-pan-y`** pour le défilement tactile.
- **Workers / graphe — panneau détail mobile** : en-tête du tiroir avec **icône X** (cible 44 px), marges **safe-area**, **z-index** relevé (`aside` 180, voile 170, modale 200) pour rester au-dessus du header admin ; corps du panneau scrollable séparément.

---

## Déploiement site + API (mai 2026)

- **Procédure** : `python3 website_deploy.py` depuis la racine du dépôt (build `website`, archive `dist` + `server`, SFTP vers le VPS, `npm ci --omit=dev` dans `/var/www/vryx/server`, redémarrage PM2 `vryx-api`, contrôle `http://127.0.0.1:4000/api/health`).
- **Résultat** : déploiement réussi sur le VPS cible ; API **online** après `pm2 save`.
- **Secrets** : utiliser `VRYX_VPS_SSH_PASSWORD` (ou clé `VRYX_VPS_SSH_KEY`) en variable d’environnement locale, sans commiter de mot de passe.

## Mise à jour : `/admin/workers` (graphe + cartes + GPU / VRAM) — 15 mai 2026

### Ce qu’il se passait avant

- Graphe : **VRAM** affichée à **0,5 Go** par défaut quand `gpuVramMb` était absent (valeur de repli dans `buildPoolGraphPayload`).
- Panneau nœud : statut **« Inactif »** pour les workers pourtant **en ligne** en veille (`status: idle`), GPU souvent **« inconnu »**, peu d’infos sur le **modèle** et **aucune** statistique de tokens sur 1 h / 24 h dans le graphe.
- Liste : pas de colonnes dédiées **tokens 1 h / 24 h** (ledger), **runtime** ni libellé VRAM cohérent pour MLX.

### Ce qu’il se passe maintenant

- **API / graphe** : plus de VRAM fictive à 0,5 Go ; `hardware` dérivé de `gpuName`, ou **Apple Silicon (Metal / MLX)** si backend MLX sans nom ; nœuds enrichis (**modèle**, **runtime**, **tokens** total / 1 h / 24 h). Snapshot pool et SSE alignés sur la même requête workers + sous-requêtes `worker_token_ledger`.
- **UI graphe** (`PoolNetworkGraph`) : statut **« En veille (connecté) »** pour `idle`, libellé VRAM **« non renseigné »** ou **mémoire unifiée (indicative)** pour MLX quand la VRAM vient des Mo totaux ; infobulle et panneau latéral avec **modèle chargé** et compteurs de tokens.
- **UI liste** (`AdminWorkersPage`) : cartes avec **tokens total / 1 h / 24 h**, **modèle**, **runtime**, **VRAM** formatée ; bandeau de stats réseau (**tokens 24 h** et **1 h** cumulés sur tous les workers enregistrés).
- **Daemon Rust (macOS)** : si `VRYX_GPU_NAME` / `VRYX_GPU_VRAM_MB` sont absents, le heartbeat envoie **`machdep.cpu.brand_string`** et la taille **`hw.memsize`** (Mo, approximation mémoire unifiée pour l’admin).
- **Détection renforcée (15 mai 2026, suite)** : lecture **`system_profiler SPDisplaysDataType -json`** pour le **vrai nom GPU** (`sppci_model`, ex. `Apple M4 Max`) et la VRAM annoncée quand `spdisplays_vram` est présent ; sinon repli **`hw.memsize`**. **Linux** : **`nvidia-smi`** (nom + mémoire). Cache **`OnceLock`** par processus. Champs `gpu_*` **absents du JSON** quand inconnus (`skip_serializing_if`) pour ne plus écraser la BDD avec `null` à chaque pulse.
- **Déploiement** : `website_deploy.py` exécuté avec succès (build, transfert, PM2 `vryx-api` redémarré, health OK).

### Ping temps réel (worker sélectionné / fiche détail)

- **Route** `GET /api/admin/workers/:peerId/ping` (admin, rate-limit 60/min) : le VPS mesure la latence vers l’`public_ip` du worker en base — **TCP** vers le port **gRPC** puis **P2P**, sinon **ICMP** ; refuse loopback / lien-local.
- **UI** : sur `/admin/workers/:id`, carte « Latence temps réel » avec polling **2,5 s** uniquement sur cette fiche ; dans le graphe Nerve Center, panneau latéral idem **uniquement pour le nœud sélectionné** (pas de rafraîchissement global du graphe pour le ping).

### Côté worker (hors site)

Pour que la base affiche tout de suite les nouvelles colonnes GPU/VRAM sur une machine déjà en prod : **redémarrer** le binaire `rust-daemon` worker après mise à jour (les heartbeats suivants mettront à jour `workers`).
