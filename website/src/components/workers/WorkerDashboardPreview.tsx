import { useEffect, useRef, useState } from 'react'
import { motion, useInView } from 'framer-motion'
import { EurSign, IconEuro, IconGpu } from '../icons/Icons'

function formatEuro(n: number) {
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function WorkerDashboardPreview() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const inView = useInView(wrapRef, { amount: 0.2 })
  const [balance, setBalance] = useState(12.06)
  const [tasks, setTasks] = useState(0)
  const [uptime, setUptime] = useState(0)
  const [latency, setLatency] = useState(0)

  useEffect(() => {
    if (!inView) return
    const id = window.setInterval(() => {
      setBalance((b) => Math.min(99.99, Math.round((b + Math.random() * 0.1 + 0.004) * 100) / 100))
      if (Math.random() > 0.65) setTasks((t) => t + 1)
      setLatency(14 + Math.floor(Math.random() * 22))
    }, 520)
    const up = window.setInterval(() => setUptime((h) => Math.min(999, h + 1)), 5000)
    return () => {
      clearInterval(id)
      clearInterval(up)
    }
  }, [inView])

  const payoutPct = Math.min(100, (balance / 50) * 100)

  return (
    <motion.div
      ref={wrapRef}
      className="panel relative overflow-hidden rounded-2xl border-electric/20 bg-gradient-to-b from-surface to-bg p-4 sm:p-6 lg:p-7"
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-25"
        style={{
          backgroundImage: `linear-gradient(rgba(0,255,136,0.05) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(0,255,136,0.05) 1px, transparent 1px)`,
          backgroundSize: '22px 22px',
        }}
      />
      <div className="relative">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-display text-lg font-semibold text-fg">Tableau de bord</h3>
            <p className="font-mono text-xs text-muted">Session simulée</p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 font-mono text-[10px] font-semibold text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
            LIVE
          </span>
        </div>

        <div className="mt-5 rounded-2xl border border-border/80 bg-bg/70 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)_inset] sm:mt-6 sm:p-5">
          <p className="font-mono text-xs text-muted">Gains session</p>
          <div className="mt-2 flex items-baseline gap-2.5">
            <IconEuro className="h-8 w-8 shrink-0 text-accent sm:h-9 sm:w-9" aria-hidden />
            <span className="font-display text-3xl font-bold tabular-nums text-success sm:text-5xl">
              {formatEuro(balance)}
              <EurSign className="text-accent" />
            </span>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-border">
            <motion.div
              className="stats-bar h-full rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${payoutPct}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
            <span className="tabular-nums">
              0<EurSign />
            </span>
            <span className="tabular-nums">
              Prochain virement : 50<EurSign />
            </span>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:mt-5 sm:grid-cols-3 sm:gap-3">
          <div className="rounded-xl border border-border/80 bg-bg/55 p-3">
            <p className="font-mono text-[10px] text-muted">Tâches</p>
            <p className="font-display text-lg font-bold tabular-nums sm:text-xl">{tasks}</p>
          </div>
          <div className="rounded-xl border border-border/80 bg-bg/55 p-3">
            <p className="font-mono text-[10px] text-muted">Uptime</p>
            <p className="font-display text-lg font-bold tabular-nums sm:text-xl">{uptime} h</p>
          </div>
          <div className="col-span-2 rounded-xl border border-border/80 bg-bg/55 p-3 sm:col-span-1">
            <p className="font-mono text-[10px] text-muted">Latence</p>
            <p className="font-display text-lg font-bold tabular-nums text-electric sm:text-xl">{latency} ms</p>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3 rounded-2xl border border-border/80 bg-bg/55 p-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-electric/15">
            <IconGpu className="h-6 w-6 text-electric" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-fg">NVIDIA RTX 4090</p>
            <p className="font-mono text-xs text-muted">24 Go VRAM · simulation</p>
          </div>
          <div className="text-right font-mono text-xs">
            <p className="text-accent">98 %</p>
            <p className="text-muted">75 °C</p>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
