import assert from 'node:assert/strict'
import {
  computeBlendedPrice,
  computeRequestCost,
  splitLegacyBlendedPrice,
  validatePricingFloor,
} from '../src/pricing-engine.js'
import { slugifyModel } from '../src/pricing-models.js'

assert.equal(slugifyModel('Qwen/Qwen3.6-35B-A3B'), 'qwen-qwen3-6-35b-a3b')

const split = splitLegacyBlendedPrice(0.3, 0.75)
assert.ok(split.inputEurPerMillion > 0)
assert.ok(split.outputEurPerMillion > 0)

assert.equal(computeBlendedPrice(0.06, 0.12, 75), 0.075)

const qwenCost = computeRequestCost({
  modelPricing: { inputEurPerMillion: 0.06, outputEurPerMillion: 0.12, blendedInputRatioPercent: 75 },
  promptTokens: 1000,
  completionTokens: 500,
})
assert.equal(qwenCost.totalCostEur, 0.00012)

const floor = validatePricingFloor({
  inputEur: 0.02,
  outputEur: 0.06,
  workerSharePercent: 40,
  minVryxNetMarginPercent: 20,
})
assert.ok(Array.isArray(floor.warnings))

const lowMargin = validatePricingFloor({
  inputEur: 0.001,
  outputEur: 0.002,
  workerSharePercent: 60,
  minVryxNetMarginPercent: 20,
})
assert.ok(lowMargin.warnings.some((w) => w.code === 'low_margin' || w.code === 'below_worker_floor'))

console.log('pricing-models-api-test: ok')
