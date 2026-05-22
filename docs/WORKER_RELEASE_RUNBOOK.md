# Vryx Worker release runbook

Objectif : produire un artefact worker verifiable, avec daemon Rust et runtime Python coherents avec le code du repo.

## Pre-check

```bash
cargo build --release -p rust-daemon
cd AppMacos
npm run prepare:runtime
npm run build
```

`prepare:runtime` copie le daemon compile vers `nodeAndWorker/bin/<platform>-<arch>/rust-daemon`, verifie les fichiers Python critiques, puis genere `nodeAndWorker/runtime-release-manifest.json` avec tailles et SHA-256.

## Build macOS unsigned

```bash
cd AppMacos
npm run build:mac:unsigned
```

Artefact attendu : `AppMacos/release/mac*/Vryx.app`. Ce build sert aux tests internes. Il n'est pas acceptable pour distribution publique large sans signature Developer ID et notarisation.

## Build macOS signe/notarise

```bash
export CSC_LINK=/path/to/developer-id.p12
export CSC_KEY_PASSWORD='...'
export APPLE_ID='...'
export APPLE_APP_SPECIFIC_PASSWORD='...'
export APPLE_TEAM_ID='...'
cd AppMacos
npm run build:mac:signed
```

La notarisation est ignoree si les variables Apple sont absentes ; le runbook doit alors declarer explicitement l'artefact comme non notarise.

## Build Windows signe

```bash
export CSC_LINK=/path/to/code-signing.pfx
export CSC_KEY_PASSWORD='...'
cd AppMacos
npm run build:win:signed
```

Alternative CI : configurer Azure Trusted Signing via les variables `VRYX_AZURE_TRUSTED_SIGNING_*`. Le script `verify:win-signature` doit passer avant publication.

## Validation release

- `runtime-release-manifest.json` present dans les ressources emballees.
- `rust-daemon` executable et version heartbeat attendue.
- `shard_runtime.py` contient le timeout MLX non agressif.
- L'app peut demarrer, se connecter au compte Vryx et envoyer un heartbeat worker authentifie.
- Worker command e2e passe sur un worker live.
- Golden path court passe apres installation.

## Checksums publication

Apres packaging :

```bash
shasum -a 256 AppMacos/release/*.{dmg,zip,exe} 2>/dev/null
```

Publier les checksums avec la release. Ne jamais publier un build qui embarque `.vryx-keys`, logs runtime, secrets ou dossiers `venv`.
