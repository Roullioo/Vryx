export const RACE_POOL_STEPS = [
  {
    n: '1',
    title: 'Réservation',
    body: 'L’API vérifie le compte, le modèle et les crédits, puis réserve les workers compatibles avec la mémoire et le profil demandé.',
    ring: 'bg-accent/20 text-accent',
  },
  {
    n: '2',
    title: 'Construction du chemin',
    body: 'Le réseau construit le meilleur chemin disponible selon la connectivité, la disponibilité et les contraintes du run.',
    ring: 'bg-electric/20 text-electric',
  },
  {
    n: '3',
    title: 'Pipeline',
    body: 'Les workers exécutent les fragments prévus dans l’ordre. La course peut exister sur certains blocs, mais le chemin stable reste un pipeline distribué mesurable.',
    ring: 'bg-accent/20 text-accent',
  },
  {
    n: '4',
    title: 'Preuves',
    body: 'Chaque run alimente les traces : workers utilisés, tokens, latence, débit, coût estimé, readiness et artefacts de benchmark.',
    ring: 'bg-alert/20 text-alert',
  },
] as const

export const RACE_POOL_FAQ = [
  {
    q: 'Race Pool est-il encore une course entre GPU ?',
    a: 'Pas comme promesse unique. Le chemin actuel réserve des workers, construit un pipeline distribué et mesure le run. La course reste une stratégie possible pour certains blocs critiques, mais elle n’est plus présentée comme le mode permanent de production.',
  },
  {
    q: 'Qu’est-ce qui est prouvé aujourd’hui ?',
    a: 'Le dossier technique contient un bench staging protégé, des workers déclarés par heartbeat, des traces réseau, un readiness score et une page network publique redacted. Les identifiants, adresses et détails sensibles ne sont pas exposés publiquement.',
  },
  {
    q: 'Comment la facturation s’aligne avec le calcul distribué ?',
    a: 'Le serveur rattache chaque génération aux tokens, crédits, coûts estimés et workers utilisés. Cette base sert au débit client, aux preuves de session et au futur ledger de payout worker.',
  },
] as const
