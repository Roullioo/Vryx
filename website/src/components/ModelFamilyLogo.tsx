import { useState } from 'react'
import type { LargeAiModel } from '../data/largeAiModels'
import { familyInitials, modelFamilyLogoSrc } from '../lib/modelLogos'

type ModelFamilyLogoProps = {
  model: Pick<LargeAiModel, 'id' | 'family' | 'logoSlug' | 'provider'>
  size?: number
  className?: string
}

export function ModelFamilyLogo({ model, size = 28, className = '' }: ModelFamilyLogoProps) {
  const [failed, setFailed] = useState(false)
  const src = modelFamilyLogoSrc(model)
  const initials = familyInitials(model.family)

  if (!src || failed) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-lg border border-accent/35 bg-accent/10 font-mono text-[0.7rem] font-bold text-accent ${className}`}
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
