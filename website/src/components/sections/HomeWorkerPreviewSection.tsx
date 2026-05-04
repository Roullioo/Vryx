import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { animate, motion } from 'framer-motion'
import { GPU_CATALOG, type GpuCatalogEntry } from '../../data/gpuCatalog'
import { STORYTELLING } from '../../data/storytelling'
import { computeWorkerGpuProfit, type WorkerProfitInput } from '../../lib/simulator'

const VRAM_MIN = Math.min(...GPU_CATALOG.map((g) => g.vram))
const VRAM_MAX = Math.max(...GPU_CATALOG.map((g) => g.vram))

function nearestGpuByVram(target: number): GpuCatalogEntry {
  let best = GPU_CATALOG[0]
  let bestDist = Infinity
  for (const g of GPU_CATALOG) {
    const d = Math.abs(g.vram - target)
    if (d < bestDist || (d === bestDist && g.fp16Tflops > best.fp16Tflops)) {
      bestDist = d
      best = g
    }
  }
  return best
}

const BASE_INPUT: Omit<WorkerProfitInput, 'utilizationPct'> = {
  electricityEurPerKwh: 0.22,
  mode: 'race-pool',
}

function formatEurCompact(n: number) {
  return n.toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
}

function vramBarPct(value: number) {
  const span = Math.max(VRAM_MAX - VRAM_MIN, 1)
  return ((value - VRAM_MIN) / span) * 100
}

function utilizationBarPct(value: number) {
  return ((value - 5) / 95) * 100
}

type PreviewSliderProps = {
  id: string
  label: string
  readout: ReactNode
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  fillPct: number
  ariaValueText: string
}

function PreviewSlider({
  id,
  label,
  readout,
  min,
  max,
  step,
  value,
  onChange,
  fillPct,
  ariaValueText,
}: PreviewSliderProps) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        <span className="font-mono text-sm tabular-nums text-muted">{readout}</span>
      </div>
      <div
        className="relative mt-2.5 rounded-full focus-within:ring-1 focus-within:ring-fg/12 focus-within:ring-offset-2 focus-within:ring-offset-bg"
        role="presentation"
      >
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-neutral-200">
          <div
            className="pointer-events-none h-full rounded-full bg-fg transition-[width] duration-100 ease-out"
            style={{ width: `${fillPct}%` }}
            aria-hidden
          />
        </div>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute -inset-y-2.5 inset-x-0 z-10 h-6 w-full cursor-pointer opacity-0 sm:h-7"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={ariaValueText}
        />
      </div>
    </div>
  )
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const fn = () => setReduced(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  return reduced
}

function AnimatedEuro({
  value,
  className,
  reducedMotion,
}: {
  value: number
  className?: string
  reducedMotion: boolean
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const fromRef = useRef(value)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reducedMotion) {
      el.textContent = formatEurCompact(value)
      fromRef.current = value
      return
    }
    const from = fromRef.current
    const controlsNum = animate(from, value, {
      duration: 0.48,
      ease: [0.22, 1, 0.36, 1],
      onUpdate(latest) {
        el.textContent = formatEurCompact(latest)
      },
    })
    const controlsPulse = animate(
      el,
      { opacity: [0.78, 1], y: [2, 0] },
      { duration: 0.34, ease: [0.22, 1, 0.36, 1] },
    )
    fromRef.current = value
    return () => {
      controlsNum.stop()
      controlsPulse.stop()
    }
  }, [value, reducedMotion])

  return <span ref={ref} className={className}>{formatEurCompact(value)}</span>
}

function AnimatedFactor({
  value,
  className,
  reducedMotion,
}: {
  value: number
  className?: string
  reducedMotion: boolean
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const fromRef = useRef(value)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reducedMotion) {
      el.textContent = value.toFixed(2)
      fromRef.current = value
      return
    }
    const from = fromRef.current
    const controlsNum = animate(from, value, {
      duration: 0.42,
      ease: [0.22, 1, 0.36, 1],
      onUpdate(latest) {
        el.textContent = latest.toFixed(2)
      },
    })
    const controlsPulse = animate(
      el,
      { opacity: [0.8, 1], y: [1, 0] },
      { duration: 0.3, ease: [0.22, 1, 0.36, 1] },
    )
    fromRef.current = value
    return () => {
      controlsNum.stop()
      controlsPulse.stop()
    }
  }, [value, reducedMotion])

  return <span ref={ref} className={className}>{value.toFixed(2)}</span>
}

export function HomeWorkerPreviewSection() {
  const reducedMotion = usePrefersReducedMotion()
  const disc = STORYTELLING.disclaimer.workerSim
  const [utilizationPct, setUtilizationPct] = useState(50)
  const [vramGb, setVramGb] = useState(16)

  const selectedGpu = useMemo(() => nearestGpuByVram(vramGb), [vramGb])

  const input: WorkerProfitInput = useMemo(
    () => ({ ...BASE_INPUT, utilizationPct }),
    [utilizationPct],
  )

  const profit = useMemo(() => computeWorkerGpuProfit(selectedGpu, input), [selectedGpu, input])
  const dailyNet = profit.netMonthlyEuro / 30
  const monthlyNet = profit.netMonthlyEuro

  const utilSliderId = 'home-worker-utilization'
  const vramSliderId = 'home-worker-vram'

  return (
    <section
      id="apercu-rentabilite"
      className="border-b border-border bg-bg py-16 sm:py-20 lg:py-24"
      aria-labelledby="preview-profit-heading"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="grid w-full gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(300px,60%)] lg:items-start lg:gap-x-8 xl:gap-x-12"
        >
          <header className="order-1 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between lg:order-none lg:col-start-1 lg:row-start-1 lg:max-w-lg">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wider text-muted">Workers</p>
              <h2
                id="preview-profit-heading"
                className="font-display mt-1 text-xl font-semibold tracking-tight text-fg sm:text-2xl"
              >
                Rentabilité indicative
              </h2>
              <p className="mt-1 text-sm text-muted">
                Repère catalogue : la VRAM choisie sélectionne le GPU le plus proche, puis calcul local dans le
                navigateur.
              </p>
            </div>
            <Link to="/workers" className="shrink-0 text-sm font-medium text-muted transition-colors hover:text-fg">
              En savoir plus
            </Link>
          </header>

          <figure className="order-3 mt-8 flex select-none justify-center sm:mt-10 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-14 lg:justify-end lg:self-start">
            <img
              src="/section1.png"
              alt="Illustration : postes de calcul reliés au rack serveur."
              width={1200}
              height={675}
              decoding="async"
              draggable={false}
              onContextMenu={(e) => e.preventDefault()}
              className="h-auto w-full max-w-[min(100%,36rem)] object-contain select-none sm:max-w-3xl md:max-w-5xl lg:max-w-none lg:w-full [-webkit-user-drag:none]"
            />
          </figure>

          <div className="order-2 py-2 sm:py-4 lg:order-none lg:col-start-1 lg:row-start-2 lg:max-w-lg">
            <PreviewSlider
              id={vramSliderId}
              label="Mémoire vidéo (Go)"
              readout={
                <span aria-live="polite">
                  {vramGb} Go · {selectedGpu.name}
                </span>
              }
              min={VRAM_MIN}
              max={VRAM_MAX}
              step={1}
              value={vramGb}
              onChange={setVramGb}
              fillPct={vramBarPct(vramGb)}
              ariaValueText={`${vramGb} gigaoctets, ${selectedGpu.name}`}
            />

            <div className="mt-8">
              <PreviewSlider
                id={utilSliderId}
                label="Disponibilité simulée sur le réseau"
                readout={<span aria-live="polite">{utilizationPct} %</span>}
                min={5}
                max={100}
                step={1}
                value={utilizationPct}
                onChange={setUtilizationPct}
                fillPct={utilizationBarPct(utilizationPct)}
                ariaValueText={`${utilizationPct} pour cent`}
              />
            </div>

            <div className="mt-10 grid gap-8 pt-2 sm:grid-cols-2 sm:pt-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted">Estimation nette</p>
                <p className="font-display mt-1 text-2xl font-semibold tabular-nums tracking-tight text-fg sm:text-3xl">
                  <AnimatedEuro value={dailyNet} reducedMotion={reducedMotion} className="inline-block" />{' '}
                  <span className="text-base font-normal text-muted sm:text-lg">€ / jour</span>
                </p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted">Sur 30 jours</p>
                <p className="font-display mt-1 text-2xl font-semibold tabular-nums tracking-tight text-fg sm:text-3xl">
                  <AnimatedEuro value={monthlyNet} reducedMotion={reducedMotion} className="inline-block" />{' '}
                  <span className="text-base font-normal text-muted sm:text-lg">€</span>
                </p>
              </div>
            </div>

            <p className="mt-8 text-xs leading-relaxed text-muted">
              Facteur mémoire (revenu) ×
              <AnimatedFactor
                value={profit.vramRevenueFactor}
                className="font-mono tabular-nums"
                reducedMotion={reducedMotion}
              />{' '}
              · mode Race-Pool · électricité 0,22 €/kWh. {disc}
            </p>

            <div className="mt-6">
              <Link
                to="/simulateur"
                className="inline-flex items-center text-sm font-semibold text-fg underline-offset-4 hover:underline"
              >
                Calculateur étendu
              </Link>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
