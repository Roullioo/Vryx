import { Routes, Route } from 'react-router-dom'
import { MainLayout } from './layouts/MainLayout'
import { HomePage } from './pages/HomePage'
import { SimulatorPage } from './pages/SimulatorPage'
import { ComparePage } from './pages/ComparePage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { ModelsPanelPage } from './pages/ModelsPanelPage'
import { AccountPage } from './pages/AccountPage'
import { RacePoolPage } from './pages/RacePoolPage'
import { ClientsPage } from './pages/ClientsPage'
import { WorkersPage } from './pages/WorkersPage'
import { AdminOverviewPage } from './pages/AdminOverviewPage'
import { AdminUsersPage } from './pages/AdminUsersPage'
import { AdminNodePage } from './pages/AdminNodePage'
import { AdminP2PChatPage } from './pages/AdminP2PChatPage'
import { AdminWorkersPage, AdminWorkerDetailPage } from './pages/AdminWorkersPage'
import { AdminSessionsPage, AdminSessionDetailPage } from './pages/AdminSessionsPage'

export default function App() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/workers" element={<WorkersPage />} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route path="/race-pool" element={<RacePoolPage />} />
        <Route path="/simulateur" element={<SimulatorPage />} />
        <Route path="/comparatif" element={<ComparePage />} />
        <Route path="/compte" element={<AccountPage />} />
        <Route path="/panel/modeles" element={<ModelsPanelPage />} />
        <Route path="/admin" element={<AdminOverviewPage />} />
        <Route path="/admin/utilisateurs" element={<AdminUsersPage />} />
        <Route path="/admin/noeud" element={<AdminNodePage />} />
        <Route path="/admin/chat-p2p" element={<AdminP2PChatPage />} />
        <Route path="/admin/workers" element={<AdminWorkersPage />} />
        <Route path="/admin/workers/:peerId" element={<AdminWorkerDetailPage />} />
        <Route path="/admin/sessions" element={<AdminSessionsPage />} />
        <Route path="/admin/sessions/:sessionId" element={<AdminSessionDetailPage />} />
        <Route path="/connexion" element={<LoginPage />} />
        <Route path="/inscription" element={<RegisterPage />} />
      </Route>
    </Routes>
  )
}
