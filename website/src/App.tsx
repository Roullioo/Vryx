import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { MainLayout } from './layouts/MainLayout'

const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })))
const SimulatorPage = lazy(() => import('./pages/SimulatorPage').then((m) => ({ default: m.SimulatorPage })))
const ComparePage = lazy(() => import('./pages/ComparePage').then((m) => ({ default: m.ComparePage })))
const LoginPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })))
const RegisterPage = lazy(() => import('./pages/RegisterPage').then((m) => ({ default: m.RegisterPage })))
const ModelsPanelPage = lazy(() => import('./pages/ModelsPanelPage').then((m) => ({ default: m.ModelsPanelPage })))
const AccountPage = lazy(() => import('./pages/AccountPage').then((m) => ({ default: m.AccountPage })))
const RacePoolPage = lazy(() => import('./pages/RacePoolPage').then((m) => ({ default: m.RacePoolPage })))
const ClientsPage = lazy(() => import('./pages/ClientsPage').then((m) => ({ default: m.ClientsPage })))
const WorkersPage = lazy(() => import('./pages/WorkersPage').then((m) => ({ default: m.WorkersPage })))
const StatusPage = lazy(() => import('./pages/StatusPage').then((m) => ({ default: m.StatusPage })))
const EnterprisePage = lazy(() => import('./pages/EnterprisePage').then((m) => ({ default: m.EnterprisePage })))
const AdminOverviewPage = lazy(() => import('./pages/AdminOverviewPage').then((m) => ({ default: m.AdminOverviewPage })))
const AdminUsersPage = lazy(() => import('./pages/AdminUsersPage').then((m) => ({ default: m.AdminUsersPage })))
const AdminUserDetailPage = lazy(() => import('./pages/AdminUsersPage').then((m) => ({ default: m.AdminUserDetailPage })))
const AdminNodePage = lazy(() => import('./pages/AdminNodePage').then((m) => ({ default: m.AdminNodePage })))
const AdminP2PChatPage = lazy(() => import('./pages/AdminP2PChatPage').then((m) => ({ default: m.AdminP2PChatPage })))
const AdminWorkersPage = lazy(() => import('./pages/AdminWorkersPage').then((m) => ({ default: m.AdminWorkersPage })))
const AdminWorkerDetailPage = lazy(() => import('./pages/AdminWorkersPage').then((m) => ({ default: m.AdminWorkerDetailPage })))
const AdminSessionsPage = lazy(() => import('./pages/AdminSessionsPage').then((m) => ({ default: m.AdminSessionsPage })))
const AdminSessionDetailPage = lazy(() => import('./pages/AdminSessionsPage').then((m) => ({ default: m.AdminSessionDetailPage })))
const AdminObservabilityPage = lazy(() => import('./pages/AdminObservabilityPage').then((m) => ({ default: m.AdminObservabilityPage })))
const AdminProductionReadinessPage = lazy(() =>
  import('./pages/AdminProductionReadinessPage').then((m) => ({ default: m.AdminProductionReadinessPage })),
)
const AdminEnterpriseQuotesPage = lazy(() =>
  import('./pages/AdminEnterpriseQuotesPage').then((m) => ({ default: m.AdminEnterpriseQuotesPage })),
)
const AdminPricingPage = lazy(() => import('./pages/AdminPricingPage').then((m) => ({ default: m.AdminPricingPage })))
const AdminModelsCatalogPage = lazy(() =>
  import('./pages/AdminModelsCatalogPage').then((m) => ({ default: m.AdminModelsCatalogPage })),
)

function RouteFallback() {
  return (
    <div className="min-h-[calc(100svh-4.25rem)] bg-bg px-4 pt-28 text-fg">
      <div className="mx-auto h-2 max-w-xs overflow-hidden rounded-full bg-surface">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<MainLayout />}>
          <Route index element={<HomePage />} />
          <Route path="workers" element={<WorkersPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="race-pool" element={<RacePoolPage />} />
          <Route path="simulateur" element={<SimulatorPage />} />
          <Route path="comparatif" element={<ComparePage />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="network" element={<StatusPage />} />
          <Route path="investor-readiness" element={<AdminProductionReadinessPage />} />
          <Route path="enterprise" element={<EnterprisePage />} />
          <Route path="compte/*" element={<AccountPage />} />
          <Route path="panel/modeles" element={<ModelsPanelPage />} />
          <Route path="admin" element={<AdminOverviewPage />} />
          <Route path="admin/utilisateurs" element={<AdminUsersPage />} />
          <Route path="admin/utilisateurs/:id" element={<AdminUserDetailPage />} />
          <Route path="admin/noeud" element={<AdminNodePage />} />
          <Route path="admin/chat-p2p" element={<AdminP2PChatPage />} />
          <Route path="admin/workers" element={<AdminWorkersPage />} />
          <Route path="admin/workers/:peerId" element={<AdminWorkerDetailPage />} />
          <Route path="admin/sessions" element={<AdminSessionsPage />} />
          <Route path="admin/sessions/:sessionId" element={<AdminSessionDetailPage />} />
          <Route path="admin/observabilite" element={<AdminObservabilityPage />} />
          <Route path="admin/production-readiness" element={<AdminProductionReadinessPage />} />
          <Route path="admin/parametres/pricing" element={<AdminPricingPage />} />
          <Route path="admin/modeles" element={<AdminModelsCatalogPage />} />
          <Route path="admin/enterprise" element={<AdminEnterpriseQuotesPage />} />
          <Route path="connexion" element={<LoginPage />} />
          <Route path="inscription" element={<RegisterPage />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
