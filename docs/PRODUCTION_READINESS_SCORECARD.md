# Production Readiness Scorecard

Objectif : rendre la maturité Vryx mesurable avant d'ajouter de nouvelles features.

Le score cible pour considérer Vryx comme candidat prod est `>= 90`.

## Endpoint admin

```text
GET /api/admin/production-readiness?hours=24
```

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

## Politique CTO

Si le score est sous `90`, la priorité est :

1. corriger les blockers ;
2. relancer un benchmark golden path ;
3. vérifier `/api/admin/inference/summary` ;
4. seulement ensuite reprendre les nouvelles features.
