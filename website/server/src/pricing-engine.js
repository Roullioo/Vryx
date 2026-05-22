/** Pure pricing engine — no DB access. */

export const BILLING_MODES = ['public', 'private_pool']
export const AVAILABILITY_STATUSES = ['available', 'limited', 'reservation', 'unavailable']

const STRIPE_FEE_PERCENT = 1.5
const STRIPE_FEE_FIXED_EUR = 0.25
const INFRA_MARGIN_PERCENT = 5

export function clampPercent(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, n))
}

export function positiveNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function toEuroAmount(value, precision = 6) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Number(n.toFixed(precision))
}

/** Split legacy blended price into input/output using ratio (default 75% input weight in blended). */
export function splitLegacyBlendedPrice(blendedEur, inputRatio = 0.75) {
  const blended = positiveNumber(blendedEur, 0.3)
  const ratio = clampPercent(inputRatio * 100, 75) / 100
  const input = toEuroAmount(blended * ratio * (4 / 3), 6)
  const output = toEuroAmount(blended * (1 - ratio) * 4, 6)
  return { inputEurPerMillion: input, outputEurPerMillion: output }
}

export function computeBlendedPrice(inputEur, outputEur, inputRatioPercent = 75) {
  const input = Number(inputEur) || 0
  const output = Number(outputEur) || 0
  const ratio = clampPercent(inputRatioPercent, 75) / 100
  return toEuroAmount(input * ratio + output * (1 - ratio), 6)
}

export function resolveModelRates(modelPricing, billingMode = 'public') {
  const inputPublic = positiveNumber(modelPricing?.inputEurPerMillion, 0)
  const outputPublic = positiveNumber(modelPricing?.outputEurPerMillion, 0)
  if (billingMode === 'private_pool') {
    const poolDiscount = clampPercent(modelPricing?.privatePoolDiscountPercent, 30)
    const inputOverride = modelPricing?.privatePoolInputEurPerMillion
    const outputOverride = modelPricing?.privatePoolOutputEurPerMillion
    const factor = 1 - poolDiscount / 100
    return {
      inputEurPerMillion: inputOverride != null ? Number(inputOverride) : toEuroAmount(inputPublic * factor, 6),
      outputEurPerMillion: outputOverride != null ? Number(outputOverride) : toEuroAmount(outputPublic * factor, 6),
      billingMode: 'private_pool',
    }
  }
  return {
    inputEurPerMillion: inputPublic,
    outputEurPerMillion: outputPublic,
    billingMode: 'public',
  }
}

export function computeTokenCostEur(tokens, eurPerMillion) {
  const n = Math.max(0, Math.floor(Number(tokens) || 0))
  const rate = Number(eurPerMillion) || 0
  if (n <= 0 || rate <= 0) return 0
  return toEuroAmount((n / 1_000_000) * rate, 6)
}

export function computeRequestCost({
  modelPricing,
  promptTokens = 0,
  completionTokens = 0,
  billingMode = 'public',
  volumeDiscountPercent = 0,
}) {
  const rates = resolveModelRates(modelPricing, billingMode)
  const discount = clampPercent(volumeDiscountPercent, 0) / 100
  const factor = 1 - discount
  const inputCost = computeTokenCostEur(promptTokens, rates.inputEurPerMillion) * factor
  const outputCost = computeTokenCostEur(completionTokens, rates.outputEurPerMillion) * factor
  const totalCostEur = toEuroAmount(inputCost + outputCost, 6)
  const blendedEurPerMillion = computeBlendedPrice(
    rates.inputEurPerMillion * factor,
    rates.outputEurPerMillion * factor,
    modelPricing?.blendedInputRatioPercent ?? 75,
  )
  return {
    inputCostEur: toEuroAmount(inputCost, 6),
    outputCostEur: toEuroAmount(outputCost, 6),
    totalCostEur,
    promptTokens: Math.max(0, Math.floor(Number(promptTokens) || 0)),
    completionTokens: Math.max(0, Math.floor(Number(completionTokens) || 0)),
    rates: {
      inputEurPerMillion: toEuroAmount(rates.inputEurPerMillion * factor, 6),
      outputEurPerMillion: toEuroAmount(rates.outputEurPerMillion * factor, 6),
      blendedEurPerMillion,
    },
    billingMode: rates.billingMode,
    volumeDiscountPercent: clampPercent(volumeDiscountPercent, 0),
  }
}

export function resolveWorkerPayout({ costEur, workerSharePercent }) {
  const cost = Number(costEur) || 0
  const share = clampPercent(workerSharePercent, 60) / 100
  const workerPayoutEur = toEuroAmount(cost * share, 4)
  const vryxGrossEur = toEuroAmount(cost * (1 - share), 4)
  return { workerPayoutEur, vryxGrossEur, workerSharePercent: clampPercent(workerSharePercent, 60) }
}

export function estimateStripeFeeEur(amountEur) {
  const amount = Number(amountEur) || 0
  if (amount <= 0) return 0
  return toEuroAmount(amount * (STRIPE_FEE_PERCENT / 100) + STRIPE_FEE_FIXED_EUR, 4)
}

export function validatePricingFloor({
  inputEur,
  outputEur,
  workerSharePercent = 60,
  estimatedWorkerCostInput = null,
  estimatedWorkerCostOutput = null,
  minVryxNetMarginPercent = 20,
  blendedInputRatioPercent = 75,
}) {
  const warnings = []
  const input = Number(inputEur) || 0
  const output = Number(outputEur) || 0
  const share = clampPercent(workerSharePercent, 60) / 100
  const minMargin = clampPercent(minVryxNetMarginPercent, 20)

  const blended = computeBlendedPrice(input, output, blendedInputRatioPercent)
  const samplePrompt = 750_000
  const sampleCompletion = 250_000
  const sampleCost = computeRequestCost({
    modelPricing: {
      inputEurPerMillion: input,
      outputEurPerMillion: output,
      blendedInputRatioPercent,
    },
    promptTokens: samplePrompt,
    completionTokens: sampleCompletion,
  })
  const workerCostInput = estimatedWorkerCostInput != null ? Number(estimatedWorkerCostInput) : input * 0.35
  const workerCostOutput = estimatedWorkerCostOutput != null ? Number(estimatedWorkerCostOutput) : output * 0.45
  const floorWorkerCost = computeTokenCostEur(samplePrompt, workerCostInput) + computeTokenCostEur(sampleCompletion, workerCostOutput)
  const stripeFee = estimateStripeFeeEur(sampleCost.totalCostEur)
  const infraCost = sampleCost.totalCostEur * (INFRA_MARGIN_PERCENT / 100)
  const workerPayout = sampleCost.totalCostEur * share
  const vryxGross = sampleCost.totalCostEur - workerPayout
  const vryxNet = vryxGross - stripeFee - infraCost
  const netMarginPercent = sampleCost.totalCostEur > 0 ? (vryxNet / sampleCost.totalCostEur) * 100 : 0

  if (input <= 0 || output <= 0) {
    warnings.push({ level: 'error', code: 'missing_rates', message: 'Les prix input et output doivent être positifs.' })
  }
  if (output < input) {
    warnings.push({ level: 'warning', code: 'output_below_input', message: 'Le prix output est inférieur au prix input — inhabituel pour l\'inférence.' })
  }
  if (sampleCost.totalCostEur < floorWorkerCost) {
    warnings.push({ level: 'error', code: 'below_worker_floor', message: 'Le prix public est inférieur au coût worker estimé sur un échantillon 75/25.' })
  }
  if (netMarginPercent < minMargin) {
    warnings.push({
      level: 'error',
      code: 'low_margin',
      message: `Marge Vryx nette estimée ${netMarginPercent.toFixed(1)} % (< ${minMargin} %).`,
      netMarginPercent: Number(netMarginPercent.toFixed(2)),
    })
  }

  return {
    ok: !warnings.some((w) => w.level === 'error'),
    warnings,
    preview: {
      blendedEurPerMillion: blended,
      sampleCostEur: sampleCost.totalCostEur,
      workerPayoutEur: toEuroAmount(workerPayout, 4),
      vryxGrossEur: toEuroAmount(vryxGross, 4),
      vryxNetEur: toEuroAmount(vryxNet, 4),
      netMarginPercent: Number(netMarginPercent.toFixed(2)),
      stripeFeeEur: stripeFee,
    },
  }
}

export function resolveModelPricingFromRow(row, globalConfig, tierMap = new Map()) {
  const tierSlug = row.pricing_tier || 'core'
  const tier = tierMap.get(tierSlug) || tierMap.get('core') || null
  const legacyBlended = row.eur_per_million != null ? Number(row.eur_per_million) : null
  const ratio = globalConfig?.blendedInputRatioPercent ?? 75

  let inputEur = row.eur_per_million_input != null ? Number(row.eur_per_million_input) : null
  let outputEur = row.eur_per_million_output != null ? Number(row.eur_per_million_output) : null

  if ((inputEur == null || outputEur == null) && legacyBlended != null && legacyBlended > 0) {
    const split = splitLegacyBlendedPrice(legacyBlended, ratio / 100)
    inputEur = inputEur ?? split.inputEurPerMillion
    outputEur = outputEur ?? split.outputEurPerMillion
  }
  if (inputEur == null && tier) inputEur = Number(tier.defaultInputEurPerMillion)
  if (outputEur == null && tier) outputEur = Number(tier.defaultOutputEurPerMillion)
  if (inputEur == null) inputEur = 0.16
  if (outputEur == null) outputEur = 0.42

  const workerSharePercent = row.worker_share_percent != null
    ? clampPercent(row.worker_share_percent, globalConfig?.defaultWorkerSharePercent ?? 60)
    : clampPercent(tier?.defaultWorkerSharePercent ?? globalConfig?.defaultWorkerSharePercent ?? 60, 60)

  const poolDiscount = globalConfig?.privatePoolTokenDiscountPercent ?? 30
  const privatePoolInput = row.private_pool_input_eur_per_million != null
    ? Number(row.private_pool_input_eur_per_million)
    : toEuroAmount(inputEur * (1 - poolDiscount / 100), 6)
  const privatePoolOutput = row.private_pool_output_eur_per_million != null
    ? Number(row.private_pool_output_eur_per_million)
    : toEuroAmount(outputEur * (1 - poolDiscount / 100), 6)

  const blended = computeBlendedPrice(inputEur, outputEur, ratio)

  return {
    tier: tierSlug,
    inputEurPerMillion: inputEur,
    outputEurPerMillion: outputEur,
    blendedEurPerMillion: blended,
    privatePoolInputEurPerMillion: privatePoolInput,
    privatePoolOutputEurPerMillion: privatePoolOutput,
    privatePoolDiscountPercent: poolDiscount,
    workerSharePercent,
    estimatedWorkerCostInput: row.estimated_worker_cost_input != null ? Number(row.estimated_worker_cost_input) : null,
    estimatedWorkerCostOutput: row.estimated_worker_cost_output != null ? Number(row.estimated_worker_cost_output) : null,
    minVryxMarginPercent: row.min_vryx_margin_percent != null ? clampPercent(row.min_vryx_margin_percent, 20) : globalConfig?.minVryxNetMarginPercent ?? 20,
    blendedInputRatioPercent: ratio,
    /** @deprecated use blendedEurPerMillion */
    effectiveEurPerMillion: blended,
    eurPerMillion: legacyBlended,
  }
}
