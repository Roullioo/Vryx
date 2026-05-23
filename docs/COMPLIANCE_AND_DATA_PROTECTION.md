# Vryx compliance and data protection baseline

Derniere mise a jour : 2026-05-22.

> Compliance pack detaille : `docs/compliance/README.md`.

Ce document est une base operationnelle. Il ne remplace pas une validation avocat/DPO, mais il donne les controles attendus pour vendre Vryx en B2B.

## Donnees traitees

- Donnees compte : email, hash mot de passe, statut, role.
- Donnees API : cle API hashee, usage tokens, cout, sessions, logs techniques.
- Donnees inference : prompt, reponse, modele, latence, tokens, cout, statut.
- Donnees worker : peer id, ports P2P, IP publique observee, hardware, uptime, tokens, erreurs.
- Donnees billing : credits, ledger, invoices Stripe, evenements webhook.
- Donnees enterprise : demande devis, volume, SLA, confidentialite, statut commercial.

## Bases legales

- Execution du contrat : compte, credits, inference, facturation.
- Interet legitime : securite, anti-fraude, logs techniques, prevention abus.
- Consentement ou contrat specifique : usage de datasets clients pour RAG/fine-tuning.
- Obligation legale : factures, taxes, conservation comptable.

## Retention

- Logs inference standard : 30 jours par defaut.
- Logs securite et audit : 180 jours.
- Facturation : duree legale comptable applicable.
- Donnees no-retention : prompts/reponses non persistes hors metriques minimales.
- Datasets clients : suppression a la fin du projet ou selon DPA.

## Droits utilisateurs

- Export compte et usage.
- Suppression compte si aucune obligation comptable ne bloque.
- Suppression cles API.
- Suppression datasets et projets client.
- Rectification email/profil.

## Chiffrement

- Transit : HTTPS public, gRPC limite au reseau interne ou tunnel securise.
- Secrets : variables d'environnement, jamais dans le repo.
- Au repos : base de donnees et backups chiffres au niveau disque ou service managé.
- API keys : stockage hashe, jamais retour en clair apres creation.

## Mode no-retention

Pour clients sensibles :

- pas de stockage prompt/reponse en clair,
- logs limites a `request_id`, modele, tokens, cout, latence, statut,
- datasets separes par projet,
- acces admin journalise,
- suppression programmable et attestable.

## Sous-traitants

- Stripe : paiement, factures, taxes.
- Hebergeur VPS/cloud : API, base, observabilite.
- Providers DNS/email si utilises.
- Workers externes : traites comme capacite de calcul sous contrat, avec obligations de confidentialite et restrictions techniques.

## Worker privacy controls

- Les endpoints publics doivent redacter peer IDs complets, IPs et ports.
- Les endpoints admin peuvent afficher les details sous auth admin.
- Les ports API/gRPC locaux ne doivent pas etre exposes publiquement.
- Les workers suspects peuvent etre bloques, mis en quarantaine ou exclus du payout.

## Checklist avant vente enterprise

- DPA pret a signer.
- Politique de retention publiee.
- Procedure incident securite publiee.
- Contrat worker et payout ledger.
- Registre RGPD maintenu.
- Backups chiffres et test restauration.
- Controle d'acces admin par role.
- Audit externe planifie.

## Gaps connus

- DPA final et CGU a valider juridiquement.
- Chiffrement applicatif champ par champ non encore generalise.
- No-retention doit etre force cote code par plan client, pas seulement par politique.
- KYC worker et justificatifs payout a finaliser selon seuils.
