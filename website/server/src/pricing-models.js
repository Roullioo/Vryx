const DEFAULT_VOLUME_DISCOUNTS = [
  { minMonthlyMillions: 100, discountPercent: 5 },
  { minMonthlyMillions: 500, discountPercent: 10 },
  { minMonthlyMillions: 2000, discountPercent: 18 },
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

function clampPercent(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, n))
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

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

function pricingRowToDto(row, fallbackEnv) {
  const defaultEur = positiveNumber(row?.default_eur_per_million, fallbackEnv.eurPerMillion)
  const vatPercent = clampPercent(row?.vat_percent, 20)
  const workerRewardSharePercent = clampPercent(row?.worker_reward_share_percent, fallbackEnv.workerRewardSharePercent)
  return {
    defaultEurPerMillion: defaultEur,
    pricingPublished: row ? Boolean(row.pricing_published) : false,
    vatPercent,
    workerRewardSharePercent,
    estimatedGrossMarginPercent: clampPercent(fallbackEnv.grossMarginPercent, 72),
    volumeDiscounts: parseJsonList(row?.volume_discount_json, DEFAULT_VOLUME_DISCOUNTS),
    updatedAt: row?.updated_at ?? null,
    updatedByUserId: row?.updated_by_user_id ?? null,
  }
}

export function computeEffectiveModelPrice(modelOverrideEur, pricing) {
  const override = modelOverrideEur == null ? null : Number(modelOverrideEur)
  if (override != null && Number.isFinite(override) && override > 0) return override
  return positiveNumber(pricing?.defaultEurPerMillion, 0.3)
}

function normalizeModelRow(row, pricing) {
  const modalities = parseJsonList(row.modalities_json, [])
  const override = row.eur_per_million == null ? null : Number(row.eur_per_million)
  const effective = computeEffectiveModelPrice(override, pricing)
  return {
    slug: row.slug,
    id: row.hf_id || row.slug,
    hfId: row.hf_id || null,
    name: row.name,
    provider: row.provider,
    family: row.family,
    paramsNote: row.params_note || '',
    contextTokens: Number(row.context_tokens || 0),
    modalities,
    openWeights: Boolean(row.open_weights),
    weightGb: row.weight_gb == null ? null : Number(row.weight_gb),
    eurPerMillion: override,
    effectiveEurPerMillion: effective,
    isActive: Boolean(row.is_active),
    isPublic: Boolean(row.is_public),
    minVramMb: row.min_vram_mb == null ? null : Number(row.min_vram_mb),
    requiredWorkers: Number(row.required_workers || 1),
    sortOrder: Number(row.sort_order || 0),
    updatedAt: row.updated_at ?? null,
  }
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
  await pool.query(`
    INSERT INTO pricing_config
      (id, default_eur_per_million, pricing_published, vat_percent, worker_reward_share_percent, volume_discount_json)
    VALUES (1, :eurPerMillion, 0, 20, :workerRewardSharePercent, :volumeDiscounts)
    ON DUPLICATE KEY UPDATE id = id
  `, {
    eurPerMillion: fallbackEnv.eurPerMillion,
    workerRewardSharePercent: fallbackEnv.workerRewardSharePercent,
    volumeDiscounts: JSON.stringify(DEFAULT_VOLUME_DISCOUNTS),
  })

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
      slug,
      hfId,
      name,
      provider,
      family,
      paramsNote,
      contextTokens,
      modalitiesJson: JSON.stringify(modalities),
      openWeights: openWeights ? 1 : 0,
      weightGb,
      sortOrder,
    })
  }
}

let pricingCache = null
let pricingCacheUntil = 0

export function invalidatePricingCache() {
  pricingCache = null
  pricingCacheUntil = 0
}

export async function getPricingConfig(pool, fallbackEnv, { force = false } = {}) {
  const now = Date.now()
  if (!force && pricingCache && pricingCacheUntil > now) return pricingCache
  const [rows] = await pool.query('SELECT * FROM pricing_config WHERE id = 1 LIMIT 1')
  pricingCache = pricingRowToDto(rows[0], fallbackEnv)
  pricingCacheUntil = now + 30_000
  return pricingCache
}

/** Alias plan refonte : tarif effectif (cache 30 s, fallback env si BDD vide). */
export async function getEffectivePricing(pool, fallbackEnv, opts) {
  return getPricingConfig(pool, fallbackEnv, opts)
}

export async function getPublicModels(pool, fallbackEnv, { includeInactive = false, includePrivate = false } = {}) {
  const pricing = await getPricingConfig(pool, fallbackEnv)
  const clauses = []
  if (!includeInactive) clauses.push('is_active = 1')
  if (!includePrivate) clauses.push('is_public = 1')
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const [rows] = await pool.query(`
    SELECT *
    FROM model_catalog
    ${where}
    ORDER BY sort_order ASC, name ASC
  `)
  return rows.map((row) => normalizeModelRow(row, pricing))
}

export async function updatePricingConfig(pool, input, fallbackEnv, userId = null) {
  const current = await getPricingConfig(pool, fallbackEnv, { force: true })
  const next = {
    defaultEurPerMillion: positiveNumber(input.defaultEurPerMillion, current.defaultEurPerMillion),
    pricingPublished: Boolean(input.pricingPublished),
    vatPercent: clampPercent(input.vatPercent, current.vatPercent),
    workerRewardSharePercent: clampPercent(input.workerRewardSharePercent, current.workerRewardSharePercent),
    volumeDiscounts: Array.isArray(input.volumeDiscounts) ? input.volumeDiscounts : current.volumeDiscounts,
  }
  await pool.query(`
    UPDATE pricing_config
    SET default_eur_per_million = :defaultEurPerMillion,
        pricing_published = :pricingPublished,
        vat_percent = :vatPercent,
        worker_reward_share_percent = :workerRewardSharePercent,
        volume_discount_json = :volumeDiscounts,
        updated_by_user_id = :userId
    WHERE id = 1
  `, {
    defaultEurPerMillion: next.defaultEurPerMillion,
    pricingPublished: next.pricingPublished ? 1 : 0,
    vatPercent: next.vatPercent,
    workerRewardSharePercent: next.workerRewardSharePercent,
    volumeDiscounts: JSON.stringify(next.volumeDiscounts),
    userId,
  })
  invalidatePricingCache()
  return getPricingConfig(pool, fallbackEnv, { force: true })
}

export async function upsertModelCatalogEntry(pool, input) {
  const slug = input.slug ? slugifyModel(input.slug) : slugifyModel(input.hfId || input.name)
  const modalities = Array.isArray(input.modalities) ? input.modalities.map(String).filter(Boolean) : []
  await pool.query(`
    INSERT INTO model_catalog
      (slug, hf_id, name, provider, family, params_note, context_tokens, modalities_json,
       open_weights, weight_gb, eur_per_million, is_active, is_public, min_vram_mb, required_workers, sort_order)
    VALUES
      (:slug, :hfId, :name, :provider, :family, :paramsNote, :contextTokens, :modalitiesJson,
       :openWeights, :weightGb, :eurPerMillion, :isActive, :isPublic, :minVramMb, :requiredWorkers, :sortOrder)
    ON DUPLICATE KEY UPDATE
      hf_id = VALUES(hf_id),
      name = VALUES(name),
      provider = VALUES(provider),
      family = VALUES(family),
      params_note = VALUES(params_note),
      context_tokens = VALUES(context_tokens),
      modalities_json = VALUES(modalities_json),
      open_weights = VALUES(open_weights),
      weight_gb = VALUES(weight_gb),
      eur_per_million = VALUES(eur_per_million),
      is_active = VALUES(is_active),
      is_public = VALUES(is_public),
      min_vram_mb = VALUES(min_vram_mb),
      required_workers = VALUES(required_workers),
      sort_order = VALUES(sort_order)
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
    isActive: input.isActive === false ? 0 : 1,
    isPublic: input.isPublic === false ? 0 : 1,
    minVramMb: input.minVramMb == null || input.minVramMb === '' ? null : Math.max(0, Math.floor(Number(input.minVramMb))),
    requiredWorkers: Math.max(1, Math.floor(Number(input.requiredWorkers || 1))),
    sortOrder: Math.floor(Number(input.sortOrder || 0)),
  })
  return slug
}
