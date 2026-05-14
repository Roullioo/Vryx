# Rapport : réduction du « mur » perçu (admin chat P2P)

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

