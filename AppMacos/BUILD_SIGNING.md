# Build signe Vryx Worker

## macOS

Le build macOS est pret pour Gatekeeper:

```bash
export CSC_LINK=/chemin/certificat-developer-id.p12
export CSC_KEY_PASSWORD='mot-de-passe-certificat'
export APPLE_ID='apple-id@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='ABCDE12345'
npm run build:mac:signed
```

Si les variables Apple ne sont pas presentes, le hook de notarisation est ignore. Le build reste utile pour tester localement, mais macOS affichera encore l'alerte Gatekeeper.

## Windows

Smart App Control Windows 11 bloque les binaires publics non signes ou sans editeur verifiable. Un ZIP, un renommage ou un nouveau chemin de telechargement ne suffit pas : l'EXE doit porter une signature Authenticode chainee vers une autorite de confiance Microsoft.

Option recommandee pour VRYX : Azure Artifact Signing / Trusted Signing, ou un certificat OV/EV Code Signing reconnu.

### Certificat PFX OV/EV

```bash
export CSC_LINK=/chemin/certificat-code-signing.pfx
export CSC_KEY_PASSWORD='mot-de-passe-certificat'
npm run build:win:signed
```

`build:win:signed` active `forceCodeSigning=true` et verifie que les installeurs `.exe` contiennent une table de signature Authenticode avant publication.

### Azure Artifact Signing / Trusted Signing

Variables a fournir dans CI ou sur la machine de build :

```bash
export AZURE_TENANT_ID='...'
export AZURE_CLIENT_ID='...'
export AZURE_CLIENT_SECRET='...'
export VRYX_AZURE_TRUSTED_SIGNING_ENDPOINT='https://<region>.codesigning.azure.net/'
export VRYX_AZURE_TRUSTED_SIGNING_ACCOUNT='vryx-signing'
export VRYX_AZURE_TRUSTED_SIGNING_PROFILE='vryx-public'
export VRYX_AZURE_TRUSTED_SIGNING_PUBLISHER='Nom legal exact de l editeur'
npm run build:win:signed
```

Le setup genere un installateur NSIS x64/arm64 avec choix du dossier, raccourcis et conservation des donnees worker a la desinstallation.
