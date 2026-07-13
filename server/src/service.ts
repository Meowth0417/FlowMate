import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { listDetectedAgents, type AgentStatus } from './agent-probe.js'
import { createDatabase, withTransaction } from './db.js'
import { ensureMockUsers, seedIfEmpty } from './seed.js'
import { generateExecution, type ProcessEvent } from './executor.js'
import {
  STAGE_DEFINITIONS,
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
    this.normalizeTesterAssignments()
    this.normalizeStageLayout()
    this.resetEphemeralRunningStages()
    this.normalizeLegacyDevelopmentReview()
    this.normalizeLegacyDeliveryToTesting()
    this.refreshTestingDerivedData()
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

  listUsers(): User[] {
    return this.db.prepare('SELECT id, name, role FROM users').all() as unknown as User[]
  }

  listAgents(): AgentStatus[] {
    return listDetectedAgents()
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
    const id = `t-${crypto.randomUUID().slice(0, 8)}`
    const now = nowIso()
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO tasks (
            id, title, description, state, creator_id, req_owner_id, pm_id, frontend_dev_id, backend_dev_id,
            tester_id, frontend_repo, backend_repo, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.description,
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
          const status = def.key === 'requirement' ? 'pending' : 'blocked'
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

  // Run the mock agent for a stage: produces execution-process timeline + artifact,
  // then puts the stage into 'review' (agent-executed stages await human action).
  executeStage(taskId: string, key: StageKey, branch: Branch, actor: User, prompt?: string): TaskView {
    const task = this.getTaskRow(taskId)
    const stage = this.getStageRow(taskId, key, branch)
    const def = getStageDefinition(key)
    if (!def.agentExecuted) {
      throw new Error('该阶段无 agent 执行')
    }
    if (stage.status !== 'pending') {
      throw new Error('当前阶段不可执行')
    }
    if (key === 'development') {
      const repo = branch === 'frontend' ? parseRepoField(task.frontend_repo) : parseRepoField(task.backend_repo)
      if (!repo) {
        throw new Error(`请先绑定${branch === 'frontend' ? '前端' : '后端'}仓库`)
      }
    }

    const effectivePrompt = prompt === undefined ? stage.extra_prompt : prompt.trim()
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

      if (key === 'requirement') {
        this.seedClarifications(taskId, result.clarifications ?? [])
      }

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
    this.db
      .prepare(
        'UPDATE task_stages SET status = ?, summary = ?, artifact_json = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?',
      )
      .run(postStatus, summary, run.artifact_json, now, taskId, key, branch)

    if (key === 'development') {
      this.setStageStatus(taskId, 'verification', branch, 'pending')
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

  getActiveRunProcess(taskId: string, key: StageKey, branch: Branch, viewer: User) {
    this.tickRunningStages(taskId)
    const stage = this.getStageRow(taskId, key, branch)
    if (!stage.active_run_id || stage.status !== 'running') {
      return { events: [], executorId: null, running: false }
    }
    const run = this.db.prepare('SELECT * FROM stage_runs WHERE id = ?').get(stage.active_run_id) as
      | { id: string; executor_id: string; status: string; reveal_interval_ms: number; started_at: string }
      | undefined
    if (!run) {
      return { events: [], executorId: null, running: false }
    }
    const all = this.runProcesses.get(run.id)
    if (!all) {
      return { events: [], executorId: run.executor_id, running: false }
    }
    // Only the current executor sees process content, and only while the stage is running.
    const visible = run.executor_id === viewer.id && stage.status === 'running'
    if (!visible) {
      return { events: [], executorId: run.executor_id, running: false }
    }
    const info = this.revealInfo(run.started_at, run.reveal_interval_ms, all.length)
    return { events: all.slice(0, info.revealed), executorId: run.executor_id, running: true }
  }

  answerClarification(taskId: string, clarificationId: string, answer: string, actor: User): TaskView {
    const row = this.db.prepare('SELECT * FROM clarifications WHERE id = ? AND task_id = ?').get(clarificationId, taskId) as
      | { status: string }
      | undefined
    if (!row) {
      throw new Error('澄清问题不存在')
    }
    if (row.status === 'confirmed') {
      throw new Error('该问题已确认，不可修改')
    }
    this.db
      .prepare("UPDATE clarifications SET answer = ?, status = 'confirmed', answered_by = ?, answered_at = ? WHERE id = ?")
      .run(answer, actor.id, nowIso(), clarificationId)
    this.addTimeline(taskId, 'clarified', '澄清问题确认', answer, actor.id, 'requirement', 'shared')
    this.regenerateRequirementDoc(taskId)
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
    const base = String(artifact.fullDoc ?? '').split('\n\n## 已确认澄清')[0]
    artifact.fullDoc = answersBlock ? `${base}\n\n## 已确认澄清\n${answersBlock}` : base
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
      const open = this.db
        .prepare("SELECT COUNT(*) as count FROM clarifications WHERE task_id = ? AND status != 'confirmed'")
        .get(taskId) as { count: number }
      if (open.count > 0) {
        throw new Error('仍有澄清问题未确认')
      }
      withTransaction(this.db, () => {
        this.setStageStatus(taskId, 'requirement', 'shared', 'passed')
        this.setStageStatus(taskId, 'design', 'shared', 'pending')
        this.addTimeline(taskId, 'advanced', '进入详细设计', '', actor.id, 'design', 'shared')
        this.touchTask(taskId)
      })
    } else if (key === 'design') {
      withTransaction(this.db, () => {
        this.setStageStatus(taskId, 'design', 'shared', 'passed')
        this.setStageStatus(taskId, 'development', 'frontend', 'pending')
        this.setStageStatus(taskId, 'development', 'backend', 'pending')
        this.addTimeline(taskId, 'advanced', '进入前后端并行开发', '', actor.id, 'development', null)
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
    const bugs = this.listTestingBugRows(taskId).map((bug) => ({
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
    const summary =
      bugs.length > 0 ? `Bug ${bugs.length} 条（待修复 ${openCount} / 待回归 ${fixedCount} / 已关闭 ${closedCount}）` : '测试阶段暂无 Bug'
    const pendingNote =
      unresolved > 0 ? `当前有 ${unresolved} 条未关闭 Bug，修复后需重新走对应分支自测与审查。` : bugs.length ? '全部 Bug 已关闭，可执行测试通过。' : ''
    this.db
      .prepare('UPDATE task_stages SET summary = ?, artifact_json = ?, pending_note = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run(summary, JSON.stringify({ bugs }), pendingNote, nowIso(), taskId, 'testing', 'shared')
  }

  private maybeOpenTesting(taskId: string) {
    const fe = this.getStageRow(taskId, 'review', 'frontend')
    const be = this.getStageRow(taskId, 'review', 'backend')
    if (fe.status !== 'passed' || be.status !== 'passed') {
      return
    }
    const testing = this.getStageRow(taskId, 'testing', 'shared')
    if (testing.status === 'passed') {
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
        } else {
          this.setStageStatus(taskId, 'design', 'shared', 'pending')
        }
        this.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run('pending', nowIso(), taskId)
      } else if (target === 'frontend' || target === 'backend') {
        this.setDevelopmentPending(taskId, target, `交付驳回：${reason}`)
        this.setStageStatus(taskId, 'verification', target, 'blocked')
        this.setStageStatus(taskId, 'review', target, 'blocked')
        this.setStageStatus(taskId, 'testing', 'shared', 'blocked')
      } else {
        throw new Error('无效的回退目标')
      }
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
    }
    this.setStageStatus(taskId, 'testing', 'shared', 'blocked')
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
    const stage = this.getStageRow(taskId, 'design', 'shared')
    const artifact = stage.artifact_json ? JSON.parse(stage.artifact_json) : {}
    artifact.supplements = [...((artifact.supplements as string[]) ?? []), note]
    this.db
      .prepare('UPDATE task_stages SET artifact_json = ?, updated_at = ? WHERE task_id = ? AND stage_key = ? AND branch = ?')
      .run(JSON.stringify(artifact), nowIso(), taskId, 'design', 'shared')
    this.addTimeline(taskId, 'supplement', '补充设计', note, actor.id, 'design', 'shared')
    return this.getTaskView(taskId, actor)
  }
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
