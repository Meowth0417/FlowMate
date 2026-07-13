import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from './db.js'
import { STAGE_DEFINITIONS, nowIso, type Branch, type StageKey, type User } from './domain.js'

export const MOCK_USERS: User[] = [
  { id: 'u-pm-1', name: '产品 · 林清', role: 'pm' },
  { id: 'u-pm-2', name: '产品 · 苏窈', role: 'pm' },
  { id: 'u-dev-1', name: '开发 · 陈默', role: 'dev' },
  { id: 'u-dev-2', name: '开发 · 周野', role: 'dev' },
  { id: 'u-dev-3', name: '开发 · 何棠', role: 'dev' },
  { id: 'u-dev-4', name: '开发 · 江予', role: 'dev' },
  { id: 'u-tester-1', name: '测试 · 程澈', role: 'tester' },
  { id: 'u-tester-2', name: '测试 · 沈夕', role: 'tester' },
  { id: 'u-ob-1', name: '观察 · 顾遥', role: 'observer' },
]

interface SeedTask {
  id: string
  title: string
  description: string
  creatorId: string
  reqOwnerId: string
  pmId: string
  frontendDevId: string
  backendDevId: string
  testerId: string
  // stage_key:branch => status
  stageStatuses: Record<string, string>
  state: string
}

// Build the fixed set of stage instances for a task at a chosen progress point.
function stageInstances() {
  const instances: { key: StageKey; branch: Branch; order: number }[] = []
  let order = 0
  for (const def of STAGE_DEFINITIONS) {
    for (const branch of def.branches) {
      instances.push({ key: def.key, branch, order })
      order += 1
    }
  }
  return instances
}

export function seedIfEmpty(database: DatabaseSync) {
  ensureMockUsers(database)
  const row = database.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number }
  if (row.count > 0) {
    return
  }

  withTransaction(database, () => {
    const tasks: SeedTask[] = [
      {
        id: 't-demo-1',
        title: '优惠券规则引擎',
        description: '支持按用户分层配置优惠券发放规则，并在下单时实时计算最优券。',
        creatorId: 'u-dev-1',
        reqOwnerId: 'u-dev-1',
        pmId: 'u-pm-1',
        frontendDevId: 'u-dev-2',
        backendDevId: 'u-dev-3',
        testerId: 'u-tester-1',
        state: 'pending',
        stageStatuses: { 'requirement:shared': 'pending' },
      },
      {
        id: 't-demo-2',
        title: '会员权益中心改版',
        description: '重构会员权益展示与领取流程，统一权益数据模型。',
        creatorId: 'u-dev-2',
        reqOwnerId: 'u-dev-2',
        pmId: 'u-pm-2',
        frontendDevId: 'u-dev-2',
        backendDevId: 'u-dev-4',
        testerId: 'u-tester-2',
        state: 'in_progress',
        stageStatuses: {
          'requirement:shared': 'passed',
          'design:shared': 'review',
        },
      },
      {
        id: 't-demo-3',
        title: '支付审批流',
        description: '为大额支付增加多级审批流程，支持审批留痕与驳回。',
        creatorId: 'u-dev-3',
        reqOwnerId: 'u-dev-3',
        pmId: 'u-pm-1',
        frontendDevId: 'u-dev-1',
        backendDevId: 'u-dev-3',
        testerId: 'u-tester-1',
        state: 'in_progress',
        stageStatuses: {
          'requirement:shared': 'passed',
          'design:shared': 'passed',
          'development:frontend': 'pending',
          'development:backend': 'passed',
          'verification:backend': 'pending',
        },
      },
    ]

    for (const task of tasks) {
      insertSeedTask(database, task)
    }
  })
}

export function ensureMockUsers(database: DatabaseSync) {
  withTransaction(database, () => {
    for (const user of MOCK_USERS) {
      database.prepare('INSERT OR IGNORE INTO users (id, name, role) VALUES (?, ?, ?)').run(user.id, user.name, user.role)
    }
  })
}

function insertSeedTask(database: DatabaseSync, task: SeedTask) {
  const now = nowIso()
  database
    .prepare(
      `INSERT INTO tasks (
        id, title, description, state, creator_id, req_owner_id, pm_id, frontend_dev_id, backend_dev_id,
        tester_id, frontend_repo, backend_repo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.title,
      task.description,
      task.state,
      task.creatorId,
      task.reqOwnerId,
      task.pmId,
      task.frontendDevId,
      task.backendDevId,
      task.testerId,
      '',
      '',
      now,
      now,
    )

  for (const inst of stageInstances()) {
    const compositeKey = `${inst.key}:${inst.branch}`
    const status = task.stageStatuses[compositeKey] ?? defaultStatus(inst.key)
    const artifact = status === 'passed' || status === 'review' ? seedArtifact(inst.key, inst.branch, task.title) : ''
    const summary = artifact ? `${task.title} · ${inst.key} 产物已生成` : ''
    database
      .prepare(
        `INSERT INTO task_stages (
          task_id, stage_key, branch, stage_order, status, run_count, extra_prompt, summary, artifact_json, pending_note, active_run_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        inst.key,
        inst.branch,
        inst.order,
        status,
        status === 'pending' || status === 'blocked' ? 0 : 1,
        '',
        summary,
        artifact,
        '',
        null,
        now,
      )
  }

  database
    .prepare(
      'INSERT INTO timeline_events (id, task_id, stage_key, branch, kind, title, detail, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(crypto.randomUUID(), task.id, null, null, 'created', '任务创建', task.description, task.creatorId, now)
}

// First stage starts pending; everything after is blocked until upstream passes.
function defaultStatus(key: StageKey): string {
  return key === 'requirement' ? 'pending' : 'blocked'
}

function seedArtifact(key: StageKey, branch: Branch, title: string): string {
  if (key === 'requirement') {
    return JSON.stringify({
      summary: `围绕「${title}」的需求已收敛为可执行输入。`,
      risks: ['数据一致性风险', '第三方依赖风险'],
      acceptance: ['核心链路可端到端跑通', '异常有兜底'],
      impactScope: '前端 + 后端',
      fullDoc: `# ${title} 需求文档\n\n已完成需求理解。`,
    })
  }
  if (key === 'design') {
    return JSON.stringify({
      frontendDesign: `## 前端设计\n${title} 主视图与状态设计。`,
      backendDesign: `## 后端设计\n${title} 服务与数据模型。`,
      apiDoc: `## 接口文档\n${title} 相关接口。`,
    })
  }
  if (key === 'development') {
    return JSON.stringify({
      changes: `${branch === 'frontend' ? '前端' : '后端'}分支已完成「${title}」实现。`,
      addedFiles: branch === 'frontend' ? ['src/pages/x.tsx'] : ['src/service/x.ts'],
      modifiedFiles: branch === 'frontend' ? ['src/App.tsx'] : ['src/index.ts'],
    })
  }
  return ''
}
