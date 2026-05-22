export const CLIENT_FAQ = [
  {
    q: 'Puis-je utiliser le SDK officiel OpenAI ?',
    a: 'Oui. Il suffit de pointer `base_url` vers l’endpoint Vryx et d’utiliser une clé API au format `vel_…`. Les schémas de requête et de réponse restent alignés sur l’API Chat Completions.',
  },
  {
    q: 'Comment sont facturés les tokens ?',
    a: 'À la consommation, en euros, au million de tokens traités. Les requêtes échouées avant tout token de sortie ne sont généralement pas facturées (voir conditions contractuelles).',
  },
  {
    q: 'Y a-t-il une limite de débit ?',
    a: 'Des plafonds par organisation et par clé API protègent le pool. Ils sont ajustables depuis votre espace compte ; au-delà, vous recevez une réponse HTTP 429 avec en-tête `Retry-After`.',
  },
] as const

export const CLIENT_ENDPOINTS = [
  { method: 'POST', path: '/v1/chat/completions', desc: 'Chat Completions (API principale)' },
  { method: 'GET', path: '/v1/models', desc: 'Liste dynamique des modèles (auth requis)' },
  { method: 'GET', path: '/api/public/models', desc: 'Liste publique des modèles et statut (aucune auth)' },
  { method: 'GET', path: '/api/public/pricing', desc: 'Tarifs publics et paramètres de facturation (lecture seule)' },
] as const
