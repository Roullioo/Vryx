# Vryx worker terms draft

Document de travail a valider juridiquement avant publication.

## Role du worker

Le worker fournit une capacite de calcul pour executer des charges d'inference autorisees par Vryx. Il ne devient pas proprietaire des prompts, sorties, modeles, datasets ou metriques clients.

## Conditions minimales

- Compte Vryx valide.
- Version worker supportee.
- Heartbeat authentifie.
- Ports API/gRPC locaux non exposes publiquement.
- Pas de modification visant a falsifier tokens, latence, modele ou qualite.
- Respect des lois applicables et des restrictions d'usage Vryx.

## Donnees visibles par le worker

Selon le mode d'execution, le worker peut recevoir des fragments de prompt, tensors, shards ou jobs d'inference. Vryx doit privilegier les modes qui minimisent l'exposition de donnees client pour les offres sensibles.

Le worker s'engage a ne pas enregistrer, reutiliser, revendre ou publier les donnees de jobs.

## Payout

Le payout est calcule selon :

- tokens generes valides,
- modele supporte,
- quantization/backend,
- taux de succes,
- uptime,
- latence,
- reputation,
- disponibilite sur pools premium ou dedies.

Vryx peut retenir ou annuler un payout en cas de fraude, fausse metrique, job invalide, violation securite, charge non terminee ou usage abusif.

## KYC et seuils

Vryx peut demander des informations d'identite, fiscales ou bancaires avant payout, notamment au-dela d'un seuil mensuel ou legal.

## Securite

Le worker doit :

- garder son secret worker confidentiel,
- mettre a jour l'app,
- ne pas exposer les endpoints internes,
- ne pas contourner les controles Vryx,
- signaler toute faille ou incident.

## Suspension

Vryx peut suspendre un worker sans preavis en cas de risque securite, fraude, non-conformite, comportement anormal ou demande client enterprise.

## Gaps a finaliser

- Statut fiscal worker par pays.
- Modele de facture ou auto-facturation.
- KYC et lutte anti-fraude.
- Clauses de confidentialite detaillees.
- Limitation de responsabilite.
- Politique de contestation payout.
