// Canonical frontend types mirroring the FlowMate V3 backend (server/src/service.ts).

export type SystemRole = 'pm' | 'dev' | 'tester' | 'observer'
export type Branch = 'shared' | 'frontend' | 'backend'
export type StageKey = 'projectContext' | 'requirement' | 'design' | 'development' | 'verification' | 'review' | 'testing' | 'delivery'
export type StageStatus = 'blocked' | 'pending' | 'running' | 'review' | 'passed'
export type BugTarget = 'frontend' | 'backend' | 'both'
export type BugStatus = 'open' | 'fixed' | 'closed'

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

export interface VerificationRecordView {
  id: string
  result: 'pass' | 'reject'
  reason: string
  operatorId: string
  createdAt: string
}

export interface TestingBugView {
  id: string
  seq: number
  target: BugTarget
  detail: string
  status: BugStatus
  reporterId: string
  frontendFixed: boolean
  backendFixed: boolean
  closedBy: string | null
  createdAt: string
  updatedAt: string
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
  verificationHistory: VerificationRecordView[]
  testingBugs: TestingBugView[]
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
  projectId: string
  state: string
  creatorId: string
  reqOwnerId: string
  pmId: string
  frontendDevId: string
  backendDevId: string
  testerId: string
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

export interface StageExecutionOptions {
  prompt?: string
  agentName?: string
  modelId?: string
  effort?: string
  fastMode?: 'on' | 'off'
  workspacePath?: string
}

export type ProjectMemoryScope = 'shared' | 'frontend' | 'backend'
export type ProjectMemoryPriority = 'high' | 'medium' | 'low'
export type ProjectMemoryStatus = 'draft' | 'confirmed' | 'deprecated'
export type ProjectMemoryStageScope = 'projectContext' | 'requirement' | 'design' | 'development' | 'review' | 'testing' | 'delivery' | 'all'
export type ProjectSnapshotStatus = 'draft' | 'active' | 'archived'
export type ProjectSnapshotTriggerType = 'initial-scan' | 'rescan' | 'task-delivery' | 'manual-update'

export interface ProjectMemoryItemView {
  id: string
  category: string
  title: string
  content: string
  structuredData: unknown
  scope: ProjectMemoryScope
  stageScope: ProjectMemoryStageScope
  priority: ProjectMemoryPriority
  status: ProjectMemoryStatus
  sourceType: string
  sourceRef: string
  createdAt: string
  updatedAt: string
}

export interface ProjectSnapshotView {
  id: string
  version: number
  status: ProjectSnapshotStatus
  summary: string
  basedOnSnapshotId: string | null
  triggerType: ProjectSnapshotTriggerType
  createdAt: string
  updatedAt: string
  items: ProjectMemoryItemView[]
}

export interface ProjectView {
  id: string
  name: string
  description: string
  activeSnapshot: ProjectSnapshotView | null
  draftSnapshot: ProjectSnapshotView | null
  createdAt: string
  updatedAt: string
}

export interface CreateTaskInput {
  title: string
  description: string
  projectId: string
  refreshProjectContext: boolean
  reqOwnerId: string
  pmId: string
  frontendDevId: string
  backendDevId: string
  testerId: string
}

export const ROLE_LABELS: Record<SystemRole, string> = {
  pm: '产品经理',
  dev: '开发',
  tester: '测试',
  observer: '观察者',
}
