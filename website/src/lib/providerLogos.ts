/** Version figée pour des URLs stables (SVG depuis le paquet npm simple-icons). */
export const SIMPLE_ICONS_VER = '16.18.0'
const SI_CDN = `https://cdn.jsdelivr.net/npm/simple-icons@${SIMPLE_ICONS_VER}/icons`

export function simpleIconsUrl(slug: string): string {
  return `${SI_CDN}/${slug}.svg`
}

/**
 * Slugs Simple Icons (fichiers .svg) par nom d’éditeur affiché dans l’app.
 * Sans entrée : le composant affiche des initiales (ex. Zhipu AI).
 */
const SLUG_BY_PROVIDER: Record<string, string> = {
  Alibaba: 'alibabacloud',
  Meta: 'meta',
  'Mistral AI': 'mistralai',
  DeepSeek: 'deepseek',
  Moonshot: 'moonshotai',
  MiniMax: 'minimax',
  Tencent: 'wechat',
  Baidu: 'baidu',
  StepFun: 'rocket',
  'Shanghai AI Lab': 'pytorch',
  NVIDIA: 'nvidia',
  Databricks: 'databricks',
  Snowflake: 'snowflake',
  '01.AI': 'huggingface',
  IBM: 'redhat',
  'Allen AI': 'pytorch',
  'AI21 Labs': 'langchain',
  'Reka AI': 'replit',
  Google: 'google',
  Microsoft: 'dotnet',
  TII: 'huggingface',
  Cohere: 'huggingface',
  Upstage: 'pytorch',
  'Aleph Alpha': 'huggingface',
  'Hugging Face': 'huggingface',
}

/** Logos externes quand l’éditeur n’existe pas dans Simple Icons. */
const CUSTOM_LOGO_BY_PROVIDER: Record<string, string> = {
  Alibaba: '/qwen.png',
  DeepSeek: '/Deepseek.png',
  Meta: '/llama.png',
  'Zhipu AI': '/zai.png',
  Microsoft: '/microsoft.png',
  Google: '/google.png',
  'Mistral AI': '/Mistral.png',
  NVIDIA: '/Nvidia.png',
}

export function providerLogoSrc(provider: string): string | null {
  const customSrc = CUSTOM_LOGO_BY_PROVIDER[provider]
  if (customSrc) return customSrc
  const slug = SLUG_BY_PROVIDER[provider]
  if (!slug) return null
  return simpleIconsUrl(slug)
}

export function providerInitials(provider: string): string {
  const parts = provider.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    const a = parts[0][0]
    const b = parts[parts.length - 1][0]
    return (a + b).toUpperCase()
  }
  return provider.replace(/\W/g, '').slice(0, 2).toUpperCase() || '--'
}
