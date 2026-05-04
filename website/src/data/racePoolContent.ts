export const RACE_POOL_STEPS = [
  {
    n: '1',
    title: 'Multi-cast',
    body: 'Pour une étape en course, le serveur diffuse le bloc utile vers plusieurs GPU candidats en parallèle.',
    ring: 'bg-accent/20 text-accent',
  },
  {
    n: '2',
    title: 'Exécution',
    body: 'Chaque GPU traite en parallèle. Premier arrivé, premier servi.',
    ring: 'bg-electric/20 text-electric',
  },
  {
    n: '3',
    title: 'Résultat',
    body: 'Le GPU dont le résultat est retenu pour ce bloc renvoie la sortie et est rémunéré selon les règles de cette étape ; le reste du graphe continue ailleurs.',
    ring: 'bg-accent/20 text-accent',
  },
  {
    n: '4',
    title: 'Cut-off',
    body: 'Signal rouge instantané pour libérer la VRAM des autres participants.',
    ring: 'bg-alert/20 text-alert',
  },
] as const

export const RACE_POOL_FAQ = [
  {
    q: 'Qu’est-ce qui différencie la Race-Pool d’un simple load balancer ?',
    a: 'Une inférence volumineuse est toujours découpée selon la VRAM : plusieurs nœuds portent des fragments différents du graphe. Là où la course s’applique, un même sous-bloc peut être envoyé à plusieurs workers en parallèle ; le premier résultat valide fait progresser la requête et les autres tentatives sur ce bloc sont coupées pour libérer la mémoire, plutôt que de faire la queue passivement.',
  },
  {
    q: 'La coupure (cut-off) est-elle fiable pour la facturation ?',
    a: 'Oui : le protocole est conçu pour que seul le chemin gagnant soit facturé côté client, et que les workers relâchent leurs ressources dès réception du signal, ce qui limite le coût marginal des tentatives avortées.',
  },
  {
    q: 'Peut-on combiner Race-Pool avec des workers géographiquement éloignés ?',
    a: 'C’est même un des cas d’usage typiques : le multi-cast traverse le réseau vers plusieurs régions ; la latence réseau fait partie de la « course ». Le simulateur sur le site permet de modéliser ce compromis.',
  },
] as const
