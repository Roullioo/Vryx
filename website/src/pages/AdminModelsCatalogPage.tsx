import { useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/admin/AdminShell'
import {
  fetchAdminModels,
  formatPricingLabel,
  saveAdminModel,
  type CatalogModel,
} from '../lib/pricingModels'

function emptyModel(): CatalogModel {
  return {
    slug: '',
    id: '',
    hfId: null,
    name: '',
    provider: 'Vryx',
    family: 'Custom',
    paramsNote: '',
    contextTokens: 0,
    modalities: ['Texte'],
    openWeights: true,
    weightGb: null,
    eurPerMillion: null,
    effectiveEurPerMillion: 0,
    isActive: true,
    isPublic: true,
    minVramMb: null,
    requiredWorkers: 1,
    sortOrder: 0,
  }
}

function formatContext(tokens: number) {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1)).toLocaleString('fr-FR')}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000).toLocaleString('fr-FR')}k`
  return String(tokens || 0)
}

type EditableTextField = 'name' | 'provider' | 'family' | 'hfId' | 'paramsNote'
type EditableBoolField = 'isActive' | 'isPublic' | 'openWeights'

export function AdminModelsCatalogPage() {
  const [models, setModels] = useState<CatalogModel[]>([])
  const [editing, setEditing] = useState<CatalogModel | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchAdminModels().then((r) => {
      if (cancelled) return
      if (r.ok) setModels(r.data.models)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) => `${m.name} ${m.provider} ${m.family} ${m.hfId || ''}`.toLowerCase().includes(q))
  }, [models, query])

  async function save(model: CatalogModel) {
    setSaving(true)
    setMessage('')
    const r = await saveAdminModel({
      ...model,
      hfId: model.hfId || null,
      modalities: model.modalities.map((m) => m.trim()).filter(Boolean),
      eurPerMillion: model.eurPerMillion == null ? null : Number(model.eurPerMillion),
      weightGb: model.weightGb == null ? null : Number(model.weightGb),
      minVramMb: model.minVramMb == null ? null : Number(model.minVramMb),
    })
    setSaving(false)
    if (r.ok) {
      setModels(r.data.models)
      setEditing(null)
      setMessage('Modèle sauvegardé.')
    } else {
      setMessage(r.error)
    }
  }

  return (
    <AdminShell
      title="Catalogue modèles"
      subtitle="Disponibilité, métadonnées et prix par modèle."
      actions={
        <button
          type="button"
          onClick={() => setEditing(emptyModel())}
          className="rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-on-accent"
        >
          Ajouter un modèle
        </button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-3xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un modèle, une famille ou un provider…"
            className="min-h-11 flex-1 rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
          />
          <span className="text-xs text-muted">{filtered.length} / {models.length} modèles</span>
        </div>

        {message && <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted">{message}</p>}

        {loading ? (
          <div className="h-40 animate-pulse rounded-3xl border border-border bg-card" />
        ) : (
          <div className="grid gap-3">
            {filtered.map((m) => (
              <article key={m.slug} className="rounded-3xl border border-border bg-card p-4 shadow-sm">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-display text-base font-semibold text-fg">{m.name}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${m.isActive ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                        {m.isActive ? 'Actif' : 'Inactif'}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${m.isPublic ? 'bg-accent/10 text-accent' : 'bg-border text-muted'}`}>
                        {m.isPublic ? 'Public' : 'Privé'}
                      </span>
                      {m.runnable ? <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-success">Live</span> : null}
                    </div>
                    <p className="mt-1 text-xs text-muted">{m.provider} · {m.family} · {m.hfId || m.slug}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditing(m)}
                    className="min-h-10 rounded-xl border border-border px-4 text-sm font-medium text-fg hover:bg-surface"
                  >
                    Éditer
                  </button>
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
                  <div><dt className="text-muted">Contexte</dt><dd className="font-mono text-fg">{formatContext(m.contextTokens)}</dd></div>
                  <div><dt className="text-muted">VRAM</dt><dd className="font-mono text-fg">{m.weightGb ? `${m.weightGb} Go` : '—'}</dd></div>
                  <div><dt className="text-muted">Prix effectif</dt><dd className="font-mono text-fg">{formatPricingLabel(m.effectiveEurPerMillion)}</dd></div>
                  <div><dt className="text-muted">Override</dt><dd className="font-mono text-fg">{formatPricingLabel(m.eurPerMillion)}</dd></div>
                  <div><dt className="text-muted">Workers</dt><dd className="font-mono text-fg">{m.workersOnline || 0}/{m.requiredWorkers}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-150 flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center">
          <div className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-border bg-card p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-fg">Éditer le modèle</h2>
                <p className="text-xs text-muted">Les changements sont visibles côté public après sauvegarde.</p>
              </div>
              <button type="button" onClick={() => setEditing(null)} className="rounded-xl border border-border px-3 py-2 text-sm text-fg">
                Fermer
              </button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {(
                [
                  ['Nom', 'name'],
                  ['Provider', 'provider'],
                  ['Famille', 'family'],
                  ['HF ID', 'hfId'],
                  ['Paramètres', 'paramsNote'],
                ] as [string, EditableTextField][]
              ).map(([label, key]) => (
                <label key={key} className="space-y-1 text-sm">
                  <span className="text-muted">{label}</span>
                  <input
                    value={String(editing[key] ?? '')}
                    onChange={(e) => setEditing((m) => (m ? { ...m, [key]: e.target.value } : m))}
                    className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent"
                  />
                </label>
              ))}
              <label className="space-y-1 text-sm">
                <span className="text-muted">Contexte tokens</span>
                <input type="number" value={editing.contextTokens} onChange={(e) => setEditing({ ...editing, contextTokens: Number(e.target.value) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">VRAM indicative (Go)</span>
                <input type="number" value={editing.weightGb ?? ''} onChange={(e) => setEditing({ ...editing, weightGb: e.target.value === '' ? null : Number(e.target.value) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Prix override (€ / M)</span>
                <input type="number" step="0.0001" value={editing.eurPerMillion ?? ''} onChange={(e) => setEditing({ ...editing, eurPerMillion: e.target.value === '' ? null : Number(e.target.value) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Modalités (séparées par virgule)</span>
                <input value={editing.modalities.join(', ')} onChange={(e) => setEditing({ ...editing, modalities: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent" />
              </label>
              <div className="grid grid-cols-2 gap-3 sm:col-span-2">
                {(
                  [
                    ['Actif', 'isActive'],
                    ['Public', 'isPublic'],
                    ['Open weights', 'openWeights'],
                  ] as [string, EditableBoolField][]
                ).map(([label, key]) => (
                  <label key={key} className="flex items-center justify-between rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
                    <span>{label}</span>
                    <input type="checkbox" checked={Boolean(editing[key])} onChange={(e) => setEditing((m) => (m ? { ...m, [key]: e.target.checked } : m))} className="h-5 w-5 accent-accent" />
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(null)} className="rounded-xl border border-border px-4 py-2 text-sm text-fg">Annuler</button>
              <button type="button" disabled={saving} onClick={() => void save(editing)} className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-50">
                {saving ? 'Sauvegarde…' : 'Sauvegarder'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  )
}
