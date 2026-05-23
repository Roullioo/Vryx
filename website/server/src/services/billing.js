export function toMoneyAmount(tokens, eurPerMillion) {
  return (Number(tokens || 0) / 1_000_000) * Number(eurPerMillion || 0)
}

export function toEuroAmount(value, precision = 6) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Number(n.toFixed(precision))
}

export function euroFromTokens(tokens, eurPerMillion) {
  return toEuroAmount(toMoneyAmount(tokens, eurPerMillion))
}

export function estimatePromptTokens(prompt) {
  return Math.max(1, Math.ceil(String(prompt || '').length / 4))
}
