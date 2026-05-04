import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { EurSign } from '../components/icons/Icons'
import { GPU_CATALOG, type GpuTier } from '../data/gpuCatalog'
import { STORYTELLING } from '../data/storytelling'
import {
  VELOCITY_EUR_PER_MILLION,
  WORKER_EUR_PER_TFLOP_HOUR,
  computeFleetWorkerProfit,
  computeWorkerGpuProfit,
  formatEur,
  runSimulator,
  workerNetSparkline12,
  type FleetLine,
  type WorkerSimMode,
} from '../lib/simulator'

const PRESETS = [
  { label: 'Démarrage', millions: 5, ref: 4.2 },
  { label: 'Croissance', millions: 80, ref: 4.8 },
  { label: 'Entreprise', millions: 400, ref: 3.9 },
]

const VOLUME_CHART_POINTS = [5, 15, 40, 80, 160]

type TabId = 'inference' | 'worker'

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1e-6)
  const w = 100
  const h = 28
  const denom = Math.max(values.length - 1, 1)
  const pts = values
    .map((v, i) => {
      const x = (i / denom) * w
      const y = h - (v / max) * (h - 4) - 2
      return `${x},${y}`
    })
    .join(' ')
  return (
    <svg width={88} height={32} viewBox={`0 0 ${w} ${h}`} className="text-success" aria-hidden>
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
        opacity={0.85}
      />
    </svg>
  )
}

export function SimulatorPage() {
  const [tab, setTab] = useState<TabId>('inference')

  const [millions, setMillions] = useState(25)
  const [refEur, setRefEur] = useState(4.5)
  const [poolN, setPoolN] = useState(16)
  const [outTok, setOutTok] = useState(512)

  const result = useMemo(
    () =>
      runSimulator({
        millionsTokensPerMonth: millions,
        referenceEurPerMillion: refEur,
        poolCandidateCount: poolN,
        avgOutputTokensPerRequest: outTok,
      }),
    [millions, refEur, poolN, outTok],
  )

  const latGainPct =
    result.estimatedSoloP50Ms > 0
      ? ((result.estimatedSoloP50Ms - result.estimatedPoolP50Ms) / result.estimatedSoloP50Ms) * 100
      : 0

  const chartRows = useMemo(
    () =>
      VOLUME_CHART_POINTS.map((m) => {
        const r = runSimulator({
          millionsTokensPerMonth: m,
          referenceEurPerMillion: refEur,
          poolCandidateCount: poolN,
          avgOutputTokensPerRequest: outTok,
        })
        return { millions: m, solo: r.monthlySoloEuro, pool: r.monthlyPoolEuro }
      }),
    [refEur, poolN, outTok],
  )
  const chartMax = Math.max(...chartRows.flatMap((r) => [r.solo, r.pool]), 1)
  const chartAreaPx = 160

  const [utilizationPct, setUtilizationPct] = useState(55)
  const [electricityEurPerKwh, setElectricityEurPerKwh] = useState(0.18)
  const [workerMode, setWorkerMode] = useState<WorkerSimMode>('race-pool')
  const [gpuQuery, setGpuQuery] = useState('')
  const [vendorFilter, setVendorFilter] = useState<'all' | 'NVIDIA' | 'AMD' | 'Apple'>('all')
  const [tierFilter, setTierFilter] = useState<'all' | GpuTier>('all')
  const [vramMin, setVramMin] = useState(0)
  const [sortKey, setSortKey] = useState<'net' | 'name' | 'roi' | 'vram'>('vram')
  const [selectedGpuId, setSelectedGpuId] = useState<string>(GPU_CATALOG[0]?.id ?? '')
  const [fleetCounts, setFleetCounts] = useState<Record<string, number>>({})

  const workerInput = useMemo(
    () => ({
      utilizationPct,
      electricityEurPerKwh,
      mode: workerMode,
    }),
    [utilizationPct, electricityEurPerKwh, workerMode],
  )

  const workerRows = useMemo(() => {
    const q = gpuQuery.trim().toLowerCase()
    let list = GPU_CATALOG.map((gpu) => ({
      gpu,
      profit: computeWorkerGpuProfit(gpu, workerInput),
    }))
    if (q) list = list.filter(({ gpu }) => gpu.name.toLowerCase().includes(q) || gpu.id.includes(q))
    if (vendorFilter !== 'all') list = list.filter(({ gpu }) => gpu.vendor === vendorFilter)
    if (tierFilter !== 'all') list = list.filter(({ gpu }) => gpu.tier === tierFilter)
    if (vramMin > 0) list = list.filter(({ gpu }) => gpu.vram >= vramMin)

    list.sort((a, b) => {
      if (sortKey === 'name') return a.gpu.name.localeCompare(b.gpu.name, 'fr')
      if (sortKey === 'roi') {
        const ra = a.profit.roiMonths ?? 9999
        const rb = b.profit.roiMonths ?? 9999
        return ra - rb
      }
      if (sortKey === 'vram') return b.gpu.vram - a.gpu.vram
      return b.profit.netMonthlyEuro - a.profit.netMonthlyEuro
    })
    return list
  }, [gpuQuery, vendorFilter, tierFilter, vramMin, sortKey, workerInput])

  const selectedGpu = GPU_CATALOG.find((g) => g.id === selectedGpuId) ?? GPU_CATALOG[0]
  const selectedProfit = selectedGpu ? computeWorkerGpuProfit(selectedGpu, workerInput) : null

  const fleetLines: FleetLine[] = useMemo(
    () =>
      Object.entries(fleetCounts)
        .filter(([, c]) => c > 0)
        .map(([id, count]) => {
          const gpu = GPU_CATALOG.find((g) => g.id === id)
          return gpu ? { gpu, count } : null
        })
        .filter(Boolean) as FleetLine[],
    [fleetCounts],
  )

  const fleetProfit = useMemo(() => computeFleetWorkerProfit(fleetLines, workerInput), [fleetLines, workerInput])

  function addGpuToFleet(id: string) {
    setFleetCounts((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
  }

  function removeOneFromFleet(id: string) {
    setFleetCounts((prev) => {
      const n = (prev[id] ?? 0) - 1
      const next = { ...prev }
      if (n <= 0) delete next[id]
      else next[id] = n
      return next
    })
  }

  const disc = STORYTELLING.disclaimer

  return (
    <div className="border-b border-border bg-bg pb-20 sm:pb-28">
      <section
        className="relative isolate -mt-[4.25rem] flex min-h-[min(82vh,34rem)] flex-col overflow-hidden border-b border-border pt-[4.25rem] sm:min-h-[min(84vh,38rem)]"
        aria-labelledby="simulator-hero-heading"
      >
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))] overflow-hidden"
          aria-hidden
        >
          <div
            className="absolute inset-0 scale-105 bg-cover bg-center bg-no-repeat blur-[3px]"
            style={{ backgroundImage: "url('/inference.png')" }}
          />
        </div>
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))] bg-slate-950/58 sm:bg-slate-950/52"
          aria-hidden
        />

        <div className="relative z-10 flex min-h-[inherit] flex-1 flex-col items-center justify-center px-4 pb-12 pt-8 text-center sm:pb-14 sm:pt-10">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="max-w-2xl"
          >
            <h1
              id="simulator-hero-heading"
              className="font-display text-balance text-3xl font-semibold leading-tight tracking-tight text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.45)] sm:text-4xl md:text-[2.35rem]"
            >
              Coûts d&apos;inférence et rentabilité GPU
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-pretty text-base leading-snug text-white/88 sm:mt-5 sm:text-lg">
              Projettez vos volumes et votre matériel avec les hypothèses Vryx : deux feuilles de route
              complémentaires.
            </p>
            <div className="mt-9 flex w-full flex-col gap-3 sm:mx-auto sm:max-w-xl sm:flex-row sm:justify-center sm:gap-4">
              <Link
                to="/compte#facturation"
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-white/90 sm:flex-none sm:px-8 sm:text-base"
              >
                Acheter des crédits
              </Link>
              <Link
                to="/workers#install"
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/35 bg-white/5 px-6 py-3 text-sm font-semibold text-white backdrop-blur-[2px] transition-colors hover:bg-white/12 sm:flex-none sm:px-8 sm:text-base"
              >
                Télécharger le worker
              </Link>
            </div>
          </motion.div>
        </div>
      </section>

      <div className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl justify-center px-4 py-5 sm:px-6 lg:px-8">
          <div
            className="inline-flex w-full max-w-md rounded-xl border border-border bg-elevated p-1 sm:max-w-none sm:w-auto"
            role="tablist"
            aria-label="Type de simulation"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'inference'}
              className={`min-h-11 flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors sm:flex-none sm:px-6 ${
                tab === 'inference' ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-fg'
              }`}
              onClick={() => setTab('inference')}
            >
              Coût inférence
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'worker'}
              className={`min-h-11 flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors sm:flex-none sm:px-6 ${
                tab === 'worker' ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-fg'
              }`}
              onClick={() => setTab('worker')}
            >
              Rentabilité worker
            </button>
          </div>
        </div>
      </div>

      {tab === 'inference' && (
        <div className="mx-auto grid max-w-5xl gap-10 px-4 py-12 lg:grid-cols-12 lg:gap-12 lg:px-8 lg:py-16">
          <motion.div
            className="space-y-6 lg:col-span-5"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            <div className="panel p-5 sm:p-6">
              <label className="block font-mono text-xs uppercase tracking-wider text-muted">
                Volume (M tokens / mois)
              </label>
              <div className="mt-3 flex items-center gap-4">
                <input
                  type="range"
                  min={0.5}
                  max={500}
                  step={0.5}
                  value={millions}
                  onChange={(e) => setMillions(Number(e.target.value))}
                  className="h-2 w-full flex-1 cursor-pointer accent-accent"
                />
                <input
                  type="number"
                  min={0.1}
                  max={1_000_000}
                  step={0.1}
                  value={millions}
                  onChange={(e) => setMillions(Number(e.target.value) || 0)}
                  className="w-24 rounded-lg border border-border bg-bg px-2 py-1.5 text-right font-mono text-sm text-fg"
                />
              </div>
              <p className="mt-2 text-xs text-muted">Entrée + sortie, sur un mois.</p>
            </div>

            <div className="panel p-5 sm:p-6">
              <label className="block font-mono text-xs uppercase tracking-wider text-muted">
                Prix ailleurs (
                <EurSign className="font-mono font-semibold text-muted" /> / million de tokens)
              </label>
              <div className="mt-3 flex items-center gap-4">
                <input
                  type="range"
                  min={1}
                  max={18}
                  step={0.1}
                  value={refEur}
                  onChange={(e) => setRefEur(Number(e.target.value))}
                  className="h-2 w-full flex-1 cursor-pointer accent-electric"
                />
                <input
                  type="number"
                  min={0.1}
                  max={80}
                  step={0.05}
                  value={refEur}
                  onChange={(e) => setRefEur(Number(e.target.value) || 0)}
                  className="w-24 rounded-lg border border-border bg-bg px-2 py-1.5 text-right font-mono text-sm text-fg"
                />
              </div>
              <p className="mt-2 text-xs text-muted">Référence fournisseur « classique ».</p>
            </div>

            <div className="panel p-5 sm:p-6">
              <label className="block font-mono text-xs uppercase tracking-wider text-muted">GPU en course (N)</label>
              <div className="mt-3 flex items-center gap-4">
                <input
                  type="range"
                  min={4}
                  max={96}
                  step={1}
                  value={poolN}
                  onChange={(e) => setPoolN(Number(e.target.value))}
                  className="h-2 w-full flex-1 cursor-pointer accent-warning"
                />
                <span className="w-12 text-right font-mono text-sm text-fg">{poolN}</span>
              </div>
              <p className="mt-2 text-xs text-muted">Sert à estimer la latence Race-Pool, pas le prix Vryx.</p>
            </div>

            <div className="panel p-5 sm:p-6">
              <label className="block font-mono text-xs uppercase tracking-wider text-muted">
                Réponse moyenne (tokens)
              </label>
              <div className="mt-3 flex items-center gap-4">
                <input
                  type="range"
                  min={64}
                  max={8192}
                  step={64}
                  value={outTok}
                  onChange={(e) => setOutTok(Number(e.target.value))}
                  className="h-2 w-full flex-1 cursor-pointer accent-accent"
                />
                <input
                  type="number"
                  min={16}
                  max={128000}
                  step={16}
                  value={outTok}
                  onChange={(e) => setOutTok(Number(e.target.value) || 16)}
                  className="w-24 rounded-lg border border-border bg-bg px-2 py-1.5 text-right font-mono text-sm text-fg"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setMillions(p.millions)
                    setRefEur(p.ref)
                  }}
                  className="rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-xs text-muted transition-colors hover:border-accent/40 hover:text-accent"
                >
                  {p.label}
                </button>
              ))}
              <Link
                to="/comparatif"
                className="rounded-lg border border-electric/35 px-3 py-1.5 font-mono text-xs text-electric transition-colors hover:bg-electric/10"
              >
                Comparatif workers
              </Link>
            </div>
          </motion.div>

          <motion.div
            className="space-y-6 lg:col-span-7"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
          >
            <div className="panel overflow-hidden">
              <div className="border-b border-border bg-surface px-5 py-4 sm:px-6">
                <h2 className="font-display text-lg font-semibold text-fg sm:text-xl">Résultat</h2>
              </div>
              <div className="grid gap-0 sm:grid-cols-2">
                <div className="border-b border-border p-5 sm:border-r sm:border-b-0 sm:p-6">
                  <p className="font-mono text-xs uppercase tracking-wider text-muted">Ailleurs</p>
                  <p className="font-display mt-2 text-3xl font-bold text-warning tabular-nums">
                    {formatEur(result.monthlySoloEuro)}
                    <EurSign className="text-warning" />
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    / mois · {formatEur(result.yearlySoloEuro)}
                    <EurSign /> / an
                  </p>
                </div>
                <div className="border-b border-border p-5 sm:p-6">
                  <p className="font-mono text-xs uppercase tracking-wider text-muted">Vryx</p>
                  <p className="font-display mt-2 text-3xl font-bold text-accent tabular-nums">
                    {formatEur(result.monthlyPoolEuro)}
                    <EurSign className="text-accent" />
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    / mois · {VELOCITY_EUR_PER_MILLION.toFixed(2)}
                    <EurSign /> / M tokens
                  </p>
                </div>
              </div>
              <div className="border-t border-border bg-accent/5 p-5 sm:p-6">
                <p className="font-mono text-xs uppercase tracking-wider text-accent">Économie / mois</p>
                <p className="font-display mt-1 text-2xl font-bold text-fg tabular-nums sm:text-3xl">
                  {formatEur(result.savingsMonthlyEuro)}
                  <EurSign />
                  <span className="ml-2 text-lg font-medium text-muted">
                    ({result.savingsMonthlyPct.toFixed(0)} %)
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  ≈ {formatEur(result.savingsYearlyEuro)}
                  <EurSign /> / an au même volume.
                </p>
              </div>
            </div>

            <div className="panel p-5 sm:p-6">
              <h3 className="font-display text-base font-semibold text-fg">Coût mensuel selon le volume</h3>
              <p className="mt-1 text-xs text-muted">
                Barres : référence « ailleurs » (orange) vs Vryx (bleu), pour les volumes indiqués avec vos
                paramètres actuels.
              </p>
              <div className="mt-6 flex justify-between gap-2 border-b border-border pb-2">
                {chartRows.map((row) => {
                  const soloPx =
                    chartMax > 0
                      ? Math.max(Math.round((row.solo / chartMax) * chartAreaPx), row.solo > 0 ? 4 : 0)
                      : 0
                  const poolPx =
                    chartMax > 0
                      ? Math.max(Math.round((row.pool / chartMax) * chartAreaPx), row.pool > 0 ? 4 : 0)
                      : 0
                  return (
                    <div key={row.millions} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                      <div className="flex h-40 w-full max-w-14 items-end justify-center gap-1">
                        <div
                          className="w-2.5 shrink-0 rounded-t bg-warning/90 transition-[height] duration-200"
                          style={{ height: soloPx }}
                          title={`Ailleurs ${formatEur(row.solo)} €`}
                        />
                        <div
                          className="w-2.5 shrink-0 rounded-t bg-accent transition-[height] duration-200"
                          style={{ height: poolPx }}
                          title={`Vryx ${formatEur(row.pool)} €`}
                        />
                      </div>
                      <span className="font-mono text-[10px] text-muted">{row.millions} M</span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="panel p-5 sm:p-6">
              <h3 className="font-display text-base font-semibold text-fg">Latence (ordre de grandeur)</h3>
              <p className="mt-2 text-xs text-muted">
                Plus il y a de GPU en compétition, plus la réponse peut arriver vite. Chiffre indicatif.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="panel-inset p-4">
                  <p className="font-mono text-xs text-muted">Un seul chemin (réf.)</p>
                  <p className="font-display mt-1 text-2xl font-bold text-warning">{result.estimatedSoloP50Ms} ms</p>
                </div>
                <div className="panel-inset p-4">
                  <p className="font-mono text-xs text-muted">Avec N = {poolN}</p>
                  <p className="font-display mt-1 text-2xl font-bold text-electric">{result.estimatedPoolP50Ms} ms</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted">
                ≈ <span className="text-electric">{latGainPct.toFixed(0)} %</span> de temps en moins qu’en référence
                sur ce profil.
              </p>
            </div>

            <p className="panel-inset p-3 text-xs text-muted">{disc.inferenceSim}</p>
          </motion.div>
        </div>
      )}

      {tab === 'worker' && (
        <div className="mx-auto max-w-7xl px-4 py-12 lg:px-6 lg:py-16">
          <div className="flex flex-col gap-10 lg:flex-row lg:items-start lg:gap-12">
            <aside className="w-full shrink-0 space-y-8 lg:w-[min(100%,280px)] lg:max-w-[300px] lg:pr-2">
              <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
                <p className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">Hypothèses</p>
                <label htmlFor="worker-util" className="mt-4 block font-mono text-xs text-muted">
                  Disponibilité (% du mois)
                </label>
                <div className="mt-2 flex items-center gap-3">
                  <input
                    id="worker-util"
                    type="range"
                    min={10}
                    max={100}
                    value={utilizationPct}
                    onChange={(e) => setUtilizationPct(Number(e.target.value))}
                    className="h-2 w-full accent-accent"
                  />
                  <span className="w-10 text-right font-mono text-sm">{utilizationPct}</span>
                </div>
                <label htmlFor="worker-kwh" className="mt-5 block font-mono text-xs text-muted">
                  Électricité (€ / kWh)
                </label>
                <div className="mt-2 flex items-center gap-3">
                  <input
                    id="worker-kwh"
                    type="range"
                    min={0.08}
                    max={0.55}
                    step={0.01}
                    value={electricityEurPerKwh}
                    onChange={(e) => setElectricityEurPerKwh(Number(e.target.value))}
                    className="h-2 w-full accent-electric"
                  />
                  <span className="w-12 text-right font-mono text-sm">{electricityEurPerKwh.toFixed(2)}</span>
                </div>
                <p className="mt-2 text-xs text-muted">
                  Taux interne : {WORKER_EUR_PER_TFLOP_HOUR.toFixed(3)}{' '}
                  <EurSign className="text-muted" /> / (unité perf × h), puis facteur selon la VRAM du GPU (voir
                  détail).
                </p>
                <p className="mt-4 font-mono text-xs text-muted">Mode worker</p>
                <div className="mt-2 flex rounded-lg bg-surface p-1">
                  <button
                    type="button"
                    className={`flex-1 rounded-md py-2 text-xs font-semibold sm:text-sm ${
                      workerMode === 'solo' ? 'bg-card text-fg shadow-sm' : 'text-muted'
                    }`}
                    onClick={() => setWorkerMode('solo')}
                  >
                    Solo
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded-md py-2 text-xs font-semibold sm:text-sm ${
                      workerMode === 'race-pool' ? 'bg-card text-fg shadow-sm' : 'text-muted'
                    }`}
                    onClick={() => setWorkerMode('race-pool')}
                  >
                    Race-Pool
                  </button>
                </div>
              </div>

              {selectedGpu && selectedProfit && (
                <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
                  <p className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">Détail</p>
                  <p className="mt-2 font-display text-lg font-semibold text-fg">{selectedGpu.name}</p>
                  <dl className="mt-4 space-y-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">VRAM</dt>
                      <dd className="font-mono text-fg">{selectedGpu.vram} Go</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">Facteur mémoire (revenu)</dt>
                      <dd className="font-mono text-fg">×{selectedProfit.vramRevenueFactor.toFixed(2)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">Brut / mois</dt>
                      <dd className="font-mono font-semibold text-fg">
                        {formatEur(selectedProfit.grossMonthlyEuro)}
                        <EurSign />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">Électricité / mois</dt>
                      <dd className="font-mono text-warning">
                        −{formatEur(selectedProfit.electricityMonthlyEuro)}
                        <EurSign />
                      </dd>
                    </div>
                    <div className="divider" />
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">Net / mois</dt>
                      <dd className="font-mono font-bold text-success">
                        {formatEur(selectedProfit.netMonthlyEuro)}
                        <EurSign />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">ROI (MSRP indicatif)</dt>
                      <dd className="font-mono text-fg">
                        {selectedProfit.roiMonths != null ? `${selectedProfit.roiMonths.toFixed(0)} mois` : '-'}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2 text-xs">
                      <dt className="text-muted">Multiplicateur mode</dt>
                      <dd className="font-mono">×{selectedProfit.modeMultiplierApplied.toFixed(2)}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="btn-primary mt-5 w-full rounded-lg py-3 text-sm font-semibold"
                    onClick={() => addGpuToFleet(selectedGpu.id)}
                  >
                    Ajouter à la flotte simulée
                  </button>
                </div>
              )}

              {fleetLines.length > 0 && (
                <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
                  <p className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">Flotte</p>
                  <ul className="mt-3 space-y-2 text-sm">
                    {fleetLines.map(({ gpu, count }) => (
                      <li key={gpu.id} className="flex items-center justify-between gap-2">
                        <span className="truncate text-fg">
                          {gpu.name}{' '}
                          <span className="text-muted">×{count}</span>
                        </span>
                        <button
                          type="button"
                          className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted hover:border-alert/40 hover:text-alert"
                          onClick={() => removeOneFromFleet(gpu.id)}
                        >
                          −1
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="divider my-4" />
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">Net flotte / mois</span>
                    <span className="font-mono font-bold text-success">
                      {formatEur(fleetProfit.netMonthlyEuro)}
                      <EurSign />
                    </span>
                  </div>
                </div>
              )}
            </aside>

            <div className="min-w-0 flex-1">
              <div className="mb-6 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <input
                    type="search"
                    placeholder="Rechercher un GPU…"
                    value={gpuQuery}
                    onChange={(e) => setGpuQuery(e.target.value)}
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg sm:col-span-2"
                  />
                  <select
                    value={vendorFilter}
                    onChange={(e) => setVendorFilter(e.target.value as typeof vendorFilter)}
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                  >
                    <option value="all">Tous fabricants</option>
                    <option value="NVIDIA">NVIDIA</option>
                    <option value="AMD">AMD</option>
                    <option value="Apple">Apple</option>
                  </select>
                  <select
                    value={tierFilter}
                    onChange={(e) => setTierFilter(e.target.value as typeof tierFilter)}
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
                  >
                    <option value="all">Tous segments</option>
                    <option value="consumer">Grand public</option>
                    <option value="workstation">Workstation</option>
                    <option value="datacenter">Datacenter</option>
                  </select>
                  <label className="flex items-center gap-2 text-sm text-muted sm:col-span-2 lg:col-span-1">
                    VRAM min.
                    <input
                      type="number"
                      min={0}
                      max={128}
                      value={vramMin || ''}
                      placeholder="0"
                      onChange={(e) => setVramMin(Number(e.target.value) || 0)}
                      className="w-20 rounded-lg border border-border bg-bg px-2 py-1.5 text-fg"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm text-muted sm:col-span-2 lg:col-span-3">
                    Trier par
                    <select
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
                      className="rounded-lg border border-border bg-bg px-3 py-2 text-fg"
                    >
                      <option value="vram">VRAM (Go)</option>
                      <option value="net">Net décroissant</option>
                      <option value="roi">ROI (mois)</option>
                      <option value="name">Nom</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto bg-card">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-muted">
                      <th className="px-3 py-3">GPU</th>
                      <th className="px-2 py-3">VRAM</th>
                      <th className="px-2 py-3">Perf</th>
                      <th className="px-2 py-3">TDP</th>
                      <th className="px-2 py-3">Brut</th>
                      <th className="px-2 py-3">Élec.</th>
                      <th className="px-2 py-3">Net</th>
                      <th className="px-2 py-3">ROI</th>
                      <th className="px-2 py-3">12 m.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workerRows.map(({ gpu, profit }) => {
                      const active = gpu.id === selectedGpuId
                      return (
                        <tr
                          key={gpu.id}
                          className={`cursor-pointer border-b border-border last:border-0 ${
                            active ? 'bg-accent/5' : 'hover:bg-elevated/80'
                          }`}
                          onClick={() => setSelectedGpuId(gpu.id)}
                        >
                          <td className="px-3 py-2.5 font-medium text-fg">
                            <span className="block truncate max-w-[200px] sm:max-w-none">{gpu.name}</span>
                            <span className="font-mono text-[10px] text-muted">{gpu.tier}</span>
                          </td>
                          <td className="px-2 py-2.5 font-mono text-muted">{gpu.vram} Go</td>
                          <td className="px-2 py-2.5 font-mono text-muted">{gpu.fp16Tflops}</td>
                          <td className="px-2 py-2.5 font-mono text-muted">{gpu.tdp} W</td>
                          <td className="px-2 py-2.5 font-mono tabular-nums">{formatEur(profit.grossMonthlyEuro)}</td>
                          <td className="px-2 py-2.5 font-mono tabular-nums text-warning">
                            {formatEur(profit.electricityMonthlyEuro)}
                          </td>
                          <td className="px-2 py-2.5 font-mono font-semibold tabular-nums text-success">
                            {formatEur(profit.netMonthlyEuro)}
                          </td>
                          <td className="px-2 py-2.5 font-mono text-muted">
                            {profit.roiMonths != null ? `${profit.roiMonths.toFixed(0)} m` : '-'}
                          </td>
                          <td className="px-2 py-2">
                            <Sparkline values={workerNetSparkline12(profit.netMonthlyEuro)} />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-xs text-muted">{disc.workerSim}</p>
            </div>
          </div>
        </div>
      )}

      <section
        className="relative isolate overflow-hidden border-t border-border py-14 sm:py-18"
        aria-labelledby="simulator-scope-heading"
      >
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/mid.png')" }}
          aria-hidden
        />
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/84 via-slate-950/74 to-slate-950/88" aria-hidden />
        <div className="relative z-10 mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <h2
              id="simulator-scope-heading"
              className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl"
            >
              Deux feuilles complémentaires
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-white/72 sm:text-base">
              Récapitulatif des deux approches. Les curseurs, graphiques et tableau sont dans les onglets plus haut sur
              la page.
            </p>
          </div>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            <article className="rounded-2xl border border-white/10 bg-black/50 px-6 py-6 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] sm:px-7 sm:py-7">
              <h3 className="font-display text-lg font-semibold text-white">Coût inférence</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/68">
                Pour les équipes qui facturent au volume : comparez une grille externe au tarif Vryx.
              </p>
              <ul className="mt-5 space-y-2.5 text-sm leading-relaxed text-white/72">
                <li className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden />
                  <span>Volume mensuel en millions de tokens (entrée et sortie).</span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden />
                  <span>Prix de référence au million pour estimer l&apos;écart budgétaire.</span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden />
                  <span>Lecture synthétique : économie mensuelle et ordre de grandeur de latence Race-Pool.</span>
                </li>
              </ul>
            </article>
            <article className="rounded-2xl border border-white/10 bg-black/50 px-6 py-6 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] sm:px-7 sm:py-7">
              <h3 className="font-display text-lg font-semibold text-white">Rentabilité worker</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/68">
                Pour celles et ceux qui hébergent du calcul : ordre de grandeur net avec le catalogue intégré.
              </p>
              <ul className="mt-5 space-y-2.5 text-sm leading-relaxed text-white/72">
                <li className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-electric" aria-hidden />
                  <span>Fiches GPU : VRAM, perf, conso ; filtres et tri sur le tableau.</span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-electric" aria-hidden />
                  <span>Hypothèses d&apos;occupation, prix de l&apos;électricité, mode Solo ou Race-Pool.</span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-electric" aria-hidden />
                  <span>Détail par carte, courbe indicative sur 12 mois, simulation de flotte.</span>
                </li>
              </ul>
            </article>
          </div>
        </div>
      </section>
    </div>
  )
}
