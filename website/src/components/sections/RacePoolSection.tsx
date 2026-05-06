import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { STORYTELLING } from '../../data/storytelling'

export function RacePoolSection() {
  const rp = STORYTELLING.racePoolSection

  return (
    <section
      id="race-pool"
      className="relative isolate overflow-hidden border-b border-border"
      aria-labelledby="race-pool-heading"
    >
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/mid.png')" }}
        aria-hidden
      />
      <div className="hero-overlay absolute inset-0" aria-hidden />

      <div className="relative z-10 mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28 lg:px-8 lg:py-32">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-14 lg:items-start">
          <header className="lg:col-span-5">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/55">{rp.eyebrow}</p>
            <h2
              id="race-pool-heading"
              className="font-display mt-4 text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[2.5rem] lg:leading-tight text-pretty"
            >
              {rp.title}
            </h2>
            <p className="mt-6 text-base leading-relaxed text-white/78 sm:text-lg">{rp.intro}</p>
            <div className="mt-8">
              <Link
                to="/race-pool"
                className="inline-flex items-center justify-center rounded-lg border border-white/35 bg-white/10 px-6 py-3 text-base font-medium text-white backdrop-blur-sm transition-colors hover:bg-white/20"
              >
                Découvrir l&apos;architecture
              </Link>
            </div>
          </header>

          <div className="space-y-4 lg:col-span-7">
            {rp.highlights.map((item, i) => (
              <motion.article
                key={item.title}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-40px' }}
                transition={{ delay: i * 0.06, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="rounded-2xl border border-white/12 bg-white/[0.06] p-6 backdrop-blur-md sm:p-7"
              >
                <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-white/45">
                  {String(i + 1).padStart(2, '0')}
                </p>
                <h3 className="font-display mt-2 text-lg font-semibold text-white sm:text-xl">{item.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-white/72 sm:text-[15px]">{item.body}</p>
              </motion.article>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
