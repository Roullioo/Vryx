import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { apiJson } from '../lib/api'

export type AuthUser = { id: string; email: string; isAdmin?: boolean }

type AuthState = {
  user: AuthUser | null
  loading: boolean
  refresh: () => Promise<void>
  login: (email: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>
  register: (
    email: string,
    password: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

/** Pendant `npm run dev`, l’API peut démarrer après Vite (proxy 502/500, réseau). */
function isTransientMeFailure(status: number): boolean {
  return status === 0 || status === 500 || status >= 502
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const dev = import.meta.env.DEV
    const maxAttempts = dev ? 30 : 3
    const delayMs = dev ? 400 : 500
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const r = await apiJson<{ user: AuthUser | null }>('/api/auth/me')
      if (r.ok) {
        setUser(r.data.user ?? null)
        return
      }
      const last = attempt === maxAttempts - 1
      if (!isTransientMeFailure(r.status) || last) {
        setUser(null)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    setUser(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      await refresh()
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  const login = useCallback(async (email: string, password: string) => {
    const r = await apiJson<{ user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    if (r.ok) {
      setUser(r.data.user)
      return { ok: true as const }
    }
    return { ok: false as const, error: r.error }
  }, [])

  const register = useCallback(async (email: string, password: string) => {
    const r = await apiJson<{ user: AuthUser }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    if (r.ok) {
      setUser(r.data.user)
      return { ok: true as const }
    }
    return { ok: false as const, error: r.error }
  }, [])

  const logout = useCallback(async () => {
    await apiJson('/api/auth/logout', { method: 'POST' })
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ user, loading, refresh, login, register, logout }),
    [user, loading, refresh, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// Hook exporté à côté du provider : acceptable pour ce module.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth doit être utilisé dans AuthProvider')
  return ctx
}
