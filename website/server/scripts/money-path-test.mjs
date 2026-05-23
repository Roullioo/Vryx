import assert from 'node:assert/strict'
import { computeRequestCost, resolveWorkerPayout, toEuroAmount } from '../src/pricing-engine.js'

const startingBalanceEur = 100
const modelPricing = {
  inputEurPerMillion: 0.18,
  outputEurPerMillion: 0.42,
  blendedInputRatioPercent: 75,
  workerSharePercent: 55,
}
const usage = {
  model: 'Qwen/Qwen3.6-35B-A3B',
  promptTokens: 120_000,
  completionTokens: 40_000,
  billingMode: 'public',
  volumeDiscountPercent: 10,
}

const cost = computeRequestCost({
  modelPricing,
  promptTokens: usage.promptTokens,
  completionTokens: usage.completionTokens,
  billingMode: usage.billingMode,
  volumeDiscountPercent: usage.volumeDiscountPercent,
})
assert.equal(cost.inputCostEur, 0.01944)
assert.equal(cost.outputCostEur, 0.01512)
assert.equal(cost.totalCostEur, 0.03456)
assert.equal(cost.volumeDiscountPercent, 10)

const balanceAfterUsage = toEuroAmount(startingBalanceEur - cost.totalCostEur, 6)
assert.equal(balanceAfterUsage, 99.96544)

const payout = resolveWorkerPayout({
  costEur: cost.totalCostEur,
  workerSharePercent: modelPricing.workerSharePercent,
})
assert.equal(payout.workerPayoutEur, 0.019)
assert.equal(payout.vryxGrossEur, 0.0156)
assert.equal(payout.workerSharePercent, 55)
assert.ok(payout.workerPayoutEur < cost.totalCostEur)

const apiKeyUsageRow = {
  model: usage.model,
  prompt_tokens: usage.promptTokens,
  completion_tokens: usage.completionTokens,
  total_tokens: usage.promptTokens + usage.completionTokens,
  cost_eur: cost.totalCostEur,
  cost_input_eur: cost.inputCostEur,
  cost_output_eur: cost.outputCostEur,
  billing_mode: cost.billingMode,
  pricing_snapshot_json: JSON.stringify({
    rates: cost.rates,
    billingMode: cost.billingMode,
    workerSharePercent: modelPricing.workerSharePercent,
    volumeDiscountPercent: cost.volumeDiscountPercent,
    inputCostEur: cost.inputCostEur,
    outputCostEur: cost.outputCostEur,
  }),
}
assert.ok(JSON.parse(apiKeyUsageRow.pricing_snapshot_json).rates.inputEurPerMillion > 0)

const creditLedgerDebit = {
  type: 'usage_debit',
  amount_eur: -cost.totalCostEur,
  reference_type: 'api_key_usage',
  reference_id: 'usage_1',
}
assert.equal(creditLedgerDebit.amount_eur, -0.03456)

const workerPayoutLedgerRow = {
  status: 'pending',
  customer_cost_eur: cost.totalCostEur,
  payout_eur: payout.workerPayoutEur,
  pricing_snapshot_json: apiKeyUsageRow.pricing_snapshot_json,
}
assert.equal(workerPayoutLedgerRow.status, 'pending')
assert.ok(workerPayoutLedgerRow.payout_eur > 0)

const failedRequest = { ok: false, totalTokens: 0, costEur: 0 }
const shouldCreateFailedPayout = failedRequest.ok && failedRequest.costEur > 0 && failedRequest.totalTokens > 0
assert.equal(shouldCreateFailedPayout, false)

console.log('money-path-test: ok')
