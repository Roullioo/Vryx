/** Fourchette mensuelle indicative pour la copy (non contractuelle), sans modèle précis. */
export const WORKER_INDICATIVE_MONTHLY_MIN_EUR = 15
export const WORKER_INDICATIVE_MONTHLY_MAX_EUR = 45

export const WORKER_INDICATIVE_MONTHLY_DISCLAIMER =
  'Indicatif : charge réseau et disponibilité influencent le total.'

export const WORKERS_FAQ = [
  {
    q: 'Quand suis-je payé ?',
    a: 'Les gains s’accumulent sur votre solde worker. Dès le seuil de 50 euros atteints, vous pouvez demander un virement SEPA (délai bancaire habituel).',
  },
  {
    q: 'Mon GPU est-il exposé sur Internet ?',
    a: 'L’application worker ouvre une connexion sortante chiffrée vers notre serveur central. Aucun port entrant n\'est requis.',
  },
  {
    q: 'L\'installation est-elle lourde ?',
    a: 'Pas du tout. Il s’agit d’une application de faible empreinte (quelques mégaoctets) : elle ne remplace pas l’installation d’un modèle complet sur votre machine ; elle orchestre uniquement les tâches que nous distribuons.',
  },
  {
    q: 'Qu\'en est-il de la confidentialité ?',
    a: 'Vous ne recevez que des équations mathématiques pures. Vous ne pouvez ni voler le modèle, ni lire la question de l\'utilisateur.',
  },
  {
    q: 'Combien un GPU milieu ou haut de gamme peut-il rapporter par mois ?',
    a: `En ordre de grandeur, une carte correctement raccordée et souvent en ligne se situe entre ${WORKER_INDICATIVE_MONTHLY_MIN_EUR} et ${WORKER_INDICATIVE_MONTHLY_MAX_EUR} euros par mois. ${WORKER_INDICATIVE_MONTHLY_DISCLAIMER}`,
  },
] as const

export const WORKER_INSTALL_LINES = [
  { label: 'Linux / macOS', cmd: 'curl -fsSL https://get.vryx.ai | sh' },
  { label: 'Windows (PowerShell admin)', cmd: 'iwr https://get.vryx.ai/ps | iex' },
] as const
