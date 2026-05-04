import type { LargeAiModel } from '../data/largeAiModels'

/**
 * VRAM indicative (chargement modèle ~FP16/BF16), en Go.
 * `weightGb` sur le modèle prime ; sinon heuristique depuis `paramsNote`.
 */
export function modelVramIndicativeGb(m: LargeAiModel): number | null {
  if (m.weightGb !== undefined && m.weightGb !== null) return m.weightGb
  return inferVramGbFromParamsNote(m.paramsNote)
}

function inferVramGbFromParamsNote(note: string): number | null {
  const n = note.trim().toLowerCase()
  if (!n || n.includes('non divulgué') || n.includes('1t')) return null

  if (/671\s*b/.test(n) && n.includes('moe')) return 80
  if (/456\s*b/.test(n) && n.includes('moe')) return 52
  if (/480\s*b/.test(n) && n.includes('moe')) return 58
  if (/398\s*b/.test(n)) return 42
  if (/132\s*b/.test(n) && n.includes('moe')) return 28
  if (/141\s*b/.test(n) && n.includes('moe')) return 36

  const parenAct = n.match(/\(\s*(\d+(?:\.\d+)?)\s*b\s*actifs?\s*\)/)
  if (parenAct) {
    const b = parseFloat(parenAct[1])
    if (!Number.isNaN(b)) return Math.max(6, Math.round(b * 2.1))
  }

  const actifsSuffix = n.match(/^(\d+(?:\.\d+)?)\s*b\s*\(\s*(\d+(?:\.\d+)?)\s*b\s*actifs?\s*\)/i)
  if (actifsSuffix) {
    const active = parseFloat(actifsSuffix[2])
    if (!Number.isNaN(active)) return Math.max(6, Math.round(active * 2.1))
  }

  const actifsPlain = n.match(/(\d+(?:\.\d+)?)\s*b\s*\(?\d*b?\s*actifs?/i)
  if (actifsPlain && n.includes('actifs')) {
    const parts = n.match(/(\d+(?:\.\d+)?)\s*b\s*actifs?/i)
    if (parts) {
      const b = parseFloat(parts[1])
      if (!Number.isNaN(b)) return Math.max(4, Math.round(b * 2.1))
    }
  }

  const commaB = n.match(/(\d+),(\d+)\s*b\b/)
  if (commaB) {
    const b = parseFloat(`${commaB[1]}.${commaB[2]}`)
    if (!Number.isNaN(b)) return Math.max(2, Math.round(b * 2))
  }

  const simple = n.match(/(\d+(?:\.\d+)?)\s*b\b/)
  if (simple) {
    const b = parseFloat(simple[1])
    if (!Number.isNaN(b)) return Math.max(1, Math.round(b * 2))
  }

  const moeOnly = n.match(/(\d+)\s*b\s*moe/)
  if (moeOnly) {
    const total = parseInt(moeOnly[1], 10)
    if (total >= 400) return Math.round(total * 0.05 * 2)
    if (total >= 100) return Math.round(total * 0.12 * 2)
    return Math.round(total * 0.2 * 2)
  }

  return null
}

export function formatVramGbLabel(gb: number | null): string {
  if (gb == null) return 'n. c.'
  return `≈ ${gb.toLocaleString('fr-FR')} Go`
}
