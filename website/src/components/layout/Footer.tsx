import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../context/AuthContext'

export function Footer() {
  const { user } = useAuth()
  const { i18n, t } = useTranslation()

  return (
    <footer className="border-t border-border bg-bg py-12 sm:py-14 lg:py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr_1fr_0.9fr] lg:gap-12">
          <div className="max-w-sm">
            <Link to="/" className="inline-flex w-fit items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg">
              <img
                src="/logo.svg"
                alt="Vryx"
                width={442}
                height={464}
                decoding="async"
                className="vryx-logo-mark h-10 w-10 object-contain sm:h-11 sm:w-11"
              />
              <span className="font-display text-lg font-semibold tracking-tight text-fg sm:text-xl">VryxAI</span>
            </Link>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              Infrastructure d&apos;inférence distribuée, opérée en Europe. Tarifs en euros, virements SEPA,
              alternative aux grands clouds pour amortir vos GPU et vos budgets.
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:gap-3">
              <Link to="/simulateur" className="btn-primary rounded-xl px-5 py-2.5 text-sm font-semibold">
                {t('footer.simulate')}
              </Link>
              <Link
                to={user ? '/compte' : '/inscription'}
                className="btn-secondary rounded-xl px-5 py-2.5 text-sm font-semibold"
              >
                {user ? t('footer.account') : t('footer.createAccount')}
              </Link>
            </div>
          </div>

          <div>
            <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">{t('footer.product')}</h4>
            <ul className="mt-4 space-y-2.5 text-sm text-muted">
              <li>
                <Link className="transition-colors hover:text-accent" to="/simulateur">
                  Simulateur
                </Link>
              </li>
              <li>
                <Link className="transition-colors hover:text-accent" to="/comparatif">
                  Comparatif seul / collectif
                </Link>
              </li>
              <li>
                <Link className="transition-colors hover:text-accent" to="/clients">
                  API &amp; tarifs
                </Link>
              </li>
              <li>
                <Link className="transition-colors hover:text-accent" to="/race-pool">
                  Groupe de calcul
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">{t('footer.workers')}</h4>
            <ul className="mt-4 space-y-2.5 text-sm text-muted">
              <li>
                <Link className="transition-colors hover:text-electric" to="/workers">
                  Devenir nœud
                </Link>
              </li>
              <li>
                <Link className="transition-colors hover:text-electric" to="/workers#install">
                  Spécifications &amp; installation
                </Link>
              </li>
              <li>
                <Link className="transition-colors hover:text-electric" to="/workers#faq-workers">
                  FAQ nœuds
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted">{t('footer.resources')}</h4>
            <ul className="mt-4 space-y-2.5 text-sm text-muted">
              <li>
                <Link className="transition-colors hover:text-accent" to="/#privacy">
                  Confidentialité
                </Link>
              </li>
              <li>
                <Link className="transition-colors hover:text-accent" to={user ? '/compte' : '/connexion'}>
                  {user ? 'Espace client' : 'Connexion'}
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 border-t border-border pt-6">
          <div className="flex flex-col gap-3 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
            <p>{t('footer.rights')}</p>
            <label className="flex items-center gap-2 font-mono text-xs tracking-wide">
              <span>{t('footer.language')}</span>
              <select
                value={i18n.language}
                onChange={(e) => void i18n.changeLanguage(e.target.value)}
                className="rounded-lg border border-border bg-surface px-2 py-1 text-fg outline-none focus:border-accent"
              >
                <option value="fr">FR</option>
                <option value="en">EN</option>
              </select>
            </label>
          </div>
        </div>
      </div>
    </footer>
  )
}
