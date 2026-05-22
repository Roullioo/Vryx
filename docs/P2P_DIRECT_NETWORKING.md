# Vryx P2P direct networking

Objectif investisseur : prouver qu'au moins un worker peut etre joint en direct, sans dependance exclusive au relay, et exposer cette preuve dans le readiness score.

## Ports

- TCP `4021` : libp2p request/response.
- UDP `4021` : libp2p QUIC.
- TCP `3031` : API locale du daemon worker, a garder privee.
- TCP `50052` : runtime inference local, a garder prive.

Seul le port P2P doit etre exposable. Les ports API et gRPC restent bindes localement ou filtres par firewall.

## Procedure de preuve

Sur la machine worker :

```bash
cd nodeAndWorker
VRYX_P2P_PORT=4021 ./scripts/vryx-direct-p2p-diagnostic.sh
```

Si le routeur supporte UPnP et que l'ouverture automatique est acceptable pour le test :

```bash
VRYX_P2P_PORT=4021 VRYX_APPLY_UPNP=1 ./scripts/vryx-direct-p2p-diagnostic.sh
```

Si le port externe `4021` est deja reserve par la box, utiliser un port externe haut tout en gardant le worker local sur `4021` :

```bash
VRYX_P2P_PORT=4021 VRYX_EXTERNAL_P2P_PORT=54021 VRYX_APPLY_UPNP=1 ./scripts/vryx-direct-p2p-diagnostic.sh
```

Depuis le VPS ou une autre machine externe :

```bash
nc -vz -w 5 <PUBLIC_IP> <EXTERNAL_P2P_PORT>
nmap -sU -p <EXTERNAL_P2P_PORT> <PUBLIC_IP>
```

Le TCP doit repondre `succeeded` pour la preuve minimale. UDP/QUIC est un plus ; certains reseaux filtrent la sonde UDP meme lorsque QUIC fonctionne.

## Marquage readiness

Une fois la sonde externe validee, configurer le worker avec :

```bash
VRYX_ROUTE_MODE=direct_tcp
VRYX_DIRECT_READY=1
VRYX_DIRECT_PUBLIC_IP=<PUBLIC_IP>
VRYX_DIRECT_PUBLIC_PORT=<EXTERNAL_P2P_PORT>
VRYX_DIRECT_PROOF_AT=<ISO_UTC_DATE>
```

Le daemon ajoute ces champs au `machine_info.network` du heartbeat. Le endpoint `/api/public/golden-path-status` et le scoring `production-readiness` lisent ensuite `directReady` ou `routeMode=direct_tcp`.

## Pare-feu attendu

- Autoriser `4021/tcp` depuis Internet ou depuis les IPs initiateurs Vryx.
- Autoriser `4021/udp` si QUIC direct doit etre teste.
- Refuser `3031/tcp` et `50052/tcp` depuis Internet.
- Journaliser les refus et connexions P2P lors des tests de due diligence.

## Critere investisseur

La preuve est consideree acceptable quand :

- un worker live envoie `routeMode=direct_tcp` et `directReady=true`,
- le VPS confirme la connexion TCP externe sur le port P2P,
- un golden path passe apres ce marquage,
- la page readiness n'affiche plus l'avertissement "Aucun worker live ne prouve une route P2P directe".
