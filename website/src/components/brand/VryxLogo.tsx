import { Link } from 'react-router-dom'

type VryxLogoProps = {
  variant?: 'full' | 'mark'
  /** dark = texte foncé sur fond clair ; light = texte clair sur fond sombre */
  tone?: 'dark' | 'light'
  /** Si défini, enveloppe le logo dans un lien vers la home */
  to?: string
  className?: string
  /** Taille du pictogramme (px environ) */
  markSize?: 'sm' | 'md' | 'lg'
  /** Si défini (ex. id d’un `h1` masqué), le lien s’en sert comme nom accessible à la place de `aria-label`. */
  labelledBy?: string
}

const markSizeClass = {
  sm: 'h-8 w-8 sm:h-9 sm:w-9',
  md: 'h-9 w-9 sm:h-10 sm:w-10',
  lg: 'h-14 w-14 sm:h-16 sm:w-16 md:h-[4.5rem] md:w-[4.5rem]',
}

export function VryxLogo({
  variant = 'full',
  tone = 'dark',
  className = '',
  to = '/',
  markSize = 'md',
  labelledBy,
}: VryxLogoProps) {
  const fg = tone === 'dark' ? '#171717' : '#ffffff'

  const mark = (
    <img
      src="/logo-withoutbg.png"
      alt=""
      width={180}
      height={180}
      decoding="async"
      className={`shrink-0 object-contain ${markSizeClass[markSize]}`}
    />
  )

  const wordmark =
    variant === 'full' ? (
      <span className="font-display text-lg font-semibold tracking-tight sm:text-xl" style={{ color: fg }}>
        VryxAI
      </span>
    ) : null

  const content = (
    <>
      {mark}
      {wordmark}
    </>
  )

  const ring =
    tone === 'light'
      ? 'focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent'
      : 'focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg'

  if (to) {
    return (
      <Link
        to={to}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : variant === 'mark' ? 'VryxAI, accueil' : undefined}
        className={`inline-flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 ${ring} ${className}`}
      >
        {content}
      </Link>
    )
  }

  return <span className={`inline-flex items-center gap-2.5 ${className}`}>{content}</span>
}
