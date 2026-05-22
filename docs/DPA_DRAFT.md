# Vryx DPA draft

Document de travail a valider juridiquement.

## Parties

- Client : responsable de traitement pour ses donnees et prompts.
- Vryx : sous-traitant pour l'inference, l'hebergement, les logs techniques et projets IA.
- Workers externes : sous-traitants ulterieurs uniquement si le plan client l'autorise.

## Objet

Fourniture d'une plateforme d'inference IA, API, pools prives, RAG, fine-tuning ou projets Custom AI.

## Instructions documentees

Vryx traite les donnees uniquement pour :

- fournir le service demande,
- securiser la plateforme,
- mesurer usage, cout et qualite,
- respecter obligations legales de facturation.

## Categories de donnees

- prompts, reponses, fichiers ou datasets fournis par le client,
- identifiants compte et utilisateurs,
- logs techniques,
- metriques usage et billing.

## Mesures de securite

- HTTPS en transit.
- Auth admin et worker obligatoire.
- Redaction des endpoints publics.
- Secrets hors repo.
- Logs d'acces.
- Retention configurable.
- Isolation logique par compte/projet.
- Possibilite no-retention pour clients sensibles.

## Sous-traitants ulterieurs

Vryx maintient une liste des sous-traitants : hebergeur, paiement, email/DNS, observabilite, workers externes autorises. Le client enterprise peut demander une restriction aux workers dedies ou internes.

## Assistance au client

Vryx aide le client a repondre aux demandes d'acces, suppression, export et rectification dans un delai raisonnable.

## Notification incident

Vryx notifie le client sans delai indu apres confirmation d'une violation de donnees personnelles, avec nature, impact connu, mesures prises et plan de correction.

## Fin de contrat

Sur demande, Vryx supprime ou restitue les donnees client, sauf conservation legale obligatoire.

## Gaps juridiques

- Delais contractuels exacts.
- Liste definitive des sous-traitants.
- Clauses SCC si transfert hors EEE.
- Audit client et preuves SOC2/ISO futures.
- Responsabilites worker selon pays.
