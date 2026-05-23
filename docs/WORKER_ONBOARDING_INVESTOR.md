# Worker Onboarding Investor Demo

## Objectif

L'app desktop VRYX Worker doit permettre a un investisseur ou a un futur operateur de comprendre le parcours en moins de trois minutes :

1. Connexion au compte VRYX.
2. Detection hardware et configuration modele/memoire.
3. Lancement du worker, apparition dans le reseau, inference et gains visibles.

## Ce qui est visible dans l'app

- Onboarding 3 clics sur le dashboard : compte, machine, start.
- Health check vert/orange/rouge : compte, hardware, memoire, worker local, P2P, heartbeat.
- Diagnostic reseau : API locale TCP, P2P, bootstrap/relay fallback, latence API.
- Reputation worker : score derive de l'uptime, tokens, jobs, et erreurs actives.
- Rentabilite estimee : projection mensuelle selon modele, backend, memoire allouee et mesures live.
- Release readiness : version app, version runtime worker, feed de mise a jour, signature macOS, notarisation et signature Windows.

## Demo golden path

1. Installer l'app signee sur macOS ou Windows.
2. Se connecter au compte VRYX.
3. Verifier que le hardware est detecte : CPU, GPU, VRAM/RAM, backend recommande.
4. Choisir le modele et l'allocation memoire proposee.
5. Cliquer sur Start worker.
6. Ouvrir le dashboard admin VRYX et verifier que le peer apparait live.
7. Lancer une requete API de test.
8. Observer les tokens, TPS, heartbeat, reputation et gains progresser dans l'app.

## Securite release

Le runtime worker supporte deja une mise a jour par manifeste VRYX avec verification de hash SHA-256 pour les commandes distantes. Pour une release investisseur finale, l'environnement CI doit fournir :

- `CSC_LINK` / `CSC_NAME` ou identite Developer ID macOS.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` pour notarisation.
- `WIN_CSC_LINK` ou `WINDOWS_CERTIFICATE_FILE` pour signature Windows.

Tant que ces variables ne sont pas presentes, l'app affiche la pipeline comme prete mais les signatures comme "a configurer".

## Preuve attendue

- Screenshot dashboard worker avec health check vert.
- Screenshot admin network avec le meme peer live.
- Requete API montrant une inference.
- Ligne d'usage API et payout worker cote serveur.
- Release build macOS/Windows signee et notarisee pour la data room.
