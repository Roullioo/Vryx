import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { STORYTELLING } from '../../data/storytelling'

export function ClientsSection() {
  const s = STORYTELLING.clientsSection

  return (
    <section
      id="clients"
      className="border-b border-border bg-surface py-20 sm:py-28"
      aria-labelledby="clients-heading"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          viewport={{ once: true, margin: '-60px' }}
          className="panel mx-auto max-w-4xl px-6 py-12 text-center sm:px-10 sm:py-14 lg:px-14 lg:py-16"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{s.eyebrow}</p>
          <h2
            id="clients-heading"
            className="font-display mt-4 text-3xl font-bold tracking-tight text-fg sm:text-4xl lg:text-[2.5rem] text-pretty"
          >
            {s.title}
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">{s.intro}</p>
          <div className="mt-10">
            <Link to="/simulateur" className="btn-secondary px-7 py-3 text-base">
              Chiffrer dans le simulateur
            </Link>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
