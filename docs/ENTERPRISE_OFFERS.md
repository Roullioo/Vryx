# Vryx Enterprise Offers

Vryx vend trois offres lisibles.

## 1. Vryx API

Self-serve developpeurs.

- Credits prepayes ou abonnement.
- Cles API compatibles OpenAI.
- Pricing par modele.
- Usage, couts, factures et ledger client.
- Prix d'entree : credits des 50 EUR.

## 2. Vryx Private Pool

Offre B2B prioritaire.

- Capacite dediee ou semi-dediee.
- Modele choisi.
- Workers reserves.
- SLA standard, business ou mission critical.
- Logs, dashboard, couts, privacy renforcee.
- Prix d'entree : 3 500 EUR/mois.

## 3. Vryx Custom AI

Projet client.

- Dataset client.
- RAG, LoRA/fine-tuning ou integration metier.
- Evaluation, deploiement inference et maintenance.
- No-retention ou pool prive selon contrat.
- Prix d'entree : 6 000 EUR/mois + setup.

## Produit Code

La page `/enterprise` contient un configurateur B2B avec :

- offre ;
- modele cible ;
- volume tokens ;
- latence cible ;
- SLA ;
- confidentialite ;
- fine-tuning ;
- taille dataset ;
- workers dedies ;
- devis automatique.

L'admin `/admin/enterprise` permet de :

- qualifier une demande ;
- suivre LOI, pilote payant, client ;
- convertir une demande en projet client ;
- suivre le projet, son modele, son SLA, son dataset, ses couts et son statut.

Tables :

- `enterprise_quote_requests`
- `enterprise_customer_projects`
