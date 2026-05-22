import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AdminShell } from '../components/admin/AdminShell'
import { VryxButton, VryxCard } from '../components/ui/VryxPrimitives'
import {
  fetchAdminPricingBundle,
  saveAdminPricing,
  saveFineTuningPlan,
  savePrivatePoolPlan,
  saveSubscriptionPlan,
  type AdminPricing,
  type FineTuningPlan,
  type PrivatePoolPlan,
  type SubscriptionPlan,
  type VolumeDiscount,
} from '../lib/pricingModels'

type TabId = 'general' | 'volume' | 'subscriptions' | 'pool' | 'finetune'

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

export function AdminPricingPage() {
  const { t } = useTranslation('admin')
  const [tab, setTab] = useState<TabId>('general')
  const [pricing, setPricing] = useState<AdminPricing>(DEFAULT_PRICING)
  const [subscriptionPlans, setSubscriptionPlans] = useState<SubscriptionPlan[]>([])
  const [privatePoolPlans, setPrivatePoolPlans] = useState<PrivatePoolPlan[]>([])
  const [fineTuningPlans, setFineTuningPlans] = useState<FineTuningPlan[]>([])
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
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const previewBlended = useMemo(() => {
    const ratio = pricing.blendedInputRatioPercent / 100
    return pricing.headline.minInputEurPerMillion * ratio + pricing.headline.minOutputEurPerMillion * (1 - ratio)
  }, [pricing])

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
    { id: 'volume', label: 'Remises volume' },
    { id: 'subscriptions', label: 'Plans B2B' },
    { id: 'pool', label: 'Private Pool' },
    { id: 'finetune', label: 'Fine-tuning' },
  ]

  return (
    <AdminShell
      title={t('pricing.title')}
      subtitle="Headline, recharge, remises, plans B2B, Private Pool et fine-tuning."
      actions={
        (tab === 'general' || tab === 'volume') ? (
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
              <div className="flex justify-between gap-4"><dt className="text-muted">Blended chat</dt><dd className="font-mono">~{previewBlended.toFixed(4)} €/M</dd></div>
            </dl>
          </VryxCard>
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
    </AdminShell>
  )
}
