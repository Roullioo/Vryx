/** Données de démonstration pour le compte (non branchées à l’API réelle). */
export const MOCK_ACCOUNT = {
  plan: 'Scale',
  balanceCredits: 1247.82,
  balanceCurrency: 'EUR',
  usagePercent: 45,
  tokensUsedMillion: 45.2,
  tokensQuotaMillion: 100,
  requestsThisMonth: 89_234,
  requestsQuota: 250_000,
  activeApiKeys: 3,
  spendThisMonth: 312.4,
  nextInvoiceEstimate: 428.0,
}

export type MockApiKey = {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
}

export const MOCK_API_KEYS: MockApiKey[] = [
  {
    id: '1',
    name: 'Production, workers',
    prefix: 'vel_sk_live_…x7k2',
    createdAt: '2026-01-12',
    lastUsedAt: '2026-04-28',
  },
  {
    id: '2',
    name: 'CI / tests',
    prefix: 'vel_sk_test_…m9pq',
    createdAt: '2026-03-03',
    lastUsedAt: '2026-04-27',
  },
  {
    id: '3',
    name: 'Dashboard interne',
    prefix: 'vel_sk_live_…3fnw',
    createdAt: '2025-11-20',
    lastUsedAt: null,
  },
]

export const MOCK_INVOICES = [
  { id: 'INV-2026-042', date: '2026-04-01', amount: 289.0, status: 'Payée' as const },
  { id: 'INV-2026-038', date: '2026-03-01', amount: 256.5, status: 'Payée' as const },
  { id: 'INV-2026-031', date: '2026-02-01', amount: 198.0, status: 'Payée' as const },
]

export const MOCK_SESSIONS = [
  { id: 's1', device: 'Chrome · macOS', ip: '192.0.2.**', lastActive: 'Il y a 2 h', current: true },
  { id: 's2', device: 'Safari · iOS', ip: '198.51.100.**', lastActive: 'Il y a 3 j', current: false },
]
