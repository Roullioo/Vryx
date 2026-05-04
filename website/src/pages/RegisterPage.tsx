import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
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
    const r = await register(email, password)
    setSubmitting(false)
    if (r.ok) {
      const dest = from && from.startsWith('/') ? from : '/'
      navigate(dest, { replace: true })
      return
    }
    setError(r.error)
  }

  return (
    <div className="bg-bg min-h-[calc(100svh-4.25rem)] px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-md">
        <div className="panel p-6 sm:p-8">
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg sm:text-3xl">Inscription</h1>
          <p className="mt-2 text-sm text-muted">
            Mot de passe : au moins 10 caractères, une majuscule, une minuscule et un chiffre.
          </p>

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
              <label htmlFor="register-email" className="mb-1.5 block text-sm font-medium text-fg">
                E-mail
              </label>
              <input
                id="register-email"
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
              <label htmlFor="register-password" className="mb-1.5 block text-sm font-medium text-fg">
                Mot de passe
              </label>
              <input
                id="register-password"
                name="password"
                type="password"
                autoComplete="new-password"
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
              {submitting ? 'Création…' : 'Créer mon compte'}
            </button>
          </form>

          <p className="mt-8 text-center text-sm text-muted">
            Déjà inscrit ?{' '}
            <Link to="/connexion" className="font-medium text-accent hover:underline">
              Se connecter
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
