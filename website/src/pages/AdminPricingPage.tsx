import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AdminShell } from '../components/admin/AdminShell'
import { VryxButton, VryxCard } from '../components/ui/VryxPrimitives'
import {
  fetchAdminPricingBundle,
  formatPricingLabel,
  saveAdminPricing,
  saveAdminModel,
  saveFineTuningPlan,
  savePrivatePoolPlan,
  saveSubscriptionPlan,
  type AdminPricing,
  type CatalogModel,
  type FineTuningPlan,
  type PrivatePoolPlan,
  type PricingAuditEntry,
  type SubscriptionPlan,
  type VolumeDiscount,
} from '../lib/pricingModels'

type TabId = 'general' | 'models' | 'volume' | 'subscriptions' | 'pool' | 'finetune' | 'audit'

const DEFAULT_PRICING: AdminPricing = {
  defaultEurPerMillion: 0.075,
  pricingPublished: true,
  vatPercent: 20,
  workerRewardSharePercent: 58,
  defaultWorkerSharePercent: 60,
  estimatedGrossMarginPercent: 72,
  volumeDiscounts: [
    { minMonthlyMillions: 100, discountPercent: 5 },
    { minMonthlyMillions: 500, discountPercent: 10 },
    { minMonthlyMillions: 2000, discountPercent: 18 },
  ],
  headline: { minInputEurPerMillion: 0.02, minOutputEurPerMillion: 0.06 },
  blendedInputRatioPercent: 75,
  recharge: { minEur: 20, recommendedEur: 50, b2bMinEur: 250, packagesEur: [20, 50, 100, 250, 500, 2000] },
  privatePoolTokenDiscountPercent: 30,
  minVryxNetMarginPercent: 20,
  updatedAt: null,
  updatedByUserId: null,
}

function parseDiscountRows(rows: VolumeDiscount[]) {
  return rows
    .map((row) => ({
      minMonthlyMillions: Math.max(0, Number(row.minMonthlyMillions) || 0),
      discountPercent: Math.max(0, Math.min(95, Number(row.discountPercent) || 0)),
    }))
    .filter((row) => row.minMonthlyMillions > 0 || row.discountPercent > 0)
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Jamais'
  return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

function availabilityLabel(value: string | null | undefined) {
  switch (value) {
    case 'available': return 'Disponible'
    case 'limited': return 'Limité'
    case 'reservation': return 'Sur réservation'
    case 'unavailable': return 'Indisponible'
    default: return 'Non défini'
  }
}

export function AdminPricingPage() {
  const { t } = useTranslation('admin')
  const [tab, setTab] = useState<TabId>('general')
  const [pricing, setPricing] = useState<AdminPricing>(DEFAULT_PRICING)
  const [subscriptionPlans, setSubscriptionPlans] = useState<SubscriptionPlan[]>([])
  const [privatePoolPlans, setPrivatePoolPlans] = useState<PrivatePoolPlan[]>([])
  const [fineTuningPlans, setFineTuningPlans] = useState<FineTuningPlan[]>([])
  const [models, setModels] = useState<CatalogModel[]>([])
  const [audit, setAudit] = useState<PricingAuditEntry[]>([])
  const [modelQuery, setModelQuery] = useState('')
  const [editingModel, setEditingModel] = useState<CatalogModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchAdminPricingBundle().then((r) => {
      if (cancelled) return
      if (r.ok) {
        setPricing({ ...DEFAULT_PRICING, ...r.data.pricing, headline: r.data.pricing.headline ?? DEFAULT_PRICING.headline, recharge: r.data.pricing.recharge ?? DEFAULT_PRICING.recharge })
        setSubscriptionPlans(r.data.subscriptionPlans)
        setPrivatePoolPlans(r.data.privatePoolPlans)
        setFineTuningPlans(r.data.fineTuningPlans)
        setModels(r.data.models)
        setAudit(r.data.audit)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const previewBlended = useMemo(() => {
    const ratio = pricing.blendedInputRatioPercent / 100
    return pricing.headline.minInputEurPerMillion * ratio + pricing.headline.minOutputEurPerMillion * (1 - ratio)
  }, [pricing])

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase()
    if (!q) return models
    return models.filter((model) =>
      `${model.name} ${model.provider} ${model.family} ${model.hfId || ''} ${model.apiAlias || ''}`.toLowerCase().includes(q),
    )
  }, [modelQuery, models])

  async function submitPricing() {
    setSaving(true)
    setMessage('')
    const r = await saveAdminPricing({ ...pricing, volumeDiscounts: parseDiscountRows(pricing.volumeDiscounts) })
    setSaving(false)
    if (r.ok) {
      setPricing(r.data.pricing)
      setMessage(t('pricing.saved'))
    } else setMessage(r.error)
  }

  async function saveModel(model: CatalogModel) {
    setSaving(true)
    setMessage('')
    const r = await saveAdminModel(model)
    setSaving(false)
    if (r.ok) {
      setModels(r.data.models)
      setEditingModel(null)
      setMessage('Prix modèle sauvegardé et historisé.')
    } else setMessage(r.error)
  }

  async function savePlan(kind: 'sub', plan: SubscriptionPlan): Promise<void>
  async function savePlan(kind: 'pool', plan: PrivatePoolPlan): Promise<void>
  async function savePlan(kind: 'ft', plan: FineTuningPlan): Promise<void>
  async function savePlan(kind: 'sub' | 'pool' | 'ft', plan: SubscriptionPlan | PrivatePoolPlan | FineTuningPlan) {
    setSaving(true)
    const r = kind === 'sub'
      ? await saveSubscriptionPlan(plan as SubscriptionPlan)
      : kind === 'pool'
        ? await savePrivatePoolPlan(plan as PrivatePoolPlan)
        : await saveFineTuningPlan(plan as FineTuningPlan)
    setSaving(false)
    if (r.ok) {
      if (kind === 'sub') setSubscriptionPlans(r.data.plans as SubscriptionPlan[])
      if (kind === 'pool') setPrivatePoolPlans(r.data.plans as PrivatePoolPlan[])
      if (kind === 'ft') setFineTuningPlans(r.data.plans as FineTuningPlan[])
      setMessage('Plan sauvegardé.')
    } else setMessage(r.error)
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'general', label: 'Général' },
    { id: 'models', label: 'Modèles' },
    { id: 'volume', label: 'Remises volume' },
    { id: 'subscriptions', label: 'Plans B2B' },
    { id: 'pool', label: 'Private Pool' },
    { id: 'finetune', label: 'Fine-tuning' },
    { id: 'audit', label: 'Historique' },
  ]

  return (
    <AdminShell
      title={t('pricing.title')}
      subtitle="Prix tokens, modèles, reversement workers, Private Pool, remises, disponibilité et historique."
      actions={
        (tab === 'general' || tab === 'volume' || tab === 'pool') ? (
          <VryxButton type="button" onClick={() => void submitPricing()} disabled={saving || loading}>
            {saving ? 'Sauvegarde…' : 'Sauvegarder'}
          </VryxButton>
        ) : null
      }
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`min-h-10 rounded-xl px-4 text-sm font-medium ${tab === item.id ? 'bg-accent text-on-accent' : 'border border-border bg-card text-fg'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {message && <p className="mb-4 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted">{message}</p>}

      {tab === 'general' && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <VryxCard className="p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="text-muted">Headline input (€ / M)</span>
                <input type="number" step="0.0001" value={pricing.headline.minInputEurPerMillion}
                  onChange={(e) => setPricing((p) => ({ ...p, headline: { ...p.headline, minInputEurPerMillion: Number(e.target.value) } }))}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted">Headline output (€ / M)</span>
                <input type="number" step="0.0001" value={pricing.headline.minOutputEurPerMillion}
                  onChange={(e) => setPricing((p) => ({ ...p, headline: { ...p.headline, minOutputEurPerMillion: Number(e.target.value) } }))}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted">Ratio input blended (%)</span>
                <input type="number" min="0" max="100" value={pricing.blendedInputRatioPercent}
                  onChange={(e) => setPricing((p) => ({ ...p, blendedInputRatioPercent: Number(e.target.value) }))}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted">Marge Vryx min (%)</span>
                <input type="number" min="0" max="95" value={pricing.minVryxNetMarginPercent}
                  onChange={(e) => setPricing((p) => ({ ...p, minVryxNetMarginPercent: Number(e.target.value) }))}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted">Taux reversé workers (%)</span>
                <input type="number" min="0" max="100" value={pricing.workerRewardSharePercent}
                  onChange={(e) => setPricing((p) => ({ ...p, workerRewardSharePercent: Number(e.target.value) }))}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted">Taux worker par défaut (%)</span>
                <input type="number" min="0" max="100" value={pricing.defaultWorkerSharePercent}
                  onChange={(e) => setPricing((p) => ({ ...p, defaultWorkerSharePercent: Number(e.target.value) }))}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted">Recharge min (€)</span>
                <input type="number" value={pricing.recharge.minEur}
                  onChange={(e) => setPricing((p) => ({ ...p, recharge: { ...p.recharge, minEur: Number(e.target.value) } }))}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted">Recharge recommandée (€)</span>
                <input type="number" value={pricing.recharge.recommendedEur}
                  onChange={(e) => setPricing((p) => ({ ...p, recharge: { ...p.recharge, recommendedEur: Number(e.target.value) } }))}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1.5 text-sm sm:col-span-2">
                <span className="text-muted">Packs recharge (€, séparés par virgule)</span>
                <input value={(pricing.recharge.packagesEur || []).join(', ')}
                  onChange={(e) => setPricing((p) => ({ ...p, recharge: { ...p.recharge, packagesEur: e.target.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0) } }))}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm sm:col-span-2">
                <span><span className="block font-medium text-fg">Publier les prix</span><span className="text-xs text-muted">Sinon « Sur devis » côté public.</span></span>
                <input type="checkbox" checked={pricing.pricingPublished} onChange={(e) => setPricing((p) => ({ ...p, pricingPublished: e.target.checked }))} className="h-5 w-5 accent-accent" />
              </label>
            </div>
          </VryxCard>
          <VryxCard className="p-5">
            <p className="text-sm font-semibold text-fg">Aperçu marketing</p>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4 border-b border-border/60 pb-2"><dt className="text-muted">Input dès</dt><dd className="font-mono">{pricing.headline.minInputEurPerMillion.toFixed(4)} €/M</dd></div>
              <div className="flex justify-between gap-4 border-b border-border/60 pb-2"><dt className="text-muted">Output dès</dt><dd className="font-mono">{pricing.headline.minOutputEurPerMillion.toFixed(4)} €/M</dd></div>
              <div className="flex justify-between gap-4 border-b border-border/60 pb-2"><dt className="text-muted">Blended chat</dt><dd className="font-mono">~{previewBlended.toFixed(4)} €/M</dd></div>
              <div className="flex justify-between gap-4 border-b border-border/60 pb-2"><dt className="text-muted">Workers</dt><dd className="font-mono">{pricing.workerRewardSharePercent}%</dd></div>
              <div className="flex justify-between gap-4 border-b border-border/60 pb-2"><dt className="text-muted">Dernière modification</dt><dd className="text-right">{formatDate(pricing.updatedAt)}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Admin</dt><dd className="font-mono">{pricing.updatedByEmail || pricing.updatedByUserId || '—'}</dd></div>
            </dl>
          </VryxCard>
        </div>
      )}

      {tab === 'models' && (
        <div className="space-y-4">
          <VryxCard className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <input
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder="Rechercher un modèle, un alias ou une famille..."
              className="min-h-11 flex-1 rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
            />
            <span className="text-xs text-muted">{filteredModels.length} / {models.length} modèles</span>
          </VryxCard>

          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[72rem] text-left text-sm">
              <thead className="border-b border-border bg-surface text-xs uppercase text-muted">
                <tr>
                  <th className="px-4 py-3">Modèle</th>
                  <th className="px-4 py-3">Input / Output</th>
                  <th className="px-4 py-3">Private Pool</th>
                  <th className="px-4 py-3">Workers</th>
                  <th className="px-4 py-3">Marge min</th>
                  <th className="px-4 py-3">Statut</th>
                  <th className="px-4 py-3">Modifié</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filteredModels.map((model) => (
                  <tr key={model.slug} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-fg">{model.name}</p>
                      <p className="text-xs text-muted">{model.provider} · {model.apiAlias || model.hfId || model.slug}</p>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {formatPricingLabel(model.eurPerMillionInput ?? model.pricing?.inputEurPerMillion)} / {formatPricingLabel(model.eurPerMillionOutput ?? model.pricing?.outputEurPerMillion)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {formatPricingLabel(model.privatePoolInputEurPerMillion ?? model.pricing?.privatePoolInputEurPerMillion)} / {formatPricingLabel(model.privatePoolOutputEurPerMillion ?? model.pricing?.privatePoolOutputEurPerMillion)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{model.workerSharePercent ?? model.pricing?.workerSharePercent ?? pricing.defaultWorkerSharePercent}%</td>
                    <td className="px-4 py-3 font-mono text-xs">{model.minVryxMarginPercent ?? pricing.minVryxNetMarginPercent}%</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${model.isPublic ? 'bg-accent/10 text-accent' : 'bg-border text-muted'}`}>{model.isPublic ? 'Public' : 'Privé'}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${model.isActive ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>{model.isActive ? 'Actif' : 'Inactif'}</span>
                        <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase text-muted">{availabilityLabel(model.availabilityStatus)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      <p>{formatDate(model.updatedAt)}</p>
                      <p>{model.updatedByEmail || model.updatedByUserId || '—'}</p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" onClick={() => setEditingModel(model)} className="rounded-xl border border-border px-3 py-2 text-xs font-semibold text-fg hover:bg-surface">
                        Éditer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'volume' && (
        <VryxCard className="p-5">
          <div className="space-y-2">
            {pricing.volumeDiscounts.map((row, index) => (
              <div key={index} className="grid gap-2 rounded-2xl border border-border bg-surface p-3 sm:grid-cols-[1fr_1fr_auto]">
                <input type="number" value={row.minMonthlyMillions} onChange={(e) => setPricing((p) => ({ ...p, volumeDiscounts: p.volumeDiscounts.map((r, i) => i === index ? { ...r, minMonthlyMillions: Number(e.target.value) } : r) }))} className="rounded-xl border border-border bg-card px-3 py-2 text-sm" aria-label="Millions mensuels" />
                <input type="number" value={row.discountPercent} onChange={(e) => setPricing((p) => ({ ...p, volumeDiscounts: p.volumeDiscounts.map((r, i) => i === index ? { ...r, discountPercent: Number(e.target.value) } : r) }))} className="rounded-xl border border-border bg-card px-3 py-2 text-sm" aria-label="Remise %" />
                <button type="button" onClick={() => setPricing((p) => ({ ...p, volumeDiscounts: p.volumeDiscounts.filter((_, i) => i !== index) }))} className="rounded-xl border border-border px-3 py-2 text-xs">Retirer</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setPricing((p) => ({ ...p, volumeDiscounts: [...p.volumeDiscounts, { minMonthlyMillions: 0, discountPercent: 0 }] }))} className="mt-3 rounded-lg border border-border px-3 py-1.5 text-xs">Ajouter un palier</button>
        </VryxCard>
      )}

      {tab === 'subscriptions' && (
        <div className="grid gap-3">
          {subscriptionPlans.map((plan) => (
            <VryxCard key={plan.slug} className="grid gap-3 p-4 sm:grid-cols-4">
              <input value={plan.name} onChange={(e) => setSubscriptionPlans((rows) => rows.map((r) => r.slug === plan.slug ? { ...r, name: e.target.value } : r))} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm" />
              <input type="number" value={plan.monthlyEur} onChange={(e) => setSubscriptionPlans((rows) => rows.map((r) => r.slug === plan.slug ? { ...r, monthlyEur: Number(e.target.value) } : r))} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm font-mono" />
              <input value={plan.description} onChange={(e) => setSubscriptionPlans((rows) => rows.map((r) => r.slug === plan.slug ? { ...r, description: e.target.value } : r))} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm sm:col-span-2" />
              <VryxButton type="button" className="sm:col-span-4 sm:max-w-xs" onClick={() => void savePlan('sub', plan)} disabled={saving}>Sauvegarder {plan.slug}</VryxButton>
            </VryxCard>
          ))}
        </div>
      )}

      {tab === 'pool' && (
        <div className="space-y-4">
          <VryxCard className="p-4">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Remise tokens Private Pool (%)</span>
              <input type="number" value={pricing.privatePoolTokenDiscountPercent} onChange={(e) => setPricing((p) => ({ ...p, privatePoolTokenDiscountPercent: Number(e.target.value) }))} className="w-24 rounded-xl border border-border bg-surface px-3 py-2 font-mono" />
            </label>
          </VryxCard>
          {privatePoolPlans.map((plan) => (
            <VryxCard key={plan.slug} className="grid gap-3 p-4 sm:grid-cols-4">
              <input value={plan.name} onChange={(e) => setPrivatePoolPlans((rows) => rows.map((r) => r.slug === plan.slug ? { ...r, name: e.target.value } : r))} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm" />
              <input type="number" value={plan.monthlyEur} onChange={(e) => setPrivatePoolPlans((rows) => rows.map((r) => r.slug === plan.slug ? { ...r, monthlyEur: Number(e.target.value) } : r))} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm font-mono" />
              <input type="number" value={plan.workerCountMin} onChange={(e) => setPrivatePoolPlans((rows) => rows.map((r) => r.slug === plan.slug ? { ...r, workerCountMin: Number(e.target.value) } : r))} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm font-mono" />
              <input type="number" value={plan.workerCountMax} onChange={(e) => setPrivatePoolPlans((rows) => rows.map((r) => r.slug === plan.slug ? { ...r, workerCountMax: Number(e.target.value) } : r))} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm font-mono" />
              <label className="flex items-center justify-between rounded-xl border border-border bg-surface px-3 py-2 text-sm">
                <span>Public</span>
                <input type="checkbox" checked={plan.isPublic} onChange={(e) => setPrivatePoolPlans((rows) => rows.map((r) => r.slug === plan.slug ? { ...r, isPublic: e.target.checked } : r))} className="h-5 w-5 accent-accent" />
              </label>
              <div className="text-xs text-muted sm:col-span-2">
                Dernière modification : {formatDate(plan.updatedAt)} · {plan.updatedByEmail || plan.updatedByUserId || '—'}
              </div>
              <VryxButton type="button" className="sm:col-span-4 sm:max-w-xs" onClick={() => void savePlan('pool', plan)} disabled={saving}>Sauvegarder {plan.slug}</VryxButton>
            </VryxCard>
          ))}
        </div>
      )}

      {tab === 'finetune' && (
        <div className="grid gap-3">
          {fineTuningPlans.map((plan) => (
            <VryxCard key={plan.slug} className="grid gap-3 p-4 sm:grid-cols-3">
              <input value={plan.name} onChange={(e) => setFineTuningPlans((rows) => rows.map((r) => r.slug === plan.slug ? { ...r, name: e.target.value } : r))} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm" />
              <input type="number" step="0.01" value={plan.eurPerMillionTraining} onChange={(e) => setFineTuningPlans((rows) => rows.map((r) => r.slug === plan.slug ? { ...r, eurPerMillionTraining: Number(e.target.value) } : r))} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm font-mono" />
              <VryxButton type="button" onClick={() => void savePlan('ft', plan)} disabled={saving}>Sauvegarder</VryxButton>
            </VryxCard>
          ))}
        </div>
      )}

      {tab === 'audit' && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="border-b border-border bg-surface text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Objet</th>
                <th className="px-4 py-3">Admin</th>
                <th className="px-4 py-3">Après</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-3 text-xs text-muted">{formatDate(entry.createdAt)}</td>
                  <td className="px-4 py-3"><span className="font-semibold text-fg">{entry.entityType}</span><span className="ml-2 font-mono text-xs text-muted">{entry.entityId}</span></td>
                  <td className="px-4 py-3 text-xs text-muted">{entry.updatedByEmail || entry.updatedByUserId || '—'}</td>
                  <td className="px-4 py-3">
                    <code className="line-clamp-2 block max-w-xl rounded-lg bg-surface px-2 py-1 text-[11px] text-muted">
                      {JSON.stringify(entry.after)}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingModel && (
        <div className="fixed inset-0 z-150 flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center">
          <div className="max-h-[92dvh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-border bg-card p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-fg">{editingModel.name}</h2>
                <p className="text-xs text-muted">Prix, disponibilité, visibilité publique et marge minimale.</p>
              </div>
              <button type="button" onClick={() => setEditingModel(null)} className="rounded-xl border border-border px-3 py-2 text-sm text-fg">Fermer</button>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-muted">Prix input (€ / M)</span>
                <input type="number" step="0.0001" value={editingModel.eurPerMillionInput ?? editingModel.pricing?.inputEurPerMillion ?? ''} onChange={(e) => setEditingModel({ ...editingModel, eurPerMillionInput: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Prix output (€ / M)</span>
                <input type="number" step="0.0001" value={editingModel.eurPerMillionOutput ?? editingModel.pricing?.outputEurPerMillion ?? ''} onChange={(e) => setEditingModel({ ...editingModel, eurPerMillionOutput: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Private Pool input (€ / M)</span>
                <input type="number" step="0.0001" value={editingModel.privatePoolInputEurPerMillion ?? ''} onChange={(e) => setEditingModel({ ...editingModel, privatePoolInputEurPerMillion: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Private Pool output (€ / M)</span>
                <input type="number" step="0.0001" value={editingModel.privatePoolOutputEurPerMillion ?? ''} onChange={(e) => setEditingModel({ ...editingModel, privatePoolOutputEurPerMillion: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Taux reversé workers (%)</span>
                <input type="number" min="0" max="100" value={editingModel.workerSharePercent ?? editingModel.pricing?.workerSharePercent ?? ''} onChange={(e) => setEditingModel({ ...editingModel, workerSharePercent: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Marge minimale Vryx (%)</span>
                <input type="number" min="0" max="95" value={editingModel.minVryxMarginPercent ?? ''} onChange={(e) => setEditingModel({ ...editingModel, minVryxMarginPercent: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted">Disponibilité</span>
                <select value={editingModel.availabilityStatus ?? 'available'} onChange={(e) => setEditingModel({ ...editingModel, availabilityStatus: e.target.value as CatalogModel['availabilityStatus'] })} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent">
                  <option value="available">Disponible</option>
                  <option value="limited">Limité</option>
                  <option value="reservation">Sur réservation</option>
                  <option value="unavailable">Indisponible</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center justify-between rounded-2xl border border-border bg-surface px-4 py-3 text-sm"><span>Public</span><input type="checkbox" checked={editingModel.isPublic} onChange={(e) => setEditingModel({ ...editingModel, isPublic: e.target.checked })} className="h-5 w-5 accent-accent" /></label>
                <label className="flex items-center justify-between rounded-2xl border border-border bg-surface px-4 py-3 text-sm"><span>Actif</span><input type="checkbox" checked={editingModel.isActive} onChange={(e) => setEditingModel({ ...editingModel, isActive: e.target.checked })} className="h-5 w-5 accent-accent" /></label>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setEditingModel(null)} className="rounded-xl border border-border px-4 py-2 text-sm text-fg">Annuler</button>
              <button type="button" disabled={saving} onClick={() => void saveModel(editingModel)} className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-50">
                {saving ? 'Sauvegarde…' : 'Sauvegarder'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  )
}
