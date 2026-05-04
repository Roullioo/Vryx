# Vryx

Monorepo : site web et API (`website/`), application desktop (`AppMacos/`), nœuds P2P et inférence (`nodeAndWorker/`).

**Documentation complète (vision, architecture, glossaire)** : [`VRYX.md`](./VRYX.md).

## Dépôt GitHub privé

Après installation de [GitHub CLI](https://cli.github.com/), connectez-vous au compte **Roullioo** :

```bash
gh auth login
export BAPTISTE_GH_USER='nom_utilisateur_github_de_Baptiste'
bash scripts/github-vryx-bootstrap.sh
```

Le script crée le dépôt privé `Roullioo/Vryx`, pousse la branche `main` et invite le collaborateur GitHub indiqué avec le rôle `admin`.

## Admins application

Les e-mails administrateurs par défaut sont définis dans `website/server/src/index.js`. Pour la prod, surchargez avec `ADMIN_EMAILS` dans `website/server/.env` (voir `website/server/env.example`).
