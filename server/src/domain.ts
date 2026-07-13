// FlowMate V3 domain model: users, roles, stages, branches, permissions.

export type SystemRole = 'pm' | 'dev' | 'observer'

export type Branch = 'shared' | 'frontend' | 'backend'

export type StageKey = 'requirement' | 'design' | 'development' | 'verification' | 'review' | 'delivery'

// Per-stage-instance status.
export type StageStatus =
  | 'blocked' // upstream not complete, cannot start
  | 'pending' // ready to execute / take manual action
  | 'running' // agent executing (mock)
  | 'review' // executed, awaiting human action (confirm / verify / pass)
  | 'passed' // completed and moved on

export type TaskState = 'pending' | 'in_progress' | 'completed' | 'cancelled'

// Permission bits: [execute][confirm][supplement]
export interface Permission {
  execute: boolean
  confirm: boolean
  supplement: boolean
}

export function code(value: string): Permission {
  return {
    execute: value[0] === '1',
    confirm: value[1] === '1',
    supplement: value[2] === '1',
  }
}

export const NO_PERMISSION = code('000')

export interface User {
  id: string
  name: string
  role: SystemRole
}

// Task-level owner fields.
export type OwnerField = 'creator' | 'reqOwner' | 'pm' | 'frontendDev' | 'backendDev'

export interface StageDefinition {
  key: StageKey
  name: string
  branches: Branch[] // which branches this stage exists on
  agentExecuted: boolean // has an agent "开始执行" action
  agentName: string
}

export const STAGE_DEFINITIONS: StageDefinition[] = [
  { key: 'requirement', name: '需求理解', branches: ['shared'], agentExecuted: true, agentName: 'requirement-agent' },
  { key: 'design', name: '详细设计', branches: ['shared'], agentExecuted: true, agentName: 'design-agent' },
  { key: 'development', name: '开发', branches: ['frontend', 'backend'], agentExecuted: true, agentName: 'coding-agent' },
  { key: 'verification', name: '功能验证', branches: ['frontend', 'backend'], agentExecuted: false, agentName: '' },
  { key: 'review', name: '代码审查', branches: ['frontend', 'backend'], agentExecuted: true, agentName: 'review-agent' },
  { key: 'delivery', name: '交付沉淀', branches: ['shared'], agentExecuted: false, agentName: '' },
]

export function getStageDefinition(key: StageKey): StageDefinition {
  const found = STAGE_DEFINITIONS.find((s) => s.key === key)
  if (!found) {
    throw new Error(`Unknown stage: ${key}`)
  }
  return found
}

export function branchLabel(branch: Branch): string {
  if (branch === 'frontend') return '前端'
  if (branch === 'backend') return '后端'
  return ''
}

export function stageDisplayName(key: StageKey, branch: Branch): string {
  const def = getStageDefinition(key)
  const prefix = branchLabel(branch)
  return prefix ? `${prefix}${def.name}` : def.name
}

// ---- Permission matrix (PRD 6.2) ----
// Columns keyed by (stageKey, branch). Front/back dev & verification share one column per branch.

type PermRoleKey = 'pm' | 'frontendDev' | 'backendDev' | 'owner' | 'observer'

// Matrix rows: requirement, design, fe-dev/verify, be-dev/verify, fe-review, be-review, delivery.
const MATRIX: Record<PermRoleKey, Record<string, string>> = {
  pm: {
    requirement: '111',
    design: '001',
    'development:frontend': '000',
    'verification:frontend': '000',
    'development:backend': '000',
    'verification:backend': '000',
    'review:frontend': '000',
    'review:backend': '000',
    delivery: '000',
  },
  frontendDev: {
    requirement: '100',
    design: '101',
    'development:frontend': '111',
    'verification:frontend': '111',
    'development:backend': '000',
    'verification:backend': '000',
    'review:frontend': '111',
    'review:backend': '000',
    delivery: '000',
  },
  backendDev: {
    requirement: '100',
    design: '101',
    'development:frontend': '000',
    'verification:frontend': '000',
    'development:backend': '111',
    'verification:backend': '111',
    'review:frontend': '000',
    'review:backend': '111',
    delivery: '000',
  },
  owner: {
    // creator / reqOwner
    requirement: '101',
    design: '111',
    'development:frontend': '000',
    'verification:frontend': '000',
    'development:backend': '000',
    'verification:backend': '000',
    'review:frontend': '111',
    'review:backend': '111',
    delivery: '111',
  },
  observer: {
    requirement: '000',
    design: '000',
    'development:frontend': '000',
    'verification:frontend': '000',
    'development:backend': '000',
    'verification:backend': '000',
    'review:frontend': '000',
    'review:backend': '000',
    delivery: '000',
  },
}

function matrixColumnKey(key: StageKey, branch: Branch): string {
  if (key === 'requirement' || key === 'design' || key === 'delivery') {
    return key
  }
  return `${key}:${branch}`
}

// A user may hold several roles on one task (e.g. creator + frontendDev).
// The effective permission is the OR of every role they hold.
export function permissionFor(
  permRoles: PermRoleKey[],
  key: StageKey,
  branch: Branch,
): Permission {
  const column = matrixColumnKey(key, branch)
  let execute = false
  let confirm = false
  let supplement = false
  for (const role of permRoles) {
    const value = MATRIX[role]?.[column]
    if (!value) continue
    const p = code(value)
    execute = execute || p.execute
    confirm = confirm || p.confirm
    supplement = supplement || p.supplement
  }
  return { execute, confirm, supplement }
}

export interface TaskOwners {
  creatorId: string
  reqOwnerId: string
  pmId: string
  frontendDevId: string
  backendDevId: string
}

// Which permission-matrix rows a user occupies on a given task.
export function permRolesForUser(user: User, owners: TaskOwners): PermRoleKey[] {
  if (user.role === 'observer') {
    return ['observer']
  }
  const roles = new Set<PermRoleKey>()
  if (user.id === owners.creatorId || user.id === owners.reqOwnerId) {
    roles.add('owner')
  }
  if (user.id === owners.pmId) {
    roles.add('pm')
  }
  if (user.id === owners.frontendDevId) {
    roles.add('frontendDev')
  }
  if (user.id === owners.backendDevId) {
    roles.add('backendDev')
  }
  return [...roles]
}

export function isRelatedUser(user: User, owners: TaskOwners): boolean {
  return (
    user.id === owners.creatorId ||
    user.id === owners.reqOwnerId ||
    user.id === owners.pmId ||
    user.id === owners.frontendDevId ||
    user.id === owners.backendDevId
  )
}

export function nowIso(): string {
  return new Date().toISOString()
}
