import { motion } from 'framer-motion'
import { VryxLogo } from '../brand/VryxLogo'

export function HeroSection() {
  return (
    <section
      className="relative isolate -mt-[4.25rem] flex min-h-svh flex-col overflow-hidden border-b border-border pt-[4.25rem]"
      aria-labelledby="hero-heading"
    >
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))] overflow-hidden"
        aria-hidden
      >
        <div
          className="absolute inset-0 scale-105 bg-cover bg-center bg-no-repeat blur-[3px]"
          style={{ backgroundImage: "url('/bgcolor.png')" }}
        />
      </div>
      <div className="absolute inset-x-0 bottom-0 -top-[max(0.75rem,env(safe-area-inset-top,0px))] bg-slate-950/55 sm:bg-slate-950/50" aria-hidden />

      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 pb-16 text-center sm:pb-20">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          className="flex max-w-xl flex-col items-center"
        >
          <div className="origin-center scale-110 sm:scale-125">
            <VryxLogo
              variant="mark"
              tone="light"
              to="/"
              markSize="lg"
              labelledBy="hero-heading"
              className="focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            />
          </div>

          <h1
            id="hero-heading"
            className="font-display mt-8 text-4xl font-semibold tracking-tight text-white sm:mt-10 sm:text-5xl md:text-6xl"
          >
            VryxAI
          </h1>
          <p className="mt-4 text-lg font-medium leading-snug text-white/90 sm:text-xl md:text-2xl">
            La puissance GPU, libérée.
          </p>
        </motion.div>
      </div>
    </section>
  )
}
