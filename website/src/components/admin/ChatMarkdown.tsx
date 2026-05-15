import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type ChatMarkdownProps = {
  text: string
  tone?: 'default' | 'self'
}

/** Rendu Markdown (titres, gras, listes, code, tableaux GFM, etc.) pour les bulles de chat. */
export function ChatMarkdown({ text, tone = 'default' }: ChatMarkdownProps) {
  const body = text.replace(/\r\n/g, '\n').trim()
  if (!body) return null

  const linkClass =
    tone === 'self'
      ? 'break-all font-medium text-current underline decoration-current/70 underline-offset-2 hover:opacity-90'
      : 'break-all font-medium text-accent underline underline-offset-2 hover:opacity-90'

  const muted = tone === 'self' ? 'text-current/80' : 'text-zinc-600 dark:text-zinc-400'
  const codeBg = tone === 'self' ? 'bg-black/15 dark:bg-white/15' : 'bg-zinc-200/90 dark:bg-zinc-700/80'
  const preShell =
    tone === 'self'
      ? 'my-3 max-h-[min(50vh,24rem)] overflow-auto rounded-xl border border-current/20 bg-black/25 p-3 text-sm text-inherit'
      : 'my-3 max-h-[min(50vh,24rem)] overflow-auto rounded-xl border border-zinc-300 bg-zinc-950 p-3 text-sm text-zinc-50 dark:border-zinc-600 dark:bg-zinc-950/90'

  const listMarker = tone === 'self' ? 'marker:text-current' : 'marker:text-accent'

  const components: Partial<Components> = {
    h1: ({ children }) => (
      <h2 className="mb-2 mt-4 border-b border-current/10 pb-1 font-display text-xl font-bold tracking-tight first:mt-0">
        {children}
      </h2>
    ),
    h2: ({ children }) => (
      <h3 className="mb-2 mt-3 font-display text-lg font-semibold tracking-tight first:mt-0">{children}</h3>
    ),
    h3: ({ children }) => (
      <h4 className="mb-1.5 mt-3 text-base font-semibold first:mt-0">{children}</h4>
    ),
    h4: ({ children }) => (
      <h5 className="mb-1.5 mt-2 text-[15px] font-semibold first:mt-0">{children}</h5>
    ),
    h5: ({ children }) => (
      <h6 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h6>
    ),
    h6: ({ children }) => (
      <h6 className="mb-1 mt-2 text-sm font-medium first:mt-0">{children}</h6>
    ),
    p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic opacity-95">{children}</em>,
    del: ({ children }) => <del className="line-through opacity-70">{children}</del>,
    a: ({ href, children }) => (
      <a href={href} className={linkClass} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    ul: ({ children }) => (
      <ul className={`my-2 list-disc space-y-1.5 pl-5 leading-relaxed ${listMarker}`}>{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className={`my-2 list-decimal space-y-1.5 pl-5 leading-relaxed ${listMarker}`}>{children}</ol>
    ),
    li: ({ children }) => <li className="[&>p]:mb-1 [&>p]:last:mb-0">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className={`my-3 border-l-[3px] border-accent/60 py-0.5 pl-3 text-[0.97em] italic ${muted} ${tone === 'self' ? 'border-current/35' : ''}`}>
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-4 border-0 border-t border-current/15" />,
    code: ({ className, children }) => {
      const isBlock = Boolean(className?.includes('language-'))
      if (isBlock) {
        return (
          <code className={`${className ?? ''} font-mono text-[13px] leading-relaxed text-inherit`}>{children}</code>
        )
      }
      return (
        <code
          className={`rounded px-1.5 py-0.5 font-mono text-[0.88em] font-medium ${codeBg} text-inherit [pre_&]:bg-transparent [pre_&]:p-0`}
        >
          {children}
        </code>
      )
    },
    pre: ({ children }) => <pre className={preShell}>{children}</pre>,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto rounded-lg border border-current/12">
        <table className="min-w-full border-collapse text-left text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="border-b border-current/15 bg-current/[0.06]">{children}</thead>,
    tbody: ({ children }) => <tbody className="divide-y divide-current/10">{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => (
      <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">{children}</th>
    ),
    td: ({ children }) => <td className="px-3 py-2 align-top">{children}</td>,
    input: ({ type, checked, disabled }) => {
      if (type === 'checkbox') {
        return (
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            readOnly
            className={`mr-2 align-middle ${tone === 'self' ? 'accent-current' : 'accent-accent'}`}
          />
        )
      }
      return <input type={type} />
    },
  }

  const wrapper =
    tone === 'self'
      ? 'chat-md max-w-none text-left text-[0.98em] leading-relaxed text-inherit'
      : 'chat-md max-w-none text-left text-[0.98em] leading-relaxed text-zinc-900 dark:text-zinc-50'

  return (
    <div className={wrapper}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  )
}
