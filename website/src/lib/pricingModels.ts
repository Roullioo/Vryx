import { apiJson } from './api'

export type VolumeDiscount = {
  minMonthlyMillions: number
  discountPercent: number
}

export type PricingHeadline = {
  minInputEurPerMillion: number
  minOutputEurPerMillion: number
}

export type RechargeConfig = {
  minEur: number
  recommendedEur: number
  b2bMinEur: number
  packagesEur?: number[]
}

export type ModelPricing = {
  inputEurPerMillion: number
  outputEurPerMillion: number
  blendedEurPerMillion: number
  privatePoolInputEurPerMillion?: number
  privatePoolOutputEurPerMillion?: number
  workerSharePercent: number
  tier: string
}

export type PublicPricing = {
  published: boolean
  headline: PricingHeadline | null
  minInputEurPerMillion: number | null
  minOutputEurPerMillion: number | null
  blendedInputRatioPercent: number
  eurPerMillionTokens: number | null
  eurPerThousandTokens: number | null
  vatPercent: number
  workerRewardSharePercent: number
  defaultWorkerSharePercent: number
  estimatedGrossMarginPercent: number
  volumeDiscounts: VolumeDiscount[]
  recharge?: RechargeConfig
  privatePoolTokenDiscountPercent: number
  minVryxNetMarginPercent: number
  subscriptionPlans?: SubscriptionPlan[]
  privatePoolPlans?: PrivatePoolPlan[]
  fineTuningPlans?: FineTuningPlan[]
  pricingTiers?: PricingTier[]
  updatedAt: string | null
}

export type AdminPricing = {
  defaultEurPerMillion: number
  pricingPublished: boolean
  vatPercent: number
  workerRewardSharePercent: number
  defaultWorkerSharePercent: number
  estimatedGrossMarginPercent: number
  volumeDiscounts: VolumeDiscount[]
  headline: PricingHeadline
  blendedInputRatioPercent: number
  recharge: RechargeConfig
  privatePoolTokenDiscountPercent: number
  minVryxNetMarginPercent: number
  updatedAt: string | null
  updatedByUserId: string | number | null
}

export type PricingTier = {
  slug: string
  label: string
  defaultInputEurPerMillion: number
  defaultOutputEurPerMillion: number
  defaultWorkerSharePercent: number
  sortOrder: number
}

export type SubscriptionPlan = {
  slug: string
  name: string
  monthlyEur: number
  description: string
  isPublic: boolean
  sortOrder: number
}

export type PrivatePoolPlan = {
  slug: string
  name: string
  monthlyEur: number
  workerCountMin: number
  workerCountMax: number
  tokenDiscountPercent: number
  isPublic: boolean
  sortOrder: number
}

export type FineTuningPlan = {
  slug: string
  name: string
  eurPerMillionTraining: number
  setupMinEur: number
  setupMaxEur: number
  deploymentMonthlyMinEur: number
  deploymentMonthlyMaxEur: number
  isPublic: boolean
  sortOrder: number
}

export type PricingWarning = {
  level: 'error' | 'warning'
  code: string
  message: string
  netMarginPercent?: number
}

export type CatalogModel = {
  slug: string
  id: string
  hfId: string | null
  apiAlias?: string | null
  name: string
  provider: string
  family: string
  paramsNote: string
  contextTokens: number
  modalities: string[]
  openWeights: boolean
  weightGb: number | null
  pricingTier?: string
  pricing?: ModelPricing
  eurPerMillion: number | null
  effectiveEurPerMillion: number
  eurPerMillionInput?: number
  eurPerMillionOutput?: number
  workerSharePercent?: number
  estimatedWorkerCostInput?: number | null
  estimatedWorkerCostOutput?: number | null
  minVryxMarginPercent?: number
  eurPerMillionCachedInput?: number | null
  eurPerMillionBatchInput?: number | null
  eurPerMillionBatchOutput?: number | null
  privatePoolInputEurPerMillion?: number
  privatePoolOutputEurPerMillion?: number
  availabilityStatus?: 'available' | 'limited' | 'reservation' | 'unavailable'
  marginPreview?: {
    blendedEurPerMillion: number
    sampleCostEur: number
    workerPayoutEur: number
    vryxGrossEur: number
    vryxNetEur: number
    netMarginPercent: number
  }
  pricingWarnings?: PricingWarning[]
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

export function formatInputOutputLabel(input: number | null | undefined, output: number | null | undefined) {
  if (input == null || output == null) return 'Sur devis'
  return `${formatPricingLabel(input)} in / ${formatPricingLabel(output)} out`
}

export function formatBlendedLabel(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return 'Sur devis'
  return `~${formatPricingLabel(value)}/M (chat moyen)`
}

export function computeBlendedPrice(
  inputEur: number,
  outputEur: number,
  inputRatioPercent = 75,
) {
  const ratio = Math.max(0, Math.min(100, inputRatioPercent)) / 100
  const blended = inputEur * ratio + outputEur * (1 - ratio)
  return Number(blended.toFixed(6))
}

export async function fetchPublicPricing() {
  return apiJson<{ ok: boolean; pricing: PublicPricing }>('/api/public/pricing')
}

export async function fetchPublicModels() {
  return apiJson<{ ok: boolean; pricing: PublicPricing; models: CatalogModel[] }>('/api/public/models')
}

export async function fetchAdminPricingBundle() {
  return apiJson<{
    ok: boolean
    pricing: AdminPricing
    tiers: PricingTier[]
    subscriptionPlans: SubscriptionPlan[]
    privatePoolPlans: PrivatePoolPlan[]
    fineTuningPlans: FineTuningPlan[]
  }>('/api/admin/pricing')
}

export async function saveAdminPricing(pricing: Partial<AdminPricing>) {
  return apiJson<{ ok: boolean; pricing: AdminPricing }>('/api/admin/pricing', {
    method: 'PATCH',
    body: JSON.stringify(pricing),
  })
}

export async function saveAdminTier(tier: Partial<PricingTier> & { slug: string }) {
  return apiJson<{ ok: boolean; tiers: PricingTier[] }>(`/api/admin/pricing/tiers/${encodeURIComponent(tier.slug)}`, {
    method: 'PATCH',
    body: JSON.stringify(tier),
  })
}

export async function saveSubscriptionPlan(plan: Partial<SubscriptionPlan> & { slug: string }) {
  return apiJson<{ ok: boolean; plans: SubscriptionPlan[] }>(`/api/admin/plans/subscriptions/${encodeURIComponent(plan.slug)}`, {
    method: 'PATCH',
    body: JSON.stringify(plan),
  })
}

export async function savePrivatePoolPlan(plan: Partial<PrivatePoolPlan> & { slug: string }) {
  return apiJson<{ ok: boolean; plans: PrivatePoolPlan[] }>(`/api/admin/plans/private-pool/${encodeURIComponent(plan.slug)}`, {
    method: 'PATCH',
    body: JSON.stringify(plan),
  })
}

export async function saveFineTuningPlan(plan: Partial<FineTuningPlan> & { slug: string }) {
  return apiJson<{ ok: boolean; plans: FineTuningPlan[] }>(`/api/admin/plans/fine-tuning/${encodeURIComponent(plan.slug)}`, {
    method: 'PATCH',
    body: JSON.stringify(plan),
  })
}

export async function fetchAdminModels() {
  return apiJson<{ ok: boolean; pricing: AdminPricing; tiers: PricingTier[]; models: CatalogModel[] }>('/api/admin/models/catalog')
}

export async function saveAdminModel(model: Partial<CatalogModel> & { name: string; provider: string; family: string }) {
  const slug = model.slug
  return apiJson<{ ok: boolean; slug: string; warnings?: PricingWarning[]; models: CatalogModel[] }>(
    slug ? `/api/admin/models/catalog/${encodeURIComponent(slug)}` : '/api/admin/models/catalog',
    {
      method: slug ? 'PATCH' : 'POST',
      body: JSON.stringify({
        slug: model.slug,
        hfId: model.hfId,
        apiAlias: model.apiAlias,
        name: model.name,
        provider: model.provider,
        family: model.family,
        paramsNote: model.paramsNote,
        contextTokens: model.contextTokens,
        modalities: model.modalities,
        openWeights: model.openWeights,
        weightGb: model.weightGb,
        pricingTier: model.pricingTier,
        eurPerMillion: model.eurPerMillion,
        eurPerMillionInput: model.eurPerMillionInput ?? model.pricing?.inputEurPerMillion,
        eurPerMillionOutput: model.eurPerMillionOutput ?? model.pricing?.outputEurPerMillion,
        eurPerMillionCachedInput: model.eurPerMillionCachedInput,
        eurPerMillionBatchInput: model.eurPerMillionBatchInput,
        eurPerMillionBatchOutput: model.eurPerMillionBatchOutput,
        privatePoolInputEurPerMillion: model.privatePoolInputEurPerMillion,
        privatePoolOutputEurPerMillion: model.privatePoolOutputEurPerMillion,
        workerSharePercent: model.workerSharePercent,
        estimatedWorkerCostInput: model.estimatedWorkerCostInput,
        estimatedWorkerCostOutput: model.estimatedWorkerCostOutput,
        minVryxMarginPercent: model.minVryxMarginPercent,
        availabilityStatus: model.availabilityStatus,
        isActive: model.isActive,
        isPublic: model.isPublic,
        minVramMb: model.minVramMb,
        requiredWorkers: model.requiredWorkers,
        sortOrder: model.sortOrder,
      }),
    },
  )
}

/** @deprecated use fetchAdminPricingBundle */
export async function fetchAdminPricing() {
  const r = await fetchAdminPricingBundle()
  if (!r.ok) return r as { ok: false; error: string }
  return { ok: true as const, data: { pricing: r.data.pricing } }
}
