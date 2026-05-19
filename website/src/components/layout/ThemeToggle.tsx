import { useEffect, useRef, useState } from 'react'
import type { ThemePreference } from '../../context/ThemeContext'
import { useTheme } from '../../context/ThemeContext'

function IconSun({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function IconMoon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function IconMonitor({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

const labels: Record<ThemePreference, string> = {
  light: 'Thème clair',
  dark: 'Thème sombre',
  system: 'Thème système',
}

export function ThemeToggle({
  navOnDarkHero = false,
  menuPlacement = 'down',
  menuAlign = 'right',
}: {
  navOnDarkHero?: boolean
  menuPlacement?: 'up' | 'down'
  menuAlign?: 'left' | 'right'
}) {
  const { preference, setPreference } = useTheme()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function close(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const icon =
    preference === 'dark' ? (
      <IconMoon className="h-5 w-5" />
    ) : preference === 'light' ? (
      <IconSun className="h-5 w-5" />
    ) : (
      <IconMonitor className="h-5 w-5" />
    )

  const btnRing =
    navOnDarkHero ? 'focus-visible:ring-white/40' : 'focus-visible:ring-accent/40 focus-visible:ring-offset-bg'

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        className={`flex h-10 w-10 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
          navOnDarkHero
            ? 'border-white/30 text-white hover:bg-white/10'
            : 'border-border text-muted hover:bg-surface hover:text-fg'
        } ${btnRing}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Apparence : ${labels[preference]}. Choisir le thème.`}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
      </button>
      {open && (
        <ul
        className={`absolute z-[60] min-w-[11rem] rounded-xl border border-white/25 bg-white/70 py-1 shadow-[0_24px_80px_rgba(15,23,42,.18)] backdrop-blur-2xl dark:border-white/12 dark:bg-zinc-950/72 dark:shadow-black/50 ${
            menuAlign === 'left' ? 'left-0' : 'right-0'
          } ${
            menuPlacement === 'up' ? 'bottom-full mb-2' : 'mt-2'
          }`}
          role="listbox"
          aria-label="Thème d’affichage"
        >
          {(['light', 'dark', 'system'] as const).map((p) => (
            <li key={p} role="option" aria-selected={preference === p}>
              <button
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                  preference === p ? 'bg-surface font-semibold text-fg' : 'text-muted hover:bg-surface hover:text-fg'
                }`}
                onClick={() => {
                  setPreference(p)
                  setOpen(false)
                }}
              >
                {p === 'light' ? <IconSun className="h-4 w-4 shrink-0" /> : null}
                {p === 'dark' ? <IconMoon className="h-4 w-4 shrink-0" /> : null}
                {p === 'system' ? <IconMonitor className="h-4 w-4 shrink-0" /> : null}
                {labels[p]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
