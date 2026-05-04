import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { STORYTELLING } from '../../data/storytelling'

export function WorkersSection() {
  const s = STORYTELLING.workersSection

  return (
    <section
      id="workers"
      className="border-b border-border bg-bg py-20 sm:py-28"
      aria-labelledby="workers-heading"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 lg:items-start">
          <motion.header
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{s.eyebrow}</p>
            <h2
              id="workers-heading"
              className="font-display mt-4 text-3xl font-bold tracking-tight text-fg sm:text-4xl lg:text-[2.5rem] lg:leading-tight text-pretty"
            >
              {s.title}
            </h2>
            <p className="mt-6 text-base leading-relaxed text-muted sm:text-lg">{s.bodyLead}</p>
          </motion.header>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.45, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
            className="panel flex flex-col gap-8 p-6 sm:p-8"
          >
            <p className="text-sm leading-relaxed text-muted sm:text-base">{s.bodyRange}</p>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link to="/comparatif" className="btn-primary px-7 py-3.5 text-center text-base">
                {s.linkCompare}
              </Link>
              <Link to="/workers" className="btn-secondary px-7 py-3.5 text-center text-base">
                {s.linkPage}
              </Link>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
