import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import {
  WORKER_INSTALL_LINES,
} from '../../data/workersContent'

type WorkerSetupPanelProps = {
  showDownloadCta?: boolean
}

export function WorkerSetupPanel({ showDownloadCta = true }: WorkerSetupPanelProps) {
  return (
    <motion.div
      className="flex flex-col gap-5"
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
    >
      <div className="panel rounded-2xl p-6 sm:p-7">
        <h3 className="font-display text-lg font-semibold tracking-tight text-fg">Spécifications</h3>
        <dl className="mt-4 space-y-3 font-mono text-sm">
          <div className="flex justify-between border-b border-border/80 py-2">
            <dt className="text-muted">GPU</dt>
            <dd className="text-accent">NVIDIA (CUDA)</dd>
          </div>
          <div className="flex justify-between border-b border-border/80 py-2">
            <dt className="text-muted">VRAM min.</dt>
            <dd className="text-fg">12 Go</dd>
          </div>
          <div className="flex justify-between border-b border-border/80 py-2">
            <dt className="text-muted">Réseau</dt>
            <dd className="text-electric">Fibre · ping {'<'} 30 ms</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-muted">Profil matériel</dt>
            <dd className="text-fg">NVIDIA récentes ou AMD RX équivalent · 12 Go VRAM min.</dd>
          </div>
        </dl>
      </div>

      <div id="install" className="code-block-surface scroll-mt-28 rounded-2xl border border-border/70 p-5 sm:p-6">
        <p className="font-mono text-xs uppercase tracking-wide text-muted">Installation</p>
        {WORKER_INSTALL_LINES.map((line) => (
          <div key={line.label} className="mt-4 first:mt-3">
            <p className="font-mono text-xs text-muted/90"># {line.label}</p>
            <p className="break-all font-mono text-sm text-accent">{line.cmd}</p>
          </div>
        ))}
      </div>

      {showDownloadCta && (
        <motion.div whileHover={{ y: -2 }}>
          <Link
            to="/workers#install"
            className="btn-secondary inline-flex w-full items-center justify-center gap-2 rounded-xl py-4 font-semibold"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Voir l’installation
          </Link>
        </motion.div>
      )}
    </motion.div>
  )
}
