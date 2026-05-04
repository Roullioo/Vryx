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
    title: 'API compatible OpenAI, -80% moins chère.',
    intro:
      'Vous changez juste l\'URL et la clé API. Tout le reste est identique. Vous réglez en euros par carte bancaire.',
  },
  workersSection: {
    eyebrow: 'Pour les gamers',
    title: 'Louez votre GPU quand vous ne jouez pas.',
    bodyLead:
      'Reversements en euros par virement SEPA. La mise en service repose sur une application cliente légère : elle rattache votre GPU au réseau sans vous imposer de stocker un modèle volumineux sur votre disque. Vous exécutez des charges de calcul transitoires, et votre solde worker est mis à jour au fil des tâches.',
    bodyRange:
      'Fourchette indicative : un GPU milieu ou haut de gamme, régulièrement en ligne, peut générer entre 15 et 45 € par mois, selon le réseau et votre disponibilité.',
    linkCompare: 'Voir le fonctionnement (Course et Relais)',
    linkPage: 'Installation et FAQ, page worker',
  },
  racePoolSection: {
    eyebrow: 'L\'architecture réseau',
    title: 'Comment on élimine la latence d\'Internet.',
    titleAccent: '',
    intro:
      'Les connexions des particuliers peuvent être instables. Nous avons conçu la "Competitive Redundancy" (La Course) et le "Pipeline Parallelism" (Le Relais) pour garantir une vitesse optimale en permanence.',
    highlights: [
      {
        title: 'La Course',
        body:
          'Après découpage mémoire, un bloc peut être envoyé à plusieurs GPU en parallèle : le premier résultat valide pour ce bloc débloque la suite ; les autres tentatives sur ce bloc sont interrompues.',
      },
      {
        title: 'Le Relais',
        body:
          'Les très grands modèles sont découpés en chaîne : un groupe de machines enchaîne avec le suivant pour ne saturer aucun poste.',
      },
    ],
  },
  racePoolPage: {
    eyebrow: 'L\'architecture Vryx',
    title: 'La Course et le Relais : vitesse garantie.',
    titleAccent: '',
    intro:
      'Pour concurrencer les datacenters sans posséder de serveurs, Vryx contourne l\'instabilité d\'Internet via deux innovations majeures : la Course (pour la redondance) et le Relais (pour la répartition de charge).',
  },
  comparePage: {
    title: 'La Course (Competitive Redundancy)',
    intro:
      'Solo ou Pool : même réseau, seul le gain change.\nChoisissez entre jackpot immédiat ou revenus réguliers.',
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
