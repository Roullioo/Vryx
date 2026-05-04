# Installation : MariaDB, API et comptes

## Prérequis

- Node.js 20 ou plus récent (pour `node --watch` côté API)
- Docker (optionnel mais recommandé pour MariaDB)

## 1. Dépendances

À la racine du projet :

```bash
npm run install:all
```

Ou manuellement : `npm install` puis `cd server && npm install`.

## 2. MariaDB avec Docker

```bash
cp server/env.example server/.env
```

Éditez `server/.env` : au minimum un `JWT_SECRET` d’au moins 32 caractères, et des `DB_*` cohérents.

Démarrez la base en réutilisant **le même** `server/.env` pour que le mot de passe MariaDB corresponde à `DB_PASSWORD` :

```bash
docker compose --env-file server/.env up -d
```

Sans `--env-file server/.env`, Docker utilise seulement les valeurs par défaut du `docker-compose.yml` (`velocity_dev`, etc.). Si votre `server/.env` contient un autre `DB_PASSWORD`, l’API échouera avec `Access denied for user 'velocity'@'localhost'`.

Attendez que le conteneur soit sain (`healthy`). La table `users` est créée au premier démarrage via `docker/mariadb/init.sql`. L’API recrée aussi la table au démarrage si elle manque.

Variables optionnelles pour surcharger les défauts (dans `server/.env` ou exportées avant `docker compose`) :

```bash
MARIADB_ROOT_PASSWORD=votre_mot_de_passe_root
DB_NAME=velocity
DB_USER=velocity
DB_PASSWORD=votre_mot_de_passe_app
MARIADB_PORT=3306
```

### Erreur « Access denied for user 'velocity'@'localhost' »

1. Vérifiez que `DB_PASSWORD` dans `server/.env` est **exactement** le mot de passe MariaDB du conteneur (relancez Docker avec `docker compose --env-file server/.env up -d`).
2. Si vous avez changé le mot de passe après la **première** initialisation, l’ancien mot de passe reste dans le volume : `docker compose down -v` puis recréez (cela **supprime** les données locales).
3. Si le port **3306** est déjà pris sur votre machine (`bind: address already in use`), dans `server/.env` mettez **les deux** sur un port libre, par exemple :

   ```bash
   DB_PORT=3307
   MARIADB_PORT=3307
   ```

   Puis `docker compose --env-file server/.env up -d`. L’API utilisera `DB_HOST` + `DB_PORT` pour se connecter au conteneur.

### Erreur proxy Vite « ECONNREFUSED 127.0.0.1:4000 »

L’API n’a pas démarré (souvent à cause du point ci-dessus). Corrigez la connexion BDD puis relancez `npm run dev`.

Sans Docker : installez MariaDB localement, créez une base et un utilisateur avec droits sur cette base, puis renseignez `DB_*` dans `server/.env`.

## 3. Secret JWT et cookie

Dans `server/.env` :

- `JWT_SECRET` : au moins 32 caractères aléatoires (`openssl rand -base64 48`).
- En production HTTPS : `COOKIE_SECURE=true`, `NODE_ENV=production`, `CORS_ORIGIN` = URL exacte du site (ex. `https://www.votredomaine.com`).

## 4. Front (optionnel)

```bash
cp env.example .env
```

`VITE_API_URL` vide = proxy Vite vers `http://127.0.0.1:4000`. Si le front et l’API sont sur des origines différentes en prod, renseignez l’URL de l’API et la même valeur dans `CORS_ORIGIN` côté serveur.

## 5. Lancer le tout en développement

```bash
npm run dev
```

Cela démarre Vite (souvent le port 5173) et l’API (port 4000). L’API **réessaie automatiquement** la connexion MariaDB pendant environ 45 s (utile juste après `docker compose up`, le temps que le conteneur soit prêt). Pages : `/connexion`, `/inscription`.

Vérification API seule : `curl -s http://127.0.0.1:4000/api/health`

### macOS : alerte « tailwindcss-oxide.darwin-arm64.node » (Gatekeeper)

Après `npm install`, si macOS bloque le binaire natif de Tailwind (message du type « Apple n’a pas pu confirmer… »), depuis la racine du dossier `website` :

```bash
xattr -cr node_modules
```

Puis relancez `npm run dev`. En alternative ponctuelle : clic droit sur le fichier signalé → Ouvrir (une fois), ou réglages Confidentialité et sécurité → Autoriser.

## 5 bis. Workers : inférence uniquement sur le VPS

Les contributeurs **ne doivent pas** télécharger de modèles LLM sur leur machine. Le script worker utilise un pont gRPC qui **délègue** les requêtes au VPS.

1. Sur le serveur, dans `server/.env`, définissez un secret long (identique côté worker) :

   ```bash
   WORKER_INFERENCE_DELEGATE_SECRET=$(openssl rand -hex 32)
   ```

2. Redémarrez l’API (`pm2 restart vryx-api` ou équivalent).

3. Sur chaque poste contributeur, **avant** `./start-worker.sh` :

   ```bash
   export VRYX_INFERENCE_DELEGATE_SECRET='…même valeur que WORKER_INFERENCE_DELEGATE_SECRET…'
   ```

   Optionnel : `VRYX_INFERENCE_DELEGATE_URL` si l’URL publique de l’API diffère de `https://vryx.eu/api/workers/inference-delegate`.

Sur le **VPS**, le service Python d’inférence de l’initiateur doit rester en **stage 1** (Ollama local uniquement), par exemple :

`python inference_server.py --port 50051 --stage 1`

## 6. Production (rappel)

- HTTPS obligatoire pour les cookies sécurisés.
- Ne jamais committer `server/.env` ni `.env`.
- Changez tous les mots de passe par défaut Docker et root MariaDB.

## 7. Proto gRPC (`vryx.proto`) et Python

Après modification de `nodeAndWorker/proto/vryx.proto`, régénérez les stubs Python utilisés par `inference_server.py` :

```bash
cd nodeAndWorker/python-inference
python3 -m grpc_tools.protoc -I../proto --python_out=. --grpc_python_out=. ../proto/vryx.proto
```

Le daemon Rust régénère les sources via `cargo build` (`build.rs` + `tonic-build`).
