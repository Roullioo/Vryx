import type { LargeAiModel } from '../data/largeAiModels'
import { providerLogoSrc, simpleIconsUrl } from './providerLogos'

/**
 * Icône Simple Icons par famille de modèle (visuel « ligne » LLM).
 * Sans slug : repli sur le logo éditeur si connu, sinon initiales.
 */
const FAMILY_SLUG: Record<string, string> = {
  Qwen: 'alibabacloud',
  Llama: 'meta',
  Gemma: 'googlegemini',
  Phi: 'microsoft',
  DeepSeek: 'deepseek',
  Mistral: 'mistralai',
  Magistral: 'mistralai',
  Pixtral: 'mistralai',
  Mixtral: 'mistralai',
  Codestral: 'mistralai',
  Kimi: 'moonshotai',
  MiniMax: 'minimax',
  Hunyuan: 'tencentqq',
  ERNIE: 'baidu',
  Step: 'step',
  InternLM: 'huggingface',
  Nemotron: 'nvidia',
  DBRX: 'databricks',
  Arctic: 'snowflake',
  Yi: '01dotai',
  Command: 'cohere',
  Aya: 'cohere',
  Granite: 'ibm',
  OLMo: 'allenai',
  Jamba: 'ai21labs',
  Reka: 'rekaai',
  Luminous: 'alephalpha',
  SOLAR: 'upstage',
  Falcon: 'tii',
}

export function modelFamilyLogoSlug(m: Pick<LargeAiModel, 'family' | 'logoSlug'>): string | null {
  if (m.logoSlug) return m.logoSlug
  return FAMILY_SLUG[m.family] ?? null
}

export function modelFamilyLogoSrc(m: Pick<LargeAiModel, 'family' | 'logoSlug' | 'provider'>): string | null {
  const slug = modelFamilyLogoSlug(m)
  if (slug) return simpleIconsUrl(slug)
  return providerLogoSrc(m.provider)
}

export function familyInitials(family: string): string {
  const t = family.replace(/[^a-zA-Z0-9]/g, '')
  if (t.length >= 2) return t.slice(0, 2).toUpperCase()
  return (family.slice(0, 2) || '--').toUpperCase()
}
