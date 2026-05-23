# Production Readiness Scorecard

Objectif : rendre la maturité Vryx mesurable avant d'ajouter de nouvelles features.

Le score cible pour considérer Vryx comme candidat prod est `>= 90`.

## Endpoint admin

```text
GET /api/admin/production-readiness?hours=24
GET /api/admin/production-readiness/evidence?hours=24
GET /api/admin/production-readiness/evidence?hours=24&download=1
```

Le dashboard investisseur est disponible côté app sur `/investor-readiness`.
Il reprend la page admin production readiness et ajoute une preuve JSON téléchargeable
pour la data room.

Le fichier evidence JSON contient :

- score readiness et grade ;
- modèles golden path figés ;
- dernier benchmark golden path ;
- preuve `99% / 100 requêtes` si disponible ;
- TPS p50/p95 ;
- TTFT p95 ;
- coût EUR par million de tokens quand il est mesuré ;
- checklist d'acceptance investisseur.

## Endpoints publics

```text
GET /api/public/golden-path-status?hours=24
GET /api/public/network-status
```

`golden-path-status` expose le score de readiness, la dernière preuve benchmark, le nombre de workers directs vs relay, et `stable99Proven`.

Le résultat contient :

- `score`
- `grade`
- `blockers`
- `warnings`
- `actions`
- métriques golden path

Grades :

- `production_candidate` : score `>= 90`
- `advanced_beta` : score `>= 80`
- `prototype_plus` : score `>= 70`
- `not_ready` : score `< 70`

## Gate CI/local

Depuis `website/server` :

```bash
npm run gate:production-readiness
```

Variables utiles :

```bash
VRYX_PROD_READINESS_MIN_SCORE=80
VRYX_PROD_READINESS_HOURS=24
VRYX_GOLDEN_PATH_MODELS=gemma4:31b,qwen/qwen3.6-35b-a3b
```

Le gate sort en code `2` si le score est sous le seuil.

## Benchmark automatique

Script :

```bash
cd /var/www/vryx/server
npm run bench:golden-path
```

Systemd :

```text
deploy/systemd/vryx-golden-path-benchmark.service
deploy/systemd/vryx-golden-path-benchmark.timer
```

Le timer lance un benchmark toutes les 15 minutes et écrit dans `worker_benchmark_runs`, ce qui alimente ensuite les endpoints publics/admin.

## Gate GitHub golden path

Le workflow `P2P Staging Bench` produit deux artefacts :

- `p2p-staging-bench.jsonl` : sorties brutes par requête ;
- `p2p-staging-bench-summary.json` : résumé investisseur avec acceptance gates.

Le job échoue si les seuils golden path ne passent pas :

- taux de succès minimum `VRYX_BENCH_MIN_SUCCESS_RATE` (99 par défaut) ;
- zéro réponse vide par défaut ;
- TPS cible atteint ;
- nombre minimum de workers compute atteint.

## Critères actuels

Le score vérifie :

1. worker golden path live ;
2. runtime `llama.cpp` + Q4 ;
3. au moins 3 requêtes inference récentes ;
4. taux de succès >= 95% ;
5. TPS decode p50 >= 10 ;
6. TTFT p95 <= 10 secondes ;
7. zéro réponse vide récente ;
8. benchmark récent au-dessus de la cible ;
9. présence d'une route directe quand le worker la rapporte.

## Multi-worker

Le multi-worker n'est considéré utilisable que s'il a :

- au moins 2 workers live ;
- un benchmark récent avec `worker_count >= 2` ;
- zéro réponse vide ;
- un score readiness global au-dessus du seuil.

Sinon il reste visible comme capacité expérimentale, mais ne doit pas être vendu comme chemin prod.

Gate local/VPS :

```bash
cd /var/www/vryx/server
npm run gate:multiworker
```

## Politique CTO

Si le score est sous `90`, la priorité est :

1. corriger les blockers ;
2. relancer un benchmark golden path ;
3. vérifier `/api/admin/inference/summary` ;
4. seulement ensuite reprendre les nouvelles features.
