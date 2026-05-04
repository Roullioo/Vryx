/** Grands modèles (catalogue orienté GLM, Qwen, Llama, écosystème ouvert / régional ; sans GPT ni Claude). */
export type LargeAiModel = {
  id: string
  name: string
  provider: string
  family: string
  paramsNote: string
  contextTokens: number
  modalities: string[]
  openWeights: boolean
  /** VRAM indicative (Go), prioritaire sur l’heuristique `paramsNote`. */
  weightGb?: number | null
  /** Slug Simple Icons pour le logo famille (rare ; sinon table par `family`). */
  logoSlug?: string
}

export const LARGE_AI_MODELS: LargeAiModel[] = [
  {
    id: 'llama-4-scout',
    name: 'Llama 4 Scout',
    provider: 'Meta',
    family: 'Llama',
    paramsNote: '17B actifs (MoE)',
    contextTokens: 10_485_760,
    modalities: ['Texte', 'Image'],
    openWeights: true,
  },
  {
    id: 'llama-4-maverick',
    name: 'Llama 4 Maverick',
    provider: 'Meta',
    family: 'Llama',
    paramsNote: '17B actifs (MoE)',
    contextTokens: 1_048_576,
    modalities: ['Texte', 'Image'],
    openWeights: true,
  },
  {
    id: 'llama-3-1-405b',
    name: 'Llama 3.1 405B Instruct',
    provider: 'Meta',
    family: 'Llama',
    paramsNote: '405B',
    contextTokens: 131_072,
    modalities: ['Texte', 'Code'],
    openWeights: true,
  },
  {
    id: 'qwen3-235b-a22b',
    name: 'Qwen3-235B-A22B',
    provider: 'Alibaba',
    family: 'Qwen',
    paramsNote: '235B (22B actifs)',
    contextTokens: 131_072,
    modalities: ['Texte', 'Code', 'Raisonnement'],
    openWeights: true,
  },
  {
    id: 'qwen3-32b',
    name: 'Qwen3-32B',
    provider: 'Alibaba',
    family: 'Qwen',
    paramsNote: '32B',
    contextTokens: 131_072,
    modalities: ['Texte', 'Code'],
    openWeights: true,
  },
  {
    id: 'qwen2-5-72b-instruct',
    name: 'Qwen2.5-72B-Instruct',
    provider: 'Alibaba',
    family: 'Qwen',
    paramsNote: '72B',
    contextTokens: 131_072,
    modalities: ['Texte', 'Code'],
    openWeights: true,
  },
  {
    id: 'glm-5-1',
    name: 'GLM-5.1',
    provider: 'Zhipu AI',
    family: 'GLM',
    paramsNote: 'N.C. (propriétaire)',
    contextTokens: 128_000,
    modalities: ['Texte', 'Code', 'Raisonnement'],
    openWeights: false,
  },
  {
    id: 'glm-5',
    name: 'GLM-5',
    provider: 'Zhipu AI',
    family: 'GLM',
    paramsNote: 'N.C. (propriétaire)',
    contextTokens: 128_000,
    modalities: ['Texte', 'Code', 'Raisonnement'],
    openWeights: false,
  },
  {
    id: 'glm-4-5',
    name: 'GLM-4.5',
    provider: 'Zhipu AI',
    family: 'GLM',
    paramsNote: '355B (32B actifs)',
    contextTokens: 128_000,
    modalities: ['Texte', 'Code', 'Raisonnement', 'Agent'],
    openWeights: true,
  },
  {
    id: 'glm-4-5-air',
    name: 'GLM-4.5-Air',
    provider: 'Zhipu AI',
    family: 'GLM',
    paramsNote: '106B (12B actifs)',
    contextTokens: 128_000,
    modalities: ['Texte', 'Code', 'Raisonnement', 'Agent'],
    openWeights: true,
  },
  {
    id: 'glm-4-1v-thinking',
    name: 'GLM-4.1V-Thinking',
    provider: 'Zhipu AI',
    family: 'GLM-V',
    paramsNote: '9B',
    contextTokens: 65_536,
    modalities: ['Texte', 'Image', 'Vidéo', 'Raisonnement'],
    openWeights: true,
  },
  {
    id: 'deepseek-r1',
    name: 'DeepSeek-R1',
    provider: 'DeepSeek',
    family: 'DeepSeek',
    paramsNote: '671B MoE',
    contextTokens: 128_000,
    modalities: ['Texte', 'Raisonnement', 'Code'],
    openWeights: true,
  },
  {
    id: 'deepseek-v3',
    name: 'DeepSeek-V3',
    provider: 'DeepSeek',
    family: 'DeepSeek',
    paramsNote: '671B MoE',
    contextTokens: 128_000,
    modalities: ['Texte', 'Code'],
    openWeights: true,
  },
  {
    id: 'deepseek-v2-5',
    name: 'DeepSeek-V2.5',
    provider: 'DeepSeek',
    family: 'DeepSeek',
    paramsNote: '236B MoE',
    contextTokens: 128_000,
    modalities: ['Texte', 'Code'],
    openWeights: true,
  },
  {
    id: 'mixtral-8x22b-instruct',
    name: 'Mixtral 8x22B Instruct',
    provider: 'Mistral AI',
    family: 'Mixtral',
    paramsNote: '141B MoE',
    contextTokens: 65_536,
    modalities: ['Texte', 'Code'],
    openWeights: true,
  },
  {
    id: 'codestral-22b',
    name: 'Codestral 22B',
    provider: 'Mistral AI',
    family: 'Codestral',
    paramsNote: '22B',
    contextTokens: 256_000,
    modalities: ['Texte', 'Code'],
    openWeights: true,
  },
  {
    id: 'mistral-large-2',
    name: 'Mistral Large 2',
    provider: 'Mistral AI',
    family: 'Mistral',
    paramsNote: '123B',
    contextTokens: 131_072,
    modalities: ['Texte', 'Code'],
    openWeights: false,
  },
  {
    id: 'gemma-3-27b-it',
    name: 'Gemma 3 27B IT',
    provider: 'Google',
    family: 'Gemma',
    paramsNote: '27B',
    contextTokens: 131_072,
    modalities: ['Texte', 'Image'],
    openWeights: true,
  },
  {
    id: 'gemma-3-12b-it',
    name: 'Gemma 3 12B IT',
    provider: 'Google',
    family: 'Gemma',
    paramsNote: '12B',
    contextTokens: 131_072,
    modalities: ['Texte', 'Image'],
    openWeights: true,
  },
  {
    id: 'phi-4',
    name: 'Phi-4',
    provider: 'Microsoft',
    family: 'Phi',
    paramsNote: '14B',
    contextTokens: 16_384,
    modalities: ['Texte', 'Code'],
    openWeights: true,
  },
  {
    id: 'phi-4-multimodal',
    name: 'Phi-4 Multimodal',
    provider: 'Microsoft',
    family: 'Phi',
    paramsNote: '5.6B',
    contextTokens: 128_000,
    modalities: ['Texte', 'Image', 'Audio'],
    openWeights: true,
  },
  {
    id: 'nemotron-4-340b',
    name: 'Nemotron-4 340B Instruct',
    provider: 'NVIDIA',
    family: 'Nemotron',
    paramsNote: '340B',
    contextTokens: 128_000,
    modalities: ['Texte', 'Code'],
    openWeights: true,
  },
]

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return m >= 10 ? `${Math.round(m)}M` : `${m % 1 === 0 ? m : m.toFixed(1)}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

export const PROVIDERS = [...new Set(LARGE_AI_MODELS.map((m) => m.provider))].sort((a, b) =>
  a.localeCompare(b, 'fr'),
)
