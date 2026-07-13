// Canonical frontend types mirroring the FlowMate V3 backend (server/src/service.ts).

export type SystemRole = 'pm' | 'dev' | 'observer'
export type Branch = 'shared' | 'frontend' | 'backend'
export type StageKey = 'requirement' | 'design' | 'development' | 'verification' | 'review' | 'delivery'
export type StageStatus = 'blocked' | 'pending' | 'running' | 'review' | 'passed'

export interface User {
  id: string
  name: string
  role: SystemRole
}

export interface Permission {
  execute: boolean
  confirm: boolean
  supplement: boolean
}

export interface RepoBinding {
  name: string
  path: string
  branch: string | null
}

export interface LocalDirItem {
  name: string
  path: string
  isDir: boolean
}

export interface LocalDirsResponse {
  path: string
  parent: string
  items: LocalDirItem[]
}

export interface AgentModelInfo {
  id: string
  name: string
  description?: string
  hidden?: boolean
  supportEffort?: boolean
}

export interface AgentStatus {
  name: string
  installed: boolean
  available: boolean
  version?: string
  error?: string
  last_probe?: string
  current_model_id?: string
  current_mode_id?: string
  default_model_id?: string
  default_effort?: string
  default_fast_service?: string
  supports_fast_service?: boolean
  efforts?: string[]
  models?: AgentModelInfo[]
}

export interface StageView {
  key: StageKey
  branch: Branch
  name: string
  status: StageStatus
  runCount: number
  extraPrompt: string
  summary: string
  artifact: unknown
  pendingNote: string
  updatedAt: string
  permission: Permission
}

export interface ClarificationView {
  id: string
  seq: number
  question: string
  options: string[]
  answer: string
  status: string
  answeredBy: string | null
}

export interface TimelineView {
  id: string
  stageKey: string | null
  branch: string | null
  kind: string
  title: string
  detail: string
  actorId: string
  createdAt: string
}

export interface TaskView {
  id: string
  title: string
  description: string
  state: string
  creatorId: string
  reqOwnerId: string
  pmId: string
  frontendDevId: string
  backendDevId: string
  frontendRepo: RepoBinding | null
  backendRepo: RepoBinding | null
  createdAt: string
  updatedAt: string
  stages: StageView[]
  clarifications: ClarificationView[]
  timeline: TimelineView[]
  stateLabel: string
}

export interface ProcessEvent {
  order: number
  type: 'thought' | 'tool' | 'text'
  title: string
  content: string
  tool?: { name: string; status: 'complete'; detail: string }
}

export interface ProcessResponse {
  events: ProcessEvent[]
  executorId: string | null
  running: boolean
}

export interface CreateTaskInput {
  title: string
  description: string
  reqOwnerId: string
  pmId: string
  frontendDevId: string
  backendDevId: string
}

export const ROLE_LABELS: Record<SystemRole, string> = {
  pm: '产品经理',
  dev: '开发',
  observer: '观察者',
}
