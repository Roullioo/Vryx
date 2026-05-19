import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const searchNext =
    typeof location.search === 'string'
      ? new URLSearchParams(location.search).get('next')
      : null
  const from =
    typeof location.state === 'object' &&
    location.state !== null &&
    'from' in location.state &&
    typeof (location.state as { from?: unknown }).from === 'string'
      ? (location.state as { from: string }).from
      : null
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const r = await login(email, password)
    setSubmitting(false)
    if (r.ok) {
      const dest = from && from.startsWith('/') ? from : '/'
      navigate(dest, { replace: true })
      return
    }
    setError(r.error)
  }

  function startGoogle() {
    const redirect = searchNext && searchNext.startsWith('/') ? searchNext : from && from.startsWith('/') ? from : '/compte'
    window.location.href = `/api/auth/google/start?next=${encodeURIComponent(redirect)}`
  }

  return (
    <div className="bg-bg min-h-[calc(100svh-4.25rem)] px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-md">
        <div className="panel p-6 sm:p-8">
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg sm:text-3xl">Connexion</h1>
          <p className="mt-2 text-sm text-muted">Accédez à votre espace Vryx.</p>

          {error && (
            <div
              className="mt-6 rounded-lg border border-alert/50 bg-alert/10 px-4 py-3 text-sm text-alert"
              role="alert"
            >
              {error}
            </div>
          )}

          <form className="mt-8 flex flex-col gap-5" onSubmit={onSubmit} noValidate>
            <div>
              <label htmlFor="login-email" className="mb-1.5 block text-sm font-medium text-fg">
                E-mail
              </label>
              <input
                id="login-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-fg outline-none ring-accent/40 transition-[border-color,box-shadow] focus:border-accent focus:ring-2"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium text-fg">
                Mot de passe
              </label>
              <input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-fg outline-none ring-accent/40 transition-[border-color,box-shadow] focus:border-accent focus:ring-2"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary mt-2 rounded-lg py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Connexion…' : 'Se connecter'}
            </button>
          </form>

          <div className="mt-6">
            <button
              type="button"
              className="btn-secondary relative flex w-full items-center justify-center gap-2 rounded-lg py-3 text-sm font-semibold"
              onClick={startGoogle}
            >
              <img src="/google.png" alt="" className="h-5 w-5" />
              Continuer avec Google
            </button>
          </div>

          <p className="mt-8 text-center text-sm text-muted">
            Pas encore de compte ?{' '}
            <Link to="/inscription" className="font-medium text-accent hover:underline">
              Créer un compte
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
