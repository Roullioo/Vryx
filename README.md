# Vryx

Infrastructure d’inférence et de calcul distribué : réseau de nœuds (libp2p, workers GPU), API Node, interface web et client macOS. L’objectif est de proposer une alternative aux datacenters classiques grâce à une orchestration pensée pour la latence et la résilience (voir la documentation produit pour le détail des concepts « Course » et « Relais »).

## Documentation

| Document | Contenu |
|----------|---------|
| **[`VRYX.md`](./VRYX.md)** | Vision, architecture technique, glossaire, flux admin / workers / VPS. |
| **[`website/INSTALLATION.md`](./website/INSTALLATION.md)** | MariaDB, variables d’environnement, `npm run dev`, workers et délégation d’inférence, régénération du proto gRPC. |

## Déploiement VPS (site + API)

Depuis la racine du dépôt, après `pip install paramiko` :

```bash
export VRYX_VPS_SSH_PASSWORD='…'   # ou VRYX_VPS_SSH_KEY=… pour une clé
python3 website_deploy.py
```

Le script build le front (`website/dist`), archive `dist` + `server` (sans `.env`), envoie sur le VPS, extrait par défaut dans **`/var/www/vryx`** (variable `VRYX_WEBSITE_REMOTE_DIR` pour surcharger), exécute `npm ci --omit=dev` puis recrée le processus **`vryx-api`** sous PM2 avec le bon répertoire. Nginx : `root /var/www/vryx/dist;` et proxy `/api` vers le port de l’API. Créez une fois `server/.env` dans ce dossier sur le serveur.

Pour le daemon bootstrap Rust, voir toujours **`vps_deploy.py`**.

## Structure du dépôt

- **`website/`** — Front React (Vite, TypeScript, Tailwind) et API Express (`website/server/`), Docker MariaDB.
- **`nodeAndWorker/`** — Proto `vryx.proto`, daemon Rust (libp2p, API locale Axum), serveur Python gRPC (inférence, stages VPS / worker), scripts de test et de démarrage.
- **`AppMacos/`** — Application Electron + React pour le nœud local (statut, flux lié au daemon).
- **`scripts/github-vryx-bootstrap.sh`** — Script utilitaire pour créer un dépôt GitHub privé et pousser le code (voir ci-dessous).

## Démarrage rapide (site + API)

Prérequis : **Node.js 20+**, Docker recommandé pour la base.

```bash
cd website
cp server/env.example server/.env
# Éditer server/.env : JWT_SECRET (≥ 32 caractères), DB_*, etc.

npm run install:all
docker compose --env-file server/.env up -d
npm run dev
```

Vérification : `curl -s http://127.0.0.1:4000/api/health`

Les cas limites (mot de passe MariaDB, proxy Vite, workers) sont décrits dans **`website/INSTALLATION.md`**.

## Dépôt GitHub (script bootstrap)

Avec [GitHub CLI](https://cli.github.com/), connecté au compte souhaité :

```bash
gh auth login
bash scripts/github-vryx-bootstrap.sh
```

Le script crée le dépôt privé **`Roullioo/Vryx`** (modifiable via `REPO_SLUG`), ajoute `origin` si besoin et pousse la branche courante.

Pour inviter un collaborateur GitHub avec le rôle **admin** sur le dépôt, définissez son **identifiant GitHub** (pas l’e-mail) puis relancez :

```bash
export BAPTISTE_GH_USER='nom_utilisateur_github'
bash scripts/github-vryx-bootstrap.sh
```

Sinon, ajoutez les collaborateurs dans les paramètres du dépôt sur GitHub.

## Admins application

Les comptes administrateurs côté application sont pilotés par la variable **`ADMIN_EMAILS`** dans `website/server/.env` (voir `website/server/env.example`). Sans surcharge, une liste par défaut est appliquée au démarrage du serveur (`website/server/src/index.js`).

---

Dépôt : [github.com/Roullioo/Vryx](https://github.com/Roullioo/Vryx) (privé).
