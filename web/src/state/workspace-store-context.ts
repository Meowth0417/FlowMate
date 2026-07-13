import { createContext, useContext } from 'react'
import type { Branch, BugTarget, StageKey, CreateTaskInput, TaskView, User } from '@/lib/types'

export interface WorkspaceStoreValue {
  // Auth (mock identity, no password) ---------------------------------------
  users: User[]
  currentUser: User | null
  authLoading: boolean
  authError: string | null
  login: (userId: string) => void
  logout: () => void
  refreshUsers: () => Promise<void>

  // Tasks -------------------------------------------------------------------
  tasks: TaskView[]
  loading: boolean
  error: string | null
  selectedTaskId: string
  selectedTask: TaskView | null
  setSelectedTaskId: (taskId: string) => void
  refreshTasks: () => Promise<void>

  // Mutations (mirror the V3 backend endpoints) -----------------------------
  createTask: (input: CreateTaskInput) => Promise<TaskView>
  cancelTask: (taskId: string) => Promise<void>
  saveExtraPrompt: (taskId: string, key: StageKey, branch: Branch, prompt: string) => Promise<void>
  executeStage: (taskId: string, key: StageKey, branch: Branch, prompt?: string) => Promise<void>
  advanceStage: (taskId: string, key: StageKey) => Promise<void>
  bindRepo: (taskId: string, branch: Branch, path: string) => Promise<void>
  answerClarification: (taskId: string, clarificationId: string, answer: string) => Promise<void>
  verifyBranch: (taskId: string, branch: Branch, pass: boolean, reason: string) => Promise<void>
  reviewBranch: (taskId: string, branch: Branch, action: 'pass' | 'reflow', levels: string[]) => Promise<void>
  passTesting: (taskId: string) => Promise<void>
  reportTestingBug: (taskId: string, target: BugTarget, detail: string) => Promise<void>
  markTestingBugFixed: (taskId: string, bugId: string) => Promise<void>
  closeTestingBug: (taskId: string, bugId: string) => Promise<void>
  deliver: (taskId: string) => Promise<void>
  rollbackDelivery: (taskId: string, target: string, reason: string) => Promise<void>
  supplementRequirement: (
    taskId: string,
    note: string,
    impact: 'frontend' | 'backend' | 'both',
    reenterDesign: boolean,
  ) => Promise<void>
  supplementDesign: (taskId: string, note: string) => Promise<void>
}

export const WorkspaceStoreContext = createContext<WorkspaceStoreValue | null>(null)

export function useWorkspaceStore() {
  const context = useContext(WorkspaceStoreContext)
  if (!context) {
    throw new Error('useWorkspaceStore must be used within WorkspaceStoreProvider')
  }
  return context
}
