/**
 * Catalogue indicatif pour le simulateur « rentabilité worker ».
 * fp16Tflops : indice de débit utile (ordre de grandeur, pas une certification constructeur).
 * Apple Silicon : mémoire unifiée (champ vram = capacité max configurée pour cette variante GPU, cf. fiches Apple).
 * fp16 / TDP Apple : ordre de grandeur package GPU-charge (sources : apple.com, support Apple, spécifications publiées).
 */
export type GpuTier = 'consumer' | 'workstation' | 'datacenter'
export type GpuVendor = 'NVIDIA' | 'AMD' | 'Apple'

export type GpuCatalogEntry = {
  id: string
  vendor: GpuVendor
  name: string
  vram: number
  /** Indice de performance pour la formule (unités relatives cohérentes entre cartes). */
  fp16Tflops: number
  tdp: number
  msrpEur: number
  tier: GpuTier
}

const DISCRETE_GPUS: GpuCatalogEntry[] = [
  { id: 'rtx-3060-12', vendor: 'NVIDIA', name: 'GeForce RTX 3060 12 Go', vram: 12, fp16Tflops: 51, tdp: 170, msrpEur: 350, tier: 'consumer' },
  { id: 'rtx-3060-ti', vendor: 'NVIDIA', name: 'GeForce RTX 3060 Ti', vram: 8, fp16Tflops: 58, tdp: 200, msrpEur: 420, tier: 'consumer' },
  { id: 'rtx-3070', vendor: 'NVIDIA', name: 'GeForce RTX 3070', vram: 8, fp16Tflops: 62, tdp: 220, msrpEur: 520, tier: 'consumer' },
  { id: 'rtx-3070-ti', vendor: 'NVIDIA', name: 'GeForce RTX 3070 Ti', vram: 8, fp16Tflops: 68, tdp: 290, msrpEur: 620, tier: 'consumer' },
  { id: 'rtx-3080', vendor: 'NVIDIA', name: 'GeForce RTX 3080', vram: 10, fp16Tflops: 71, tdp: 320, msrpEur: 720, tier: 'consumer' },
  { id: 'rtx-3080-12', vendor: 'NVIDIA', name: 'GeForce RTX 3080 12 Go', vram: 12, fp16Tflops: 74, tdp: 350, msrpEur: 780, tier: 'consumer' },
  { id: 'rtx-3080-ti', vendor: 'NVIDIA', name: 'GeForce RTX 3080 Ti', vram: 12, fp16Tflops: 80, tdp: 350, msrpEur: 1200, tier: 'consumer' },
  { id: 'rtx-4060', vendor: 'NVIDIA', name: 'GeForce RTX 4060', vram: 8, fp16Tflops: 48, tdp: 115, msrpEur: 320, tier: 'consumer' },
  { id: 'rtx-4060-ti-16', vendor: 'NVIDIA', name: 'GeForce RTX 4060 Ti 16 Go', vram: 16, fp16Tflops: 65, tdp: 165, msrpEur: 500, tier: 'consumer' },
  { id: 'rtx-4070', vendor: 'NVIDIA', name: 'GeForce RTX 4070', vram: 12, fp16Tflops: 73, tdp: 200, msrpEur: 600, tier: 'consumer' },
  { id: 'rtx-4070-s', vendor: 'NVIDIA', name: 'GeForce RTX 4070 Super', vram: 12, fp16Tflops: 80, tdp: 220, msrpEur: 650, tier: 'consumer' },
  { id: 'rtx-4070-ti-s', vendor: 'NVIDIA', name: 'GeForce RTX 4070 Ti Super', vram: 16, fp16Tflops: 88, tdp: 285, msrpEur: 800, tier: 'consumer' },
  { id: 'rtx-4080', vendor: 'NVIDIA', name: 'GeForce RTX 4080', vram: 16, fp16Tflops: 97, tdp: 320, msrpEur: 1200, tier: 'consumer' },
  { id: 'rtx-4080-s', vendor: 'NVIDIA', name: 'GeForce RTX 4080 Super', vram: 16, fp16Tflops: 104, tdp: 320, msrpEur: 1100, tier: 'consumer' },
  { id: 'rtx-4090', vendor: 'NVIDIA', name: 'GeForce RTX 4090', vram: 24, fp16Tflops: 165, tdp: 450, msrpEur: 2000, tier: 'consumer' },
  { id: 'rtx-5070', vendor: 'NVIDIA', name: 'GeForce RTX 5070', vram: 12, fp16Tflops: 95, tdp: 220, msrpEur: 550, tier: 'consumer' },
  { id: 'rtx-5080', vendor: 'NVIDIA', name: 'GeForce RTX 5080', vram: 16, fp16Tflops: 120, tdp: 360, msrpEur: 1000, tier: 'consumer' },
  { id: 'rtx-5090', vendor: 'NVIDIA', name: 'GeForce RTX 5090', vram: 32, fp16Tflops: 180, tdp: 575, msrpEur: 2000, tier: 'consumer' },
  { id: 'rx-7900-xtx', vendor: 'AMD', name: 'Radeon RX 7900 XTX', vram: 24, fp16Tflops: 123, tdp: 355, msrpEur: 1000, tier: 'consumer' },
  { id: 'rtx-a4000', vendor: 'NVIDIA', name: 'RTX A4000', vram: 16, fp16Tflops: 31, tdp: 140, msrpEur: 1200, tier: 'workstation' },
  { id: 'rtx-a5000', vendor: 'NVIDIA', name: 'RTX A5000', vram: 24, fp16Tflops: 66, tdp: 230, msrpEur: 2300, tier: 'workstation' },
  { id: 'rtx-a6000', vendor: 'NVIDIA', name: 'RTX A6000', vram: 48, fp16Tflops: 78, tdp: 300, msrpEur: 4500, tier: 'workstation' },
  { id: 'l4', vendor: 'NVIDIA', name: 'L4', vram: 24, fp16Tflops: 121, tdp: 72, msrpEur: 2500, tier: 'datacenter' },
  { id: 'l40s', vendor: 'NVIDIA', name: 'L40S', vram: 48, fp16Tflops: 362, tdp: 350, msrpEur: 8000, tier: 'datacenter' },
  { id: 'h100-pcie', vendor: 'NVIDIA', name: 'H100 PCIe', vram: 80, fp16Tflops: 990, tdp: 350, msrpEur: 28000, tier: 'datacenter' },
]

/** Variantes GPU Apple M1 à M5 (cœurs GPU et mémoire unifiée max par ligne produit Apple). */
const APPLE_SILICON_GPUS: GpuCatalogEntry[] = [
  { id: 'apple-m1-gpu7', vendor: 'Apple', name: 'Apple M1 · 7 GPU · 16 Go unifiés max', vram: 16, fp16Tflops: 23, tdp: 18, msrpEur: 700, tier: 'consumer' },
  { id: 'apple-m1-gpu8', vendor: 'Apple', name: 'Apple M1 · 8 GPU · 16 Go unifiés max', vram: 16, fp16Tflops: 26, tdp: 20, msrpEur: 750, tier: 'consumer' },
  { id: 'apple-m1-pro-14gpu', vendor: 'Apple', name: 'Apple M1 Pro · 14 GPU · 32 Go max', vram: 32, fp16Tflops: 45, tdp: 32, msrpEur: 1600, tier: 'workstation' },
  { id: 'apple-m1-pro-16gpu', vendor: 'Apple', name: 'Apple M1 Pro · 16 GPU · 32 Go max', vram: 32, fp16Tflops: 52, tdp: 36, msrpEur: 1900, tier: 'workstation' },
  { id: 'apple-m1-max-24gpu', vendor: 'Apple', name: 'Apple M1 Max · 24 GPU · 64 Go max', vram: 64, fp16Tflops: 78, tdp: 52, msrpEur: 2600, tier: 'workstation' },
  { id: 'apple-m1-max-32gpu', vendor: 'Apple', name: 'Apple M1 Max · 32 GPU · 64 Go max', vram: 64, fp16Tflops: 104, tdp: 62, msrpEur: 3000, tier: 'workstation' },
  { id: 'apple-m1-ultra-48gpu', vendor: 'Apple', name: 'Apple M1 Ultra · 48 GPU · 128 Go max', vram: 128, fp16Tflops: 156, tdp: 100, msrpEur: 5200, tier: 'workstation' },
  { id: 'apple-m1-ultra-64gpu', vendor: 'Apple', name: 'Apple M1 Ultra · 64 GPU · 128 Go max', vram: 128, fp16Tflops: 208, tdp: 120, msrpEur: 6000, tier: 'workstation' },

  { id: 'apple-m2-gpu8', vendor: 'Apple', name: 'Apple M2 · 8 GPU · 24 Go max', vram: 24, fp16Tflops: 28, tdp: 22, msrpEur: 800, tier: 'consumer' },
  { id: 'apple-m2-gpu10', vendor: 'Apple', name: 'Apple M2 · 10 GPU · 24 Go max', vram: 24, fp16Tflops: 36, tdp: 25, msrpEur: 900, tier: 'consumer' },
  { id: 'apple-m2-pro-16gpu', vendor: 'Apple', name: 'Apple M2 Pro · 16 GPU · 32 Go max', vram: 32, fp16Tflops: 57, tdp: 38, msrpEur: 1700, tier: 'workstation' },
  { id: 'apple-m2-pro-19gpu', vendor: 'Apple', name: 'Apple M2 Pro · 19 GPU · 32 Go max', vram: 32, fp16Tflops: 67, tdp: 43, msrpEur: 2000, tier: 'workstation' },
  { id: 'apple-m2-max-30gpu', vendor: 'Apple', name: 'Apple M2 Max · 30 GPU · 96 Go max', vram: 96, fp16Tflops: 107, tdp: 58, msrpEur: 3200, tier: 'workstation' },
  { id: 'apple-m2-max-38gpu', vendor: 'Apple', name: 'Apple M2 Max · 38 GPU · 96 Go max', vram: 96, fp16Tflops: 135, tdp: 68, msrpEur: 3600, tier: 'workstation' },
  { id: 'apple-m2-ultra-60gpu', vendor: 'Apple', name: 'Apple M2 Ultra · 60 GPU · 192 Go max', vram: 192, fp16Tflops: 213, tdp: 115, msrpEur: 6400, tier: 'workstation' },
  { id: 'apple-m2-ultra-76gpu', vendor: 'Apple', name: 'Apple M2 Ultra · 76 GPU · 192 Go max', vram: 192, fp16Tflops: 270, tdp: 130, msrpEur: 7200, tier: 'workstation' },

  { id: 'apple-m3-gpu8', vendor: 'Apple', name: 'Apple M3 · 8 GPU · 24 Go max', vram: 24, fp16Tflops: 32, tdp: 23, msrpEur: 850, tier: 'consumer' },
  { id: 'apple-m3-gpu10', vendor: 'Apple', name: 'Apple M3 · 10 GPU · 24 Go max', vram: 24, fp16Tflops: 41, tdp: 27, msrpEur: 950, tier: 'consumer' },
  { id: 'apple-m3-pro-11gpu', vendor: 'Apple', name: 'Apple M3 Pro · 11 GPU · 36 Go max', vram: 36, fp16Tflops: 45, tdp: 34, msrpEur: 2100, tier: 'workstation' },
  { id: 'apple-m3-pro-14gpu', vendor: 'Apple', name: 'Apple M3 Pro · 14 GPU · 36 Go max', vram: 36, fp16Tflops: 57, tdp: 40, msrpEur: 2400, tier: 'workstation' },
  { id: 'apple-m3-max-30gpu', vendor: 'Apple', name: 'Apple M3 Max · 30 GPU · 128 Go max', vram: 128, fp16Tflops: 122, tdp: 62, msrpEur: 3800, tier: 'workstation' },
  { id: 'apple-m3-max-40gpu', vendor: 'Apple', name: 'Apple M3 Max · 40 GPU · 128 Go max', vram: 128, fp16Tflops: 162, tdp: 76, msrpEur: 4400, tier: 'workstation' },
  { id: 'apple-m3-ultra-60gpu', vendor: 'Apple', name: 'Apple M3 Ultra · 60 GPU · 192 Go max', vram: 192, fp16Tflops: 243, tdp: 118, msrpEur: 8000, tier: 'workstation' },
  { id: 'apple-m3-ultra-76gpu', vendor: 'Apple', name: 'Apple M3 Ultra · 76 GPU · 192 Go max', vram: 192, fp16Tflops: 308, tdp: 132, msrpEur: 9000, tier: 'workstation' },

  { id: 'apple-m4-gpu8', vendor: 'Apple', name: 'Apple M4 · 8 GPU · 32 Go max', vram: 32, fp16Tflops: 41, tdp: 25, msrpEur: 950, tier: 'consumer' },
  { id: 'apple-m4-gpu10', vendor: 'Apple', name: 'Apple M4 · 10 GPU · 32 Go max', vram: 32, fp16Tflops: 52, tdp: 28, msrpEur: 1100, tier: 'consumer' },
  { id: 'apple-m4-pro-16gpu', vendor: 'Apple', name: 'Apple M4 Pro · 16 GPU · 64 Go max', vram: 64, fp16Tflops: 82, tdp: 44, msrpEur: 2300, tier: 'workstation' },
  { id: 'apple-m4-pro-20gpu', vendor: 'Apple', name: 'Apple M4 Pro · 20 GPU · 64 Go max', vram: 64, fp16Tflops: 103, tdp: 50, msrpEur: 2700, tier: 'workstation' },
  { id: 'apple-m4-max-32gpu', vendor: 'Apple', name: 'Apple M4 Max · 32 GPU · 128 Go max', vram: 128, fp16Tflops: 165, tdp: 70, msrpEur: 4000, tier: 'workstation' },
  { id: 'apple-m4-max-40gpu', vendor: 'Apple', name: 'Apple M4 Max · 40 GPU · 128 Go max', vram: 128, fp16Tflops: 206, tdp: 80, msrpEur: 4600, tier: 'workstation' },

  { id: 'apple-m5-gpu8', vendor: 'Apple', name: 'Apple M5 · 8 GPU · 32 Go max', vram: 32, fp16Tflops: 58, tdp: 30, msrpEur: 1200, tier: 'consumer' },
  { id: 'apple-m5-gpu10', vendor: 'Apple', name: 'Apple M5 · 10 GPU · 32 Go max', vram: 32, fp16Tflops: 72, tdp: 35, msrpEur: 1400, tier: 'consumer' },
  { id: 'apple-m5-pro-16gpu', vendor: 'Apple', name: 'Apple M5 Pro · 16 GPU · 64 Go max · 307 Go/s', vram: 64, fp16Tflops: 115, tdp: 50, msrpEur: 2900, tier: 'workstation' },
  { id: 'apple-m5-pro-20gpu', vendor: 'Apple', name: 'Apple M5 Pro · 20 GPU · 64 Go max · 307 Go/s', vram: 64, fp16Tflops: 144, tdp: 58, msrpEur: 3500, tier: 'workstation' },
  { id: 'apple-m5-max-32gpu', vendor: 'Apple', name: 'Apple M5 Max · 32 GPU · 64 Go max · 460 Go/s', vram: 64, fp16Tflops: 230, tdp: 75, msrpEur: 4200, tier: 'workstation' },
  { id: 'apple-m5-max-40gpu', vendor: 'Apple', name: 'Apple M5 Max · 40 GPU · 128 Go max · 614 Go/s', vram: 128, fp16Tflops: 288, tdp: 90, msrpEur: 5000, tier: 'workstation' },
]

export const GPU_CATALOG: GpuCatalogEntry[] = [...DISCRETE_GPUS, ...APPLE_SILICON_GPUS]
