import type { ReactNode } from 'react'

type IconProps = { className?: string; 'aria-hidden'?: boolean }

/** Symbole € en mono + espace fin (lisible dans Space Grotesk). */
export function EurSign({ className = '' }: { className?: string }) {
  return (
    <span className={`shrink-0 font-mono text-[0.92em] font-semibold tabular-nums ${className}`.trim()}>
      {'\u202f'}€
    </span>
  )
}

/** Montant + € (mono). `amount` peut être une string déjà formatée. */
export function EurAmount({ amount, className = '' }: { amount: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-0 tabular-nums ${className}`.trim()}>
      <span>{amount}</span>
      <EurSign />
    </span>
  )
}

export function IconBolt({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ah}
    >
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  )
}

export function IconGpu({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden={ah}
    >
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zM7 14h10" strokeLinecap="round" />
    </svg>
  )
}

export function IconTerminal({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden={ah}
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m6 8 4 4-4 4M12 16h6" />
    </svg>
  )
}

export function IconShield({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden={ah}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

export function IconLock({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden={ah}
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

export function IconCode({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden={ah}
    >
      <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
    </svg>
  )
}

export function IconCredit({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden={ah}
    >
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  )
}

/** Sigle € en police mono dans le cadre SVG (aligné aux autres icônes). */
export function IconEuro({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={ah}>
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        style={{
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontSize: '14.25px',
          fontWeight: 650,
          letterSpacing: '-0.02em',
        }}
      >
        €
      </text>
    </svg>
  )
}

export function IconSearch({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ah}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

export function IconLayoutGrid({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ah}
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

export function IconClock({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ah}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  )
}

export function IconChevronDown({ className, 'aria-hidden': ah = true }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden={ah}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
