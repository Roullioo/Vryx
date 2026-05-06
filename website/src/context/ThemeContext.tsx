import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'vryx-theme'

const META_THEME_LIGHT = '#fafafa'
const META_THEME_DARK = '#0c0c0c'

function readStoredPreference(): ThemePreference | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* ignore */
  }
  return null
}

export function getSystemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'system') return getSystemDark() ? 'dark' : 'light'
  return pref
}

function applyDomTheme(resolved: ResolvedTheme) {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved === 'dark' ? 'dark' : 'light'

  let meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.appendChild(meta)
  }
  meta.setAttribute('content', resolved === 'dark' ? META_THEME_DARK : META_THEME_LIGHT)
}

type ThemeContextValue = {
  preference: ThemePreference
  resolvedTheme: ResolvedTheme
  setPreference: (p: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    if (typeof window === 'undefined') return 'system'
    return readStoredPreference() ?? 'system'
  })

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    typeof window === 'undefined' ? 'light' : resolveTheme(readStoredPreference() ?? 'system'),
  )

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, p)
    } catch {
      /* ignore */
    }
    const r = resolveTheme(p)
    setResolvedTheme(r)
    applyDomTheme(r)
  }, [])

  useEffect(() => {
    const r = resolveTheme(preference)
    setResolvedTheme(r)
    applyDomTheme(r)
  }, [preference])

  useEffect(() => {
    if (preference !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const r = resolveTheme('system')
      setResolvedTheme(r)
      applyDomTheme(r)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [preference])

  const value = useMemo(
    () => ({
      preference,
      resolvedTheme,
      setPreference,
    }),
    [preference, resolvedTheme, setPreference],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

/** Pour composants hors provider strict (ex. stories) : préfère useTheme(). */
export function useThemeOptional() {
  return useContext(ThemeContext)
}
