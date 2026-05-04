import { useCallback, useId, useMemo, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  MOCK_ACCOUNT,
  MOCK_API_KEYS,
  MOCK_INVOICES,
  MOCK_SESSIONS,
  type MockApiKey,
} from '../data/accountMock'
import {
  EurSign,
  IconCode,
  IconCredit,
  IconEuro,
  IconGpu,
  IconLock,
  IconShield,
  IconTerminal,
} from '../components/icons/Icons'

const navAnchors = [
  { id: 'resume', label: 'Synthèse' },
  { id: 'usage', label: 'Usage & quotas' },
  { id: 'cles', label: 'Clés API' },
  { id: 'facturation', label: 'Facturation' },
  { id: 'securite', label: 'Sécurité' },
  { id: 'organisation', label: 'Organisation' },
] as const

function SectionTitle({ icon: Icon, title, id }: { icon: typeof IconEuro; title: string; id: string }) {
  return (
    <h2
      id={id}
      className="font-display scroll-mt-28 text-xl font-bold tracking-tight text-fg sm:text-2xl"
    >
      <span className="inline-flex items-center gap-2">
        <Icon className="h-6 w-6 shrink-0 text-accent" aria-hidden />
        {title}
      </span>
    </h2>
  )
}

export function AccountPage() {
  const { user, loading } = useAuth()
  const formId = useId()
  const [keys, setKeys] = useState<MockApiKey[]>(() => [...MOCK_API_KEYS])
  const [keyModalOpen, setKeyModalOpen] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [revealKey, setRevealKey] = useState<string | null>(null)
  const [copyHint, setCopyHint] = useState<string | null>(null)
  const [twoFactor, setTwoFactor] = useState(false)
  const [rateLimitRps, setRateLimitRps] = useState(120)

  const usageBar = useMemo(
    () => Math.min(100, Math.round(MOCK_ACCOUNT.usagePercent)),
    [],
  )

  const closeModal = useCallback(() => {
    setKeyModalOpen(false)
    setNewKeyName('')
  }, [])

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyHint('Copié dans le presse-papiers.')
      setTimeout(() => setCopyHint(null), 2500)
    } catch {
      setCopyHint('Copie impossible : sélectionnez le texte manuellement.')
      setTimeout(() => setCopyHint(null), 4000)
    }
  }

  function createKey(e: FormEvent) {
    e.preventDefault()
    const name = newKeyName.trim()
    if (!name) return
    const raw = `vel_sk_live_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
    const id = `k-${Date.now()}`
    setKeys((prev) => [
      {
        id,
        name,
        prefix: `${raw.slice(0, 16)}…`,
        createdAt: new Date().toISOString().slice(0, 10),
        lastUsedAt: null,
      },
      ...prev,
    ])
    setRevealKey(raw)
    closeModal()
  }

  function revokeKey(id: string) {
    setKeys((prev) => prev.filter((k) => k.id !== id))
  }

  if (!loading && !user) {
    return <Navigate to="/connexion" replace state={{ from: '/compte' }} />
  }

  if (loading) {
    return (
      <div className="bg-bg min-h-[calc(100svh-4.25rem)] px-4 py-16">
        <div className="mx-auto max-w-4xl animate-pulse space-y-4">
          <div className="h-10 w-1/2 rounded-lg bg-card border border-border" />
          <div className="h-40 panel" />
        </div>
      </div>
    )
  }

  return (
    <div className="bg-bg min-h-[calc(100svh-4.25rem)] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-border pb-8">
          <p className="text-sm font-medium text-accent">Espace client Vryx</p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            Mon compte
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted sm:text-base">
            Solde, consommation, clés API, facturation et sécurité. Données de démonstration : aucune
            modification n’est persistée côté serveur pour l’instant.
          </p>
          <p className="mt-3 font-mono text-sm text-muted">Connecté en tant que {user?.email}</p>
        </header>

        <nav
          className="scrollbar-thin sticky top-[4.25rem] z-30 -mx-4 mt-6 flex gap-2 overflow-x-auto border-b border-border bg-bg/95 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6 lg:top-[4.5rem]"
          aria-label="Sections du compte"
        >
          {navAnchors.map((a) => (
            <a
              key={a.id}
              href={`#${a.id}`}
              className="shrink-0 rounded-full border border-border bg-surface px-4 py-2 text-xs font-medium text-fg transition-colors hover:border-accent/40 hover:text-accent sm:text-sm"
            >
              {a.label}
            </a>
          ))}
        </nav>

        {copyHint && (
          <div
            className="mt-4 rounded-lg border border-electric/40 bg-electric/10 px-4 py-2 text-sm text-electric"
            role="status"
          >
            {copyHint}
          </div>
        )}

        <div className="mt-10 flex flex-col gap-14 lg:gap-16">
          <section className="space-y-6" aria-labelledby="resume">
            <SectionTitle icon={IconEuro} title="Synthèse" id="resume" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="panel p-5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Forfait</p>
                <p className="mt-1 font-display text-2xl font-bold text-fg">{MOCK_ACCOUNT.plan}</p>
                <p className="mt-2 text-xs text-muted">Facturation à l’usage + quota mensuel.</p>
              </div>
              <div className="panel p-5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Solde crédits</p>
                <p className="mt-1 font-display text-2xl font-bold text-fg">
                  {MOCK_ACCOUNT.balanceCredits.toLocaleString('fr-FR', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  <EurSign className="text-muted" />
                </p>
                <p className="mt-2 text-xs text-muted">Prépayé + remises volume négociées.</p>
              </div>
              <div className="panel p-5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Dépenses avril</p>
                <p className="mt-1 font-display text-2xl font-bold text-fg">
                  {MOCK_ACCOUNT.spendThisMonth.toLocaleString('fr-FR', {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  })}{' '}
                  <EurSign className="text-muted" /> HT
                </p>
                <p className="mt-2 text-xs text-muted">
                  Prochaine facture estimée : {MOCK_ACCOUNT.nextInvoiceEstimate.toLocaleString('fr-FR')}
                  <EurSign /> HT
                </p>
              </div>
              <div className="panel p-5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Clés API actives</p>
                <p className="mt-1 font-display text-2xl font-bold text-fg">{keys.length}</p>
                <Link
                  to="/panel/modeles"
                  className="mt-3 inline-flex text-xs font-medium text-accent hover:underline"
                >
                  Gérer les modèles routés
                </Link>
              </div>
            </div>
          </section>

          <section className="space-y-6" aria-labelledby="usage">
            <SectionTitle icon={IconGpu} title="Usage et quotas" id="usage" />
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="panel p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-fg">Tokens (fenêtre glissante 30 j.)</h3>
                <div className="mt-4 h-3 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-fg"
                    style={{ width: `${usageBar}%` }}
                  />
                </div>
                <p className="mt-3 text-sm text-muted">
                  {MOCK_ACCOUNT.tokensUsedMillion.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}M /{' '}
                  {MOCK_ACCOUNT.tokensQuotaMillion}M tokens consommés ({usageBar} %).
                </p>
              </div>
              <div className="panel p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-fg">Requêtes API</h3>
                <div className="mt-4 h-3 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-muted"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round((MOCK_ACCOUNT.requestsThisMonth / MOCK_ACCOUNT.requestsQuota) * 100),
                      )}%`,
                    }}
                  />
                </div>
                <p className="mt-3 text-sm text-muted">
                  {MOCK_ACCOUNT.requestsThisMonth.toLocaleString('fr-FR')} /{' '}
                  {MOCK_ACCOUNT.requestsQuota.toLocaleString('fr-FR')} appels ce mois-ci.
                </p>
              </div>
            </div>
            <div className="panel p-5 sm:p-6">
              <h3 className="text-sm font-semibold text-fg">Limite de débit (req/s)</h3>
              <p className="mt-1 text-xs text-muted">
                Plafond par organisation pour protéger vos workers et la file Race-Pool.
              </p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  type="range"
                  min={10}
                  max={500}
                  step={10}
                  value={rateLimitRps}
                  onChange={(e) => setRateLimitRps(Number(e.target.value))}
                  className="h-2 w-full max-w-md accent-accent"
                  aria-valuetext={`${rateLimitRps} requêtes par seconde`}
                />
                <span className="font-mono text-sm text-electric">{rateLimitRps} req/s</span>
              </div>
            </div>
          </section>

          <section className="space-y-6" aria-labelledby="cles">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <SectionTitle icon={IconTerminal} title="Clés API" id="cles" />
              <button
                type="button"
                onClick={() => {
                  setRevealKey(null)
                  setKeyModalOpen(true)
                }}
                className="btn-primary shrink-0 rounded-lg px-4 py-2.5 text-sm font-semibold"
              >
                Nouvelle clé
              </button>
            </div>
            {revealKey && (
              <div
                className="panel border-warning/40 bg-warning/5 p-4 sm:p-5"
                role="region"
                aria-live="polite"
              >
                <p className="text-sm font-semibold text-warning">Enregistrez cette clé maintenant</p>
                <p className="mt-1 text-xs text-muted">
                  Elle ne sera plus affichée ensuite (comportement type cloud).
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <code className="block break-all rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-fg">
                    {revealKey}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyText(revealKey)}
                    className="btn-secondary rounded-lg px-4 py-2 text-sm font-medium"
                  >
                    Copier
                  </button>
                  <button
                    type="button"
                    onClick={() => setRevealKey(null)}
                    className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-fg"
                  >
                    J’ai sauvegardé
                  </button>
                </div>
              </div>
            )}

            <div className="overflow-x-auto panel">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                    <th className="px-4 py-3 pl-5">Nom</th>
                    <th className="px-4 py-3">Préfixe</th>
                    <th className="px-4 py-3">Création</th>
                    <th className="px-4 py-3">Dernier usage</th>
                    <th className="px-4 py-3 pr-5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-b border-border/70 hover:bg-surface/50">
                      <td className="px-4 py-3 pl-5 font-medium text-fg">{k.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted">{k.prefix}</td>
                      <td className="px-4 py-3 text-muted">{k.createdAt}</td>
                      <td className="px-4 py-3 text-muted">{k.lastUsedAt ?? '-'}</td>
                      <td className="px-4 py-3 pr-5 text-right">
                        <button
                          type="button"
                          onClick={() => revokeKey(k.id)}
                          className="text-xs font-medium text-alert hover:underline"
                        >
                          Révoquer
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">
              En-tête d’authentification :{' '}
              <code className="rounded bg-surface border border-border px-1.5 py-0.5 font-mono text-fg">Authorization: Bearer &lt;clé&gt;</code>
              . Idempotency-Key recommandé sur les POST de déploiement worker.
            </p>
          </section>

          <section className="space-y-6" aria-labelledby="facturation">
            <SectionTitle icon={IconCredit} title="Facturation" id="facturation" />
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="panel p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-fg">Moyen de paiement</h3>
                <p className="mt-3 text-sm text-muted">Carte ········ 4242 · expire 08/27</p>
                <button
                  type="button"
                  className="mt-4 rounded-lg border border-border px-4 py-2 text-sm text-fg hover:border-accent/40"
                >
                  Mettre à jour (démo)
                </button>
              </div>
              <div className="panel p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-fg">Exports</h3>
                <ul className="mt-3 space-y-2 text-sm text-muted">
                  <li>
                    <button type="button" className="text-accent hover:underline">
                      Télécharger CSV usage (avril)
                    </button>
                  </li>
                  <li>
                    <button type="button" className="text-accent hover:underline">
                      Télécharger factures Q1 (ZIP)
                    </button>
                  </li>
                </ul>
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-border bg-card/40">
              <table className="w-full min-w-[28rem] text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                    <th className="px-4 py-3 pl-5">Facture</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Montant HT</th>
                    <th className="px-4 py-3 pr-5">Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {MOCK_INVOICES.map((inv) => (
                    <tr key={inv.id} className="border-b border-border/70">
                      <td className="px-4 py-3 pl-5 font-mono text-fg">{inv.id}</td>
                      <td className="px-4 py-3 text-muted">{inv.date}</td>
                      <td className="px-4 py-3 tabular-nums">
                        {inv.amount.toLocaleString('fr-FR')}
                        <EurSign />
                      </td>
                      <td className="px-4 py-3 pr-5">
                        <span className="rounded-md bg-accent/15 px-2 py-1 text-xs font-medium text-accent">
                          {inv.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-6" aria-labelledby="securite">
            <SectionTitle icon={IconShield} title="Sécurité" id="securite" />
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="panel p-5 sm:p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-fg">Authentification à deux facteurs</h3>
                    <p className="mt-1 text-xs text-muted">TOTP (Google Authenticator, etc.)</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={twoFactor}
                    onClick={() => setTwoFactor((v) => !v)}
                    className={[
                      'relative inline-flex h-8 w-14 shrink-0 rounded-full border-2 border-transparent transition-colors',
                      twoFactor ? 'bg-accent' : 'bg-border',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'pointer-events-none mt-0.5 inline-block size-7 rounded-full bg-bg shadow transition-transform',
                        twoFactor ? 'translate-x-6' : 'translate-x-0.5',
                      ].join(' ')}
                    />
                  </button>
                </div>
              </div>
              <div className="panel p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-fg">Mot de passe</h3>
                <p className="mt-1 text-xs text-muted">Dernière modification il y a 42 jours.</p>
                <button
                  type="button"
                  className="mt-4 rounded-lg border border-border px-4 py-2 text-sm text-fg hover:border-electric/50"
                >
                  Changer le mot de passe (démo)
                </button>
              </div>
            </div>
            <div className="panel p-5 sm:p-6">
              <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-fg">
                <IconLock className="h-4 w-4 text-electric" aria-hidden />
                Sessions actives
              </h3>
              <ul className="space-y-3">
                {MOCK_SESSIONS.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-col gap-2 rounded-lg border border-border bg-surface/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <p className="font-medium text-fg">{s.device}</p>
                      <p className="text-xs text-muted">
                        {s.ip} · {s.lastActive}
                        {s.current && (
                          <span className="ml-2 rounded bg-accent/20 px-2 py-0.5 text-accent">Session actuelle</span>
                        )}
                      </p>
                    </div>
                    {!s.current && (
                      <button type="button" className="text-xs font-medium text-alert hover:underline">
                        Déconnecter
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="space-y-6" aria-labelledby="organisation">
            <SectionTitle icon={IconCode} title="Organisation" id="organisation" />
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="panel p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-fg">Workspace</h3>
                <p className="mt-2 text-sm text-muted">Nom affiché : Vryx, production EU</p>
                <p className="mt-1 font-mono text-xs text-muted">org_8f3c2a91e4b7</p>
                <button
                  type="button"
                  className="mt-4 rounded-lg border border-border px-4 py-2 text-sm text-fg hover:border-accent/40"
                >
                  Renommer (démo)
                </button>
              </div>
              <div className="panel p-5 sm:p-6">
                <h3 className="text-sm font-semibold text-fg">Membres et rôles</h3>
                <p className="mt-2 text-sm text-muted">12 membres · 3 administrateurs · SSO entreprise (OIDC) prêt.</p>
                <button
                  type="button"
                  className="mt-4 rounded-lg border border-border px-4 py-2 text-sm text-fg hover:border-accent/40"
                >
                  Inviter un membre (démo)
                </button>
              </div>
            </div>
          </section>
        </div>

        <p className="mt-14 text-center text-xs text-muted">
          Besoin d’ajuster les limites ou un contrat cadre ? Contactez votre account manager Vryx.
        </p>
      </div>

      {keyModalOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-4 sm:items-center"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal()
          }}
        >
          <div
            className="panel max-h-[90vh] w-full max-w-md overflow-y-auto p-6 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${formId}-title`}
          >
            <h2 id={`${formId}-title`} className="font-display text-lg font-bold text-fg">
              Nouvelle clé API
            </h2>
            <p className="mt-2 text-sm text-muted">
              Donnez un libellé pour retrouver la clé dans vos audits et rotations.
            </p>
            <form className="mt-6 flex flex-col gap-4" onSubmit={createKey}>
              <div>
                <label htmlFor={`${formId}-name`} className="mb-1.5 block text-sm font-medium text-fg">
                  Nom interne
                </label>
                <input
                  id={`${formId}-name`}
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
                  placeholder="Ex. Production EU, workers pool A"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-lg border border-border px-4 py-2.5 text-sm text-fg hover:bg-surface"
                >
                  Annuler
                </button>
                <button type="submit" className="btn-primary rounded-lg px-4 py-2.5 text-sm font-semibold">
                  Générer la clé
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
