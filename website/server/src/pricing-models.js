import {
  clampPercent,
  computeBlendedPrice,
  positiveNumber,
  resolveModelPricingFromRow,
  splitLegacyBlendedPrice,
  validatePricingFloor,
} from './pricing-engine.js'
import { getJsonCache, setJsonCache, delCache } from './cache.js'

const DEFAULT_VOLUME_DISCOUNTS = [
  { minMonthlyMillions: 100, discountPercent: 5 },
  { minMonthlyMillions: 500, discountPercent: 10 },
  { minMonthlyMillions: 2000, discountPercent: 18 },
]

const PRICING_TIER_SEED = [
  ['nano', 'Nano 0.5B-4B', 0.02, 0.06, 40, 10],
  ['small', 'Small 7B-12B', 0.05, 0.11, 45, 20],
  ['fast', 'Fast 20B-24B', 0.07, 0.20, 55, 30],
  ['core', 'Core 31B-35B', 0.16, 0.42, 60, 40],
  ['pro', 'Pro 70B-72B', 0.36, 0.58, 60, 50],
  ['moe', 'MoE 100B-250B', 0.22, 0.65, 60, 60],
  ['large_moe', 'Large MoE 300B+', 0.70, 1.90, 60, 70],
  ['code', 'Code / Reasoning', 0.55, 1.60, 60, 80],
]

const MODEL_PRICING_SEED = {
  'qwen2-0-5b-instruct': ['nano', 0.02, 0.06],
  'qwen3-5-9b': ['small', 0.06, 0.12],
  'codestral-22b': ['fast', 0.07, 0.20],
  'qwen3-32b': ['core', 0.16, 0.42],
  'gemma4-31b': ['core', 0.18, 0.46],
  'qwen3-6-35b-a3b': ['core', 0.18, 0.55],
  'llama-2-70b-hf': ['pro', 0.36, 0.58],
  'qwen2-5-72b-instruct': ['pro', 0.36, 0.62],
  'mixtral-8x22b-instruct': ['moe', 0.22, 0.65],
  'qwen3-235b-a22b': ['moe', 0.30, 0.90],
  'deepseek-r1': ['large_moe', 0.70, 1.90],
}

const SUBSCRIPTION_PLAN_SEED = [
  ['free', 'Free', 0, 'Crédits test limités', 10],
  ['developer', 'Developer', 19, 'API keys + logs', 20],
  ['pro', 'Pro', 49, 'Priorité légère', 30],
  ['team', 'Team', 199, 'Équipe + factures', 40],
  ['business', 'Business', 799, 'Support + quotas', 50],
  ['scale', 'Scale', 1990, 'SLA + remises', 60],
]

const PRIVATE_POOL_PLAN_SEED = [
  ['s', 'Private Pool S', 2500, 2, 2, 30, 10],
  ['m', 'Private Pool M', 5900, 5, 8, 30, 20],
  ['l', 'Private Pool L', 12000, 9, 16, 30, 30],
  ['xl', 'Private Pool XL', 0, 17, 999, 30, 40],
]

const FINETUNING_PLAN_SEED = [
  ['lora_small', 'LoRA Small', 1.5, 2500, 15000, 500, 3000, 10],
  ['lora_pro', 'LoRA Pro', 6, 5000, 25000, 1000, 5000, 20],
  ['lora_moe', 'LoRA MoE', 12, 8000, 40000, 2000, 8000, 30],
]

const PUBLIC_MODEL_SEED = [
  ['llama-4-scout', null, 'Llama 4 Scout', 'Meta', 'Llama', '17B actifs (MoE)', 10485760, ['Texte', 'Image'], true, null, 10],
  ['llama-4-maverick', null, 'Llama 4 Maverick', 'Meta', 'Llama', '17B actifs (MoE)', 1048576, ['Texte', 'Image'], true, null, 20],
  ['llama-3-1-405b', null, 'Llama 3.1 405B Instruct', 'Meta', 'Llama', '405B', 131072, ['Texte', 'Code'], true, null, 30],
  ['qwen3-235b-a22b', null, 'Qwen3-235B-A22B', 'Alibaba', 'Qwen', '235B (22B actifs)', 131072, ['Texte', 'Code', 'Raisonnement'], true, null, 40],
  ['qwen3-6-35b-a3b', 'Qwen/Qwen3.6-35B-A3B', 'Qwen3.6-35B-A3B', 'Alibaba', 'Qwen', '35B (3B actifs)', 262144, ['Texte', 'Code', 'Raisonnement', 'MoE'], true, 19, 50],
  ['qwen3-32b', null, 'Qwen3-32B', 'Alibaba', 'Qwen', '32B', 131072, ['Texte', 'Code'], true, null, 60],
  ['qwen2-5-72b-instruct', null, 'Qwen2.5-72B-Instruct', 'Alibaba', 'Qwen', '72B', 131072, ['Texte', 'Code'], true, null, 70],
  ['glm-5-1', null, 'GLM-5.1', 'Zhipu AI', 'GLM', 'N.C. (propriétaire)', 128000, ['Texte', 'Code', 'Raisonnement'], false, null, 80],
  ['glm-5', null, 'GLM-5', 'Zhipu AI', 'GLM', 'N.C. (propriétaire)', 128000, ['Texte', 'Code', 'Raisonnement'], false, null, 90],
  ['glm-4-5', null, 'GLM-4.5', 'Zhipu AI', 'GLM', '355B (32B actifs)', 128000, ['Texte', 'Code', 'Raisonnement', 'Agent'], true, null, 100],
  ['glm-4-5-air', null, 'GLM-4.5-Air', 'Zhipu AI', 'GLM', '106B (12B actifs)', 128000, ['Texte', 'Code', 'Raisonnement', 'Agent'], true, null, 110],
  ['glm-4-1v-thinking', null, 'GLM-4.1V-Thinking', 'Zhipu AI', 'GLM-V', '9B', 65536, ['Texte', 'Image', 'Vidéo', 'Raisonnement'], true, null, 120],
  ['deepseek-r1', null, 'DeepSeek-R1', 'DeepSeek', 'DeepSeek', '671B MoE', 128000, ['Texte', 'Raisonnement', 'Code'], true, null, 130],
  ['deepseek-v3', null, 'DeepSeek-V3', 'DeepSeek', 'DeepSeek', '671B MoE', 128000, ['Texte', 'Code'], true, null, 140],
  ['deepseek-v2-5', null, 'DeepSeek-V2.5', 'DeepSeek', 'DeepSeek', '236B MoE', 128000, ['Texte', 'Code'], true, null, 150],
  ['mixtral-8x22b-instruct', null, 'Mixtral 8x22B Instruct', 'Mistral AI', 'Mixtral', '141B MoE', 65536, ['Texte', 'Code'], true, null, 160],
  ['codestral-22b', null, 'Codestral 22B', 'Mistral AI', 'Codestral', '22B', 256000, ['Texte', 'Code'], true, null, 170],
  ['mistral-large-2', null, 'Mistral Large 2', 'Mistral AI', 'Mistral', '123B', 131072, ['Texte', 'Code'], false, null, 180],
  ['gemma-3-27b-it', null, 'Gemma 3 27B IT', 'Google', 'Gemma', '27B', 131072, ['Texte', 'Image'], true, null, 190],
  ['gemma-3-12b-it', null, 'Gemma 3 12B IT', 'Google', 'Gemma', '12B', 131072, ['Texte', 'Image'], true, null, 200],
  ['phi-4', null, 'Phi-4', 'Microsoft', 'Phi', '14B', 16384, ['Texte', 'Code'], true, null, 210],
  ['phi-4-multimodal', null, 'Phi-4 Multimodal', 'Microsoft', 'Phi', '5.6B', 128000, ['Texte', 'Image', 'Audio'], true, null, 220],
  ['nemotron-4-340b', null, 'Nemotron-4 340B Instruct', 'NVIDIA', 'Nemotron', '340B', 128000, ['Texte', 'Code'], true, null, 230],
  ['qwen3-5-9b', 'Qwen/Qwen3.5-9B', 'Qwen3.5 9B', 'Alibaba', 'Qwen', '9B', 131072, ['Texte', 'Code', 'Raisonnement'], true, 6, 240],
  ['qwen2-0-5b-instruct', 'Qwen/Qwen2-0.5B-Instruct', 'Qwen2 0.5B Instruct', 'Alibaba', 'Qwen', '0.5B', 32768, ['Texte', 'Code'], true, 2, 250],
  ['llama-2-70b-hf', 'meta-llama/Llama-2-70b-hf', 'Llama 2 70B', 'Meta', 'Llama', '70B', 4096, ['Texte'], true, 39.2, 260],
  ['gemma4-31b', 'gemma4:31b', 'Gemma 4 31B', 'Google', 'Gemma', '31B', 131072, ['Texte'], true, null, 270],
]

export function slugifyModel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'model'
}

function parseJsonList(value, fallback = []) {
  if (Array.isArray(value)) return value
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

async function ensureColumn(pool, table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { table, column },
  )
  if (Number(rows[0]?.c || 0) === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

function pricingRowToDto(row, fallbackEnv) {
  const ratio = clampPercent(row?.blended_input_ratio_percent, 75)
  const minInput = positiveNumber(row?.min_input_eur_per_million, 0.02)
  const minOutput = positiveNumber(row?.min_output_eur_per_million, 0.06)
  const legacyDefault = positiveNumber(row?.default_eur_per_million, fallbackEnv.eurPerMillion)
  const blendedLegacy = computeBlendedPrice(minInput, minOutput, ratio)
  const published = row ? Boolean(row.pricing_published) : false
  return {
    defaultEurPerMillion: legacyDefault,
    pricingPublished: published,
    vatPercent: clampPercent(row?.vat_percent, 20),
    workerRewardSharePercent: clampPercent(row?.worker_reward_share_percent, fallbackEnv.workerRewardSharePercent),
    defaultWorkerSharePercent: clampPercent(row?.default_worker_share_percent, 60),
    estimatedGrossMarginPercent: clampPercent(fallbackEnv.grossMarginPercent, 72),
    volumeDiscounts: parseJsonList(row?.volume_discount_json, DEFAULT_VOLUME_DISCOUNTS),
    headline: {
      minInputEurPerMillion: minInput,
      minOutputEurPerMillion: minOutput,
    },
    blendedInputRatioPercent: ratio,
    recharge: {
      minEur: positiveNumber(row?.stripe_min_recharge_eur, 20),
      recommendedEur: positiveNumber(row?.stripe_recommended_recharge_eur, 50),
      b2bMinEur: positiveNumber(row?.b2b_min_recharge_eur, 250),
      packagesEur: parseJsonList(row?.stripe_packages_json, [20, 50, 100, 250, 500, 2000]),
    },
    privatePoolTokenDiscountPercent: clampPercent(row?.private_pool_token_discount_percent, 30),
    minVryxNetMarginPercent: clampPercent(row?.min_vryx_net_margin_percent, 20),
    /** @deprecated blended headline */
    eurPerMillionTokens: published ? blendedLegacy : null,
    updatedAt: row?.updated_at ?? null,
    updatedByUserId: row?.updated_by_user_id ?? null,
    updatedByEmail: row?.updated_by_email ?? null,
  }
}

function tierRowToDto(row) {
  return {
    slug: row.slug,
    label: row.label,
    defaultInputEurPerMillion: Number(row.default_input_eur_per_million),
    defaultOutputEurPerMillion: Number(row.default_output_eur_per_million),
    defaultWorkerSharePercent: clampPercent(row.default_worker_share_percent, 60),
    sortOrder: Number(row.sort_order || 0),
  }
}

function subscriptionPlanToDto(row) {
  return {
    slug: row.slug,
    name: row.name,
    monthlyEur: Number(row.monthly_eur),
    description: row.description || '',
    isPublic: Boolean(row.is_public),
    sortOrder: Number(row.sort_order || 0),
  }
}

function privatePoolPlanToDto(row) {
  return {
    slug: row.slug,
    name: row.name,
    monthlyEur: Number(row.monthly_eur),
    workerCountMin: Number(row.worker_count_min || 0),
    workerCountMax: Number(row.worker_count_max || 0),
    tokenDiscountPercent: clampPercent(row.token_discount_percent, 30),
    isPublic: Boolean(row.is_public),
    sortOrder: Number(row.sort_order || 0),
    updatedAt: row.updated_at ?? null,
    updatedByUserId: row.updated_by_user_id ?? null,
    updatedByEmail: row.updated_by_email ?? null,
  }
}

function fineTuningPlanToDto(row) {
  return {
    slug: row.slug,
    name: row.name,
    eurPerMillionTraining: Number(row.eur_per_million_training),
    setupMinEur: Number(row.setup_min_eur || 0),
    setupMaxEur: Number(row.setup_max_eur || 0),
    deploymentMonthlyMinEur: Number(row.deployment_monthly_min_eur || 0),
    deploymentMonthlyMaxEur: Number(row.deployment_monthly_max_eur || 0),
    isPublic: Boolean(row.is_public),
    sortOrder: Number(row.sort_order || 0),
  }
}

export function computeEffectiveModelPrice(modelOverrideEur, pricing) {
  const override = modelOverrideEur == null ? null : Number(modelOverrideEur)
  if (override != null && Number.isFinite(override) && override > 0) return override
  const h = pricing?.headline
  if (h) return computeBlendedPrice(h.minInputEurPerMillion, h.minOutputEurPerMillion, pricing.blendedInputRatioPercent ?? 75)
  return positiveNumber(pricing?.defaultEurPerMillion, 0.3)
}

function normalizeModelRow(row, globalConfig, tierMap) {
  const modalities = parseJsonList(row.modalities_json, [])
  const modelPricing = resolveModelPricingFromRow(row, globalConfig, tierMap)
  const floor = validatePricingFloor({
    inputEur: modelPricing.inputEurPerMillion,
    outputEur: modelPricing.outputEurPerMillion,
    workerSharePercent: modelPricing.workerSharePercent,
    estimatedWorkerCostInput: modelPricing.estimatedWorkerCostInput,
    estimatedWorkerCostOutput: modelPricing.estimatedWorkerCostOutput,
    minVryxNetMarginPercent: modelPricing.minVryxMarginPercent,
    blendedInputRatioPercent: globalConfig.blendedInputRatioPercent ?? 75,
  })
  return {
    slug: row.slug,
    id: row.hf_id || row.slug,
    hfId: row.hf_id || null,
    apiAlias: row.api_alias || null,
    name: row.name,
    provider: row.provider,
    family: row.family,
    paramsNote: row.params_note || '',
    contextTokens: Number(row.context_tokens || 0),
    modalities,
    openWeights: Boolean(row.open_weights),
    weightGb: row.weight_gb == null ? null : Number(row.weight_gb),
    pricingTier: modelPricing.tier,
    pricing: {
      inputEurPerMillion: modelPricing.inputEurPerMillion,
      outputEurPerMillion: modelPricing.outputEurPerMillion,
      blendedEurPerMillion: modelPricing.blendedEurPerMillion,
      privatePoolInputEurPerMillion: modelPricing.privatePoolInputEurPerMillion,
      privatePoolOutputEurPerMillion: modelPricing.privatePoolOutputEurPerMillion,
      workerSharePercent: modelPricing.workerSharePercent,
      tier: modelPricing.tier,
    },
    eurPerMillion: row.eur_per_million == null ? null : Number(row.eur_per_million),
    effectiveEurPerMillion: modelPricing.blendedEurPerMillion,
    eurPerMillionInput: modelPricing.inputEurPerMillion,
    eurPerMillionOutput: modelPricing.outputEurPerMillion,
    workerSharePercent: modelPricing.workerSharePercent,
    estimatedWorkerCostInput: modelPricing.estimatedWorkerCostInput,
    estimatedWorkerCostOutput: modelPricing.estimatedWorkerCostOutput,
    minVryxMarginPercent: modelPricing.minVryxMarginPercent,
    eurPerMillionCachedInput: row.eur_per_million_cached_input == null ? null : Number(row.eur_per_million_cached_input),
    eurPerMillionBatchInput: row.eur_per_million_batch_input == null ? null : Number(row.eur_per_million_batch_input),
    eurPerMillionBatchOutput: row.eur_per_million_batch_output == null ? null : Number(row.eur_per_million_batch_output),
    privatePoolInputEurPerMillion: modelPricing.privatePoolInputEurPerMillion,
    privatePoolOutputEurPerMillion: modelPricing.privatePoolOutputEurPerMillion,
    availabilityStatus: row.availability_status || 'available',
    marginPreview: floor.preview,
    pricingWarnings: floor.warnings,
    isActive: Boolean(row.is_active),
    isPublic: Boolean(row.is_public),
    minVramMb: row.min_vram_mb == null ? null : Number(row.min_vram_mb),
    requiredWorkers: Number(row.required_workers || 1),
    sortOrder: Number(row.sort_order || 0),
    updatedAt: row.updated_at ?? null,
    updatedByUserId: row.updated_by_user_id ?? null,
    updatedByEmail: row.updated_by_email ?? null,
  }
}

async function writePricingAudit(pool, entityType, entityId, beforeValue, afterValue, userId = null) {
  await pool.query(`
    INSERT INTO pricing_config_audit (entity_type, entity_id, before_json, after_json, updated_by_user_id)
    VALUES (:entityType, :entityId, :beforeJson, :afterJson, :userId)
  `, {
    entityType,
    entityId,
    beforeJson: beforeValue == null ? null : JSON.stringify(beforeValue),
    afterJson: afterValue == null ? null : JSON.stringify(afterValue),
    userId,
  })
}

export async function ensurePricingAndModelCatalogTables(pool, fallbackEnv) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_config (
      id TINYINT UNSIGNED NOT NULL,
      default_eur_per_million DECIMAL(12,6) NOT NULL DEFAULT 0,
      pricing_published TINYINT(1) NOT NULL DEFAULT 0,
      vat_percent DECIMAL(6,3) NOT NULL DEFAULT 20,
      worker_reward_share_percent DECIMAL(6,3) NOT NULL DEFAULT 58,
      volume_discount_json LONGTEXT NULL,
      updated_by_user_id BIGINT UNSIGNED NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  const pricingConfigColumns = [
    ['min_input_eur_per_million', 'DECIMAL(12,6) NOT NULL DEFAULT 0.02'],
    ['min_output_eur_per_million', 'DECIMAL(12,6) NOT NULL DEFAULT 0.06'],
    ['blended_input_ratio_percent', 'DECIMAL(6,3) NOT NULL DEFAULT 75'],
    ['stripe_min_recharge_eur', 'DECIMAL(10,2) NOT NULL DEFAULT 20'],
    ['stripe_recommended_recharge_eur', 'DECIMAL(10,2) NOT NULL DEFAULT 50'],
    ['b2b_min_recharge_eur', 'DECIMAL(10,2) NOT NULL DEFAULT 250'],
    ['stripe_packages_json', 'LONGTEXT NULL'],
    ['default_worker_share_percent', 'DECIMAL(6,3) NOT NULL DEFAULT 60'],
    ['min_vryx_net_margin_percent', 'DECIMAL(6,3) NOT NULL DEFAULT 20'],
    ['private_pool_token_discount_percent', 'DECIMAL(6,3) NOT NULL DEFAULT 30'],
  ]
  for (const [col, def] of pricingConfigColumns) {
    await ensureColumn(pool, 'pricing_config', col, def)
  }

  await pool.query(`
    INSERT INTO pricing_config
      (id, default_eur_per_million, pricing_published, vat_percent, worker_reward_share_percent,
       volume_discount_json, min_input_eur_per_million, min_output_eur_per_million,
       blended_input_ratio_percent, stripe_min_recharge_eur, stripe_recommended_recharge_eur,
       b2b_min_recharge_eur, stripe_packages_json, default_worker_share_percent,
       min_vryx_net_margin_percent, private_pool_token_discount_percent)
    VALUES (1, :eurPerMillion, 1, 20, :workerRewardSharePercent, :volumeDiscounts,
            0.02, 0.06, 75, 20, 50, 250, :packages, 60, 20, 30)
    ON DUPLICATE KEY UPDATE id = id
  `, {
    eurPerMillion: fallbackEnv.eurPerMillion,
    workerRewardSharePercent: fallbackEnv.workerRewardSharePercent,
    volumeDiscounts: JSON.stringify(DEFAULT_VOLUME_DISCOUNTS),
    packages: JSON.stringify([20, 50, 100, 250, 500, 2000]),
  })

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_tiers (
      slug VARCHAR(40) NOT NULL,
      label VARCHAR(120) NOT NULL,
      default_input_eur_per_million DECIMAL(12,6) NOT NULL,
      default_output_eur_per_million DECIMAL(12,6) NOT NULL,
      default_worker_share_percent DECIMAL(6,3) NOT NULL DEFAULT 60,
      sort_order INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  for (const [slug, label, inputEur, outputEur, workerShare, sortOrder] of PRICING_TIER_SEED) {
    await pool.query(`
      INSERT INTO pricing_tiers (slug, label, default_input_eur_per_million, default_output_eur_per_million, default_worker_share_percent, sort_order)
      VALUES (:slug, :label, :inputEur, :outputEur, :workerShare, :sortOrder)
      ON DUPLICATE KEY UPDATE
        label = VALUES(label),
        default_input_eur_per_million = VALUES(default_input_eur_per_million),
        default_output_eur_per_million = VALUES(default_output_eur_per_million),
        default_worker_share_percent = VALUES(default_worker_share_percent),
        sort_order = VALUES(sort_order)
    `, { slug, label, inputEur, outputEur, workerShare, sortOrder })
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      slug VARCHAR(40) NOT NULL,
      name VARCHAR(120) NOT NULL,
      monthly_eur DECIMAL(10,2) NOT NULL DEFAULT 0,
      description VARCHAR(500) NULL,
      is_public TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  for (const [slug, name, monthlyEur, description, sortOrder] of SUBSCRIPTION_PLAN_SEED) {
    await pool.query(`
      INSERT INTO subscription_plans (slug, name, monthly_eur, description, is_public, sort_order)
      VALUES (:slug, :name, :monthlyEur, :description, 1, :sortOrder)
      ON DUPLICATE KEY UPDATE name = VALUES(name), monthly_eur = VALUES(monthly_eur), description = VALUES(description)
    `, { slug, name, monthlyEur, description, sortOrder })
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS private_pool_plans (
      slug VARCHAR(40) NOT NULL,
      name VARCHAR(120) NOT NULL,
      monthly_eur DECIMAL(10,2) NOT NULL DEFAULT 0,
      worker_count_min INT UNSIGNED NOT NULL DEFAULT 0,
      worker_count_max INT UNSIGNED NOT NULL DEFAULT 0,
      token_discount_percent DECIMAL(6,3) NOT NULL DEFAULT 30,
      is_public TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await ensureColumn(pool, 'private_pool_plans', 'updated_by_user_id', 'BIGINT UNSIGNED NULL')

  for (const [slug, name, monthlyEur, workerMin, workerMax, discount, sortOrder] of PRIVATE_POOL_PLAN_SEED) {
    await pool.query(`
      INSERT INTO private_pool_plans (slug, name, monthly_eur, worker_count_min, worker_count_max, token_discount_percent, is_public, sort_order)
      VALUES (:slug, :name, :monthlyEur, :workerMin, :workerMax, :discount, 1, :sortOrder)
      ON DUPLICATE KEY UPDATE name = VALUES(name), monthly_eur = VALUES(monthly_eur)
    `, { slug, name, monthlyEur, workerMin, workerMax, discount, sortOrder })
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fine_tuning_plans (
      slug VARCHAR(40) NOT NULL,
      name VARCHAR(120) NOT NULL,
      eur_per_million_training DECIMAL(12,6) NOT NULL,
      setup_min_eur DECIMAL(10,2) NOT NULL DEFAULT 0,
      setup_max_eur DECIMAL(10,2) NOT NULL DEFAULT 0,
      deployment_monthly_min_eur DECIMAL(10,2) NOT NULL DEFAULT 0,
      deployment_monthly_max_eur DECIMAL(10,2) NOT NULL DEFAULT 0,
      is_public TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  for (const row of FINETUNING_PLAN_SEED) {
    const [slug, name, trainEur, setupMin, setupMax, deployMin, deployMax, sortOrder] = row
    await pool.query(`
      INSERT INTO fine_tuning_plans
        (slug, name, eur_per_million_training, setup_min_eur, setup_max_eur, deployment_monthly_min_eur, deployment_monthly_max_eur, is_public, sort_order)
      VALUES (:slug, :name, :trainEur, :setupMin, :setupMax, :deployMin, :deployMax, 1, :sortOrder)
      ON DUPLICATE KEY UPDATE name = VALUES(name), eur_per_million_training = VALUES(eur_per_million_training)
    `, { slug, name, trainEur, setupMin, setupMax, deployMin, deployMax, sortOrder })
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_config_audit (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      entity_type VARCHAR(40) NOT NULL,
      entity_id VARCHAR(120) NOT NULL,
      before_json LONGTEXT NULL,
      after_json LONGTEXT NULL,
      updated_by_user_id BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_pricing_audit_entity (entity_type, entity_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_catalog (
      slug VARCHAR(120) NOT NULL,
      hf_id VARCHAR(180) NULL,
      name VARCHAR(180) NOT NULL,
      provider VARCHAR(100) NOT NULL,
      family VARCHAR(100) NOT NULL,
      params_note VARCHAR(120) NULL,
      context_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
      modalities_json LONGTEXT NULL,
      open_weights TINYINT(1) NOT NULL DEFAULT 1,
      weight_gb DECIMAL(10,3) NULL,
      eur_per_million DECIMAL(12,6) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      is_public TINYINT(1) NOT NULL DEFAULT 1,
      min_vram_mb INT UNSIGNED NULL,
      required_workers INT UNSIGNED NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (slug),
      UNIQUE KEY uq_model_catalog_hf_id (hf_id),
      KEY idx_model_catalog_public_active (is_public, is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  const modelColumns = [
    ['pricing_tier', "VARCHAR(40) NOT NULL DEFAULT 'core'"],
    ['eur_per_million_input', 'DECIMAL(12,6) NULL'],
    ['eur_per_million_output', 'DECIMAL(12,6) NULL'],
    ['eur_per_million_cached_input', 'DECIMAL(12,6) NULL'],
    ['eur_per_million_batch_input', 'DECIMAL(12,6) NULL'],
    ['eur_per_million_batch_output', 'DECIMAL(12,6) NULL'],
    ['private_pool_input_eur_per_million', 'DECIMAL(12,6) NULL'],
    ['private_pool_output_eur_per_million', 'DECIMAL(12,6) NULL'],
    ['worker_share_percent', 'DECIMAL(6,3) NULL'],
    ['estimated_worker_cost_input', 'DECIMAL(12,6) NULL'],
    ['estimated_worker_cost_output', 'DECIMAL(12,6) NULL'],
    ['min_vryx_margin_percent', 'DECIMAL(6,3) NULL'],
    ['availability_status', "VARCHAR(24) NOT NULL DEFAULT 'available'"],
    ['api_alias', 'VARCHAR(120) NULL'],
    ['updated_by_user_id', 'BIGINT UNSIGNED NULL'],
  ]
  for (const [col, def] of modelColumns) {
    await ensureColumn(pool, 'model_catalog', col, def)
  }

  for (const row of PUBLIC_MODEL_SEED) {
    const [slug, hfId, name, provider, family, paramsNote, contextTokens, modalities, openWeights, weightGb, sortOrder] = row
    await pool.query(`
      INSERT INTO model_catalog
        (slug, hf_id, name, provider, family, params_note, context_tokens, modalities_json,
         open_weights, weight_gb, is_active, is_public, sort_order)
      VALUES
        (:slug, :hfId, :name, :provider, :family, :paramsNote, :contextTokens, :modalitiesJson,
         :openWeights, :weightGb, 1, 1, :sortOrder)
      ON DUPLICATE KEY UPDATE
        hf_id = COALESCE(model_catalog.hf_id, VALUES(hf_id)),
        name = IF(model_catalog.name = '' OR model_catalog.name IS NULL, VALUES(name), model_catalog.name),
        provider = IF(model_catalog.provider = '' OR model_catalog.provider IS NULL, VALUES(provider), model_catalog.provider),
        family = IF(model_catalog.family = '' OR model_catalog.family IS NULL, VALUES(family), model_catalog.family),
        params_note = IF(model_catalog.params_note IS NULL OR model_catalog.params_note = '', VALUES(params_note), model_catalog.params_note),
        context_tokens = IF(model_catalog.context_tokens = 0, VALUES(context_tokens), model_catalog.context_tokens),
        modalities_json = IF(model_catalog.modalities_json IS NULL, VALUES(modalities_json), model_catalog.modalities_json),
        open_weights = model_catalog.open_weights,
        weight_gb = COALESCE(model_catalog.weight_gb, VALUES(weight_gb)),
        sort_order = IF(model_catalog.sort_order = 0, VALUES(sort_order), model_catalog.sort_order)
    `, {
      slug, hfId, name, provider, family, paramsNote, contextTokens,
      modalitiesJson: JSON.stringify(modalities), openWeights: openWeights ? 1 : 0, weightGb, sortOrder,
    })
  }

  // Migrate legacy eur_per_million -> in/out split where missing
  await pool.query(`
    UPDATE model_catalog
    SET
      eur_per_million_input = COALESCE(eur_per_million_input, eur_per_million * 0.75 * (4/3)),
      eur_per_million_output = COALESCE(eur_per_million_output, eur_per_million * 0.25 * 4)
    WHERE eur_per_million IS NOT NULL AND eur_per_million > 0
      AND (eur_per_million_input IS NULL OR eur_per_million_output IS NULL)
  `)

  for (const [slug, [tier, inputEur, outputEur]] of Object.entries(MODEL_PRICING_SEED)) {
    await pool.query(`
      UPDATE model_catalog
      SET pricing_tier = :tier,
          eur_per_million_input = :inputEur,
          eur_per_million_output = :outputEur,
          api_alias = COALESCE(api_alias, :apiAlias)
      WHERE slug = :slug
        AND (eur_per_million_input IS NULL OR eur_per_million_input = 0 OR slug IN (:slug))
    `, { slug, tier, inputEur, outputEur, apiAlias: slug })
  }
}

let pricingCache = null
let pricingCacheUntil = 0
let tiersCache = null
let tiersCacheUntil = 0

export function invalidatePricingCache() {
  pricingCache = null
  pricingCacheUntil = 0
  tiersCache = null
  tiersCacheUntil = 0
  delCache('pricing:*').catch((e) => console.warn('[redis] pricing cache invalidation skipped', e?.message || e))
}

export async function getPricingTiers(pool, { force = false } = {}) {
  const now = Date.now()
  if (!force && tiersCache && tiersCacheUntil > now) return tiersCache
  if (!force) {
    const cached = await getJsonCache('pricing:tiers:v1')
    if (cached) {
      tiersCache = cached
      tiersCacheUntil = now + 30_000
      return tiersCache
    }
  }
  const [rows] = await pool.query('SELECT * FROM pricing_tiers ORDER BY sort_order ASC')
  tiersCache = rows.map(tierRowToDto)
  tiersCacheUntil = now + 30_000
  await setJsonCache('pricing:tiers:v1', tiersCache, 60)
  return tiersCache
}

export async function getSubscriptionPlans(pool) {
  const [rows] = await pool.query('SELECT * FROM subscription_plans WHERE is_public = 1 ORDER BY sort_order ASC')
  return rows.map(subscriptionPlanToDto)
}

export async function getPrivatePoolPlans(pool) {
  const [rows] = await pool.query('SELECT * FROM private_pool_plans WHERE is_public = 1 ORDER BY sort_order ASC')
  return rows.map(privatePoolPlanToDto)
}

export async function getFineTuningPlans(pool) {
  const [rows] = await pool.query('SELECT * FROM fine_tuning_plans WHERE is_public = 1 ORDER BY sort_order ASC')
  return rows.map(fineTuningPlanToDto)
}

export async function getAllSubscriptionPlans(pool) {
  const [rows] = await pool.query('SELECT * FROM subscription_plans ORDER BY sort_order ASC')
  return rows.map(subscriptionPlanToDto)
}

export async function getAllPrivatePoolPlans(pool) {
  const [rows] = await pool.query(`
    SELECT p.*, u.email AS updated_by_email
    FROM private_pool_plans p
    LEFT JOIN users u ON u.id = p.updated_by_user_id
    ORDER BY p.sort_order ASC
  `)
  return rows.map(privatePoolPlanToDto)
}

export async function getAllFineTuningPlans(pool) {
  const [rows] = await pool.query('SELECT * FROM fine_tuning_plans ORDER BY sort_order ASC')
  return rows.map(fineTuningPlanToDto)
}

export async function getPricingConfig(pool, fallbackEnv, { force = false } = {}) {
  const now = Date.now()
  if (!force && pricingCache && pricingCacheUntil > now) return pricingCache
  if (!force) {
    const cached = await getJsonCache('pricing:config:v1')
    if (cached) {
      pricingCache = cached
      pricingCacheUntil = now + 30_000
      return pricingCache
    }
  }
  const [rows] = await pool.query(`
    SELECT c.*, u.email AS updated_by_email
    FROM pricing_config c
    LEFT JOIN users u ON u.id = c.updated_by_user_id
    WHERE c.id = 1
    LIMIT 1
  `)
  pricingCache = pricingRowToDto(rows[0], fallbackEnv)
  pricingCacheUntil = now + 30_000
  await setJsonCache('pricing:config:v1', pricingCache, 60)
  return pricingCache
}

export async function getEffectivePricing(pool, fallbackEnv, opts) {
  return getPricingConfig(pool, fallbackEnv, opts)
}

export async function getPublicPricingBundle(pool, fallbackEnv) {
  const [pricing, tiers, subscriptionPlans, privatePoolPlans, fineTuningPlans] = await Promise.all([
    getPricingConfig(pool, fallbackEnv),
    getPricingTiers(pool),
    getSubscriptionPlans(pool),
    getPrivatePoolPlans(pool),
    getFineTuningPlans(pool),
  ])
  return { pricing, tiers, subscriptionPlans, privatePoolPlans, fineTuningPlans }
}

export async function getPricingAudit(pool, { limit = 80 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 80)))
  const [rows] = await pool.query(`
    SELECT a.*, u.email AS updated_by_email
    FROM pricing_config_audit a
    LEFT JOIN users u ON u.id = a.updated_by_user_id
    ORDER BY a.created_at DESC
    LIMIT ${safeLimit}
  `)
  return rows.map((row) => ({
    id: Number(row.id),
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
    updatedByUserId: row.updated_by_user_id ?? null,
    updatedByEmail: row.updated_by_email ?? null,
    createdAt: row.created_at,
  }))
}

async function buildTierMap(pool) {
  const tiers = await getPricingTiers(pool)
  return new Map(tiers.map((t) => [t.slug, t]))
}

export async function resolveModelPricingByKey(pool, fallbackEnv, modelKey, billingMode = 'public') {
  const key = String(modelKey || '').trim()
  if (!key) return null
  const [rows] = await pool.query(`
    SELECT * FROM model_catalog
    WHERE slug = :key OR hf_id = :key OR api_alias = :key
    LIMIT 1
  `, { key, key, key })
  if (!rows[0]) return null
  const globalConfig = await getPricingConfig(pool, fallbackEnv)
  const tierMap = await buildTierMap(pool)
  const normalized = normalizeModelRow(rows[0], globalConfig, tierMap)
  return { ...normalized, billingMode }
}

export async function getPublicModels(pool, fallbackEnv, { includeInactive = false, includePrivate = false, includeModifierDetails = false } = {}) {
  const globalConfig = await getPricingConfig(pool, fallbackEnv)
  const tierMap = await buildTierMap(pool)
  const clauses = []
  if (!includeInactive) clauses.push('m.is_active = 1')
  if (!includePrivate) clauses.push('m.is_public = 1')
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const select = includeModifierDetails
    ? 'SELECT m.*, u.email AS updated_by_email FROM model_catalog m LEFT JOIN users u ON u.id = m.updated_by_user_id'
    : 'SELECT m.* FROM model_catalog m'
  const [rows] = await pool.query(`${select} ${where} ORDER BY m.sort_order ASC, m.name ASC`)
  return rows.map((row) => normalizeModelRow(row, globalConfig, tierMap))
}

export async function updatePricingConfig(pool, input, fallbackEnv, userId = null) {
  const current = await getPricingConfig(pool, fallbackEnv, { force: true })
  const next = {
    defaultEurPerMillion: positiveNumber(input.defaultEurPerMillion, current.defaultEurPerMillion),
    pricingPublished: input.pricingPublished !== undefined ? Boolean(input.pricingPublished) : current.pricingPublished,
    vatPercent: clampPercent(input.vatPercent, current.vatPercent),
    workerRewardSharePercent: clampPercent(input.workerRewardSharePercent, current.workerRewardSharePercent),
    defaultWorkerSharePercent: clampPercent(input.defaultWorkerSharePercent, current.defaultWorkerSharePercent ?? 60),
    volumeDiscounts: Array.isArray(input.volumeDiscounts) ? input.volumeDiscounts : current.volumeDiscounts,
    headline: {
      minInputEurPerMillion: positiveNumber(input.headline?.minInputEurPerMillion ?? input.minInputEurPerMillion, current.headline?.minInputEurPerMillion ?? 0.02),
      minOutputEurPerMillion: positiveNumber(input.headline?.minOutputEurPerMillion ?? input.minOutputEurPerMillion, current.headline?.minOutputEurPerMillion ?? 0.06),
    },
    blendedInputRatioPercent: clampPercent(input.blendedInputRatioPercent, current.blendedInputRatioPercent ?? 75),
    recharge: {
      minEur: positiveNumber(input.recharge?.minEur ?? input.stripeMinRechargeEur, current.recharge?.minEur ?? 20),
      recommendedEur: positiveNumber(input.recharge?.recommendedEur ?? input.stripeRecommendedRechargeEur, current.recharge?.recommendedEur ?? 50),
      b2bMinEur: positiveNumber(input.recharge?.b2bMinEur ?? input.b2bMinRechargeEur, current.recharge?.b2bMinEur ?? 250),
      packagesEur: Array.isArray(input.recharge?.packagesEur) ? input.recharge.packagesEur : current.recharge?.packagesEur,
    },
    privatePoolTokenDiscountPercent: clampPercent(input.privatePoolTokenDiscountPercent, current.privatePoolTokenDiscountPercent ?? 30),
    minVryxNetMarginPercent: clampPercent(input.minVryxNetMarginPercent, current.minVryxNetMarginPercent ?? 20),
  }
  await pool.query(`
    UPDATE pricing_config SET
      default_eur_per_million = :defaultEurPerMillion,
      pricing_published = :pricingPublished,
      vat_percent = :vatPercent,
      worker_reward_share_percent = :workerRewardSharePercent,
      default_worker_share_percent = :defaultWorkerSharePercent,
      volume_discount_json = :volumeDiscounts,
      min_input_eur_per_million = :minInput,
      min_output_eur_per_million = :minOutput,
      blended_input_ratio_percent = :blendedRatio,
      stripe_min_recharge_eur = :stripeMin,
      stripe_recommended_recharge_eur = :stripeRecommended,
      b2b_min_recharge_eur = :b2bMin,
      stripe_packages_json = :packages,
      private_pool_token_discount_percent = :poolDiscount,
      min_vryx_net_margin_percent = :minMargin,
      updated_by_user_id = :userId
    WHERE id = 1
  `, {
    defaultEurPerMillion: next.defaultEurPerMillion,
    pricingPublished: next.pricingPublished ? 1 : 0,
    vatPercent: next.vatPercent,
    workerRewardSharePercent: next.workerRewardSharePercent,
    defaultWorkerSharePercent: next.defaultWorkerSharePercent,
    volumeDiscounts: JSON.stringify(next.volumeDiscounts),
    minInput: next.headline.minInputEurPerMillion,
    minOutput: next.headline.minOutputEurPerMillion,
    blendedRatio: next.blendedInputRatioPercent,
    stripeMin: next.recharge.minEur,
    stripeRecommended: next.recharge.recommendedEur,
    b2bMin: next.recharge.b2bMinEur,
    packages: JSON.stringify(next.recharge.packagesEur),
    poolDiscount: next.privatePoolTokenDiscountPercent,
    minMargin: next.minVryxNetMarginPercent,
    userId,
  })
  invalidatePricingCache()
  const updated = await getPricingConfig(pool, fallbackEnv, { force: true })
  await writePricingAudit(pool, 'pricing_config', 'global', current, updated, userId)
  return updated
}

export async function upsertPricingTier(pool, input) {
  const slug = slugifyModel(input.slug)
  await pool.query(`
    INSERT INTO pricing_tiers (slug, label, default_input_eur_per_million, default_output_eur_per_million, default_worker_share_percent, sort_order)
    VALUES (:slug, :label, :inputEur, :outputEur, :workerShare, :sortOrder)
    ON DUPLICATE KEY UPDATE
      label = VALUES(label),
      default_input_eur_per_million = VALUES(default_input_eur_per_million),
      default_output_eur_per_million = VALUES(default_output_eur_per_million),
      default_worker_share_percent = VALUES(default_worker_share_percent),
      sort_order = VALUES(sort_order)
  `, {
    slug,
    label: String(input.label || slug),
    inputEur: positiveNumber(input.defaultInputEurPerMillion, 0.16),
    outputEur: positiveNumber(input.defaultOutputEurPerMillion, 0.42),
    workerShare: clampPercent(input.defaultWorkerSharePercent, 60),
    sortOrder: Math.floor(Number(input.sortOrder || 0)),
  })
  invalidatePricingCache()
  return slug
}

export async function upsertSubscriptionPlan(pool, input) {
  const slug = slugifyModel(input.slug)
  await pool.query(`
    INSERT INTO subscription_plans (slug, name, monthly_eur, description, is_public, sort_order)
    VALUES (:slug, :name, :monthlyEur, :description, :isPublic, :sortOrder)
    ON DUPLICATE KEY UPDATE name = VALUES(name), monthly_eur = VALUES(monthly_eur), description = VALUES(description), is_public = VALUES(is_public), sort_order = VALUES(sort_order)
  `, {
    slug, name: input.name, monthlyEur: Number(input.monthlyEur || 0), description: input.description || null,
    isPublic: input.isPublic === false ? 0 : 1, sortOrder: Math.floor(Number(input.sortOrder || 0)),
  })
  return slug
}

export async function upsertPrivatePoolPlan(pool, input, userId = null) {
  const slug = slugifyModel(input.slug)
  const [beforeRows] = await pool.query('SELECT * FROM private_pool_plans WHERE slug = :slug LIMIT 1', { slug })
  await pool.query(`
    INSERT INTO private_pool_plans (slug, name, monthly_eur, worker_count_min, worker_count_max, token_discount_percent, is_public, sort_order, updated_by_user_id)
    VALUES (:slug, :name, :monthlyEur, :workerMin, :workerMax, :discount, :isPublic, :sortOrder, :userId)
    ON DUPLICATE KEY UPDATE name = VALUES(name), monthly_eur = VALUES(monthly_eur), worker_count_min = VALUES(worker_count_min),
      worker_count_max = VALUES(worker_count_max), token_discount_percent = VALUES(token_discount_percent), is_public = VALUES(is_public),
      sort_order = VALUES(sort_order), updated_by_user_id = :userId
  `, {
    slug, name: input.name, monthlyEur: Number(input.monthlyEur || 0),
    workerMin: Math.max(0, Math.floor(Number(input.workerCountMin || 0))),
    workerMax: Math.max(0, Math.floor(Number(input.workerCountMax || 0))),
    discount: clampPercent(input.tokenDiscountPercent, 30),
    isPublic: input.isPublic === false ? 0 : 1, sortOrder: Math.floor(Number(input.sortOrder || 0)),
    userId,
  })
  const [afterRows] = await pool.query('SELECT * FROM private_pool_plans WHERE slug = :slug LIMIT 1', { slug })
  await writePricingAudit(pool, 'private_pool_plan', slug, beforeRows[0] ?? null, afterRows[0] ?? null, userId)
  return slug
}

export async function upsertFineTuningPlan(pool, input) {
  const slug = slugifyModel(input.slug)
  await pool.query(`
    INSERT INTO fine_tuning_plans (slug, name, eur_per_million_training, setup_min_eur, setup_max_eur, deployment_monthly_min_eur, deployment_monthly_max_eur, is_public, sort_order)
    VALUES (:slug, :name, :trainEur, :setupMin, :setupMax, :deployMin, :deployMax, :isPublic, :sortOrder)
    ON DUPLICATE KEY UPDATE name = VALUES(name), eur_per_million_training = VALUES(eur_per_million_training)
  `, {
    slug, name: input.name, trainEur: Number(input.eurPerMillionTraining || 0),
    setupMin: Number(input.setupMinEur || 0), setupMax: Number(input.setupMaxEur || 0),
    deployMin: Number(input.deploymentMonthlyMinEur || 0), deployMax: Number(input.deploymentMonthlyMaxEur || 0),
    isPublic: input.isPublic === false ? 0 : 1, sortOrder: Math.floor(Number(input.sortOrder || 0)),
  })
  return slug
}

export async function upsertModelCatalogEntry(pool, input, fallbackEnv, userId = null) {
  const slug = input.slug ? slugifyModel(input.slug) : slugifyModel(input.hfId || input.name)
  const [beforeRows] = await pool.query('SELECT * FROM model_catalog WHERE slug = :slug LIMIT 1', { slug })
  const modalities = Array.isArray(input.modalities) ? input.modalities.map(String).filter(Boolean) : []
  const globalConfig = await getPricingConfig(pool, fallbackEnv)
  const tierMap = await buildTierMap(pool)
  const tier = input.pricingTier || input.pricing_tier || 'core'
  const tierDefaults = tierMap.get(tier) || tierMap.get('core')
  const inputEur = input.eurPerMillionInput ?? input.eur_per_million_input ?? tierDefaults?.defaultInputEurPerMillion ?? null
  const outputEur = input.eurPerMillionOutput ?? input.eur_per_million_output ?? tierDefaults?.defaultOutputEurPerMillion ?? null

  const floor = validatePricingFloor({
    inputEur: inputEur ?? tierDefaults?.defaultInputEurPerMillion,
    outputEur: outputEur ?? tierDefaults?.defaultOutputEurPerMillion,
    workerSharePercent: input.workerSharePercent ?? tierDefaults?.defaultWorkerSharePercent ?? 60,
    estimatedWorkerCostInput: input.estimatedWorkerCostInput,
    estimatedWorkerCostOutput: input.estimatedWorkerCostOutput,
    minVryxNetMarginPercent: input.minVryxMarginPercent ?? globalConfig.minVryxNetMarginPercent,
    blendedInputRatioPercent: globalConfig.blendedInputRatioPercent ?? 75,
  })

  await pool.query(`
    INSERT INTO model_catalog
      (slug, hf_id, name, provider, family, params_note, context_tokens, modalities_json,
       open_weights, weight_gb, eur_per_million, pricing_tier, eur_per_million_input, eur_per_million_output,
       eur_per_million_cached_input, eur_per_million_batch_input, eur_per_million_batch_output,
       private_pool_input_eur_per_million, private_pool_output_eur_per_million,
       worker_share_percent, estimated_worker_cost_input, estimated_worker_cost_output,
       min_vryx_margin_percent, availability_status, api_alias, updated_by_user_id,
       is_active, is_public, min_vram_mb, required_workers, sort_order)
    VALUES
      (:slug, :hfId, :name, :provider, :family, :paramsNote, :contextTokens, :modalitiesJson,
       :openWeights, :weightGb, :eurPerMillion, :pricingTier, :inputEur, :outputEur,
       :cachedInput, :batchInput, :batchOutput, :poolInput, :poolOutput,
       :workerShare, :workerCostIn, :workerCostOut, :minMargin, :availability, :apiAlias, :userId,
       :isActive, :isPublic, :minVramMb, :requiredWorkers, :sortOrder)
    ON DUPLICATE KEY UPDATE
      hf_id = VALUES(hf_id), name = VALUES(name), provider = VALUES(provider), family = VALUES(family),
      params_note = VALUES(params_note), context_tokens = VALUES(context_tokens), modalities_json = VALUES(modalities_json),
      open_weights = VALUES(open_weights), weight_gb = VALUES(weight_gb), eur_per_million = VALUES(eur_per_million),
      pricing_tier = VALUES(pricing_tier), eur_per_million_input = VALUES(eur_per_million_input),
      eur_per_million_output = VALUES(eur_per_million_output),
      eur_per_million_cached_input = VALUES(eur_per_million_cached_input),
      eur_per_million_batch_input = VALUES(eur_per_million_batch_input),
      eur_per_million_batch_output = VALUES(eur_per_million_batch_output),
      private_pool_input_eur_per_million = VALUES(private_pool_input_eur_per_million),
      private_pool_output_eur_per_million = VALUES(private_pool_output_eur_per_million),
      worker_share_percent = VALUES(worker_share_percent),
      estimated_worker_cost_input = VALUES(estimated_worker_cost_input),
      estimated_worker_cost_output = VALUES(estimated_worker_cost_output),
      min_vryx_margin_percent = VALUES(min_vryx_margin_percent),
      availability_status = VALUES(availability_status), api_alias = VALUES(api_alias),
      updated_by_user_id = VALUES(updated_by_user_id),
      is_active = VALUES(is_active), is_public = VALUES(is_public),
      min_vram_mb = VALUES(min_vram_mb), required_workers = VALUES(required_workers), sort_order = VALUES(sort_order)
  `, {
    slug,
    hfId: input.hfId || null,
    name: String(input.name || '').trim() || slug,
    provider: String(input.provider || 'Vryx').trim(),
    family: String(input.family || 'Custom').trim(),
    paramsNote: String(input.paramsNote || '').trim() || null,
    contextTokens: Math.max(0, Math.floor(Number(input.contextTokens || 0))),
    modalitiesJson: JSON.stringify(modalities),
    openWeights: input.openWeights ? 1 : 0,
    weightGb: input.weightGb == null ? null : Number(input.weightGb),
    eurPerMillion: input.eurPerMillion == null || input.eurPerMillion === '' ? null : Number(input.eurPerMillion),
    pricingTier: tier,
    inputEur: inputEur == null ? null : Number(inputEur),
    outputEur: outputEur == null ? null : Number(outputEur),
    cachedInput: input.eurPerMillionCachedInput == null ? null : Number(input.eurPerMillionCachedInput),
    batchInput: input.eurPerMillionBatchInput == null ? null : Number(input.eurPerMillionBatchInput),
    batchOutput: input.eurPerMillionBatchOutput == null ? null : Number(input.eurPerMillionBatchOutput),
    poolInput: input.privatePoolInputEurPerMillion == null ? null : Number(input.privatePoolInputEurPerMillion),
    poolOutput: input.privatePoolOutputEurPerMillion == null ? null : Number(input.privatePoolOutputEurPerMillion),
    workerShare: input.workerSharePercent == null ? null : clampPercent(input.workerSharePercent, 60),
    workerCostIn: input.estimatedWorkerCostInput == null ? null : Number(input.estimatedWorkerCostInput),
    workerCostOut: input.estimatedWorkerCostOutput == null ? null : Number(input.estimatedWorkerCostOutput),
    minMargin: input.minVryxMarginPercent == null ? null : clampPercent(input.minVryxMarginPercent, 20),
    availability: input.availabilityStatus || 'available',
    apiAlias: input.apiAlias || null,
    isActive: input.isActive === false ? 0 : 1,
    isPublic: input.isPublic === false ? 0 : 1,
    minVramMb: input.minVramMb == null || input.minVramMb === '' ? null : Math.max(0, Math.floor(Number(input.minVramMb))),
    requiredWorkers: Math.max(1, Math.floor(Number(input.requiredWorkers || 1))),
    sortOrder: Math.floor(Number(input.sortOrder || 0)),
    userId,
  })
  const [afterRows] = await pool.query('SELECT * FROM model_catalog WHERE slug = :slug LIMIT 1', { slug })
  await writePricingAudit(pool, 'model_catalog', slug, beforeRows[0] ?? null, afterRows[0] ?? null, userId)
  return { slug, warnings: floor.warnings }
}

export { splitLegacyBlendedPrice, validatePricingFloor }
