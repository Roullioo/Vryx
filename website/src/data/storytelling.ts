/** Textes marketing : alternative datacenter, gamers, sécurité, install rapide, latence (course et relais). */

export const STORYTELLING = {
  privacySection: {
    eyebrow: 'Sécurité',
    title: 'Confidentialité par conception',
    titleEn: 'Privacy by design',
    intro:
      'La confidentialité est une contrainte d\'architecture : le worker reçoit des opérations mathématiques isolées, jamais le modèle complet ni vos données en clair.',
    footnote:
      'VRAM libérée après chaque tâche. Flux chiffré côté orchestration. Surface d\'attaque réduite par conception.',
  },
  cta: {
    title: 'Reprenez le contrôle de vos calculs.',
    body:
      'Que vous cherchiez à réduire votre facture d\'inférence ou à rentabiliser votre matériel, Vryx est l\'infrastructure de demain.',
    primary: { label: 'Simulateur de coûts', to: '/simulateur' },
    secondary: { label: 'Connexion', to: '/connexion' },
  },
  clientsSection: {
    eyebrow: 'Pour les développeurs',
    title: 'API compatible OpenAI, credits et couts mesures.',
    intro:
      'Vous changez l\'URL, générez une clé API et suivez vos tokens, crédits et coûts en euros. La priorité produit est la preuve de fonctionnement, pas une promesse de remise uniforme.',
  },
  workersSection: {
    eyebrow: 'Pour les gamers',
    title: 'Louez votre GPU quand vous ne jouez pas.',
    bodyLead:
      'Reversements en euros par virement SEPA. La mise en service rattache votre machine au reseau, declare son hardware, son runtime, son modele et son etat de sante. Selon le profil, le worker execute un runtime local et participe aux generations mesurees.',
    bodyRange:
      'Fourchette indicative : un GPU milieu ou haut de gamme, régulièrement en ligne, peut générer entre 15 et 45 € par mois, selon le réseau et votre disponibilité.',
    linkCompare: 'Voir le fonctionnement du pool',
    linkPage: 'Installation et FAQ, page worker',
  },
  racePoolSection: {
    eyebrow: 'L\'architecture réseau',
    title: 'Comment Vryx orchestre un pool IA distribué.',
    titleAccent: '',
    intro:
      'Vryx orchestre un réseau de workers déclarés, réservés et mesurés. La course reste une optimisation possible, mais le chemin stable est un pipeline distribué, réservé et auditable.',
    highlights: [
      {
        title: 'Réservation et sélection',
        body:
          'Le serveur choisit les workers selon le modèle, la mémoire disponible, le heartbeat et la disponibilité. Les routes publiques ne publient que des données redacted.',
      },
      {
        title: 'Pipeline et preuves',
        body:
          'Les runs produisent des traces : affectations, tokens, latence, débit, coûts estimés, readiness et artefacts de benchmark.',
      },
    ],
  },
  racePoolPage: {
    eyebrow: 'L\'architecture Vryx',
    title: 'Race Pool : orchestration, pipeline et preuves.',
    titleAccent: '',
    intro:
      'Race Pool décrit maintenant le fonctionnement réel : réservation de workers, construction du chemin d’exécution, pipeline distribué et mesures exploitables en readiness.',
  },
  comparePage: {
    title: 'Pool workers et repartition de calcul',
    intro:
      'Solo ou pool: le revenu depend de la disponibilite, du modele supporte, de la latence et de la qualite des runs.',
  },
  clientsPage: {
    title: 'Développeurs : API, tarifs et sécurité.',
  },
  workersPage: {
    title: 'Amortissez votre GPU en euros',
    intro:
      'Installation rapide, virements SEPA en euros.',
  },
  disclaimer: {
    workerSim:
      'Ordre de grandeur non contractuel. La charge du réseau et votre disponibilité influencent le résultat.',
    inferenceSim:
      'Indicatif, sans valeur contractuelle. Aucune donnée n’est envoyée.',
  },
} as const
