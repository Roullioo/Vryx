import assert from 'node:assert/strict'
import { computeEffectiveModelPrice, slugifyModel } from '../src/pricing-models.js'

assert.equal(slugifyModel('Qwen/Qwen3.6-35B-A3B'), 'qwen-qwen3-6-35b-a3b')
assert.equal(slugifyModel('  GLM 4.5 Air  '), 'glm-4-5-air')
assert.equal(slugifyModel(''), 'model')

const globalPricing = { defaultEurPerMillion: 0.3 }

assert.equal(computeEffectiveModelPrice(null, globalPricing), 0.3)
assert.equal(computeEffectiveModelPrice(0.42, globalPricing), 0.42)
assert.equal(computeEffectiveModelPrice(-1, globalPricing), 0.3)

const pricing = {
  defaultEurPerMillion: 0.3,
  pricingPublished: true,
  vatPercent: 20,
  workerRewardSharePercent: 58,
  volumeDiscounts: [
    { minMonthlyMillions: 100, discountPercent: 5 },
    { minMonthlyMillions: 500, discountPercent: 10 },
  ],
}

assert.equal(pricing.pricingPublished, true)
assert.equal(pricing.volumeDiscounts.at(-1).discountPercent, 10)
assert.equal(Number((pricing.defaultEurPerMillion * (1 - 0.1)).toFixed(4)), 0.27)
assert.equal(computeEffectiveModelPrice(null, pricing), 0.3)
assert.equal(computeEffectiveModelPrice(0.25, pricing), 0.25)

console.log('pricing-models-api-test: ok')
