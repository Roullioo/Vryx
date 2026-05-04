import type { GpuCatalogEntry } from '../data/gpuCatalog'

/** Tarif public Vryx (pool), en euros par million de tokens facturés. */
export const VELOCITY_EUR_PER_MILLION = 0.3

/** Débit séquentiel de référence (solo), tokens/s ; ordre de grandeur serveur dédié mid-range. */
const SOLO_THROUGHPUT_TOKENS_PER_S = 42

/** Surcoût orchestration Race-Pool (ms), après le premier worker utile. */
const POOL_ORCHESTRATION_MS = 38

export type SimulatorInput = {
  /** Millions de tokens (entrée + sortie) facturés par mois */
  millionsTokensPerMonth: number
  /** Tarif de référence « cloud classique » (€ / million de tokens) */
  referenceEurPerMillion: number
  /** Nombre de GPU candidats en compétition sur une requête Race-Pool */
  poolCandidateCount: number
  /** Tokens de sortie moyens par requête (pour le modèle de latence) */
  avgOutputTokensPerRequest: number
}

export type SimulatorResult = {
  monthlySoloEuro: number
  monthlyPoolEuro: number
  yearlySoloEuro: number
  yearlyPoolEuro: number
  savingsMonthlyEuro: number
  savingsMonthlyPct: number
  savingsYearlyEuro: number
  /** Latence P50 indicative, requête type (ms) ; solo = un worker / une file */
  estimatedSoloP50Ms: number
  /** Latence P50 indicative avec Race-Pool (ms) ; min des workers + orchestration */
  estimatedPoolP50Ms: number
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

/**
 * Modèle éducatif : solo = file + un débit ; pool = effet « course » sur la latence
 * (le plus rapide des N candidats réduit le temps de génération moyen, sans changer le prix au token).
 */
export function runSimulator(input: SimulatorInput): SimulatorResult {
  const M = clamp(input.millionsTokensPerMonth, 0, 1_000_000)
  const ref = clamp(input.referenceEurPerMillion, 0.05, 80)
  const n = Math.round(clamp(input.poolCandidateCount, 2, 256))
  const outTok = Math.round(clamp(input.avgOutputTokensPerRequest, 16, 128_000))

  const monthlySoloEuro = M * ref
  const monthlyPoolEuro = M * VELOCITY_EUR_PER_MILLION
  const yearlySoloEuro = monthlySoloEuro * 12
  const yearlyPoolEuro = monthlyPoolEuro * 12
  const savingsMonthlyEuro = monthlySoloEuro - monthlyPoolEuro
  const savingsMonthlyPct =
    monthlySoloEuro > 0 ? (savingsMonthlyEuro / monthlySoloEuro) * 100 : 0
  const savingsYearlyEuro = savingsMonthlyEuro * 12

  const genMsSolo = (outTok / SOLO_THROUGHPUT_TOKENS_PER_S) * 1000
  const baseQueueSolo = 680
  const estimatedSoloP50Ms = Math.round(baseQueueSolo + genMsSolo)

  const raceFactor = 1 + 0.11 * Math.log2(n)
  const genMsPool = genMsSolo / raceFactor
  const baseQueuePool = 420
  const estimatedPoolP50Ms = Math.round(baseQueuePool + genMsPool + POOL_ORCHESTRATION_MS)

  return {
    monthlySoloEuro,
    monthlyPoolEuro,
    yearlySoloEuro,
    yearlyPoolEuro,
    savingsMonthlyEuro,
    savingsMonthlyPct,
    savingsYearlyEuro,
    estimatedSoloP50Ms,
    estimatedPoolP50Ms,
  }
}

export function formatEur(n: number) {
  return n.toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// --- Simulateur rentabilité worker (ordre de grandeur, paramétrique) ---

export type WorkerSimMode = 'solo' | 'race-pool'

/** Heures calendaire max sur un mois (30 j). */
export const WORKER_HOURS_MONTH_MAX = 24 * 30

/**
 * Tarif indicatif : euros par unité (fp16Tflops) et par heure en ligne,
 * avant électricité. Calibré pour donner des ordres de grandeur crédibles sur le catalogue.
 */
export const WORKER_EUR_PER_TFLOP_HOUR = 0.0015

export type WorkerProfitInput = {
  /** 0 à 100 : part du mois où le GPU est réellement disponible pour le réseau */
  utilizationPct: number
  /** Prix de l’électricité au kWh (domicile / colocation) */
  electricityEurPerKwh: number
  mode: WorkerSimMode
}

export type WorkerGpuProfit = {
  grossMonthlyEuro: number
  electricityMonthlyEuro: number
  netMonthlyEuro: number
  /** Mois pour amortir le MSRP indicatif ; null si net ≤ 0 */
  roiMonths: number | null
  hoursOnlineMonth: number
  modeMultiplierApplied: number
  /** Multiplicateur appliqué au brut selon la VRAM (charge utile / lots). */
  vramRevenueFactor: number
}

export function workerModeMultiplier(mode: WorkerSimMode): number {
  return mode === 'solo' ? 0.92 : 1.06
}

/**
 * Pondération revenu selon la VRAM : les charges utiles d'inférence dépendent fortement
 * de la mémoire disponible (contexte, batch). Facteur doux entre ~0,9 et ~1,2 sur le catalogue.
 */
export function workerVramRevenueFactor(vramGb: number): number {
  const n = clamp(vramGb, 4, 96)
  return clamp(0.88 + (n / 24) * 0.16, 0.9, 1.22)
}

/**
 * Revenu brut ≈ fp16Tflops × taux × heures × multiplicateur de mode × facteur VRAM.
 * Net = brut − (TDP en kW × heures × €/kWh).
 */
export function computeWorkerGpuProfit(
  gpu: GpuCatalogEntry,
  input: WorkerProfitInput,
): WorkerGpuProfit {
  const utilization = clamp(input.utilizationPct / 100, 0.05, 1)
  const hoursOnlineMonth = WORKER_HOURS_MONTH_MAX * utilization
  const mult = workerModeMultiplier(input.mode)
  const vramF = workerVramRevenueFactor(gpu.vram)
  const grossMonthlyEuro =
    gpu.fp16Tflops * WORKER_EUR_PER_TFLOP_HOUR * hoursOnlineMonth * mult * vramF
  // L'inférence n'utilise généralement pas 100% du TDP, plutôt ~60% en moyenne
  const averagePowerKw = (gpu.tdp / 1000) * 0.6
  const electricityMonthlyEuro = averagePowerKw * hoursOnlineMonth * input.electricityEurPerKwh
  const netMonthlyEuro = grossMonthlyEuro - electricityMonthlyEuro
  const roiMonths =
    netMonthlyEuro > 0.01 ? gpu.msrpEur / netMonthlyEuro : null

  return {
    grossMonthlyEuro,
    electricityMonthlyEuro,
    netMonthlyEuro,
    roiMonths,
    hoursOnlineMonth,
    modeMultiplierApplied: mult,
    vramRevenueFactor: vramF,
  }
}

/** 12 points pour mini-graphique (variation illustrative autour du net mensuel). */
export function workerNetSparkline12(netMonthlyEuro: number): number[] {
  if (netMonthlyEuro <= 0) return Array(12).fill(0)
  return Array.from({ length: 12 }, (_, i) => {
    const wobble = 1 + 0.04 * Math.sin((i + 1) / 1.8)
    return netMonthlyEuro * wobble
  })
}

export type FleetLine = { gpu: GpuCatalogEntry; count: number }

export function computeFleetWorkerProfit(lines: FleetLine[], input: WorkerProfitInput): WorkerGpuProfit {
  if (lines.length === 0) {
    return {
      grossMonthlyEuro: 0,
      electricityMonthlyEuro: 0,
      netMonthlyEuro: 0,
      roiMonths: null,
      hoursOnlineMonth: WORKER_HOURS_MONTH_MAX * clamp(input.utilizationPct / 100, 0.05, 1),
      modeMultiplierApplied: workerModeMultiplier(input.mode),
      vramRevenueFactor: 1,
    }
  }
  let gross = 0
  let elec = 0
  let msrp = 0
  let hours = 0
  for (const { gpu, count } of lines) {
    const one = computeWorkerGpuProfit(gpu, input)
    gross += one.grossMonthlyEuro * count
    elec += one.electricityMonthlyEuro * count
    msrp += gpu.msrpEur * count
    hours = one.hoursOnlineMonth
  }
  const net = gross - elec
  return {
    grossMonthlyEuro: gross,
    electricityMonthlyEuro: elec,
    netMonthlyEuro: net,
    roiMonths: net > 0.01 ? msrp / net : null,
    hoursOnlineMonth: hours,
    modeMultiplierApplied: workerModeMultiplier(input.mode),
    vramRevenueFactor: 1,
  }
}
