import { apiJson } from './api'

export type VolumeDiscount = {
  minMonthlyMillions: number
  discountPercent: number
}

export type PublicPricing = {
  published: boolean
  eurPerMillionTokens: number | null
  eurPerThousandTokens: number | null
  vatPercent: number
  workerRewardSharePercent: number
  estimatedGrossMarginPercent: number
  volumeDiscounts: VolumeDiscount[]
  updatedAt: string | null
}

export type AdminPricing = {
  defaultEurPerMillion: number
  pricingPublished: boolean
  vatPercent: number
  workerRewardSharePercent: number
  estimatedGrossMarginPercent: number
  volumeDiscounts: VolumeDiscount[]
  updatedAt: string | null
  updatedByUserId: string | number | null
}

export type CatalogModel = {
  slug: string
  id: string
  hfId: string | null
  name: string
  provider: string
  family: string
  paramsNote: string
  contextTokens: number
  modalities: string[]
  openWeights: boolean
  weightGb: number | null
  eurPerMillion: number | null
  effectiveEurPerMillion: number
  isActive: boolean
  isPublic: boolean
  minVramMb: number | null
  requiredWorkers: number
  sortOrder: number
  workersOnline?: number
  workersTotal?: number
  runnable?: boolean
  ready?: boolean
  lastSeenAt?: string | null
}

export function formatPricingLabel(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return 'Sur devis'
  return `${Number(value).toLocaleString('fr-FR', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })} €`
}

export async function fetchPublicPricing() {
  return apiJson<{ ok: boolean; pricing: PublicPricing }>('/api/public/pricing')
}

export async function fetchPublicModels() {
  return apiJson<{ ok: boolean; pricing: PublicPricing; models: CatalogModel[] }>('/api/public/models')
}

export async function fetchAdminPricing() {
  return apiJson<{ ok: boolean; pricing: AdminPricing }>('/api/admin/pricing')
}

export async function saveAdminPricing(pricing: AdminPricing) {
  return apiJson<{ ok: boolean; pricing: AdminPricing }>('/api/admin/pricing', {
    method: 'PATCH',
    body: JSON.stringify(pricing),
  })
}

export async function fetchAdminModels() {
  return apiJson<{ ok: boolean; pricing: AdminPricing; models: CatalogModel[] }>('/api/admin/models/catalog')
}

export async function saveAdminModel(model: Partial<CatalogModel> & { name: string; provider: string; family: string }) {
  const slug = model.slug
  return apiJson<{ ok: boolean; slug: string; models: CatalogModel[] }>(
    slug ? `/api/admin/models/catalog/${encodeURIComponent(slug)}` : '/api/admin/models/catalog',
    {
      method: slug ? 'PATCH' : 'POST',
      body: JSON.stringify({
        slug: model.slug,
        hfId: model.hfId,
        name: model.name,
        provider: model.provider,
        family: model.family,
        paramsNote: model.paramsNote,
        contextTokens: model.contextTokens,
        modalities: model.modalities,
        openWeights: model.openWeights,
        weightGb: model.weightGb,
        eurPerMillion: model.eurPerMillion,
        isActive: model.isActive,
        isPublic: model.isPublic,
        minVramMb: model.minVramMb,
        requiredWorkers: model.requiredWorkers,
        sortOrder: model.sortOrder,
      }),
    },
  )
}
