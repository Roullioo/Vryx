import { useState } from 'react'
import { providerInitials, providerLogoSrc } from '../lib/providerLogos'

type ProviderLogoProps = {
  provider: string
  size?: number
  className?: string
}

export function ProviderLogo({ provider, size = 24, className = '' }: ProviderLogoProps) {
  const [failed, setFailed] = useState(false)
  const src = providerLogoSrc(provider)
  const initials = providerInitials(provider)

  if (!src || failed) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-surface font-mono text-[0.65rem] font-bold text-muted ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        {initials}
      </span>
    )
  }

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`shrink-0 rounded-lg border border-border bg-surface object-contain p-0.5 ${className}`}
      onError={() => setFailed(true)}
    />
  )
}
