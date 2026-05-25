#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const ignored = [
  /^website\/package-lock\.json$/,
  /^website\/server\/package-lock\.json$/,
  /^AppMacos\/package-lock\.json$/,
  /^nodeAndWorker\/Cargo\.lock$/,
  /(^|\/)env\.example$/,
  /\.(png|jpe?g|webp|gif|ico|icns|pdf|mp4|mov|zip|gz|tar|bin|wasm)$/i,
  /^docs\/readme\/.*\.svg$/,
]

const patterns = [
  { name: 'Stripe secret key', re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'Vryx API key', re: /\bvel_sk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
  { name: 'OpenAI key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b|\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  {
    name: 'Hardcoded production secret env',
    re: /^[ \t]*(?:JWT_SECRET|DB_PASSWORD|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|VRYX_BENCH_TOKEN|VRYX_WORKER_SECRET)[ \t]*=[ \t]*['"]?([^'"\s#][^#\n]*)/gm,
    validate: (match) => {
      const value = String(match[1] || '').trim()
      if (!value) return false
      if (/^(process\.env|import\.meta|example|changeme|change-me|replace|remplacez|your_|votre_|dev|test|placeholder)/i.test(value)) return false
      return value.length >= 12
    },
  },
]

const findings = []

for (const file of tracked) {
  if (ignored.some((re) => re.test(file))) continue
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0
    for (const match of text.matchAll(pattern.re)) {
      if (pattern.validate && !pattern.validate(match)) continue
      const line = text.slice(0, match.index).split('\n').length
      findings.push(`${file}:${line} ${pattern.name}`)
    }
  }
}

if (findings.length) {
  console.error('Potential committed secrets found:')
  for (const finding of findings) console.error(`- ${finding}`)
  process.exit(1)
}

console.log('No committed secrets matched the Vryx CI secret patterns.')
