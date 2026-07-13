// V3 rewrite: this module now only re-exports canonical V3 types under the
// names the existing pages import. Mock data & the hardcoded currentUser were
// removed — real users/tasks come from the backend via lib/api + the store.
export type {
  Branch,
  ClarificationView,
  CreateTaskInput,
  Permission,
  ProcessEvent,
  ProcessResponse,
  StageKey,
  StageStatus,
  StageView,
  SystemRole,
  TaskView,
  TimelineView,
  User,
} from '@/lib/types'
export { ROLE_LABELS } from '@/lib/types'

// Backward-friendly aliases used across the workspace page.
import type { CreateTaskInput, StageView, TaskView, TimelineView } from '@/lib/types'
export type WorkspaceTask = TaskView
export type Stage = StageView
export type TimelineEvent = TimelineView
export type TaskFormInput = CreateTaskInput
