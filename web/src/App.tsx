import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { CreateTaskPage } from '@/pages/create-task-page'
import { LoginPage } from '@/pages/login-page'
import { ProjectManagementPage } from '@/pages/project-management-page'
import { WorkspacePage } from '@/pages/workspace-page'
import { WorkspaceStoreProvider } from '@/state/workspace-store'
import { useWorkspaceStore } from '@/state/workspace-store-context'

function RequireAuth({ children }: { children: ReactNode }) {
  const { currentUser, authLoading } = useWorkspaceStore()
  if (authLoading) {
    return null
  }
  if (!currentUser) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

function App() {
  return (
    <WorkspaceStoreProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <WorkspacePage />
            </RequireAuth>
          }
        />
        <Route
          path="/tasks/new"
          element={
            <RequireAuth>
              <CreateTaskPage />
            </RequireAuth>
          }
        />
        <Route
          path="/projects"
          element={
            <RequireAuth>
              <ProjectManagementPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </WorkspaceStoreProvider>
  )
}

export default App
