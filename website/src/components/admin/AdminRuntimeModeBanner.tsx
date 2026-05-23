import { useEffect, useState } from 'react'
import { apiJson } from '../../lib/api'
import { VryxBadge } from '../ui/VryxPrimitives'

type RuntimeBadge = {
  label: string
  active: boolean
  tone?: 'neutral' | 'accent' | 'success' | 'warning'
}

type RuntimeMode = {
  ok: boolean
  environment: string
  billingMode: string
  payment: string
  enforceCredits: boolean
  stripe: {
    checkoutEnabled: boolean
    live: boolean
    mode: string
  }
  redis: {
    ready: boolean
    requiredInProd: boolean
  }
  workerApp: {
    build: string
    signed: boolean
  }
  workers: {
    runtime: string
  }
  badges: RuntimeBadge[]
}

export function AdminRuntimeModeBanner() {
  const [mode, setMode] = useState<RuntimeMode | null>(null)

  useEffect(() => {
    let active = true
    apiJson<RuntimeMode>('/api/admin/runtime-mode').then((result) => {
      if (active && result.ok) setMode(result.data)
    })
    return () => {
      active = false
    }
  }, [])

  if (!mode) return null

  const rows = [
    ['Mode actuel', mode.environment],
    ['Paiement', mode.payment],
    ['Stripe live', mode.stripe.live ? 'actif' : 'désactivé'],
    ['App worker', mode.workerApp.signed ? 'signed build' : mode.workerApp.build],
    ['Redis', mode.redis.ready ? 'actif' : 'à vérifier'],
    ['Workers', mode.workers.runtime],
  ]

  return (
    <section className="mb-5 rounded-2xl border border-accent/25 bg-accent/8 p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase text-accent">Mode investisseur</p>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 rounded-xl bg-card/70 px-3 py-2">
                <dt className="text-muted">{label}</dt>
                <dd className="font-mono text-xs font-semibold text-fg">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="flex flex-wrap gap-2 xl:max-w-xs xl:justify-end">
          {mode.badges.map((badge) => (
            <VryxBadge key={badge.label} tone={badge.active ? badge.tone || 'neutral' : 'neutral'}>
              {badge.label}
            </VryxBadge>
          ))}
        </div>
      </div>
    </section>
  )
}
