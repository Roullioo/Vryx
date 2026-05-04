import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { STORYTELLING } from '../../data/storytelling'
import { useAuth } from '../../context/AuthContext'

export function CTASection() {
  const c = STORYTELLING.cta
  const { user } = useAuth()
  const secondaryTo = user ? '/compte' : c.secondary.to
  const secondaryLabel = user ? 'Mon compte' : c.secondary.label

  return (
    <section className="border-t border-border bg-surface py-20 sm:py-28" aria-labelledby="cta-home-heading">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          viewport={{ once: true, margin: '-60px' }}
          className="panel mx-auto max-w-3xl px-6 py-12 text-center sm:px-10 sm:py-14"
        >
          <h2
            id="cta-home-heading"
            className="font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl text-pretty"
          >
            {c.title}
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted sm:text-lg">{c.body}</p>
          <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center sm:justify-center">
            <Link to={c.primary.to} className="btn-primary px-8 py-3.5 text-base">
              {c.primary.label}
            </Link>
            <Link to={secondaryTo} className="btn-secondary px-8 py-3.5 text-base">
              {secondaryLabel}
            </Link>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
