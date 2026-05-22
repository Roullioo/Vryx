import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AdminShell } from '../components/admin/AdminShell'
import { VryxButton, VryxCard } from '../components/ui/VryxPrimitives'
import {
  fetchAdminPricing,
  saveAdminPricing,
  type AdminPricing,
  type VolumeDiscount,
} from '../lib/pricingModels'

const DEFAULT_PRICING: AdminPricing = {
  defaultEurPerMillion: 0.3,
  pricingPublished: false,
  vatPercent: 20,
  workerRewardSharePercent: 58,
  estimatedGrossMarginPercent: 72,
  volumeDiscounts: [
    { minMonthlyMillions: 100, discountPercent: 5 },
    { minMonthlyMillions: 500, discountPercent: 10 },
    { minMonthlyMillions: 2000, discountPercent: 18 },
  ],
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
  const [pricing, setPricing] = useState<AdminPricing>(DEFAULT_PRICING)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchAdminPricing().then((r) => {
      if (cancelled) return
      if (r.ok) setPricing(r.data.pricing)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const preview = useMemo(() => {
    const monthlyMillions = 100
    const discount = parseDiscountRows(pricing.volumeDiscounts)
      .filter((row) => monthlyMillions >= row.minMonthlyMillions)
      .sort((a, b) => b.discountPercent - a.discountPercent)[0]?.discountPercent ?? 0
    const net = pricing.defaultEurPerMillion * (1 - discount / 100)
    return { monthlyMillions, discount, net }
  }, [pricing])

  async function submit() {
    setSaving(true)
    setMessage('')
    const r = await saveAdminPricing({
      ...pricing,
      volumeDiscounts: parseDiscountRows(pricing.volumeDiscounts),
    })
    setSaving(false)
    if (r.ok) {
      setPricing(r.data.pricing)
      setMessage(t('pricing.saved'))
    } else {
      setMessage(r.error)
    }
  }

  const updateDiscount = (index: number, patch: Partial<VolumeDiscount>) => {
    setPricing((prev) => ({
      ...prev,
      volumeDiscounts: prev.volumeDiscounts.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }))
  }

  return (
    <AdminShell
      title={t('pricing.title')}
      subtitle="Tarif public, TVA, commission workers et remises volume."
      actions={
        <VryxButton type="button" onClick={() => void submit()} disabled={saving || loading}>
          {saving ? 'Sauvegarde…' : 'Sauvegarder'}
        </VryxButton>
      }
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <VryxCard className="p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="text-muted">Tarif global (€ / million de tokens)</span>
              <input
                type="number"
                min="0.0001"
                step="0.0001"
                value={pricing.defaultEurPerMillion}
                onChange={(e) => setPricing((p) => ({ ...p, defaultEurPerMillion: Number(e.target.value) }))}
                className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="text-muted">TVA (%)</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={pricing.vatPercent}
                onChange={(e) => setPricing((p) => ({ ...p, vatPercent: Number(e.target.value) }))}
                className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="text-muted">Commission workers (%)</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={pricing.workerRewardSharePercent}
                onChange={(e) => setPricing((p) => ({ ...p, workerRewardSharePercent: Number(e.target.value) }))}
                className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
              <span>
                <span className="block font-medium text-fg">Publier le prix</span>
                <span className="text-xs text-muted">Si désactivé, le public voit « Sur devis ».</span>
              </span>
              <input
                type="checkbox"
                checked={pricing.pricingPublished}
                onChange={(e) => setPricing((p) => ({ ...p, pricingPublished: e.target.checked }))}
                className="h-5 w-5 accent-accent"
              />
            </label>
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-fg">Remises volume</h2>
              <button
                type="button"
                onClick={() => setPricing((p) => ({ ...p, volumeDiscounts: [...p.volumeDiscounts, { minMonthlyMillions: 0, discountPercent: 0 }] }))}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface"
              >
                Ajouter un palier
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {pricing.volumeDiscounts.map((row, index) => (
                <div key={index} className="grid gap-2 rounded-2xl border border-border bg-surface p-3 sm:grid-cols-[1fr_1fr_auto]">
                  <input
                    type="number"
                    min="0"
                    value={row.minMonthlyMillions}
                    onChange={(e) => updateDiscount(index, { minMonthlyMillions: Number(e.target.value) })}
                    className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                    aria-label="Millions mensuels"
                  />
                  <input
                    type="number"
                    min="0"
                    max="95"
                    value={row.discountPercent}
                    onChange={(e) => updateDiscount(index, { discountPercent: Number(e.target.value) })}
                    className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                    aria-label="Remise en pourcentage"
                  />
                  <button
                    type="button"
                    onClick={() => setPricing((p) => ({ ...p, volumeDiscounts: p.volumeDiscounts.filter((_, i) => i !== index) }))}
                    className="rounded-xl border border-border px-3 py-2 text-xs font-medium text-muted hover:bg-card hover:text-fg"
                  >
                    Retirer
                  </button>
                </div>
              ))}
            </div>
          </div>
          {message && <p className="mt-4 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">{message}</p>}
        </VryxCard>

        <VryxCard className="p-5">
          <p className="text-sm font-semibold text-fg">Aperçu public</p>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
              <dt className="text-muted">Affichage</dt>
              <dd className="font-medium text-fg">{pricing.pricingPublished ? 'Prix publié' : 'Sur devis'}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
              <dt className="text-muted">Tarif net palier 100M</dt>
              <dd className="font-mono text-fg">{preview.net.toFixed(4)} € / M</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
              <dt className="text-muted">Remise appliquée</dt>
              <dd className="font-mono text-fg">{preview.discount} %</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Mis à jour</dt>
              <dd className="text-right text-fg">{pricing.updatedAt ? new Date(pricing.updatedAt).toLocaleString('fr-FR') : '—'}</dd>
            </div>
          </dl>
        </VryxCard>
      </div>
    </AdminShell>
  )
}
