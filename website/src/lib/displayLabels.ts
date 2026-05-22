const LABELS: Record<string, string> = {
  acknowledged: 'Confirmée',
  active: 'Actif',
  advanced_beta: 'Bêta avancée',
  cooldown: 'Refroidissement',
  custom_ai: 'Custom AI',
  delivered: 'Livrée',
  direct_tcp: 'Connexion directe',
  eu_only: 'Europe uniquement',
  failed: 'Échec',
  idle: 'En veille',
  initiator_sequential: 'Chaîne séquentielle',
  knowledge_ai: 'Knowledge AI',
  legacy_pytorch: 'Pool historique',
  loading: 'Chargement',
  loading_shard: 'Chargement des fragments',
  new: 'Nouvelle demande',
  no_retention: 'Sans rétention',
  not_ready: 'Pas prêt',
  offline: 'Hors ligne',
  online: 'En ligne',
  pending: 'En attente',
  pipeline_distribue: 'Pipeline distribué',
  pipeline_relay_daisy_chain: 'Pipeline distribué',
  private_pool: 'Pool privé',
  production_candidate: 'Candidat production',
  prototype_plus: 'Prototype avancé',
  ready: 'Prêt',
  reserved: 'Réservé',
  row_split_tensor_parallel: 'Parallélisme distribué',
  running: 'En cours',
  starting: 'Démarrage',
  tcp_grpc: 'TCP interne',
  tcp_p2p: 'TCP P2P',
  unreachable: 'Injoignable',
  usage_debit: 'Débit usage',
  credit_purchase: 'Achat de crédits',
  admin_adjustment: 'Ajustement admin',
  velocity_mlx: 'Pool Mac optimisé',
  velocity_vllm: 'Pool Nvidia optimisé',
  worker_only_pipeline: 'Pipeline worker',
}

export function displayLabel(value: string | null | undefined): string {
  if (!value) return '—'
  const normalized = String(value).trim()
  const key = normalized.toLowerCase()
  if (LABELS[key]) return LABELS[key]
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase('fr-FR'))
}

export function displayMaybeCode(value: string | null | undefined): string {
  if (!value) return '—'
  return String(value)
    .split(/(\s+|·|,|\/)/)
    .map((part) => (/^[a-z0-9]+(?:[_-][a-z0-9]+)+$/i.test(part) ? displayLabel(part) : part))
    .join('')
}
