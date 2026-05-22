# Vryx incident response

## Severite

- SEV1 : fuite de donnees, secret expose, acces admin compromis, paiement compromis, indisponibilite production majeure.
- SEV2 : panne inference ou billing partielle, worker abuse confirme, regression securite sans fuite connue.
- SEV3 : degradation latence, bench golden path en echec, bug UI admin, alertes non critiques.

## Detection

- Logs API et worker heartbeat.
- Erreurs golden path et production-readiness.
- Alertes CI/CD et audits dependances.
- Signalement client ou worker.
- Alertes Stripe webhook/billing.

## Triage 30 minutes

1. Nommer un incident lead.
2. Geler les deploiements non critiques.
3. Classer la severite.
4. Preserver logs et artefacts.
5. Identifier le perimetre : comptes, workers, cles API, datasets, paiement.
6. Appliquer containment : rotation secrets, blocage worker, rate limit, rollback, coupure endpoint.

## Containment

- Rotation `JWT_SECRET`, worker secret, Stripe webhook secret si touches.
- Revocation cles API client exposees.
- Mise en quarantaine des workers suspects.
- Desactivation temporaire routes worker/admin si necessaire.
- Passage billing en mode bloque si debit incorrect.

## Communication

- SEV1 : communication client sous 24h apres confirmation initiale.
- RGPD : evaluation notification autorite sous 72h si violation de donnees personnelles.
- Message public : faits confirmes uniquement, impact, mitigation, prochaine mise a jour.
- Postmortem interne obligatoire pour SEV1/SEV2.

## Eradication et recovery

- Patch et revue de code.
- Tests de regression.
- Redeploiement controle.
- Verification golden path.
- Verification billing ledger.
- Verification public status redacted.

## Postmortem

Inclure :

- timeline,
- cause racine,
- impact client,
- donnees affectees,
- detection,
- ce qui a fonctionne,
- ce qui a echoue,
- actions correctives,
- proprietaire et date limite.

## Exercices

- Rotation secrets trimestrielle simulee.
- Test restauration backup trimestriel.
- Simulation worker malveillant semestrielle.
- Exercice fuite API key semestriel.
