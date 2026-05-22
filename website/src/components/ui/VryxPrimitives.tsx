import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

export function VryxCard({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-3xl border border-border bg-card/90 shadow-panel backdrop-blur-md ${className}`}
      {...props}
    />
  )
}

export function VryxBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' }) {
  const cls =
    tone === 'accent'
      ? 'bg-accent/12 text-accent'
      : tone === 'success'
        ? 'bg-success/12 text-success'
        : tone === 'warning'
          ? 'bg-warning/12 text-warning'
          : 'bg-surface text-muted'
  return <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{children}</span>
}

export function VryxButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex min-h-11 items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    />
  )
}

export function VryxInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`min-h-11 rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 ${className}`}
      {...props}
    />
  )
}
