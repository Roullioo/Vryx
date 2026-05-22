import { useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/admin/AdminShell'
import { ModelFamilyLogo } from '../components/ModelFamilyLogo'
import {
  fetchAdminModels,
  formatPricingLabel,
  saveAdminModel,
  type CatalogModel,
  type PricingTier,
} from '../lib/pricingModels'

type ModelFilter = 'all' | 'live' | 'public' | 'private' | 'inactive' | 'warning'
type EditableTextField = 'name' | 'provider' | 'family' | 'hfId' | 'apiAlias' | 'paramsNote'
type EditableBoolField = 'isActive' | 'isPublic' | 'openWeights'

function emptyModel(): CatalogModel {
  return {
    slug: '',
    id: '',
    hfId: null,
    apiAlias: null,
    name: '',
    provider: 'Vryx',
    family: 'Custom',
    paramsNote: '',
    contextTokens: 0,
    modalities: ['Texte'],
    openWeights: true,
    weightGb: null,
    pricingTier: 'core',
    eurPerMillion: null,
    effectiveEurPerMillion: 0,
    isActive: true,
    isPublic: true,
    minVramMb: null,
    requiredWorkers: 1,
    sortOrder: 0,
    availabilityStatus: 'available',
  }
}

function formatContext(tokens: number) {
  if (!tokens) return '—'
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1)).toLocaleString('fr-FR')}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000).toLocaleString('fr-FR')}k`
  return tokens.toLocaleString('fr-FR')
}

function formatGb(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) return '—'
  return `${Number(value).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`
}

function priceValue(model: CatalogModel, side: 'input' | 'output' | 'blended') {
  if (side === 'input') return model.pricing?.inputEurPerMillion ?? model.eurPerMillionInput
  if (side === 'output') return model.pricing?.outputEurPerMillion ?? model.eurPerMillionOutput
  return model.pricing?.blendedEurPerMillion ?? model.effectiveEurPerMillion
}

function statusTone(model: CatalogModel) {
  if (!model.isActive) return 'border-warning/40 bg-warning/10 text-warning'
  if (model.runnable || model.ready) return 'border-success/40 bg-success/10 text-success'
  if (model.isPublic) return 'border-accent/40 bg-accent/10 text-accent'
  return 'border-border bg-surface text-muted'
}

function availabilityLabel(value: CatalogModel['availabilityStatus']) {
  if (value === 'limited') return 'Limité'
  if (value === 'reservation') return 'Réservation'
  if (value === 'unavailable') return 'Indispo'
  return 'Disponible'
}

function modelRisk(model: CatalogModel) {
  if (!model.isActive) return 'Inactif'
  if ((model.pricingWarnings || []).some((warning) => warning.level === 'error')) return 'Prix à corriger'
  if ((model.workersOnline || 0) < (model.requiredWorkers || 1)) return 'Capacité courte'
  if (!model.isPublic) return 'Privé'
  return 'OK'
}

function computeStats(models: CatalogModel[]) {
  const publicModels = models.filter((model) => model.isPublic).length
  const activeModels = models.filter((model) => model.isActive).length
  const liveModels = models.filter((model) => model.runnable || model.ready).length
  const warnings = models.filter((model) => (model.pricingWarnings || []).length > 0).length
  const workerSlots = models.reduce((sum, model) => sum + Number(model.workersOnline || 0), 0)
  const priced = models.filter((model) => Number(priceValue(model, 'blended')) > 0)
  const blendedAvg = priced.length
    ? priced.reduce((sum, model) => sum + Number(priceValue(model, 'blended') || 0), 0) / priced.length
    : 0
  const families = new Set(models.map((model) => model.family).filter(Boolean)).size
  return { publicModels, activeModels, liveModels, warnings, workerSlots, blendedAvg, families }
}

function kpi(label: string, value: string | number, hint: string) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-[11px] font-semibold uppercase text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-fg">{value}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  )
}

export function AdminModelsCatalogPage() {
  const [models, setModels] = useState<CatalogModel[]>([])
  const [tiers, setTiers] = useState<PricingTier[]>([])
  const [editing, setEditing] = useState<CatalogModel | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ModelFilter>('all')
  const [family, setFamily] = useState('all')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchAdminModels().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setModels(result.data.models)
        setTiers(result.data.tiers || [])
      } else {
        setMessage(result.error)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const families = useMemo(
    () => Array.from(new Set(models.map((model) => model.family).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [models],
  )
  const stats = useMemo(() => computeStats(models), [models])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models
      .filter((model) => {
        if (family !== 'all' && model.family !== family) return false
        if (filter === 'live' && !(model.runnable || model.ready)) return false
        if (filter === 'public' && !model.isPublic) return false
        if (filter === 'private' && model.isPublic) return false
        if (filter === 'inactive' && model.isActive) return false
        if (filter === 'warning' && (model.pricingWarnings || []).length === 0) return false
        if (!q) return true
        return `${model.name} ${model.provider} ${model.family} ${model.hfId || ''} ${model.apiAlias || ''} ${model.slug}`
          .toLowerCase()
          .includes(q)
      })
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || a.name.localeCompare(b.name))
  }, [family, filter, models, query])

  async function save(model: CatalogModel) {
    setSaving(true)
    setMessage('')
    const result = await saveAdminModel({
      ...model,
      hfId: model.hfId || null,
      apiAlias: model.apiAlias || null,
      modalities: model.modalities.map((item) => item.trim()).filter(Boolean),
      eurPerMillion: model.eurPerMillion == null ? null : Number(model.eurPerMillion),
      weightGb: model.weightGb == null ? null : Number(model.weightGb),
      minVramMb: model.minVramMb == null ? null : Number(model.minVramMb),
    })
    setSaving(false)
    if (result.ok) {
      setModels(result.data.models)
      setEditing(null)
      setMessage('Modèle sauvegardé.')
    } else {
      setMessage(result.error)
    }
  }

  return (
    <AdminShell
      title="Catalogue modèles"
      subtitle="Pilotage pricing, capacité worker, exposition publique et risques de marge."
      actions={
        <button
          type="button"
          onClick={() => setEditing(emptyModel())}
          className="min-h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent"
        >
          Ajouter
        </button>
      }
    >
      <div className="space-y-5">
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {kpi('Modèles', models.length, `${stats.activeModels} actifs · ${stats.publicModels} publics`)}
          {kpi('Live', stats.liveModels, `${stats.workerSlots} worker slots détectés`)}
          {kpi('Prix moyen', formatPricingLabel(stats.blendedAvg), 'blended EUR / million tokens')}
          {kpi('Alertes', stats.warnings, `${stats.families} familles suivies`)}
        </section>

        <section className="rounded-lg border border-border bg-card p-3">
          <div className="grid gap-3 lg:grid-cols-[1fr_180px_180px_auto]">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Recherche modèle, provider, HF ID, alias API…"
              className="min-h-10 rounded-lg border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
            />
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as ModelFilter)}
              className="min-h-10 rounded-lg border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
            >
              <option value="all">Tous les états</option>
              <option value="live">Live</option>
              <option value="public">Publics</option>
              <option value="private">Privés</option>
              <option value="inactive">Inactifs</option>
              <option value="warning">Alertes pricing</option>
            </select>
            <select
              value={family}
              onChange={(event) => setFamily(event.target.value)}
              className="min-h-10 rounded-lg border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
            >
              <option value="all">Toutes familles</option>
              {families.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <span className="flex min-h-10 items-center justify-end text-xs text-muted">
              {filtered.length} / {models.length}
            </span>
          </div>
        </section>

        {message && <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted">{message}</p>}

        {loading ? (
          <div className="h-72 animate-pulse rounded-lg border border-border bg-card" />
        ) : (
          <section className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="min-w-[1120px] w-full border-collapse text-left text-sm">
                <thead className="border-b border-border bg-surface/70 text-[11px] uppercase text-muted">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Modèle</th>
                    <th className="px-4 py-3 font-semibold">Statut</th>
                    <th className="px-4 py-3 font-semibold">Contexte</th>
                    <th className="px-4 py-3 font-semibold">Capacité</th>
                    <th className="px-4 py-3 font-semibold">Prix in/out</th>
                    <th className="px-4 py-3 font-semibold">Marge</th>
                    <th className="px-4 py-3 font-semibold">Risque</th>
                    <th className="px-4 py-3 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((model) => {
                    const warnings = model.pricingWarnings || []
                    return (
                      <tr key={model.slug} className="align-top hover:bg-surface/50">
                        <td className="px-4 py-3">
                          <div className="flex items-start gap-3">
                            <ModelFamilyLogo model={model} size={30} className="mt-0.5" />
                            <div className="min-w-0">
                              <p className="font-medium text-fg">{model.name}</p>
                              <p className="mt-0.5 max-w-[320px] truncate font-mono text-[11px] text-muted">
                                {model.apiAlias || model.hfId || model.slug}
                              </p>
                              <p className="mt-1 text-xs text-muted">{model.provider} · {model.family} · {model.paramsNote || 'params n/a'}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1.5">
                            <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold uppercase ${statusTone(model)}`}>
                              {model.runnable || model.ready ? 'Live' : model.isActive ? 'Actif' : 'Inactif'}
                            </span>
                            <span className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase text-muted">
                              {model.isPublic ? 'Public' : 'Privé'}
                            </span>
                            <span className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase text-muted">
                              {availabilityLabel(model.availabilityStatus)}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-fg">{formatContext(model.contextTokens)}</td>
                        <td className="px-4 py-3">
                          <p className="font-mono text-fg">{model.workersOnline || 0}/{model.requiredWorkers || 1} workers</p>
                          <p className="mt-1 text-xs text-muted">{formatGb(model.weightGb)} · min {model.minVramMb ? `${Math.round(model.minVramMb / 1024)} Go` : 'auto'}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-mono text-fg">{formatPricingLabel(priceValue(model, 'input'))}</p>
                          <p className="mt-1 font-mono text-muted">{formatPricingLabel(priceValue(model, 'output'))}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-mono text-fg">{formatPricingLabel(priceValue(model, 'blended'))}</p>
                          <p className="mt-1 text-xs text-muted">
                            worker {model.workerSharePercent ?? model.pricing?.workerSharePercent ?? '—'} %
                            {model.marginPreview ? ` · net ${model.marginPreview.netMarginPercent}%` : ''}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p className={warnings.length ? 'text-warning' : 'text-success'}>{modelRisk(model)}</p>
                          {warnings[0] && <p className="mt-1 max-w-[220px] text-xs text-muted">{warnings[0].message}</p>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setEditing(model)}
                            className="min-h-9 rounded-lg border border-border px-3 text-xs font-semibold text-fg hover:bg-surface"
                          >
                            Éditer
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-150 flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center">
          <div className="max-h-[92dvh] w-full max-w-4xl overflow-y-auto rounded-lg border border-border bg-card shadow-2xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-card px-5 py-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-fg">{editing.name || 'Nouveau modèle'}</h2>
                <p className="text-xs text-muted">{editing.slug || 'slug auto'} · {editing.family || 'famille'}</p>
              </div>
              <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-border px-3 py-2 text-sm text-fg">
                Fermer
              </button>
            </div>

            <div className="grid gap-5 p-5 lg:grid-cols-[1fr_280px]">
              <div className="space-y-5">
                <section>
                  <h3 className="mb-3 text-xs font-semibold uppercase text-muted">Identité</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        ['Nom', 'name'],
                        ['Provider', 'provider'],
                        ['Famille', 'family'],
                        ['HF ID', 'hfId'],
                        ['Alias API', 'apiAlias'],
                        ['Paramètres', 'paramsNote'],
                      ] as [string, EditableTextField][]
                    ).map(([label, key]) => (
                      <label key={key} className="space-y-1 text-sm">
                        <span className="text-muted">{label}</span>
                        <input
                          value={String(editing[key] ?? '')}
                          onChange={(event) => setEditing((current) => (current ? { ...current, [key]: event.target.value } : current))}
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent"
                        />
                      </label>
                    ))}
                  </div>
                </section>

                <section>
                  <h3 className="mb-3 text-xs font-semibold uppercase text-muted">Capacité</h3>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Contexte tokens</span>
                      <input type="number" value={editing.contextTokens} onChange={(event) => setEditing({ ...editing, contextTokens: Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Poids (Go)</span>
                      <input type="number" value={editing.weightGb ?? ''} onChange={(event) => setEditing({ ...editing, weightGb: event.target.value === '' ? null : Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">VRAM min (Mo)</span>
                      <input type="number" value={editing.minVramMb ?? ''} onChange={(event) => setEditing({ ...editing, minVramMb: event.target.value === '' ? null : Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Workers requis</span>
                      <input type="number" min="1" value={editing.requiredWorkers} onChange={(event) => setEditing({ ...editing, requiredWorkers: Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Ordre</span>
                      <input type="number" value={editing.sortOrder} onChange={(event) => setEditing({ ...editing, sortOrder: Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Modalités</span>
                      <input value={editing.modalities.join(', ')} onChange={(event) => setEditing({ ...editing, modalities: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                  </div>
                </section>

                <section>
                  <h3 className="mb-3 text-xs font-semibold uppercase text-muted">Pricing</h3>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Tier</span>
                      <select value={editing.pricingTier ?? editing.pricing?.tier ?? 'core'} onChange={(event) => setEditing({ ...editing, pricingTier: event.target.value })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent">
                        {tiers.length ? tiers.map((tier) => <option key={tier.slug} value={tier.slug}>{tier.label}</option>) : <option value="core">Core</option>}
                      </select>
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Input € / M</span>
                      <input type="number" step="0.0001" value={editing.eurPerMillionInput ?? editing.pricing?.inputEurPerMillion ?? ''} onChange={(event) => setEditing({ ...editing, eurPerMillionInput: event.target.value === '' ? undefined : Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Output € / M</span>
                      <input type="number" step="0.0001" value={editing.eurPerMillionOutput ?? editing.pricing?.outputEurPerMillion ?? ''} onChange={(event) => setEditing({ ...editing, eurPerMillionOutput: event.target.value === '' ? undefined : Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Worker share %</span>
                      <input type="number" min="0" max="100" value={editing.workerSharePercent ?? editing.pricing?.workerSharePercent ?? ''} onChange={(event) => setEditing({ ...editing, workerSharePercent: event.target.value === '' ? undefined : Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Private input € / M</span>
                      <input type="number" step="0.0001" value={editing.privatePoolInputEurPerMillion ?? ''} onChange={(event) => setEditing({ ...editing, privatePoolInputEurPerMillion: event.target.value === '' ? undefined : Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Private output € / M</span>
                      <input type="number" step="0.0001" value={editing.privatePoolOutputEurPerMillion ?? ''} onChange={(event) => setEditing({ ...editing, privatePoolOutputEurPerMillion: event.target.value === '' ? undefined : Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Marge min %</span>
                      <input type="number" min="0" max="95" value={editing.minVryxMarginPercent ?? ''} onChange={(event) => setEditing({ ...editing, minVryxMarginPercent: event.target.value === '' ? undefined : Number(event.target.value) })} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
                    </label>
                  </div>
                </section>
              </div>

              <aside className="space-y-3">
                <div className="rounded-lg border border-border bg-surface p-4">
                  <p className="text-xs font-semibold uppercase text-muted">Lecture rapide</p>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between gap-3"><dt className="text-muted">Blended</dt><dd className="font-mono text-fg">{formatPricingLabel(priceValue(editing, 'blended'))}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-muted">Workers</dt><dd className="font-mono text-fg">{editing.workersOnline || 0}/{editing.requiredWorkers || 1}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-muted">Risque</dt><dd className="text-right text-fg">{modelRisk(editing)}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-muted">Dernier heartbeat</dt><dd className="text-right text-fg">{editing.lastSeenAt ? new Date(editing.lastSeenAt).toLocaleString('fr-FR') : '—'}</dd></div>
                  </dl>
                </div>

                {editing.marginPreview && (
                  <div className="rounded-lg border border-border bg-surface p-4">
                    <p className="text-xs font-semibold uppercase text-muted">Marge</p>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex justify-between gap-3"><dt className="text-muted">Net</dt><dd className="font-mono text-fg">{editing.marginPreview.netMarginPercent}%</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted">Payout</dt><dd className="font-mono text-fg">{editing.marginPreview.workerPayoutEur} €</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted">Vryx net</dt><dd className="font-mono text-fg">{editing.marginPreview.vryxNetEur} €</dd></div>
                    </dl>
                  </div>
                )}

                <div className="rounded-lg border border-border bg-surface p-4">
                  <p className="text-xs font-semibold uppercase text-muted">Publication</p>
                  <div className="mt-3 space-y-2">
                    <label className="space-y-1 text-sm">
                      <span className="text-muted">Disponibilité</span>
                      <select value={editing.availabilityStatus ?? 'available'} onChange={(event) => setEditing({ ...editing, availabilityStatus: event.target.value as CatalogModel['availabilityStatus'] })} className="w-full rounded-lg border border-border bg-card px-3 py-2 text-fg outline-none focus:border-accent">
                        <option value="available">Disponible</option>
                        <option value="limited">Limité</option>
                        <option value="reservation">Sur réservation</option>
                        <option value="unavailable">Indisponible</option>
                      </select>
                    </label>
                    {(
                      [
                        ['Actif', 'isActive'],
                        ['Public', 'isPublic'],
                        ['Open weights', 'openWeights'],
                      ] as [string, EditableBoolField][]
                    ).map(([label, key]) => (
                      <label key={key} className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-sm">
                        <span>{label}</span>
                        <input type="checkbox" checked={Boolean(editing[key])} onChange={(event) => setEditing((current) => (current ? { ...current, [key]: event.target.checked } : current))} className="h-5 w-5 accent-accent" />
                      </label>
                    ))}
                  </div>
                </div>
              </aside>
            </div>

            <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-card px-5 py-4">
              <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-border px-4 py-2 text-sm text-fg">Annuler</button>
              <button type="button" disabled={saving} onClick={() => void save(editing)} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-50">
                {saving ? 'Sauvegarde…' : 'Sauvegarder'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  )
}
