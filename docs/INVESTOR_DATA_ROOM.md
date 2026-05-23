# Vryx investor data room

Derniere mise a jour : 2026-05-22.

## Positionnement

Vryx est une plateforme d'inference IA distribuee : API compatible developpeurs, workers desktop, daemon Rust/libp2p, runtime Python/gRPC, dashboard admin, facturation par credits et readiness score.

Angle investisseur : le coeur technique existe ; la levee finance l'industrialisation, la securite, le go-to-market B2B et la capacite reseau.

## Preuves techniques disponibles

- API Express avec auth, comptes, cles API, sessions, usage tokens et billing ledger.
- Worker desktop Electron avec configuration modele/backend/quantization, secret worker et heartbeat authentifie.
- Daemon Rust libp2p avec TCP/QUIC, relay, hot commands et heartbeat enrichi.
- Runtime Python/gRPC MLX/llama/vLLM avec timeout busy corrige.
- Dashboard `/admin/production-readiness`.
- Page publique `/network`.
- Endpoint public redacted `/api/public/network-status`.
- Golden path benchmark journalise avec artefacts JSON.
- Service `vryx-golden-path-proof-100.service` pour preuve 100 requetes.
- Workflow CI `Investor CI`.
- Workflow release worker `Worker Release Build`.
- All credentials used during investor-readiness testing were rotated after validation.
- Redis/Valkey is used as a speed, coordination and job layer while MariaDB remains the source of truth for users, credits, pricing, usage, payouts and audits.
- Billing money path auditable : `docs/BILLING_MONEY_PATH.md` et `/api/admin/billing/proof`.

## Metrics a exposer en pitch

- Workers enregistres et workers live.
- Tokens 24h / 30j.
- Golden path : success rate, empty responses, TPS p50/p95, TTFT p95.
- Cout estime par million de tokens.
- Solde credits client et usage debite.
- Worker rewards et marge nette.
- CI verte : frontend, backend, Rust, Python, Electron smoke.

## Golden path cible

Configuration de reference :

- Modele : `Qwen/Qwen3.6-35B-A3B`.
- Quantization : `q4`.
- Pool : `auto`.
- Seuil : 100 requetes, >= 99 % succes, 0 reponse vide, TPS p50 >= 10, TTFT p95 <= 10 s.

Artefacts :

- Court quotidien : `/var/www/vryx/var/golden-path/latest.json`.
- Preuve 100 runs : `/var/www/vryx/var/golden-path-proof-100/latest.json`.

## Offre commerciale

- Vryx API : credits prepayes, cles API, debit a l'usage.
- Vryx Private Pool : capacite dediee/semi-dediee, SLA, privacy renforcee.
- Vryx Custom AI : RAG, fine-tuning, LoRA ou projet IA metier avec devis.

## Preuves commerciales a collecter

Objectif court terme : 2-3 lettres d'interet signees ou au moins 1 pilote payant.

Suivi produit :

- `/admin/enterprise` suit maintenant les demandes B2B, lettres d'interet, pilotes payants, montant pilote, prochaine action et lien vers document signe.
- Les templates sont disponibles dans `docs/LETTER_OF_INTEREST_TEMPLATE.md` et `docs/PAID_PILOT_TEMPLATE.md`.
- Le pipeline de preuve est decrit dans `docs/COMMERCIAL_PROOF_PIPELINE.md`.

Important : une lettre d'interet ne devient une preuve investisseur qu'une fois signee par un prospect reel. Un pilote payant doit etre lie a une facture, un paiement ou un bon de commande.

## Roadmap 90 jours

- Jours 1-15 : securite production, routes redacted, worker auth obligatoire, secrets stricts.
- Jours 15-30 : golden path 100 runs, P2P direct proof, demo live stable.
- Jours 30-45 : Stripe production, credits API, invoices, pricing par modele.
- Jours 45-60 : worker app signee, auto-update, health check, diagnostic reseau.
- Jours 60-75 : Private Pool, simulateur devis, data room, premiers pilotes.
- Jours 75-90 : CI verte, audit securite planifie, deck 12 slides, 3 LOI/pilotes.

## Roadmap 24 mois

- 0-6 mois : securite, billing, worker release signee, pilotes B2B, proof network.
- 6-12 mois : private pools, SLA, observabilite avancee, worker payouts, partenaires.
- 12-18 mois : Knowledge AI/RAG securise, Fine-Tune Studio, model routing par cout/latence.
- 18-24 mois : capacite multi-region UE, compliance renforcee, marketplace worker premium.

## Risques et mitigations

- Reseau P2P instable : fallback relay, diagnostic direct, scoring route directe.
- Securite worker/API : auth obligatoire, redaction publique, rate limits, audit externe.
- Cout inference : pricing par modele, credits prepayes, worker payout ledger.
- Compliance B2B : no-retention, DPA, logs d'acces, suppression donnees, incident response.
- Distribution desktop : signature macOS/Windows, checksums, auto-update controle.

## Budget levee indicatif

- Engineering infra/securite : 35 %.
- Produit worker/API/billing : 25 %.
- Go-to-market B2B et partenariats : 20 %.
- Legal/compliance/audit : 10 %.
- Cloud, GPU reserve, operations : 10 %.

## Documents lies

- `docs/SECURITY_ARCHITECTURE_VRYX.md`
- `docs/P2P_DIRECT_NETWORKING.md`
- `docs/WORKER_RELEASE_RUNBOOK.md`
- `docs/COMPLIANCE_AND_DATA_PROTECTION.md`
- `docs/DPA_DRAFT.md`
- `docs/INCIDENT_RESPONSE.md`
- `docs/WORKER_TERMS_DRAFT.md`
- `docs/LETTER_OF_INTEREST_TEMPLATE.md`
- `docs/PAID_PILOT_TEMPLATE.md`
- `docs/COMMERCIAL_PROOF_PIPELINE.md`
