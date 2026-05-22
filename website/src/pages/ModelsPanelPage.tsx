import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuth } from '../context/AuthContext'
import { IconSearch } from '../components/icons/Icons'
import { ModelFamilyLogo } from '../components/ModelFamilyLogo'
import { ProviderLogo } from '../components/ProviderLogo'
import { fetchPublicModels, formatPricingLabel, type CatalogModel } from '../lib/pricingModels'

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return m >= 10 ? `${Math.round(m)}M` : `${m % 1 === 0 ? m : m.toFixed(1)}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens || 0)
}

function formatVramGbLabel(value: number | null | undefined) {
  if (value == null || value <= 0) return '—'
  return `${Number(value).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`
}

function ModelCard({
  m
}: {
  m: CatalogModel
}) {
  const vramGb = m.weightGb

  return (
    <article className="panel p-4 sm:p-5">
      <div className="min-w-0 flex gap-3">
        <ModelFamilyLogo model={m} size={40} className="mt-0.5" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-base font-semibold text-fg">{m.name}</h2>
            <span
              className={[
                'rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide',
                m.openWeights ? 'bg-accent/15 text-accent' : 'bg-border/80 text-muted',
              ].join(' ')}
            >
              {m.openWeights ? 'Poids ouverts' : 'Propriétaire'}
            </span>
            <span className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${m.runnable || m.ready ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
              {m.runnable || m.ready ? 'Disponible' : 'Bientôt'}
            </span>
          </div>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted">
            <ProviderLogo provider={m.provider} size={22} />
            <span>
              {m.provider} · {m.family}
            </span>
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted">Paramètres</dt>
          <dd className="mt-0.5 font-mono text-fg">{m.paramsNote}</dd>
        </div>
        <div>
          <dt className="text-muted">Contexte</dt>
          <dd className="mt-0.5 font-mono text-electric">{formatContext(m.contextTokens)} tokens</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted">Modalités</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {m.modalities.map((mod) => (
              <span
                key={mod}
                className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-fg"
              >
                {mod}
              </span>
            ))}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted">Poids (VRAM indicative)</dt>
          <dd className="mt-0.5 font-mono text-sm text-fg">{formatVramGbLabel(vramGb)}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted">Prix public</dt>
          <dd className="mt-0.5 font-mono text-sm text-fg">{formatPricingLabel(m.effectiveEurPerMillion)} / million de tokens</dd>
        </div>
      </dl>
    </article>
  )
}

export function ModelsPanelPage() {
  const { user, loading } = useAuth()
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState<string>('')
  const [models, setModels] = useState<CatalogModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchPublicModels().then((r) => {
      if (cancelled) return
      if (r.ok) setModels(r.data.models)
      setModelsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const providers = useMemo(() => [...new Set(models.map((m) => m.provider))].sort((a, b) => a.localeCompare(b, 'fr')), [models])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models.filter((m) => {
      if (provider && m.provider !== provider) return false
      if (!q) return true
      const blob = `${m.name} ${m.provider} ${m.family} ${m.paramsNote} ${m.modalities.join(' ')} ${formatVramGbLabel(m.weightGb)}`.toLowerCase()
      return blob.includes(q)
    })
  }, [models, query, provider])

  const stats = useMemo(() => {
    const openW = filtered.filter((m) => m.openWeights).length
    const maxContext = filtered.reduce((max, m) => Math.max(max, m.contextTokens), 0)
    return { openW, total: filtered.length, maxContext }
  }, [filtered])

  function onSearchSubmit(e: FormEvent) {
    e.preventDefault()
  }

  if (!loading && !user) {
    return <Navigate to="/connexion" replace state={{ from: '/panel/modeles' }} />
  }

  if (loading || modelsLoading) {
    return (
      <div className="bg-bg min-h-[calc(100svh-4.25rem)] px-4 py-16">
        <div className="mx-auto max-w-4xl animate-pulse space-y-4">
          <div className="h-10 w-2/3 max-w-md rounded-lg bg-card" />
          <div className="h-24 rounded-xl bg-card" />
          <div className="h-64 rounded-xl bg-card" />
        </div>
      </div>
    )
  }

  return (
    <div className="bg-bg min-h-[calc(100svh-4.25rem)] pb-8 sm:pb-10 lg:pb-12">
      <section
        className="relative isolate -mt-[4.25rem] flex min-h-[min(86vh,38rem)] flex-col overflow-hidden border-b border-border pt-[4.25rem] sm:min-h-[min(88vh,42rem)]"
        aria-labelledby="models-hero-heading"
      >
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))] overflow-hidden"
          aria-hidden
        >
          <div
            className="absolute inset-0 scale-105 bg-cover bg-center bg-no-repeat blur-[3px]"
            style={{ backgroundImage: "url('/brain.png')" }}
          />
        </div>
        <div
          className="hero-overlay pointer-events-none absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))]"
          aria-hidden
        />
        <div className="relative z-10 flex min-h-[inherit] flex-1 flex-col items-center justify-center px-4 pb-14 pt-8 text-center sm:pb-16 sm:pt-10">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="flex max-w-2xl flex-col items-center"
          >
            <h1
              id="models-hero-heading"
              className="font-display text-balance text-3xl font-semibold leading-tight tracking-tight text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.45)] sm:text-4xl md:text-[2.35rem]"
            >
              Nos IA
            </h1>
            <p className="mt-4 max-w-xl text-pretty text-base leading-snug text-white/88 sm:mt-5 sm:text-lg">
              Catalogue des grands modèles disponibles sur la plateforme, avec tailles indicatives et contexte.
            </p>
          </motion.div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 pt-8 sm:px-6 lg:px-8 lg:pt-10">
        <section className="grid gap-4 sm:grid-cols-3" aria-label="Indicateurs">
          <div className="panel px-4 py-4 sm:px-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Modèles affichés</p>
            <p className="mt-1 font-display text-2xl font-bold text-fg">{stats.total}</p>
          </div>
          <div className="panel px-4 py-4 sm:px-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Open weights (liste)</p>
            <p className="mt-1 font-display text-2xl font-bold text-accent">{stats.openW}</p>
          </div>
          <div className="panel px-4 py-4 sm:px-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Contexte max</p>
            <p className="mt-1 font-display text-2xl font-bold text-electric">{formatContext(stats.maxContext)}</p>
          </div>
        </section>

        <form
          className="panel mt-8 flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-end lg:gap-4"
          onSubmit={onSearchSubmit}
          role="search"
        >
          <div className="relative min-w-0 flex-1">
            <IconSearch
              className="pointer-events-none absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <input
              type="search"
              name="q"
              placeholder="Rechercher un modèle, un éditeur, une famille…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-xl border border-border bg-bg py-3 pr-4 pl-11 text-sm text-fg outline-none ring-accent/30 focus:border-accent focus:ring-2"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="flex min-w-40 flex-col gap-1.5 text-xs font-medium text-muted">
              Éditeur
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="rounded-xl border border-border bg-bg px-3 py-2.5 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
              >
                <option value="">Tous</option>
              {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </form>

        <div className="mt-10 lg:hidden">
          <h2 className="sr-only">Liste des modèles</h2>
          <ul className="flex flex-col gap-4">
            {filtered.map((m) => (
              <li key={m.id}>
                <ModelCard m={m} />
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-10 hidden overflow-x-auto rounded-2xl border border-border bg-card/60 shadow-sm lg:block">
          <h2 className="sr-only">Tableau des modèles</h2>
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <caption className="sr-only">
              Grands modèles d’intelligence artificielle avec filtres
            </caption>
            <thead>
              <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                <th scope="col" className="px-4 py-3">
                  Modèle
                </th>
                <th scope="col" className="px-4 py-3">
                  Famille
                </th>
                <th scope="col" className="px-4 py-3">
                  Éditeur
                </th>
                <th scope="col" className="px-4 py-3">
                  Taille (indicatif)
                </th>
                <th scope="col" className="px-4 py-3">
                  Contexte
                </th>
                <th scope="col" className="px-4 py-3">
                  VRAM (Go)
                </th>
                <th scope="col" className="px-4 py-3">
                  Prix
                </th>
                <th scope="col" className="px-4 py-3">
                  Disponibilité
                </th>
                <th scope="col" className="px-4 py-3">
                  Modalités
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m, i) => (
                <tr
                  key={m.id}
                  className={`border-b border-border/80 transition-colors hover:bg-surface/70 ${i % 2 === 0 ? 'bg-bg/40' : 'bg-surface/30'}`}
                >
                  <th scope="row" className="px-4 py-3 font-semibold text-fg">
                    <span className="inline-flex items-center gap-2">
                      <ModelFamilyLogo model={m} size={26} />
                      {m.name}
                    </span>
                  </th>
                  <td className="px-4 py-3 text-muted">{m.family}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-2">
                      <ProviderLogo provider={m.provider} size={22} />
                      {m.provider}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-fg">{m.paramsNote}</td>
                  <td className="px-4 py-3 font-mono text-electric">{formatContext(m.contextTokens)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-fg">{formatVramGbLabel(m.weightGb)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-fg">{formatPricingLabel(m.effectiveEurPerMillion)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${m.runnable || m.ready ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                      {m.runnable || m.ready ? 'Disponible' : 'Bientôt'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="line-clamp-2 text-xs text-muted">{m.modalities.join(', ')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 && (
          <p className="mt-10 rounded-2xl border border-border bg-surface px-4 py-8 text-center text-muted">
            Aucun modèle ne correspond aux filtres. Modifiez la recherche ou l’éditeur.
          </p>
        )}

        <p className="mt-10 text-center text-xs text-muted">
          Données indicatives. VRAM : ordre de grandeur (souvent ~2 Go par milliard de paramètres en FP16/BF16,
          ajustements MoE). Contextes et fiches éditeurs évoluent.
        </p>
      </div>
    </div>
  )
}
