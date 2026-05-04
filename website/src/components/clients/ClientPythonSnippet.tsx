import { useState } from 'react'
import { motion } from 'framer-motion'
import { CLIENT_PYTHON_SNIPPET } from '../../data/clientsContent'

/** Fond terminal sombre : les couleurs d’accent syntaxe restent lisibles (thème type Dracula). */
export function ClientPythonSnippet({ className = '' }: { className?: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(CLIENT_PYTHON_SNIPPET)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ type: 'spring', stiffness: 280, damping: 28 }}
      className={`overflow-hidden rounded-2xl border border-border bg-card shadow-[0_4px_24px_rgba(15,23,42,0.08)] ${className}`}
    >
      <div className="flex items-center justify-between border-b border-border bg-elevated px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-alert/90" aria-hidden />
          <span className="h-2.5 w-2.5 rounded-full bg-warning/90" aria-hidden />
          <span className="h-2.5 w-2.5 rounded-full bg-accent" aria-hidden />
        </div>
        <span className="font-mono text-xs font-medium text-muted">example.py</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="rounded-lg px-2 py-1.5 text-muted transition-colors hover:bg-border/60 hover:text-fg"
          aria-label="Copier le code"
        >
          {copied ? (
            <span className="font-mono text-xs font-medium text-accent">Copié</span>
          ) : (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto bg-[#1e1e2e] p-4 font-mono text-[13px] leading-[1.65] text-[#f8f8f2] sm:p-6 sm:text-sm">
        <code>
          <span className="text-[#ff79c6]">from</span> <span className="text-[#f8f8f2]">openai</span>{' '}
          <span className="text-[#ff79c6]">import</span> <span className="text-[#f8f8f2]">OpenAI</span>
          {'\n\n'}
          <span className="text-[#f8f8f2]">client</span> = <span className="text-[#50fa7b]">OpenAI</span>(
          {'\n'}
          {'    '}
          <span className="text-[#8be9fd]">base_url</span>=
          <span className="text-[#f1fa8c]">&quot;https://api.vryx-ai.eu/v1&quot;</span>,{'\n'}
          {'    '}
          <span className="text-[#8be9fd]">api_key</span>=<span className="text-[#f1fa8c]">&quot;vel_...&quot;</span>,{'\n'}
          ){'\n\n'}
          <span className="text-[#f8f8f2]">response</span> = <span className="text-[#f8f8f2]">client</span>.
          <span className="text-[#f8f8f2]">chat</span>.<span className="text-[#50fa7b]">completions</span>.
          <span className="text-[#50fa7b]">create</span>(
          {'\n'}
          {'    '}
          <span className="text-[#8be9fd]">model</span>=<span className="text-[#f1fa8c]">&quot;vryx-llama-70b&quot;</span>,{'\n'}
          {'    '}
          <span className="text-[#8be9fd]">messages</span>=[...]{'\n'}
          ){'\n\n'}
          <span className="text-[#6272a4]"># C&apos;est tout.</span>
          {'\n'}
          <span className="text-[#50fa7b]">print</span>(<span className="text-[#f8f8f2]">response</span>.
          <span className="text-[#f8f8f2]">choices</span>[<span className="text-[#bd93f9]">0</span>].
          <span className="text-[#f8f8f2]">message</span>.<span className="text-[#f8f8f2]">content</span>)
        </code>
      </pre>
    </motion.div>
  )
}
