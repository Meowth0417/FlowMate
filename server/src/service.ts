import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { listDetectedAgents, type AgentStatus } from './agent-probe.js'
import { createDatabase, withTransaction } from './db.js'
import { ensureMockUsers, seedIfEmpty } from './seed.js'
import { buildDesignArtifact, DESIGN_STAGE_SUMMARY, generateExecution, type ProcessEvent } from './executor.js'
import { runCopilotDesign, runCopilotRequirement } from './real-agent.js'
import {
  STAGE_DEFINITIONS,
  branchLabel,
  getStageDefinition,
  isRelatedUser,
  nowIso,
  permRolesForUser,
  permissionFor,
  stageDisplayName,
  type Branch,
  type StageKey,
  type User,
} from './domain.js'

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
  target: 'frontend' | 'backend' | 'both'
  detail: string
  status: 'open' | 'fixed' | 'closed'
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
  status: string
  runCount: number
  extraPrompt: string
  summary: string
  artifact: unknown
  pendingNote: string
  updatedAt: string
  permission: { execute: boolean; confirm: boolean; supplement: boolean }
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

export interface LocalDirsView {
  path: string
  parent: string
  items: LocalDirItem[]
}

export interface StageExecutionOptions {
  prompt?: string
  agentName?: string
  modelId?: string
  effort?: string
  fastMode?: 'on' | 'off'
  workspacePath?: string
}

export interface ProjectMemoryItemView {
  id: string
  category: string
  title: string
  content: string
  structuredData: unknown
  scope: 'shared' | 'frontend' | 'backend'
  stageScope: string
  priority: 'high' | 'medium' | 'low'
  status: 'draft' | 'confirmed' | 'deprecated'
  sourceType: string
  sourceRef: string
  createdAt: string
  updatedAt: string
}

export interface ProjectSnapshotView {
  id: string
  version: number
  status: 'draft' | 'active' | 'archived'
  summary: string
  basedOnSnapshotId: string | null
  triggerType: string
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

interface TaskRow {
  id: string
  title: string
  description: string
  project_id: string
  state: string
  creator_id: string
  req_owner_id: string
  pm_id: string
  frontend_dev_id: string
  backend_dev_id: string
  tester_id: string
  frontend_repo: string
  backend_repo: string
  created_at: string
  updated_at: string
}

interface StageRow {
  task_id: string
  stage_key: string
  branch: string
  stage_order: number
  status: string
  run_count: number
  extra_prompt: string
  summary: string
  artifact_json: string
  pending_note: string
  active_run_id: string | null
  updated_at: string
}

interface StageRunRow {
  id: string
  task_id: string
  stage_key: string
  branch: string
  run_index: number
  status: string
  executor_id: string
  agent_name: string
  model_id: string
  effort: string
  fast_mode: string
  extra_prompt: string
  process_json: string
  artifact_json: string
  error_message: string
  reveal_interval_ms: number
  started_at: string
  finished_at: string | null
}

interface ProjectRow {
  id: string
  name: string
  description: string
  created_at: string
  updated_at: string
}

function toOwners(row: TaskRow) {
  return {
    creatorId: row.creator_id,
    reqOwnerId: row.req_owner_id,
    pmId: row.pm_id,
    frontendDevId: row.frontend_dev_id,
    backendDevId: row.backend_dev_id,
    testerId: row.tester_id,
  }
}

function normalizeRepoBranch(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeRepoPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const path = resolve(value.trim())
  return isAbsolute(path) ? path : null
}

function parseRepoField(value: string): RepoBinding | null {
  const text = value.trim()
  if (!text) {
    return null
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as { name?: unknown; path?: unknown; branch?: unknown }
      const path = normalizeRepoPath(record.path)
      if (path) {
        const fallbackName = basename(path) || path
        const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : fallbackName
        return { name, path, branch: normalizeRepoBranch(record.branch) }
      }
    }
  } catch {
    // Legacy string/array-only bindings cannot provide a usable local path.
  }
  return null
}

function stringifyRepoField(repo: RepoBinding | null): string {
  if (!repo?.name.trim() || !repo.path.trim()) {
    return ''
  }
  return JSON.stringify({
    name: repo.name.trim(),
    path: repo.path.trim(),
    branch: normalizeRepoBranch(repo.branch),
  })
}

export class WorkflowService {
  private db: DatabaseSync
  private runProcesses = new Map<string, ProcessEvent[]>()

  constructor() {
    this.db = createDatabase()
    ensureMockUsers(this.db)
    seedIfEmpty(this.db)
    this.ensureDefaultProject()
    this.migrateTaskProjects()
    this.normalizeTesterAssignments()
    this.normalizeStageLayout()
    this.resetEphemeralRunningStages()
    this.normalizeLegacyDevelopmentReview()
    this.normalizeLegacyDeliveryToTesting()
    this.normalizeStageArtifacts()
    this.refreshTestingDerivedData()
    this.normalizeTestingAvailability()
  }

  private resetEphemeralRunningStages() {
    const now = nowIso()
    withTransaction(this.db, () => {
      this.db
        .prepare("UPDATE task_stages SET status = 'pending', active_run_id = NULL, updated_at = ? WHERE status = 'running'")
        .run(now)
      this.db.prepare("UPDATE stage_runs SET status = 'aborted', finished_at = ? WHERE status = 'running'").run(now)
    })
  }

  private normalizeLegacyDevelopmentReview() {
    const now = nowIso()
    withTransaction(this.db, () => {
      const legacyRows = this.db
        .prepare("SELECT task_id, branch FROM task_stages WHERE stage_key = 'development' AND status = 'review'")
        .all() as unknown as { task_id: string; branch: Branch }[]

      for (const row of legacyRows) {
        this.db
          .prepare("UPDATE task_stages SET status = 'passed', updated_at = ? WHERE task_id = ? AND stage_key = 'development' AND branch = ?")
          .run(now, row.task_id, row.branch)

        this.db
          .prepare("UPDATE task_stages SET status = 'pending', updated_at = ? WHERE task_id = ? AND stage_key = 'verification' AND branch = ? AND status = 'blocked'")
          .run(now, row.task_id, row.branch)
      }
    })
  }

  private normalizeTesterAssignments() {
    const defaultTester = this.db
      .prepare("SELECT id FROM users WHERE role = 'tester' ORDER BY id ASC LIMIT 1")
      .get() as { id: string } | undefined
    if (!defaultTester) {
      return
    }
    this.db.prepare("UPDATE tasks SET tester_id = ? WHERE tester_id = ''").run(defaultTester.id)
  }

  private ensureDefaultProject() {
    const now = nowIso()
    this.db
      .prepare('INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('p-default', '默认项目', '历史任务自动迁移的默认项目。', now, now)
  }

  private migrateTaskProjects() {
    this.db.prepare("UPDATE tasks SET project_id = 'p-default' WHERE project_id = ''").run()
  }

  private normalizeStageLayout() {
    const now = nowIso()
    const stageOrder = new Map<string, number>()
    let order = 0
    for (const def of STAGE_DEFINITIONS) {
      for (const branch of def.branches) {
        stageOrder.set(`${def.key}:${branch}`, order)
        order += 1
      }
    }

    const tasks = this.db.prepare('SELECT id FROM tasks').all() as unknown as Array<{ id: string }>
    withTransaction(this.db, () => {
      for (const task of tasks) {
        const existing = this.listStageRows(task.id)
        const rowMap = new Map(existing.map((row) => [`${row.stage_key}:${row.branch}`, row] as const))
        for (const def of STAGE_DEFINITIONS) {
          for (const branch of def.branches) {
            const compositeKey = `${def.key}:${branch}` as `${string}:${string}`
            const stage = rowMap.get(compositeKey)
            if (stage) {
              this.db
                .prepare('UPDATE task_stages SET stage_order = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
                .run(stageOrder.get(compositeKey) ?? 0, task.id, def.key, branch)
              continue
            }
            this.db
              .prepare(
                `INSERT INTO task_stages (
                  task_id, stage_key, branch, stage_order, status, run_count, extra_prompt, summary, artifact_json, pending_note, active_run_id, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, '', '', '', '', NULL, ?)`,
              )
              .run(task.id, def.key, branch, stageOrder.get(compositeKey) ?? 0, this.initialMigratedStageStatus(task.id, def.key, branch), now)
          }
        }
      }
    })
  }

  private initialMigratedStageStatus(taskId: string, key: StageKey, branch: Branch) {
    if (key !== 'testing') {
      return key === 'requirement' ? 'pending' : 'blocked'
    }
    const delivery = this.db
      .prepare("SELECT status FROM task_stages WHERE task_id = ? AND stage_key = 'delivery' AND branch = 'shared'")
      .get(taskId) as { status: string } | undefined
    if (delivery && (delivery.status === 'pending' || delivery.status === 'passed')) {
      return 'passed'
    }
    const feReview = this.getStageRow(taskId, 'review', 'frontend')
    const beReview = this.getStageRow(taskId, 'review', 'backend')
    return feReview.status === 'passed' && beReview.status === 'passed' ? 'pending' : 'blocked'
  }

  private normalizeLegacyDeliveryToTesting() {
    const now = nowIso()
    withTransaction(this.db, () => {
      const rows = this.db
        .prepare("SELECT task_id, status FROM task_stages WHERE stage_key = 'delivery' AND branch = 'shared'")
        .all() as unknown as Array<{ task_id: string; status: string }>

      for (const row of rows) {
        const testing = this.getStageRow(row.task_id, 'testing', 'shared')
        if (testing.status !== 'blocked' && testing.status !== 'pending' && testing.status !== 'passed') {
          continue
        }
        if (row.status === 'pending' || row.status === 'passed') {
          this.db
            .prepare("UPDATE task_stages SET status = 'passed', updated_at = ? WHERE task_id = ? AND stage_key = 'testing' AND branch = 'shared'")
            .run(now, row.task_id)
        }
      }
    })
  }

  private refreshTestingDerivedData() {
    const tasks = this.db.prepare('SELECT id FROM tasks').all() as unknown as Array<{ id: string }>
    for (const task of tasks) {
      this.refreshTestingStageArtifact(task.id)
      this.refreshDevelopmentBugNotes(task.id)
    }
  }

  private normalizeStageArtifacts() {
    const tasks = this.db.prepare('SELECT * FROM tasks').all() as unknown as TaskRow[]
    const now = nowIso()
    withTransaction(this.db, () => {
      for (const task of tasks) {
        const requirementStage = this.getStageRow(task.id, 'requirement', 'shared')
        this.syncNormalizedStageArtifact(
          requirementStage,
          normalizeRequirementArtifact(parseArtifact(requirementStage.artifact_json), requirementStage.summary),
          now,
        )

        const designStage = this.getStageRow(task.id, 'design', 'shared')
        const normalizedDesign = normalizeDesignArtifact(task.title, parseArtifact(designStage.artifact_json), designStage.summary)
        this.syncNormalizedStageArtifact(designStage, normalizedDesign, now)
        if (designStage.status === 'review') {
          const note = this.designConfirmationNote(this.readDesignConfirmations(normalizedDesign.artifact))
          if (designStage.pending_note !== note) {
            this.db
              .prepare('UPDATE task_stages SET pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
              .run(note, now, task.id, 'design', 'shared')
          }
        }

        for (const branch of ['frontend', 'backend'] as const) {
          const developmentStage = this.getStageRow(task.id, 'development', branch)
          this.syncNormalizedStageArtifact(
            developmentStage,
            normalizeDevelopmentArtifact(branch, parseArtifact(developmentStage.artifact_json), developmentStage.summary),
            now,
          )

          const reviewStage = this.getStageRow(task.id, 'review', branch)
          this.syncNormalizedStageArtifact(
            reviewStage,
            normalizeReviewArtifact(parseArtifact(reviewStage.artifact_json), reviewStage.summary),
            now,
          )

          const verificationStage = this.getStageRow(task.id, 'verification', branch)
          this.syncNormalizedStageArtifact(
            verificationStage,
            buildVerificationArtifact(branch, verificationStage, this.listVerificationRows(task.id, branch)),
            now,
          )
        }

        const testingStage = this.getStageRow(task.id, 'testing', 'shared')
        this.syncNormalizedStageArtifact(testingStage, buildTestingArtifact(testingStage, this.listTestingBugRows(task.id)), now)

        const deliveryStage = this.getStageRow(task.id, 'delivery', 'shared')
        this.syncNormalizedStageArtifact(deliveryStage, buildDeliveryArtifact(task, deliveryStage), now)
      }
    })
  }

  private syncNormalizedStageArtifact(stage: StageRow, normalized: { summary: string; artifact: Record<string, unknown> }, now: string) {
    const artifactJson = JSON.stringify(normalized.artifact)
    if (stage.summary === normalized.summary && stage.artifact_json === artifactJson) {
      return
    }
    this.db
      .prepare('UPDATE task_stages SET summary = ?, artifact_json = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run(normalized.summary, artifactJson, now, stage.task_id, stage.stage_key, stage.branch)
  }

  private normalizeTestingAvailability() {
    const tasks = this.db.prepare('SELECT id FROM tasks').all() as unknown as Array<{ id: string }>
    for (const task of tasks) {
      this.maybeOpenTesting(task.id)
    }
  }

  listUsers(): User[] {
    return this.db.prepare('SELECT id, name, role FROM users').all() as unknown as User[]
  }

  listProjects(): ProjectView[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC').all() as unknown as ProjectRow[]
    return rows.map((row) => this.buildProjectView(row))
  }

  getProjectView(projectId: string): ProjectView {
    return this.buildProjectView(this.getProjectRow(projectId))
  }

  saveProject(input: { projectId?: string; name: string; description?: string }): ProjectView {
    const now = nowIso()
    const name = input.name.trim()
    const description = input.description?.trim() ?? ''
    if (!name) {
      throw new Error('项目名称不能为空')
    }
    const projectId = input.projectId?.trim() || `p-${crypto.randomUUID().slice(0, 8)}`
    const existing = input.projectId ? this.getProjectRow(projectId) : null
    if (existing) {
      this.db.prepare('UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(name, description, now, projectId)
    } else {
      this.db.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(projectId, name, description, now, now)
    }
    return this.getProjectView(projectId)
  }

  saveProjectMemory(projectId: string, input: { summary: string; items: Omit<ProjectMemoryItemView, 'id' | 'createdAt' | 'updatedAt'>[] }): ProjectView {
    const project = this.getProjectRow(projectId)
    const now = nowIso()
    const active = this.db
      .prepare("SELECT * FROM project_memory_snapshots WHERE project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
      .get(projectId) as
      | { id: string; version: number }
      | undefined
    const nextVersion = (active?.version ?? 0) + 1
    const draftId = `ps-${crypto.randomUUID().slice(0, 8)}`
    withTransaction(this.db, () => {
      this.db.prepare("UPDATE project_memory_snapshots SET status = 'archived', updated_at = ? WHERE project_id = ? AND status = 'draft'").run(now, projectId)
      this.db
        .prepare(
          'INSERT INTO project_memory_snapshots (id, project_id, version, status, summary, based_on_snapshot_id, trigger_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(draftId, projectId, nextVersion, 'draft', input.summary.trim(), active?.id ?? null, 'manual-update', now, now)
      input.items.forEach((item) => {
        this.db
          .prepare(
            `INSERT INTO project_memory_items (
              id, project_id, snapshot_id, category, title, content, structured_data, scope, stage_scope, priority, status, source_type, source_ref, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            crypto.randomUUID(),
            projectId,
            draftId,
            item.category,
            item.title,
            item.content,
            JSON.stringify(item.structuredData ?? null),
            item.scope,
            item.stageScope,
            item.priority,
            item.status,
            item.sourceType,
            item.sourceRef,
            now,
            now,
          )
      })
      if (active?.id) {
        this.db.prepare("UPDATE project_memory_snapshots SET status = 'archived', updated_at = ? WHERE id = ?").run(now, active.id)
      }
      this.db.prepare("UPDATE project_memory_snapshots SET status = 'active', updated_at = ? WHERE id = ?").run(now, draftId)
      this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, project.id)
    })
    return this.getProjectView(projectId)
  }

  private buildProjectView(row: ProjectRow): ProjectView {
    const snapshots = this.db
      .prepare('SELECT * FROM project_memory_snapshots WHERE project_id = ? ORDER BY version DESC, created_at DESC')
      .all(row.id) as unknown as Array<{
      id: string
      version: number
      status: 'draft' | 'active' | 'archived'
      summary: string
      based_on_snapshot_id: string | null
      trigger_type: string
      created_at: string
      updated_at: string
    }>
    const buildSnapshot = (snapshotId: string): ProjectSnapshotView => {
      const snapshot = snapshots.find((item) => item.id === snapshotId)!
      const items = this.db
        .prepare('SELECT * FROM project_memory_items WHERE snapshot_id = ? ORDER BY scope ASC, priority DESC, created_at ASC')
        .all(snapshotId) as unknown as Array<{
        id: string
        category: string
        title: string
        content: string
        structured_data: string
        scope: 'shared' | 'frontend' | 'backend'
        stage_scope: string
        priority: 'high' | 'medium' | 'low'
        status: 'draft' | 'confirmed' | 'deprecated'
        source_type: string
        source_ref: string
        created_at: string
        updated_at: string
      }>
      return {
        id: snapshot.id,
        version: snapshot.version,
        status: snapshot.status,
        summary: snapshot.summary,
        basedOnSnapshotId: snapshot.based_on_snapshot_id,
        triggerType: snapshot.trigger_type,
        createdAt: snapshot.created_at,
        updatedAt: snapshot.updated_at,
        items: items.map((item) => ({
          id: item.id,
          category: item.category,
          title: item.title,
          content: item.content,
          structuredData: parseArtifact(item.structured_data),
          scope: item.scope,
          stageScope: item.stage_scope,
          priority: item.priority,
          status: item.status,
          sourceType: item.source_type,
          sourceRef: item.source_ref,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        })),
      }
    }
    const active = snapshots.find((item) => item.status === 'active')
    const draft = snapshots.find((item) => item.status === 'draft')
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      activeSnapshot: active ? buildSnapshot(active.id) : null,
      draftSnapshot: draft ? buildSnapshot(draft.id) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listAgents(): AgentStatus[] {
    return listDetectedAgents()
  }

  private getStageRunRow(runId: string) {
    const row = this.db.prepare('SELECT * FROM stage_runs WHERE id = ?').get(runId) as StageRunRow | undefined
    if (!row) {
      throw new Error('执行记录不存在')
    }
    return row
  }

  private getProjectRow(projectId: string): ProjectRow {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined
    if (!row) {
      throw new Error('项目不存在')
    }
    return row
  }

  private parseProcessJson(value: string) {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? (parsed as ProcessEvent[]) : []
    } catch {
      return []
    }
  }

  private appendRunProcessEvents(runId: string, events: ProcessEvent[]) {
    const run = this.getStageRunRow(runId)
    const existing = this.parseProcessJson(run.process_json)
    const normalized = events.map((event, index) => ({ ...event, order: existing.length + index }))
    const next = [...existing, ...normalized]
    this.db.prepare('UPDATE stage_runs SET process_json = ? WHERE id = ?').run(JSON.stringify(next), runId)
  }

  private trimStageRunHistory(taskId: string, key: StageKey, branch: Branch, keep = 10) {
    const rows = this.db
      .prepare('SELECT id FROM stage_runs WHERE task_id = ? AND stage_key = ? AND branch = ? ORDER BY run_index DESC, started_at DESC')
      .all(taskId, key, branch) as unknown as Array<{ id: string }>
    rows.slice(keep).forEach((row) => {
      this.db.prepare('DELETE FROM stage_runs WHERE id = ?').run(row.id)
      this.runProcesses.delete(row.id)
    })
  }

  private resolveRealAgentSelection(options?: StageExecutionOptions) {
    const agentName = options?.agentName?.trim() || 'copilot'
    if (agentName !== 'copilot') {
      throw new Error('第一批真实执行仅支持 copilot')
    }
    const agent = this.listAgents().find((item) => item.name === agentName)
    if (!agent?.installed || !agent.available) {
      throw new Error(agent?.error?.trim() || '所选 agent 当前不可用')
    }
    return {
      agentName,
      modelId: options?.modelId?.trim() || agent.default_model_id || agent.current_model_id || '',
      effort: options?.effort?.trim() || agent.default_effort || '',
      fastMode: options?.fastMode === 'on' ? 'on' : 'off',
    }
  }

  listLocalDirs(path?: string): LocalDirsView {
    const trimmed = typeof path === 'string' ? path.trim() : ''
    if (!trimmed) {
      return { path: '', parent: '', items: this.listLocalRoots() }
    }

    const absPath = resolve(trimmed)
    if (!isAbsolute(absPath)) {
      throw new Error('路径必须是绝对路径')
    }
    const info = statSync(absPath, { throwIfNoEntry: false })
    if (!info) {
      throw new Error('目录不存在')
    }
    if (!info.isDirectory()) {
      throw new Error('路径不是目录')
    }

    const items = readdirSync(absPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: resolve(absPath, entry.name),
        isDir: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

    const parent = dirname(absPath)
    return {
      path: absPath,
      parent: parent === absPath ? '' : parent,
      items,
    }
  }

  private listLocalRoots(): LocalDirItem[] {
    if (process.platform === 'win32') {
      const drives: LocalDirItem[] = []
      for (let code = 65; code <= 90; code += 1) {
        const drive = `${String.fromCharCode(code)}:\\`
        if (existsSync(drive)) {
          drives.push({ name: drive, path: drive, isDir: true })
        }
      }
      return drives
    }

    const rootPath = resolve('/')
    const items = [{ name: rootPath, path: rootPath, isDir: true }]
    const userHome = homedir().trim()
    if (userHome && userHome !== rootPath) {
      items.push({ name: basename(userHome) || userHome, path: resolve(userHome), isDir: true })
    }
    return items
  }

  getUser(userId: string): User {
    const user = this.db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(userId) as User | undefined
    if (!user) {
      throw new Error('用户不存在')
    }
    return user
  }

  private getTaskRow(taskId: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!row) {
      throw new Error('任务不存在')
    }
    return row
  }

  private getStageRow(taskId: string, key: StageKey, branch: Branch): StageRow {
    const row = this.db
      .prepare('SELECT * FROM task_stages WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .get(taskId, key, branch) as StageRow | undefined
    if (!row) {
      throw new Error('阶段不存在')
    }
    return row
  }

  private listStageRows(taskId: string): StageRow[] {
    return this.db
      .prepare('SELECT * FROM task_stages WHERE task_id = ? ORDER BY stage_order ASC')
      .all(taskId) as unknown as StageRow[]
  }

  private listVerificationRows(taskId: string, branch: Branch) {
    return this.db
      .prepare('SELECT * FROM verifications WHERE task_id = ? AND branch = ? ORDER BY created_at ASC, rowid ASC')
      .all(taskId, branch) as unknown as Array<{
      id: string
      branch: string
      result: 'pass' | 'reject'
      reason: string
      operator_id: string
      created_at: string
    }>
  }

  // ---- Views ----

  listTasks(viewer: User): TaskView[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as unknown as TaskRow[]
    const visible = rows.filter((row) => viewer.role === 'observer' || isRelatedUser(viewer, toOwners(row)))
    return visible.map((row) => this.buildTaskView(row, viewer))
  }

  getTaskView(taskId: string, viewer: User): TaskView {
    return this.buildTaskView(this.getTaskRow(taskId), viewer)
  }

  private buildTaskView(row: TaskRow, viewer: User): TaskView {
    const owners = toOwners(row)
    const permRoles = permRolesForUser(viewer, owners)
    this.tickRunningStages(row.id)
    const stageRows = this.listStageRows(row.id)
    const verificationRows = this.db
      .prepare('SELECT * FROM verifications WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(row.id) as unknown as {
      id: string
      branch: string
      result: string
      reason: string
      operator_id: string
      created_at: string
    }[]
    const testingBugRows = this.db
      .prepare(
        "SELECT * FROM testing_bugs WHERE task_id = ? ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'fixed' THEN 1 ELSE 2 END ASC, seq DESC",
      )
      .all(row.id) as unknown as Array<{
      id: string
      seq: number
      target: 'frontend' | 'backend' | 'both'
      detail: string
      status: 'open' | 'fixed' | 'closed'
      reporter_id: string
      frontend_fixed_by: string
      frontend_fixed_at: string | null
      backend_fixed_by: string
      backend_fixed_at: string | null
      closed_by: string | null
      created_at: string
      updated_at: string
    }>
    const stages: StageView[] = stageRows.map((stage) => {
      const key = stage.stage_key as StageKey
      const branch = stage.branch as Branch
      const perm = permissionFor(permRoles, key, branch)
      const verificationHistory: VerificationRecordView[] =
        key === 'verification'
          ? verificationRows
              .filter((v) => v.branch === branch)
              .map((v) => ({
                id: v.id,
                result: v.result as 'pass' | 'reject',
                reason: v.reason,
                operatorId: v.operator_id,
                createdAt: v.created_at,
              }))
          : []
      const testingBugs: TestingBugView[] =
        key === 'testing'
          ? testingBugRows.map((bug) => ({
              id: bug.id,
              seq: bug.seq,
              target: bug.target,
              detail: bug.detail,
              status: bug.status,
              reporterId: bug.reporter_id,
              frontendFixed: Boolean(bug.frontend_fixed_at),
              backendFixed: Boolean(bug.backend_fixed_at),
              closedBy: bug.closed_by,
              createdAt: bug.created_at,
              updatedAt: bug.updated_at,
            }))
          : []
      return {
        key,
        branch,
        name: stageDisplayName(key, branch),
        status: stage.status,
        runCount: stage.run_count,
        extraPrompt: stage.extra_prompt,
        summary: stage.summary,
        artifact: stage.artifact_json ? JSON.parse(stage.artifact_json) : null,
        pendingNote: stage.pending_note,
        updatedAt: stage.updated_at,
        permission: perm,
        verificationHistory,
        testingBugs,
      }
    })

    const clarRows = this.db
      .prepare('SELECT * FROM clarifications WHERE task_id = ? ORDER BY seq ASC')
      .all(row.id) as unknown as {
      id: string
      seq: number
      question: string
      options_json: string
      answer: string
      status: string
      answered_by: string | null
    }[]
    const clarifications: ClarificationView[] = clarRows.map((c) => ({
      id: c.id,
      seq: c.seq,
      question: c.question,
      options: JSON.parse(c.options_json) as string[],
      answer: c.answer,
      status: c.status,
      answeredBy: c.answered_by,
    }))

    const timelineRows = this.db
      .prepare('SELECT * FROM timeline_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(row.id) as unknown as {
      id: string
      stage_key: string | null
      branch: string | null
      kind: string
      title: string
      detail: string
      actor_id: string
      created_at: string
    }[]
    const timeline: TimelineView[] = timelineRows.map((t) => ({
      id: t.id,
      stageKey: t.stage_key,
      branch: t.branch,
      kind: t.kind,
      title: t.title,
      detail: t.detail,
      actorId: t.actor_id,
      createdAt: t.created_at,
    }))

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      projectId: row.project_id,
      state: row.state,
      creatorId: row.creator_id,
      reqOwnerId: row.req_owner_id,
      pmId: row.pm_id,
      frontendDevId: row.frontend_dev_id,
      backendDevId: row.backend_dev_id,
      testerId: row.tester_id,
      frontendRepo: parseRepoField(row.frontend_repo),
      backendRepo: parseRepoField(row.backend_repo),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stages,
      clarifications,
      timeline,
      stateLabel: deriveStateLabel(row.state, stages),
    }
  }

  // ---- Mutations ----

  private touchTask(taskId: string) {
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(nowIso(), taskId)
  }

  private setStageStatus(taskId: string, key: StageKey, branch: Branch, status: string) {
    this.db
      .prepare('UPDATE task_stages SET status = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run(status, nowIso(), taskId, key, branch)
  }

  private addTimeline(
    taskId: string,
    kind: string,
    title: string,
    detail: string,
    actorId: string,
    key: StageKey | null,
    branch: Branch | null,
  ) {
    this.db
      .prepare(
        'INSERT INTO timeline_events (id, task_id, stage_key, branch, kind, title, detail, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(crypto.randomUUID(), taskId, key, branch, kind, title, detail, actorId, nowIso())
  }

  createTask(
    input: {
      title: string
      description: string
      projectId: string
      refreshProjectContext: boolean
      reqOwnerId: string
      pmId: string
      frontendDevId: string
      backendDevId: string
      testerId: string
    },
    creator: User,
  ): TaskView {
    if (creator.role === 'observer') {
      throw new Error('观察者不可创建任务')
    }
    const tester = this.getUser(input.testerId)
    if (tester.role !== 'tester') {
      throw new Error('测试负责人必须是测试角色用户')
    }
    this.getProjectRow(input.projectId)
    const hasActiveSnapshot = Boolean(
      this.db
        .prepare("SELECT id FROM project_memory_snapshots WHERE project_id = ? AND status = 'active' LIMIT 1")
        .get(input.projectId) as { id: string } | undefined,
    )
    if (!input.refreshProjectContext && !hasActiveSnapshot) {
      throw new Error('当前项目还没有有效上下文快照，请先刷新项目上下文')
    }
    const id = `t-${crypto.randomUUID().slice(0, 8)}`
    const now = nowIso()
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO tasks (
            id, title, description, project_id, state, creator_id, req_owner_id, pm_id, frontend_dev_id, backend_dev_id,
            tester_id, frontend_repo, backend_repo, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.description,
          input.projectId,
          'pending',
          creator.id,
          input.reqOwnerId,
          input.pmId,
          input.frontendDevId,
          input.backendDevId,
          input.testerId,
          '',
          '',
          now,
          now,
        )

      let order = 0
      for (const def of STAGE_DEFINITIONS) {
        for (const branch of def.branches) {
          const status =
            def.key === 'projectContext'
              ? input.refreshProjectContext
                ? 'pending'
                : 'passed'
              : def.key === 'requirement'
                ? input.refreshProjectContext
                  ? 'blocked'
                  : 'pending'
                : 'blocked'
          this.db
            .prepare(
              `INSERT INTO task_stages (
                task_id, stage_key, branch, stage_order, status, run_count, extra_prompt, summary, artifact_json, pending_note, active_run_id, updated_at
              ) VALUES (?, ?, ?, ?, ?, 0, '', '', '', '', NULL, ?)`,
            )
            .run(id, def.key, branch, order, status, now)
          order += 1
        }
      }
      this.addTimeline(id, 'created', '任务创建', input.description, creator.id, null, null)
    })
    return this.getTaskView(id, creator)
  }

  cancelTask(taskId: string, actor: User): TaskView {
    const task = this.getTaskRow(taskId)
    if (task.state !== 'pending') {
      throw new Error('任务已开始执行，无法撤销')
    }
    this.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run('cancelled', nowIso(), taskId)
    this.addTimeline(taskId, 'cancelled', '任务撤销', '', actor.id, null, null)
    return this.getTaskView(taskId, actor)
  }

  saveExtraPrompt(taskId: string, key: StageKey, branch: Branch, prompt: string, actor: User): TaskView {
    this.db
      .prepare('UPDATE task_stages SET extra_prompt = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run(prompt, nowIso(), taskId, key, branch)
    if (prompt.trim()) {
      this.addTimeline(taskId, 'prompt', `${stageDisplayName(key, branch)} 附加提示词`, prompt, actor.id, key, branch)
    }
    return this.getTaskView(taskId, actor)
  }

  private startRealStageExecution(
    task: TaskRow,
    stage: StageRow,
    actor: User,
    options?: StageExecutionOptions,
  ) {
    const key = stage.stage_key as StageKey
    const branch = stage.branch as Branch
    const effectivePrompt = options?.prompt === undefined ? stage.extra_prompt : options.prompt.trim()
    const selected = this.resolveRealAgentSelection(options)
    const now = nowIso()
    const runId = crypto.randomUUID()
    const runIndex = stage.run_count + 1
    const initialEvents: ProcessEvent[] = [
      { order: 0, type: 'thought', title: '准备执行', content: '已创建真实 agent 后台任务。' },
      { order: 1, type: 'tool', title: selected.agentName, content: `将使用 ${selected.modelId || '默认模型'} 执行。`, tool: { name: selected.agentName, status: 'complete', detail: selected.effort || 'default' } },
    ]

    withTransaction(this.db, () => {
      if (task.state === 'pending') {
        this.db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('in_progress', task.id)
      }
      this.db
        .prepare(
          `INSERT INTO stage_runs (
            id, task_id, stage_key, branch, run_index, status, executor_id, agent_name, model_id, effort, fast_mode, extra_prompt, process_json, artifact_json, error_message, reveal_interval_ms, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, '', '', 0, ?, NULL)`,
        )
        .run(
          runId,
          task.id,
          key,
          branch,
          runIndex,
          actor.id,
          selected.agentName,
          selected.modelId,
          selected.effort,
          selected.fastMode,
          effectivePrompt,
          JSON.stringify(initialEvents),
          now,
        )

      this.db
        .prepare('UPDATE task_stages SET status = ?, run_count = ?, active_run_id = ?, extra_prompt = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
        .run('running', runIndex, runId, effectivePrompt, '', now, task.id, key, branch)
      this.touchTask(task.id)
      this.addTimeline(task.id, 'executing', `${stageDisplayName(key, branch)} 开始真实执行`, selected.agentName, actor.id, key, branch)
    })

    void this.runRealStageExecution(task, stage, actor, runId, effectivePrompt)
    return this.getTaskView(task.id, actor)
  }

  private async runRealStageExecution(
    task: TaskRow,
    stage: StageRow,
    actor: User,
    runId: string,
    effectivePrompt: string,
  ) {
    const key = stage.stage_key as StageKey
    const branch = stage.branch as Branch
    try {
      const run = this.getStageRunRow(runId)
      const projectContext =
        key === 'requirement'
          ? this.projectMemoryContext(task.project_id, ['shared'])
          : this.projectMemoryContext(task.project_id, ['shared', 'frontend', 'backend'])
      const mergedPrompt = [projectContext, effectivePrompt].filter((item) => item.trim()).join('\n\n')
      const result = await (
        key === 'requirement'
          ? runCopilotRequirement(
              {
                title: task.title,
                description: task.description,
                extraPrompt: mergedPrompt,
              },
              { modelId: run.model_id, effort: run.effort },
            )
          : runCopilotDesign(
              {
                title: task.title,
                description: task.description,
                requirementDoc: this.requirementDocForDesign(task.id),
                extraPrompt: mergedPrompt,
              },
              { modelId: run.model_id, effort: run.effort },
            )
      )

      this.appendRunProcessEvents(runId, result.process)

      withTransaction(this.db, () => {
        this.db
          .prepare('UPDATE stage_runs SET status = ?, artifact_json = ?, error_message = ?, finished_at = ? WHERE id = ?')
          .run('complete', JSON.stringify({ ...result.artifact, summary: result.summary }), '', nowIso(), runId)
        this.db
          .prepare('UPDATE task_stages SET status = ?, summary = ?, artifact_json = ?, pending_note = ?, active_run_id = NULL, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
          .run(
            'review',
            result.summary,
            JSON.stringify(result.artifact),
            key === 'design' ? this.designConfirmationNote({ frontend: false, backend: false }) : '',
            nowIso(),
            task.id,
            key,
            branch,
          )
        if (key === 'requirement') {
          this.replaceClarifications(task.id, result.clarifications ?? [])
        }
        this.touchTask(task.id)
        this.addTimeline(task.id, 'stage', `${stageDisplayName(key, branch)} 真实执行完成`, '', actor.id, key, branch)
      })
      this.trimStageRunHistory(task.id, key, branch)
    } catch (error) {
      const message = (error as Error).message || '真实 agent 执行失败'
      this.appendRunProcessEvents(runId, [{ order: this.parseProcessJson(this.getStageRunRow(runId).process_json).length, type: 'text', title: '执行失败', content: message }])
      withTransaction(this.db, () => {
        this.db.prepare('UPDATE stage_runs SET status = ?, error_message = ?, finished_at = ? WHERE id = ?').run('failed', message, nowIso(), runId)
        this.db
          .prepare('UPDATE task_stages SET status = ?, active_run_id = NULL, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
          .run('pending', `执行失败：${message}`, nowIso(), task.id, key, branch)
        this.touchTask(task.id)
        this.addTimeline(task.id, 'stage', `${stageDisplayName(key, branch)} 执行失败`, message, actor.id, key, branch)
      })
      this.trimStageRunHistory(task.id, key, branch)
    }
  }

  private requirementDocForDesign(taskId: string) {
    const stage = this.getStageRow(taskId, 'requirement', 'shared')
    const artifact = parseArtifact(stage.artifact_json)
    if (artifact && typeof artifact.fullDoc === 'string' && artifact.fullDoc.trim()) {
      return artifact.fullDoc.trim()
    }
    return stage.summary || ''
  }

  private projectMemoryContext(projectId: string, scopes: Array<'shared' | 'frontend' | 'backend'>) {
    const snapshot = this.db
      .prepare("SELECT id FROM project_memory_snapshots WHERE project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
      .get(projectId) as { id: string } | undefined
    if (!snapshot) {
      return ''
    }
    const rows = this.db
      .prepare(
        `SELECT scope, category, title, content
         FROM project_memory_items
         WHERE snapshot_id = ? AND scope IN (${scopes.map(() => '?').join(',')})
         ORDER BY CASE scope WHEN 'shared' THEN 0 WHEN 'frontend' THEN 1 ELSE 2 END, created_at ASC`,
      )
      .all(snapshot.id, ...scopes) as Array<{ scope: string; category: string; title: string; content: string }>
    if (!rows.length) {
      return ''
    }
    return [
      '以下为项目上下文快照，请作为硬约束与背景输入一并纳入：',
      ...rows.map((item) => `- [${item.scope}/${item.category}] ${item.title}\n${item.content}`),
    ].join('\n')
  }

  private executeProjectContextStage(task: TaskRow, stage: StageRow, actor: User, options?: StageExecutionOptions) {
    this.assertProjectContextExecutor(task, actor)
    const workspacePath = normalizeRepoPath(options?.workspacePath)
    if (!workspacePath) {
      throw new Error('请先选择本地工作区')
    }
    const info = statSync(workspacePath, { throwIfNoEntry: false })
    if (!info?.isDirectory()) {
      throw new Error('本地工作区必须是有效目录')
    }

    const isFrontend = actor.id === task.frontend_dev_id
    const scope = isFrontend ? 'frontend' : 'backend'
    const currentArtifact = (parseArtifact(stage.artifact_json) ?? {}) as {
      summary?: string
      items?: Array<Record<string, unknown>>
      refreshState?: { frontend?: boolean; backend?: boolean }
    }
    const refreshState = {
      frontend: Boolean(currentArtifact.refreshState?.frontend),
      backend: Boolean(currentArtifact.refreshState?.backend),
    }
    const nextItems = this.scanProjectWorkspaceMemory(workspacePath, scope)
    const mergedItems = [
      ...(Array.isArray(currentArtifact.items) ? currentArtifact.items.filter((item) => (item as { scope?: string }).scope !== scope) : []),
      ...nextItems,
    ]
    const nextState = {
      frontend: isFrontend ? true : refreshState.frontend,
      backend: isFrontend ? refreshState.backend : true,
    }
    const summary = `已从${isFrontend ? '前端' : '后端'}工作区提炼 ${nextItems.length} 条项目记忆。`
    const nextArtifact = {
      summary,
      items: mergedItems,
      refreshState: nextState,
    }

    withTransaction(this.db, () => {
      if (nextState.frontend && nextState.backend) {
        this.activateProjectSnapshot(task.project_id, {
          summary: '项目上下文刷新已完成，当前快照可供需求理解与详细设计消费。',
          items: mergedItems.map((item) => ({
            category: String(item.category ?? 'best-practice'),
            title: String(item.title ?? '项目记忆'),
            content: String(item.content ?? ''),
            structuredData: item,
            scope: (item.scope as 'shared' | 'frontend' | 'backend') ?? 'shared',
            stageScope: 'all',
            priority: 'medium' as const,
            status: 'confirmed' as const,
            sourceType: 'repo-scan',
            sourceRef: String(item.sourceRef ?? ''),
          })),
          triggerType: 'rescan',
        })
        this.db
          .prepare('UPDATE task_stages SET status = ?, summary = ?, artifact_json = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
          .run('passed', '项目上下文刷新已完成。', JSON.stringify(nextArtifact), '', nowIso(), task.id, 'projectContext', 'shared')
        this.setStageStatus(task.id, 'requirement', 'shared', 'pending')
        this.addTimeline(task.id, 'stage', '项目上下文刷新完成', this.projectContextPendingNote(nextState), actor.id, 'projectContext', 'shared')
      } else {
        this.db
          .prepare('UPDATE task_stages SET status = ?, summary = ?, artifact_json = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
          .run('review', summary, JSON.stringify(nextArtifact), this.projectContextPendingNote(nextState), nowIso(), task.id, 'projectContext', 'shared')
        this.addTimeline(task.id, 'stage', '项目上下文刷新进行中', this.projectContextPendingNote(nextState), actor.id, 'projectContext', 'shared')
      }
      this.touchTask(task.id)
    })

    return this.getTaskView(task.id, actor)
  }

  private activateProjectSnapshot(
    projectId: string,
    input: { summary: string; items: Omit<ProjectMemoryItemView, 'id' | 'createdAt' | 'updatedAt'>[]; triggerType: string },
  ) {
    const now = nowIso()
    const active = this.db
      .prepare("SELECT id, version FROM project_memory_snapshots WHERE project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
      .get(projectId) as { id: string; version: number } | undefined
    const snapshotId = `ps-${crypto.randomUUID().slice(0, 8)}`
    this.db.prepare("UPDATE project_memory_snapshots SET status = 'archived', updated_at = ? WHERE project_id = ? AND status IN ('active','draft')").run(now, projectId)
    this.db
      .prepare('INSERT INTO project_memory_snapshots (id, project_id, version, status, summary, based_on_snapshot_id, trigger_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(snapshotId, projectId, (active?.version ?? 0) + 1, 'active', input.summary, active?.id ?? null, input.triggerType, now, now)
    input.items.forEach((item) => {
      this.db
        .prepare(
          `INSERT INTO project_memory_items (
            id, project_id, snapshot_id, category, title, content, structured_data, scope, stage_scope, priority, status, source_type, source_ref, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          projectId,
          snapshotId,
          item.category,
          item.title,
          item.content,
          JSON.stringify(item.structuredData ?? null),
          item.scope,
          item.stageScope,
          item.priority,
          item.status,
          item.sourceType,
          item.sourceRef,
          now,
          now,
        )
    })
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId)
  }

  private scanProjectWorkspaceMemory(workspacePath: string, scope: 'frontend' | 'backend') {
    const docs: Array<{ path: string; content: string }> = []
    const agentsMd = join(workspacePath, 'AGENTS.md')
    if (existsSync(agentsMd)) {
      docs.push({ path: agentsMd, content: this.safeReadTextFile(agentsMd) })
    }
    const agentsDir = join(workspacePath, '.agents')
    if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
      this.collectTextFiles(agentsDir).forEach((filePath) => {
        docs.push({ path: filePath, content: this.safeReadTextFile(filePath) })
      })
    }
    if (!docs.length) {
      throw new Error('所选工作区缺少 AGENTS.md 或 .agents 目录')
    }
    return docs.flatMap((doc) => this.extractProjectMemoryItems(workspacePath, doc.path, doc.content, scope))
  }

  private collectTextFiles(root: string): string[] {
    const results: string[] = []
    const stack = [root]
    while (stack.length) {
      const current = stack.pop()!
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const fullPath = join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(fullPath)
        } else if (/\.(md|txt|json|ya?ml)$/i.test(entry.name)) {
          results.push(fullPath)
        }
      }
    }
    return results
  }

  private safeReadTextFile(path: string) {
    return readFileSync(path, 'utf8')
  }

  private extractProjectMemoryItems(rootPath: string, filePath: string, content: string, scope: 'frontend' | 'backend') {
    const normalized = content.replace(/\r\n/g, '\n').trim()
    if (!normalized) {
      return []
    }
    const sections = normalized.split(/\n(?=##?\s+)/g).filter(Boolean)
    const category = scope === 'frontend' ? 'component-pattern' : 'service-boundary-rule'
    return sections.slice(0, 12).map((section, index) => {
      const lines = section.split('\n').filter(Boolean)
      const titleLine = lines[0]?.replace(/^#+\s*/, '').trim() || `${basename(filePath)} #${index + 1}`
      return {
        scope,
        category,
        title: titleLine,
        content: lines.slice(1).join('\n').trim() || lines[0].trim(),
        sourceRef: relative(rootPath, filePath) || basename(filePath),
      }
    })
  }

  bindRepo(taskId: string, branch: Branch, repoPath: string, actor: User): TaskView {
    const task = this.getTaskRow(taskId)
    const expectedActorId = branch === 'frontend' ? task.frontend_dev_id : task.backend_dev_id
    if (actor.id !== expectedActorId) {
      throw new Error(`仅指定${branch === 'frontend' ? '前端' : '后端'}开发可绑定本地仓库`)
    }
    const stage = this.getStageRow(taskId, 'development', branch)
    const currentRepo = branch === 'frontend' ? parseRepoField(task.frontend_repo) : parseRepoField(task.backend_repo)
    if (stage.run_count > 0 && currentRepo) {
      throw new Error('首次执行后不可更换仓库')
    }
    const normalizedPath = normalizeRepoPath(repoPath)
    if (!normalizedPath) {
      throw new Error('请先选择本地仓库路径')
    }
    const info = statSync(normalizedPath, { throwIfNoEntry: false })
    if (!info) {
      throw new Error('本地仓库路径不存在')
    }
    if (!info.isDirectory()) {
      throw new Error('本地仓库路径必须是目录')
    }
    const normalizedRepo: RepoBinding = {
      name: basename(normalizedPath) || normalizedPath,
      path: normalizedPath,
      branch: detectGitBranch(normalizedPath),
    }
    const column = branch === 'frontend' ? 'frontend_repo' : 'backend_repo'
    this.db.prepare(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`).run(stringifyRepoField(normalizedRepo), nowIso(), taskId)
    this.addTimeline(
      taskId,
      'repo',
      `绑定${branch === 'frontend' ? '前端' : '后端'}仓库`,
      normalizedRepo.branch ? `${normalizedRepo.path} @ ${normalizedRepo.branch}` : normalizedRepo.path,
      actor.id,
      'development',
      branch,
    )
    return this.getTaskView(taskId, actor)
  }

  // Execute a stage, using real background execution for requirement/design and
  // the existing mock path for the remaining agent-driven stages.
  executeStage(taskId: string, key: StageKey, branch: Branch, actor: User, options?: StageExecutionOptions): TaskView {
    const task = this.getTaskRow(taskId)
    const stage = this.getStageRow(taskId, key, branch)
    const def = getStageDefinition(key)
    if (!def.agentExecuted) {
      throw new Error('该阶段无 agent 执行')
    }
    if (key === 'projectContext') {
      if (stage.status !== 'pending' && stage.status !== 'review') {
        throw new Error('当前阶段不可执行')
      }
    } else if (stage.status !== 'pending') {
      throw new Error('当前阶段不可执行')
    }
    if (key === 'projectContext') {
      return this.executeProjectContextStage(task, stage, actor, options)
    }
    if (key === 'requirement') {
      this.assertRequirementExecutor(task, actor)
    }
    if (key === 'development') {
      const repo = branch === 'frontend' ? parseRepoField(task.frontend_repo) : parseRepoField(task.backend_repo)
      if (!repo) {
        throw new Error(`请先绑定${branch === 'frontend' ? '前端' : '后端'}仓库`)
      }
    }

    if (key === 'requirement' || key === 'design') {
      return this.startRealStageExecution(task, stage, actor, options)
    }

    const effectivePrompt = options?.prompt === undefined ? stage.extra_prompt : options.prompt.trim()
    const result = generateExecution(key, branch, task.title, effectivePrompt, stage.pending_note)
    const artifactWithSummary = { ...result.artifact, summary: result.summary }
    const now = nowIso()
    const runId = crypto.randomUUID()
    const runIndex = stage.run_count + 1
    this.runProcesses.set(runId, result.process)

    withTransaction(this.db, () => {
      if (task.state === 'pending') {
        this.db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('in_progress', taskId)
      }
      this.db
        .prepare(
          `INSERT INTO stage_runs (
            id, task_id, stage_key, branch, run_index, status, executor_id, extra_prompt, process_json, artifact_json, reveal_interval_ms, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, 700, ?, NULL)`,
        )
        .run(
          runId,
          taskId,
          key,
          branch,
          runIndex,
          actor.id,
          effectivePrompt,
          '[]',
          JSON.stringify(artifactWithSummary),
          now,
        )

      this.db
        .prepare(
          'UPDATE task_stages SET status = ?, run_count = ?, active_run_id = ?, extra_prompt = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?',
        )
        .run('running', runIndex, runId, effectivePrompt, '', now, taskId, key, branch)

      this.touchTask(taskId)
      this.addTimeline(taskId, 'executing', `${stageDisplayName(key, branch)} 开始执行`, '', actor.id, key, branch)
    })

    return this.getTaskView(taskId, actor)
  }

  // Reveal count for a running run based on elapsed time.
  private revealInfo(startedAt: string, intervalMs: number, total: number) {
    const elapsed = Date.now() - new Date(startedAt).getTime()
    const revealed = Math.max(0, Math.min(total, Math.floor(elapsed / intervalMs) + 1))
    return { revealed, done: revealed >= total }
  }

  // Finalize any running stage whose reveal window has elapsed.
  private tickRunningStages(taskId: string) {
    const running = this.db
      .prepare("SELECT * FROM task_stages WHERE task_id = ? AND status = 'running'")
      .all(taskId) as unknown as StageRow[]
    for (const stage of running) {
      if (!stage.active_run_id) continue
      const run = this.db.prepare('SELECT * FROM stage_runs WHERE id = ?').get(stage.active_run_id) as
        | { id: string; artifact_json: string; reveal_interval_ms: number; started_at: string; executor_id: string }
        | undefined
      if (!run) continue
      const process = this.runProcesses.get(run.id)
      if (!process) continue
      const info = this.revealInfo(run.started_at, run.reveal_interval_ms, process.length)
      if (info.done) {
        this.finalizeStageRun(taskId, stage, run)
      }
    }
  }

  private finalizeStageRun(
    taskId: string,
    stage: StageRow,
    run: { id: string; artifact_json: string },
  ) {
    const key = stage.stage_key as StageKey
    const branch = stage.branch as Branch
    const artifact = run.artifact_json ? JSON.parse(run.artifact_json) : {}
    const summary = typeof artifact.summary === 'string' ? artifact.summary : `${stageDisplayName(key, branch)} 产物已生成`
    const now = nowIso()

    // Development auto-enters verification (PRD 5.3). Other agent stages await human action.
    const postStatus = key === 'development' ? 'passed' : 'review'
    this.db
      .prepare('UPDATE stage_runs SET status = ?, finished_at = ? WHERE id = ?')
      .run('complete', now, run.id)
    this.runProcesses.delete(run.id)
    const pendingNote = key === 'design' ? this.designConfirmationNote(this.readDesignConfirmations(artifact)) : ''
    this.db
      .prepare(
        'UPDATE task_stages SET status = ?, summary = ?, artifact_json = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?',
      )
      .run(postStatus, summary, run.artifact_json, pendingNote, now, taskId, key, branch)

    if (key === 'development') {
      this.setStageStatus(taskId, 'verification', branch, 'pending')
      this.refreshVerificationStageArtifact(taskId, branch)
      this.addTimeline(taskId, 'stage', `${stageDisplayName('verification', branch)} 可开始`, '自动进入功能验证', '', 'verification', branch)
    }
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
  }

  private seedClarifications(taskId: string, seeds: { question: string; options: string[] }[]) {
    const existing = this.db.prepare('SELECT COUNT(*) as count FROM clarifications WHERE task_id = ?').get(taskId) as {
      count: number
    }
    if (existing.count > 0) {
      return
    }
    seeds.forEach((seed, index) => {
      this.db
        .prepare(
          "INSERT INTO clarifications (id, task_id, seq, question, options_json, answer, status) VALUES (?, ?, ?, ?, ?, '', 'open')",
        )
        .run(crypto.randomUUID(), taskId, index, seed.question, JSON.stringify(seed.options))
    })
  }

  private replaceClarifications(taskId: string, seeds: { question: string; options: string[] }[]) {
    this.db.prepare('DELETE FROM clarifications WHERE task_id = ?').run(taskId)
    seeds.forEach((seed, index) => {
      this.db
        .prepare(
          "INSERT INTO clarifications (id, task_id, seq, question, options_json, answer, status) VALUES (?, ?, ?, ?, ?, '', 'open')",
        )
        .run(crypto.randomUUID(), taskId, index, seed.question, JSON.stringify(seed.options))
    })
  }

  private confirmedClarifications(taskId: string) {
    return this.db
      .prepare("SELECT question, answer FROM clarifications WHERE task_id = ? AND status = 'confirmed' ORDER BY seq ASC")
      .all(taskId) as unknown as { question: string; answer: string }[]
  }

  private buildRequirementReunderstandPrompt(extraPrompt: string, confirmed: { question: string; answer: string }[]) {
    const sections: string[] = []
    if (extraPrompt.trim()) {
      sections.push(extraPrompt.trim())
    }
    if (confirmed.length) {
      sections.push(
        ['以下为已确认的问题澄清，请在重新理解时作为已知输入一并纳入：', ...confirmed.map((item) => `- ${item.question}：${item.answer}`)].join(
          '\n',
        ),
      )
    }
    return sections.join('\n\n')
  }

  private assertRequirementPm(task: TaskRow, actor: User) {
    if (actor.id !== task.pm_id) {
      throw new Error('仅对应产品经理可执行该操作')
    }
  }

  private assertRequirementExecutor(task: TaskRow, actor: User) {
    if (actor.id !== task.pm_id && actor.id !== task.req_owner_id) {
      throw new Error('仅对应产品经理或需求负责人可执行该操作')
    }
  }

  private assertDesignConfirmer(task: TaskRow, actor: User) {
    if (actor.id !== task.frontend_dev_id && actor.id !== task.backend_dev_id) {
      throw new Error('仅前后端开发可确认详细设计')
    }
  }

  private assertProjectContextExecutor(task: TaskRow, actor: User) {
    if (actor.id !== task.frontend_dev_id && actor.id !== task.backend_dev_id) {
      throw new Error('仅前后端负责人可执行项目上下文刷新')
    }
  }

  private projectContextPendingNote(state: { frontend: boolean; backend: boolean }) {
    if (!state.frontend && !state.backend) return '待前后端刷新'
    if (!state.frontend) return '待前端刷新'
    if (!state.backend) return '待后端刷新'
    return ''
  }

  private designConfirmationNote(confirmations: { frontend: boolean; backend: boolean }) {
    if (!confirmations.frontend && !confirmations.backend) {
      return '待前后端确认'
    }
    if (!confirmations.frontend) {
      return '待前端确认'
    }
    if (!confirmations.backend) {
      return '待后端确认'
    }
    return ''
  }

  private readDesignConfirmations(artifact: Record<string, unknown> | null) {
    const raw = artifact?.confirmations
    if (!raw || typeof raw !== 'object') {
      return { frontend: false, backend: false }
    }
    return {
      frontend: Boolean((raw as Record<string, unknown>).frontend),
      backend: Boolean((raw as Record<string, unknown>).backend),
    }
  }

  private clearDesignConfirmationState(taskId: string) {
    const stage = this.getStageRow(taskId, 'design', 'shared')
    const artifact = parseArtifact(stage.artifact_json)
    if (!artifact) {
      this.db
        .prepare("UPDATE task_stages SET pending_note = '', updated_at = ? WHERE task_id = ? AND stage_key = 'design' AND branch = 'shared'")
        .run(nowIso(), taskId)
      return
    }
    artifact.confirmations = { frontend: false, backend: false }
    this.db
      .prepare("UPDATE task_stages SET artifact_json = ?, pending_note = '', updated_at = ? WHERE task_id = ? AND stage_key = 'design' AND branch = 'shared'")
      .run(JSON.stringify(artifact), nowIso(), taskId)
  }

  getActiveRunProcess(taskId: string, key: StageKey, branch: Branch, viewer: User) {
    this.tickRunningStages(taskId)
    const stage = this.getStageRow(taskId, key, branch)
    if (!stage.active_run_id || stage.status !== 'running') {
      return { events: [], executorId: null, running: false }
    }
    const run = this.db.prepare('SELECT * FROM stage_runs WHERE id = ?').get(stage.active_run_id) as StageRunRow | undefined
    if (!run) {
      return { events: [], executorId: null, running: false }
    }
    // Only the current executor sees process content, and only while the stage is running.
    const visible = run.executor_id === viewer.id && stage.status === 'running'
    if (!visible) {
      return { events: [], executorId: run.executor_id, running: false }
    }
    const all = this.runProcesses.get(run.id)
    if (!all) {
      return { events: this.parseProcessJson(run.process_json), executorId: run.executor_id, running: run.status === 'running' }
    }
    const info = this.revealInfo(run.started_at, run.reveal_interval_ms, all.length)
    return { events: all.slice(0, info.revealed), executorId: run.executor_id, running: true }
  }

  answerClarification(taskId: string, clarificationId: string, answer: string, actor: User): TaskView {
    const task = this.getTaskRow(taskId)
    this.assertRequirementPm(task, actor)
    const row = this.db.prepare('SELECT * FROM clarifications WHERE id = ? AND task_id = ?').get(clarificationId, taskId) as
      | { status: string }
      | undefined
    if (!row) {
      throw new Error('问题澄清不存在')
    }
    if (row.status === 'confirmed') {
      throw new Error('该问题已确认，不可修改')
    }
    this.db
      .prepare("UPDATE clarifications SET answer = ?, status = 'confirmed', answered_by = ?, answered_at = ? WHERE id = ?")
      .run(answer, actor.id, nowIso(), clarificationId)
    this.addTimeline(taskId, 'clarified', '问题澄清确认', answer, actor.id, 'requirement', 'shared')
    this.regenerateRequirementDoc(taskId)
    return this.getTaskView(taskId, actor)
  }

  reunderstandRequirement(taskId: string, actor: User, prompt?: string): TaskView {
    const task = this.getTaskRow(taskId)
    this.assertRequirementExecutor(task, actor)
    const stage = this.getStageRow(taskId, 'requirement', 'shared')
    if (stage.status !== 'review') {
      throw new Error('当前需求理解不可重新执行')
    }

    const confirmed = this.confirmedClarifications(taskId)
    const basePrompt = prompt === undefined ? stage.extra_prompt : prompt.trim()
    const effectivePrompt = this.buildRequirementReunderstandPrompt(basePrompt, confirmed)
    const result = generateExecution('requirement', 'shared', task.title, effectivePrompt, '')
    const artifactWithSummary = { ...result.artifact, summary: result.summary } as Record<string, unknown>
    if (confirmed.length) {
      const baseFullDoc = typeof artifactWithSummary.fullDoc === 'string' ? artifactWithSummary.fullDoc : ''
      artifactWithSummary.fullDoc = `${baseFullDoc}\n\n## 已纳入上轮确认信息\n${confirmed
        .map((item) => `- ${item.question} → ${item.answer}`)
        .join('\n')}`
    }
    const now = nowIso()
    const runId = crypto.randomUUID()
    const runIndex = stage.run_count + 1
    this.runProcesses.set(runId, result.process)

    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO stage_runs (
            id, task_id, stage_key, branch, run_index, status, executor_id, extra_prompt, process_json, artifact_json, reveal_interval_ms, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, 700, ?, NULL)`,
        )
        .run(
          runId,
          taskId,
          'requirement',
          'shared',
          runIndex,
          actor.id,
          effectivePrompt,
          '[]',
          JSON.stringify(artifactWithSummary),
          now,
        )

      this.db
        .prepare(
          'UPDATE task_stages SET status = ?, run_count = ?, active_run_id = ?, extra_prompt = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?',
        )
        .run('running', runIndex, runId, basePrompt, '', now, taskId, 'requirement', 'shared')

      this.replaceClarifications(taskId, result.clarifications ?? [])
      this.touchTask(taskId)
      this.addTimeline(
        taskId,
        'executing',
        '需求理解重新执行',
        confirmed.length ? `已附带 ${confirmed.length} 条已确认问题澄清作为输入` : '',
        actor.id,
        'requirement',
        'shared',
      )
    })

    return this.getTaskView(taskId, actor)
  }

  private regenerateRequirementDoc(taskId: string) {
    const stage = this.getStageRow(taskId, 'requirement', 'shared')
    if (!stage.artifact_json) return
    const artifact = JSON.parse(stage.artifact_json) as Record<string, unknown> & { fullDoc?: string }
    const clars = this.db
      .prepare("SELECT question, answer FROM clarifications WHERE task_id = ? AND status = 'confirmed' ORDER BY seq ASC")
      .all(taskId) as unknown as { question: string; answer: string }[]
    const answersBlock = clars.map((c) => `- ${c.question} → ${c.answer}`).join('\n')
    const fullDoc = String(artifact.fullDoc ?? '')
    const base = fullDoc.split('\n\n## 已确认问题澄清')[0].split('\n\n## 已确认澄清')[0]
    artifact.fullDoc = answersBlock ? `${base}\n\n## 已确认问题澄清\n${answersBlock}` : base
    this.db
      .prepare('UPDATE task_stages SET artifact_json = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run(JSON.stringify(artifact), nowIso(), taskId, 'requirement', 'shared')
  }

  // ---- Flow transitions ----

  // Advance a shared upstream stage to the next stage. reqOwner/creator drives.
  advanceStage(taskId: string, key: StageKey, actor: User): TaskView {
    const stage = this.getStageRow(taskId, key, 'shared')
    if (stage.status !== 'review') {
      throw new Error('当前阶段尚未完成执行，无法推进')
    }
    if (key === 'requirement') {
      this.assertRequirementPm(this.getTaskRow(taskId), actor)
      const open = this.db
        .prepare("SELECT COUNT(*) as count FROM clarifications WHERE task_id = ? AND status != 'confirmed'")
        .get(taskId) as { count: number }
      if (open.count > 0) {
        throw new Error('仍有问题澄清未确认')
      }
      withTransaction(this.db, () => {
        this.setStageStatus(taskId, 'requirement', 'shared', 'passed')
        this.setStageStatus(taskId, 'design', 'shared', 'pending')
        this.clearDesignConfirmationState(taskId)
        this.addTimeline(taskId, 'advanced', '进入详细设计', '', actor.id, 'design', 'shared')
        this.touchTask(taskId)
      })
    } else if (key === 'design') {
      const task = this.getTaskRow(taskId)
      this.assertDesignConfirmer(task, actor)
      const artifact = parseArtifact(stage.artifact_json) ?? {}
      const confirmations = this.readDesignConfirmations(artifact)
      const isFrontend = actor.id === task.frontend_dev_id
      if ((isFrontend && confirmations.frontend) || (!isFrontend && confirmations.backend)) {
        throw new Error('你已确认过详细设计')
      }
      const nextConfirmations = {
        frontend: isFrontend ? true : confirmations.frontend,
        backend: isFrontend ? confirmations.backend : true,
      }
      const nextArtifact = { ...artifact, confirmations: nextConfirmations }
      withTransaction(this.db, () => {
        if (nextConfirmations.frontend && nextConfirmations.backend) {
          this.db
            .prepare('UPDATE task_stages SET status = ?, artifact_json = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
            .run('passed', JSON.stringify(nextArtifact), '', nowIso(), taskId, 'design', 'shared')
          this.setStageStatus(taskId, 'development', 'frontend', 'pending')
          this.setStageStatus(taskId, 'development', 'backend', 'pending')
          this.addTimeline(taskId, 'advanced', '进入前后端并行开发', '', actor.id, 'development', null)
        } else {
          const pendingNote = this.designConfirmationNote(nextConfirmations)
          this.db
            .prepare('UPDATE task_stages SET artifact_json = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
            .run(JSON.stringify(nextArtifact), pendingNote, nowIso(), taskId, 'design', 'shared')
          this.addTimeline(taskId, 'stage', '详细设计待另一侧确认', pendingNote, actor.id, 'design', 'shared')
        }
        this.touchTask(taskId)
      })
    } else {
      throw new Error('该阶段不支持此推进操作')
    }
    return this.getTaskView(taskId, actor)
  }

  // Functional verification: pass moves to review; reject returns to development with a reason.
  verify(taskId: string, branch: Branch, pass: boolean, reason: string, actor: User): TaskView {
    const stage = this.getStageRow(taskId, 'verification', branch)
    if (stage.status !== 'pending') {
      throw new Error('功能验证当前不可操作')
    }
    withTransaction(this.db, () => {
      if (pass) {
        this.db
          .prepare('INSERT INTO verifications (id, task_id, branch, result, reason, operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), taskId, branch, 'pass', '', actor.id, nowIso())
        this.setStageStatus(taskId, 'verification', branch, 'passed')
        this.setStageStatus(taskId, 'review', branch, 'pending')
        this.addTimeline(taskId, 'verified', `${stageDisplayName('verification', branch)} 通过`, '', actor.id, 'verification', branch)
      } else {
        if (!reason.trim()) {
          throw new Error('驳回必须填写理由')
        }
        this.db
          .prepare('INSERT INTO verifications (id, task_id, branch, result, reason, operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), taskId, branch, 'reject', reason, actor.id, nowIso())
        this.setStageStatus(taskId, 'verification', branch, 'blocked')
        this.setDevelopmentPending(taskId, branch, `功能验证驳回：${reason}`)
        this.addTimeline(taskId, 'rejected', `${stageDisplayName('verification', branch)} 驳回`, reason, actor.id, 'development', branch)
      }
      this.refreshVerificationStageArtifact(taskId, branch)
      this.touchTask(taskId)
    })
    return this.getTaskView(taskId, actor)
  }

  private setDevelopmentPending(taskId: string, branch: Branch, note: string) {
    this.db
      .prepare('UPDATE task_stages SET status = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run('pending', note, nowIso(), taskId, 'development', branch)
  }

  private listTestingBugRows(taskId: string) {
    return this.db
      .prepare('SELECT * FROM testing_bugs WHERE task_id = ? ORDER BY seq ASC')
      .all(taskId) as unknown as Array<{
      id: string
      task_id: string
      seq: number
      target: 'frontend' | 'backend' | 'both'
      detail: string
      status: 'open' | 'fixed' | 'closed'
      reporter_id: string
      frontend_fixed_by: string
      frontend_fixed_at: string | null
      backend_fixed_by: string
      backend_fixed_at: string | null
      closed_by: string | null
      closed_at: string | null
      created_at: string
      updated_at: string
    }>
  }

  private unresolvedTestingBugs(taskId: string) {
    return this.listTestingBugRows(taskId).filter((bug) => bug.status !== 'closed')
  }

  private branchBugs(taskId: string, branch: Extract<Branch, 'frontend' | 'backend'>) {
    return this.unresolvedTestingBugs(taskId).filter((bug) => bug.target === branch || bug.target === 'both')
  }

  private composeTestingBugNote(taskId: string, branch: Extract<Branch, 'frontend' | 'backend'>) {
    const bugs = this.branchBugs(taskId, branch)
    if (!bugs.length) {
      return ''
    }
    return `测试阶段待修复问题：\n${bugs.map((bug) => `${bug.seq}. [${testingBugTargetLabel(bug.target)} · ${testingBugStatusLabel(bug.status)}] ${bug.detail}`).join('\n')}`
  }

  private refreshDevelopmentBugNotes(taskId: string) {
    for (const branch of ['frontend', 'backend'] as const) {
      const note = this.composeTestingBugNote(taskId, branch)
      this.db
        .prepare('UPDATE task_stages SET pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
        .run(note, nowIso(), taskId, 'development', branch)
    }
  }

  private refreshTestingStageArtifact(taskId: string) {
    const normalized = buildTestingArtifact(this.getStageRow(taskId, 'testing', 'shared'), this.listTestingBugRows(taskId))
    const bugCount = this.listTestingBugRows(taskId).length
    const unresolved = this.unresolvedTestingBugs(taskId).length
    const pendingNote =
      unresolved > 0 ? `当前有 ${unresolved} 条未关闭 Bug，修复后需重新走对应分支自测与审查。` : bugCount ? '全部 Bug 已关闭，可执行测试通过。' : ''
    this.db
      .prepare('UPDATE task_stages SET summary = ?, artifact_json = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run(normalized.summary, JSON.stringify(normalized.artifact), pendingNote, nowIso(), taskId, 'testing', 'shared')
  }

  private refreshVerificationStageArtifact(taskId: string, branch: Branch) {
    const stage = this.getStageRow(taskId, 'verification', branch)
    const normalized = buildVerificationArtifact(branch, stage, this.listVerificationRows(taskId, branch))
    this.db
      .prepare('UPDATE task_stages SET summary = ?, artifact_json = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run(normalized.summary, JSON.stringify(normalized.artifact), nowIso(), taskId, 'verification', branch)
  }

  private refreshDeliveryStageArtifact(taskId: string) {
    const task = this.getTaskRow(taskId)
    const stage = this.getStageRow(taskId, 'delivery', 'shared')
    const normalized = buildDeliveryArtifact(task, stage)
    this.db
      .prepare('UPDATE task_stages SET summary = ?, artifact_json = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run(normalized.summary, JSON.stringify(normalized.artifact), nowIso(), taskId, 'delivery', 'shared')
  }

  private maybeOpenTesting(taskId: string) {
    const fe = this.getStageRow(taskId, 'review', 'frontend')
    const be = this.getStageRow(taskId, 'review', 'backend')
    if (fe.status !== 'passed' || be.status !== 'passed') {
      return
    }
    const testing = this.getStageRow(taskId, 'testing', 'shared')
    if (testing.status !== 'blocked') {
      return
    }
    if (this.listTestingBugRows(taskId).some((bug) => bug.status === 'open')) {
      return
    }
    this.setStageStatus(taskId, 'testing', 'shared', 'pending')
    this.refreshTestingStageArtifact(taskId)
    this.addTimeline(taskId, 'stage', '可进入测试', '前后端审查均已通过', '', 'testing', 'shared')
  }

  passTesting(taskId: string, actor: User): TaskView {
    const task = this.getTaskRow(taskId)
    const stage = this.getStageRow(taskId, 'testing', 'shared')
    if (actor.id !== task.tester_id) {
      throw new Error('仅任务测试负责人可判定测试通过')
    }
    if (stage.status !== 'pending') {
      throw new Error('测试阶段当前不可操作')
    }
    if (this.unresolvedTestingBugs(taskId).length > 0) {
      throw new Error('仍有未关闭 Bug，不可测试通过')
    }
    withTransaction(this.db, () => {
      this.setStageStatus(taskId, 'testing', 'shared', 'passed')
      this.setStageStatus(taskId, 'delivery', 'shared', 'pending')
      this.refreshTestingStageArtifact(taskId)
      this.refreshDeliveryStageArtifact(taskId)
      this.addTimeline(taskId, 'tested', '测试通过', '所有 Bug 已关闭，进入交付沉淀', actor.id, 'testing', 'shared')
      this.addTimeline(taskId, 'stage', '可进入交付沉淀', '测试阶段已通过', '', 'delivery', 'shared')
      this.touchTask(taskId)
    })
    return this.getTaskView(taskId, actor)
  }

  reportTestingBug(
    taskId: string,
    target: 'frontend' | 'backend' | 'both',
    detail: string,
    actor: User,
  ): TaskView {
    if (target !== 'frontend' && target !== 'backend' && target !== 'both') {
      throw new Error('无效的 Bug 归属')
    }
    const task = this.getTaskRow(taskId)
    if (!isRelatedUser(actor, toOwners(task))) {
      throw new Error('仅任务相关用户可在测试阶段提交 Bug')
    }
    const testing = this.getStageRow(taskId, 'testing', 'shared')
    if (testing.status === 'passed') {
      throw new Error('测试已通过，不可继续提交 Bug')
    }
    const bugCount = this.listTestingBugRows(taskId).length
    if (testing.status !== 'pending' && !(testing.status === 'blocked' && bugCount > 0)) {
      throw new Error('当前不在测试阶段，不可提交 Bug')
    }
    if (!detail.trim()) {
      throw new Error('Bug 描述不能为空')
    }
    withTransaction(this.db, () => {
      const current = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) as maxSeq FROM testing_bugs WHERE task_id = ?')
        .get(taskId) as { maxSeq: number }
      const now = nowIso()
      this.db
        .prepare(
          `INSERT INTO testing_bugs (
            id, task_id, seq, target, detail, status, reporter_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), taskId, current.maxSeq + 1, target, detail.trim(), actor.id, now, now)

      this.setStageStatus(taskId, 'testing', 'shared', 'blocked')
      for (const branch of bugTargetBranches(target)) {
        this.setDevelopmentPending(taskId, branch, this.composeTestingBugNote(taskId, branch))
        this.setStageStatus(taskId, 'verification', branch, 'blocked')
        this.setStageStatus(taskId, 'review', branch, 'blocked')
        this.refreshVerificationStageArtifact(taskId, branch)
      }
      this.refreshDevelopmentBugNotes(taskId)
      this.refreshTestingStageArtifact(taskId)
      this.addTimeline(taskId, 'bug', `提交${testingBugTargetLabel(target)} Bug`, detail.trim(), actor.id, 'testing', 'shared')
      this.touchTask(taskId)
    })
    return this.getTaskView(taskId, actor)
  }

  markTestingBugFixed(taskId: string, bugId: string, actor: User): TaskView {
    const task = this.getTaskRow(taskId)
    const bug = this.listTestingBugRows(taskId).find((item) => item.id === bugId)
    if (!bug) {
      throw new Error('Bug 不存在')
    }
    if (bug.status === 'closed') {
      throw new Error('已关闭 Bug 不可再次标记修复')
    }

    const isFrontendDev = actor.id === task.frontend_dev_id
    const isBackendDev = actor.id === task.backend_dev_id
    const now = nowIso()

    withTransaction(this.db, () => {
      if (bug.target === 'frontend') {
        if (!isFrontendDev) {
          throw new Error('仅前端开发可标记该 Bug 已修复')
        }
        this.db
          .prepare('UPDATE testing_bugs SET status = ?, frontend_fixed_by = ?, frontend_fixed_at = ?, updated_at = ? WHERE id = ?')
          .run('fixed', actor.id, now, now, bugId)
      } else if (bug.target === 'backend') {
        if (!isBackendDev) {
          throw new Error('仅后端开发可标记该 Bug 已修复')
        }
        this.db
          .prepare('UPDATE testing_bugs SET status = ?, backend_fixed_by = ?, backend_fixed_at = ?, updated_at = ? WHERE id = ?')
          .run('fixed', actor.id, now, now, bugId)
      } else {
        if (isFrontendDev && !bug.frontend_fixed_at) {
          this.db
            .prepare('UPDATE testing_bugs SET frontend_fixed_by = ?, frontend_fixed_at = ?, updated_at = ? WHERE id = ?')
            .run(actor.id, now, now, bugId)
        } else if (isBackendDev && !bug.backend_fixed_at) {
          this.db
            .prepare('UPDATE testing_bugs SET backend_fixed_by = ?, backend_fixed_at = ?, updated_at = ? WHERE id = ?')
            .run(actor.id, now, now, bugId)
        } else {
          throw new Error('仅相关开发可标记该 Bug 已修复')
        }
        const next = this.listTestingBugRows(taskId).find((item) => item.id === bugId)
        if (next?.frontend_fixed_at && next.backend_fixed_at) {
          this.db.prepare('UPDATE testing_bugs SET status = ?, updated_at = ? WHERE id = ?').run('fixed', nowIso(), bugId)
        }
      }
      this.refreshDevelopmentBugNotes(taskId)
      this.refreshTestingStageArtifact(taskId)
      this.addTimeline(taskId, 'bug-fixed', `Bug #${bug.seq} 已修复`, bug.detail, actor.id, 'testing', 'shared')
      this.touchTask(taskId)
    })
    return this.getTaskView(taskId, actor)
  }

  closeTestingBug(taskId: string, bugId: string, actor: User): TaskView {
    const task = this.getTaskRow(taskId)
    const stage = this.getStageRow(taskId, 'testing', 'shared')
    const bug = this.listTestingBugRows(taskId).find((item) => item.id === bugId)
    if (actor.id !== task.tester_id) {
      throw new Error('仅任务测试负责人可关闭 Bug')
    }
    if (!bug) {
      throw new Error('Bug 不存在')
    }
    if (stage.status !== 'pending') {
      throw new Error('测试阶段未重新打开，不可关闭 Bug')
    }
    if (bug.status !== 'fixed') {
      throw new Error('仅已修复 Bug 可关闭')
    }
    withTransaction(this.db, () => {
      const now = nowIso()
      this.db
        .prepare('UPDATE testing_bugs SET status = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?')
        .run('closed', actor.id, now, now, bugId)
      this.refreshDevelopmentBugNotes(taskId)
      this.refreshTestingStageArtifact(taskId)
      this.addTimeline(taskId, 'bug-closed', `Bug #${bug.seq} 回归通过`, bug.detail, actor.id, 'testing', 'shared')
      this.touchTask(taskId)
    })
    return this.getTaskView(taskId, actor)
  }

  // Code review: pass; or reflow selected risk levels back to development.
  review(
    taskId: string,
    branch: Branch,
    action: 'pass' | 'reflow',
    levels: string[],
    actor: User,
  ): TaskView {
    const stage = this.getStageRow(taskId, 'review', branch)
    if (stage.status !== 'review') {
      throw new Error('代码审查当前不可操作')
    }
    withTransaction(this.db, () => {
      if (action === 'pass') {
        this.setStageStatus(taskId, 'review', branch, 'passed')
        this.addTimeline(taskId, 'reviewed', `${stageDisplayName('review', branch)} 通过`, '', actor.id, 'review', branch)
        this.maybeOpenTesting(taskId)
      } else {
        if (!levels.length) {
          throw new Error('回流需选择至少一个风险分级')
        }
        const note = `代码审查回流（${levels.map(levelLabel).join('、')}）`
        this.setStageStatus(taskId, 'review', branch, 'blocked')
        this.setDevelopmentPending(taskId, branch, note)
        this.addTimeline(taskId, 'reflow', `${stageDisplayName('review', branch)} 回流`, note, actor.id, 'development', branch)
      }
      this.touchTask(taskId)
    })
    return this.getTaskView(taskId, actor)
  }

  // Delivery: pass completes the task; reject rolls back to a target stage.
  deliver(taskId: string, actor: User): TaskView {
    const stage = this.getStageRow(taskId, 'delivery', 'shared')
    if (stage.status !== 'pending') {
      throw new Error('交付沉淀当前不可操作')
    }
    withTransaction(this.db, () => {
      this.setStageStatus(taskId, 'delivery', 'shared', 'passed')
      this.refreshDeliveryStageArtifact(taskId)
      this.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run('completed', nowIso(), taskId)
      this.addTimeline(taskId, 'delivered', '交付沉淀通过', '任务已完成', actor.id, 'delivery', 'shared')
    })
    return this.getTaskView(taskId, actor)
  }

  // Delivery reject → rollback. target: 'requirement' | 'design' | 'frontend' | 'backend'.
  rollbackFromDelivery(taskId: string, target: string, reason: string, actor: User): TaskView {
    const stage = this.getStageRow(taskId, 'delivery', 'shared')
    if (stage.status !== 'pending') {
      throw new Error('交付沉淀当前不可操作')
    }
    withTransaction(this.db, () => {
      this.setStageStatus(taskId, 'delivery', 'shared', 'blocked')
      if (target === 'requirement' || target === 'design') {
        // Both branches invalidated; task returns to pending upstream (PRD 5.6).
        this.invalidateBranches(taskId)
        if (target === 'requirement') {
          this.setStageStatus(taskId, 'requirement', 'shared', 'pending')
          this.setStageStatus(taskId, 'design', 'shared', 'blocked')
          this.clearDesignConfirmationState(taskId)
        } else {
          this.setStageStatus(taskId, 'design', 'shared', 'pending')
          this.clearDesignConfirmationState(taskId)
        }
        this.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run('pending', nowIso(), taskId)
      } else if (target === 'frontend' || target === 'backend') {
        this.setDevelopmentPending(taskId, target, `交付驳回：${reason}`)
        this.setStageStatus(taskId, 'verification', target, 'blocked')
        this.setStageStatus(taskId, 'review', target, 'blocked')
        this.setStageStatus(taskId, 'testing', 'shared', 'blocked')
        this.refreshVerificationStageArtifact(taskId, target)
        this.refreshTestingStageArtifact(taskId)
      } else {
        throw new Error('无效的回退目标')
      }
      this.refreshDeliveryStageArtifact(taskId)
      this.addTimeline(taskId, 'rollback', '交付驳回', `${target} · ${reason}`, actor.id, null, null)
      this.touchTask(taskId)
    })
    return this.getTaskView(taskId, actor)
  }

  private invalidateBranches(taskId: string) {
    for (const branch of ['frontend', 'backend'] as Branch[]) {
      for (const key of ['development', 'verification', 'review'] as StageKey[]) {
        this.setStageStatus(taskId, key, branch, 'blocked')
      }
      this.refreshVerificationStageArtifact(taskId, branch)
    }
    this.setStageStatus(taskId, 'testing', 'shared', 'blocked')
    this.refreshTestingStageArtifact(taskId)
    this.refreshDeliveryStageArtifact(taskId)
  }

  // Supplement requirement after it has passed: append note, choose impact, optionally re-enter design.
  supplementRequirement(
    taskId: string,
    note: string,
    impact: 'frontend' | 'backend' | 'both',
    reenterDesign: boolean,
    actor: User,
  ): TaskView {
    if (!note.trim()) {
      throw new Error('补充内容不能为空')
    }
    this.assertRequirementPm(this.getTaskRow(taskId), actor)
    const stage = this.getStageRow(taskId, 'requirement', 'shared')
    const artifact = stage.artifact_json ? JSON.parse(stage.artifact_json) : {}
    artifact.fullDoc = `${String(artifact.fullDoc ?? '')}\n\n## 补充需求\n- ${note}（影响：${impact}）`
    withTransaction(this.db, () => {
      this.db
        .prepare('UPDATE task_stages SET artifact_json = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
        .run(JSON.stringify(artifact), nowIso(), taskId, 'requirement', 'shared')
      // Only reroute downstream stages that have already been reached; otherwise
      // this is a pre-completion enrichment of the requirement doc only.
      const design = this.getStageRow(taskId, 'design', 'shared')
      if (reenterDesign && design.status !== 'blocked') {
        this.setStageStatus(taskId, 'design', 'shared', 'pending')
        this.clearDesignConfirmationState(taskId)
      } else if (!reenterDesign) {
        const targets: Branch[] = impact === 'both' ? ['frontend', 'backend'] : [impact]
        for (const branch of targets) {
          const dev = this.getStageRow(taskId, 'development', branch)
          if (dev.status !== 'blocked') {
            this.setDevelopmentPending(taskId, branch, `补充需求：${note}`)
          }
        }
      }
      this.addTimeline(taskId, 'supplement', '补充需求', `${note}（影响：${impact}）`, actor.id, 'requirement', 'shared')
      this.touchTask(taskId)
    })
    return this.getTaskView(taskId, actor)
  }

  // Supplement design content while design is in review, producing a new artifact version.
  supplementDesign(taskId: string, note: string, actor: User): TaskView {
    if (!note.trim()) {
      throw new Error('补充内容不能为空')
    }
    const task = this.getTaskRow(taskId)
    const stage = this.getStageRow(taskId, 'design', 'shared')
    const artifact = stage.artifact_json ? JSON.parse(stage.artifact_json) : {}
    const supplements = [
      ...(Array.isArray(artifact.supplements)
        ? artifact.supplements.filter((item: unknown): item is string => typeof item === 'string')
        : []),
      note,
    ]
    artifact.supplements = supplements
    artifact.testCases = buildDesignArtifact(task.title, supplements).testCases
    artifact.confirmations = { frontend: false, backend: false }
    this.db
      .prepare('UPDATE task_stages SET summary = ?, artifact_json = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run(DESIGN_STAGE_SUMMARY, JSON.stringify(artifact), this.designConfirmationNote({ frontend: false, backend: false }), nowIso(), taskId, 'design', 'shared')
    this.addTimeline(taskId, 'supplement', '补充设计', note, actor.id, 'design', 'shared')
    return this.getTaskView(taskId, actor)
  }
}

function normalizeRequirementArtifact(artifact: Record<string, unknown> | null, stageSummary: string) {
  if (!artifact) {
    return { summary: stageSummary, artifact: {} as Record<string, unknown> }
  }
  const summary = pickSummary(artifact, stageSummary, '需求理解产物已生成。')
  const acceptance = asStringArrayValue(artifact.acceptance)
  const risks = asStringArrayValue(artifact.risks)
  const impactScope = asStringValue(artifact.impactScope)
  return {
    summary,
    artifact: withCommonArtifactFields(artifact, summary, compactStrings([
      acceptance.length ? `验收标准 ${acceptance.length} 条` : '',
      risks.length ? `关键风险 ${risks.length} 条` : '',
      impactScope ? `影响范围：${impactScope}` : '',
    ]), ['供详细设计阶段拆分前后端方案', '供开发阶段理解业务目标与约束']),
  }
}

function normalizeDesignArtifact(taskTitle: string, artifact: Record<string, unknown> | null, stageSummary: string) {
  if (!artifact) {
    return { summary: stageSummary, artifact: {} as Record<string, unknown> }
  }
  const supplements = asStringArrayValue(artifact.supplements)
  const base = buildDesignArtifact(taskTitle, supplements)
  const testCases = asStringValue(artifact.testCases) || asStringValue(base.testCases)
  const confirmations =
    artifact.confirmations && typeof artifact.confirmations === 'object'
      ? {
          frontend: Boolean((artifact.confirmations as Record<string, unknown>).frontend),
          backend: Boolean((artifact.confirmations as Record<string, unknown>).backend),
        }
      : { frontend: false, backend: false }
  const summary = stageSummary === '前后端设计与接口文档已生成，可进入并行开发。'
    ? DESIGN_STAGE_SUMMARY
    : pickSummary(artifact, stageSummary, DESIGN_STAGE_SUMMARY)
  return {
    summary,
    artifact: withCommonArtifactFields(
      { ...artifact, testCases, confirmations },
      summary,
      compactStrings(['前后端方案已统一', asStringValue(artifact.apiDoc) ? '接口契约已明确' : '', testCases ? '测试用例已准备' : '']),
      ['供前后端开发执行实现', '供验证、审查与测试阶段对照设计'],
    ),
  }
}

function normalizeDevelopmentArtifact(branch: Extract<Branch, 'frontend' | 'backend'>, artifact: Record<string, unknown> | null, stageSummary: string) {
  if (!artifact) {
    return { summary: stageSummary, artifact: {} as Record<string, unknown> }
  }
  const addedFiles = asStringArrayValue(artifact.addedFiles)
  const modifiedFiles = asStringArrayValue(artifact.modifiedFiles)
  const summary = pickSummary(artifact, stageSummary, `${branchLabel(branch)}分支实现已完成，可进入功能验证。`)
  return {
    summary,
    artifact: withCommonArtifactFields(
      artifact,
      summary,
      compactStrings([`${branchLabel(branch)}实现已完成`, `新增文件 ${addedFiles.length} 个`, `修改文件 ${modifiedFiles.length} 个`]),
      ['供功能验证阶段验证实现结果', '供代码审查阶段定位改动范围'],
    ),
  }
}

function normalizeReviewArtifact(artifact: Record<string, unknown> | null, stageSummary: string) {
  if (!artifact) {
    return { summary: stageSummary, artifact: {} as Record<string, unknown> }
  }
  const high = asNumberValue(artifact.high)
  const medium = asNumberValue(artifact.medium)
  const low = asNumberValue(artifact.low)
  const issues = asArrayValue(artifact.issues)
  const summary = pickSummary(artifact, stageSummary, `代码审查已形成问题清单。`)
  return {
    summary,
    artifact: withCommonArtifactFields(
      artifact,
      summary,
      compactStrings([`高危 ${high} 项`, `中危 ${medium} 项`, `低危 ${low} 项`]),
      issues.length > 0 ? ['供开发阶段按风险分级回流修复', '供测试阶段关注高风险点'] : ['供测试阶段继续联调与验证'],
    ),
  }
}

function buildVerificationArtifact(
  branch: Branch,
  stage: StageRow,
  history: Array<{ result: 'pass' | 'reject'; reason: string }>,
) {
  const latest = history.length ? history[history.length - 1] : null
  const verificationScope = [`${branchLabel(branch)}分支对应功能点验证`]
  const verificationResult = latest?.result === 'pass' ? '通过' : latest?.result === 'reject' ? '驳回' : stage.status === 'pending' ? '待验证' : '未开始'
  const passBasis = latest?.result === 'pass' ? '功能验证已通过，可进入代码审查。' : ''
  const rejectionReason = latest?.result === 'reject' ? latest.reason : ''
  const summary =
    latest?.result === 'pass'
      ? `${stageDisplayName('verification', branch)}已通过，进入代码审查。`
      : latest?.result === 'reject'
        ? `${stageDisplayName('verification', branch)}已驳回，等待开发修复。`
        : stage.status === 'pending'
          ? `${stageDisplayName('verification', branch)}待人工验证。`
          : `${stageDisplayName('verification', branch)}尚未开放。`
  return {
    summary,
    artifact: withCommonArtifactFields(
      {
        verificationScope,
        verificationResult,
        rejectionReason,
        passBasis,
      },
      summary,
      compactStrings([
        `验证结果：${verificationResult}`,
        rejectionReason ? `驳回原因：${rejectionReason}` : '',
        passBasis,
      ]),
      latest?.result === 'pass'
        ? ['供代码审查阶段继续处理']
        : latest?.result === 'reject'
          ? ['供开发阶段修复后重新验证']
          : stage.status === 'pending'
            ? ['等待验证执行人记录验证结果']
            : ['等待上游开发完成后进入功能验证'],
    ),
  }
}

function buildTestingArtifact(
  stage: StageRow,
  bugRows: Array<{
    id: string
    seq: number
    target: 'frontend' | 'backend' | 'both'
    detail: string
    status: 'open' | 'fixed' | 'closed'
    reporter_id: string
    frontend_fixed_at: string | null
    backend_fixed_at: string | null
    closed_by: string | null
    created_at: string
    updated_at: string
  }>,
) {
  const bugs = bugRows.map((bug) => ({
    id: bug.id,
    seq: bug.seq,
    target: bug.target,
    detail: bug.detail,
    status: bug.status,
    reporterId: bug.reporter_id,
    frontendFixed: Boolean(bug.frontend_fixed_at),
    backendFixed: Boolean(bug.backend_fixed_at),
    closedBy: bug.closed_by,
    createdAt: bug.created_at,
    updatedAt: bug.updated_at,
  }))
  const openCount = bugs.filter((bug) => bug.status === 'open').length
  const fixedCount = bugs.filter((bug) => bug.status === 'fixed').length
  const closedCount = bugs.filter((bug) => bug.status === 'closed').length
  const unresolved = openCount + fixedCount
  const bugSummary =
    bugs.length > 0 ? `Bug ${bugs.length} 条（待修复 ${openCount} / 待回归 ${fixedCount} / 已关闭 ${closedCount}）` : '测试阶段暂无 Bug'
  const testConclusion =
    stage.status === 'passed'
      ? '测试通过，可进入交付沉淀。'
      : unresolved > 0
        ? '测试未通过，等待修复后重新验证。'
        : stage.status === 'pending'
          ? '测试阶段待确认最终测试结论。'
          : '等待前后端代码审查通过后进入测试。'
  const summary =
    stage.status === 'passed'
      ? '测试通过，已形成交付输入。'
      : unresolved > 0
        ? bugSummary
        : bugs.length > 0
          ? '全部 Bug 已关闭，可执行测试通过。'
          : stage.status === 'pending'
            ? '测试阶段待执行。'
            : '测试阶段尚未开放。'
  return {
    summary,
    artifact: withCommonArtifactFields(
      {
        bugs,
        testScope: ['主流程联调', '已提交 Bug 的回归验证'],
        executionResult: unresolved > 0 ? `当前仍有 ${unresolved} 条未关闭 Bug。` : bugs.length ? '全部历史 Bug 已完成回归关闭。' : '尚未记录测试缺陷。',
        bugSummary,
        regressionConclusion:
          fixedCount > 0 ? `仍有 ${fixedCount} 条 Bug 待回归。` : unresolved > 0 ? '存在待修复 Bug，回归未完成。' : bugs.length ? '历史 Bug 已全部关闭。' : '暂无回归项。',
        testConclusion,
      },
      summary,
      compactStrings([bugSummary, testConclusion]),
      stage.status === 'passed'
        ? ['供交付沉淀阶段整理交付包']
        : unresolved > 0
          ? ['供相关开发修复并重新提交验证']
          : stage.status === 'pending'
            ? ['供测试执行人补充测试结论或提交 Bug']
            : ['等待代码审查全部通过后进入测试'],
    ),
  }
}

function buildDeliveryArtifact(task: TaskRow, stage: StageRow) {
  const frontendRepo = parseRepoField(task.frontend_repo)
  const backendRepo = parseRepoField(task.backend_repo)
  const deliveryItems = compactStrings([
    frontendRepo ? `前端仓库：${frontendRepo.branch ? `${frontendRepo.name} @ ${frontendRepo.branch}` : frontendRepo.name}` : '前端仓库：未绑定',
    backendRepo ? `后端仓库：${backendRepo.branch ? `${backendRepo.name} @ ${backendRepo.branch}` : backendRepo.name}` : '后端仓库：未绑定',
    `任务标题：${task.title}`,
  ])
  const summary =
    stage.status === 'passed'
      ? '交付沉淀已完成，任务已闭环。'
      : stage.status === 'pending'
        ? '交付沉淀待确认。'
        : '交付沉淀尚未开放。'
  return {
    summary,
    artifact: withCommonArtifactFields(
      {
        deliveryItems,
        releaseNotes: stage.status === 'passed' ? '本轮需求已完成交付，可按交付清单进行交接。' : '测试通过后在此整理上线说明与交付说明。',
        rollbackPlan: '可回退到需求理解、详细设计、前端开发或后端开发。',
        handoffConclusion:
          stage.status === 'passed' ? '交付完成，任务闭环结束。' : stage.status === 'pending' ? '待交付执行人确认最终交付结果。' : '当前未形成有效交付结论。',
      },
      summary,
      compactStrings([
        stage.status === 'passed' ? '交付结论：通过' : stage.status === 'pending' ? '测试已通过，待确认交付结论' : '等待测试通过后生成交付结论',
        stage.status === 'passed' ? '任务状态：已完成' : '',
      ]),
      stage.status === 'passed' ? ['供管理者与交付对象查阅交付结果'] : ['供交付执行人确认交付或驳回去向'],
    ),
  }
}

function withCommonArtifactFields(
  artifact: Record<string, unknown>,
  summary: string,
  keyConclusions: string[],
  downstreamInputs: string[],
) {
  return {
    ...artifact,
    summary,
    keyConclusions,
    downstreamInputs,
  }
}

function parseArtifact(value: string) {
  const text = value.trim()
  if (!text) {
    return null
  }
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function pickSummary(artifact: Record<string, unknown>, stageSummary: string, fallback: string) {
  return asStringValue(artifact.summary) || stageSummary || fallback
}

function compactStrings(values: Array<string | null | undefined>) {
  return values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter((value) => value.length > 0)
}

function asStringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function asStringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function asArrayValue(value: unknown) {
  return Array.isArray(value) ? value : []
}

function asNumberValue(value: unknown) {
  return typeof value === 'number' ? value : 0
}

function levelLabel(level: string): string {
  if (level === 'high') return '高危'
  if (level === 'medium') return '中危'
  if (level === 'low') return '低危'
  return level
}

function bugTargetBranches(target: 'frontend' | 'backend' | 'both'): Array<'frontend' | 'backend'> {
  return target === 'both' ? ['frontend', 'backend'] : [target]
}

function testingBugTargetLabel(target: 'frontend' | 'backend' | 'both') {
  if (target === 'frontend') return '前端'
  if (target === 'backend') return '后端'
  return '前后端'
}

function testingBugStatusLabel(status: 'open' | 'fixed' | 'closed') {
  if (status === 'open') return '待修复'
  if (status === 'fixed') return '待回归'
  return '已关闭'
}

function detectGitBranch(repoPath: string): string | null {
  try {
    const branch = execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return branch || null
  } catch {
    return null
  }
}

function deriveStateLabel(state: string, stages: StageView[]): string {
  if (state === 'completed') return '已完成'
  if (state === 'cancelled') return '已撤销'
  if (state === 'pending') return '待执行'
  const running = stages.find((s) => s.status === 'running')
  if (running) return `${running.name}处理中`
  const review = stages.find((s) => s.status === 'review')
  if (review) return `等待${review.name}确认`
  const testing = stages.find((s) => s.key === 'testing' && s.status === 'pending')
  if (testing) return '等待测试'
  const delivery = stages.find((s) => s.key === 'delivery' && s.status === 'pending')
  if (delivery) return '等待交付确认'
  return '进行中'
}
