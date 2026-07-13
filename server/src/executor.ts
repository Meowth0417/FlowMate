import type { Branch, StageKey } from './domain.js'
import { branchLabel } from './domain.js'

export interface ProcessEvent {
  order: number
  type: 'thought' | 'tool' | 'text'
  title: string
  content: string
  tool?: { name: string; status: 'complete'; detail: string }
}

export interface ClarificationSeed {
  question: string
  options: string[] // first option is the recommended one
}

export interface ExecutionResult {
  process: ProcessEvent[]
  artifact: Record<string, unknown>
  summary: string
  clarifications?: ClarificationSeed[]
}

function thought(order: number, content: string): ProcessEvent {
  return { order, type: 'thought', title: '思考', content }
}

function tool(order: number, name: string, detail: string): ProcessEvent {
  return { order, type: 'tool', title: name, content: detail, tool: { name, status: 'complete', detail } }
}

function text(order: number, title: string, content: string): ProcessEvent {
  return { order, type: 'text', title, content }
}

export function generateExecution(
  stageKey: StageKey,
  branch: Branch,
  taskTitle: string,
  extraPrompt: string,
  rejectionNote: string,
): ExecutionResult {
  switch (stageKey) {
    case 'requirement':
      return requirementExecution(taskTitle, extraPrompt)
    case 'design':
      return designExecution(taskTitle, extraPrompt)
    case 'development':
      return developmentExecution(branch, taskTitle, extraPrompt, rejectionNote)
    case 'review':
      return reviewExecution(branch, taskTitle)
    default:
      return { process: [text(0, '执行', '该阶段无 agent 执行')], artifact: {}, summary: '' }
  }
}

function requirementExecution(taskTitle: string, extraPrompt: string): ExecutionResult {
  const process: ProcessEvent[] = [
    thought(0, `解析原始需求「${taskTitle}」，提取核心目标与边界。`),
    tool(1, 'read_context', '读取任务描述与背景材料'),
    thought(2, extraPrompt ? `结合附加提示词：${extraPrompt}` : '识别潜在歧义与待澄清点。'),
    tool(3, 'analyze_requirement', '拆解需求，归纳风险、验收标准与影响范围'),
    text(4, '生成需求摘要', '整理需求摘要与关键风险'),
    text(5, '生成澄清问题', '产出待产品经理确认的澄清问题'),
    text(6, '完成', '需求理解初稿已生成，等待澄清确认'),
  ]
  const artifact = {
    summary: `围绕「${taskTitle}」的需求已收敛为可执行输入，明确了核心目标、边界与验收口径。`,
    risks: ['与既有模块的数据一致性风险', '第三方依赖可用性风险', '灰度与回滚策略待明确'],
    acceptance: ['核心链路可端到端跑通', '异常场景有兜底提示', '关键操作留有审计记录'],
    impactScope: '前端交互 + 后端接口 + 数据表结构',
    fullDoc: `# ${taskTitle} 需求文档\n\n## 背景\n${taskTitle} 的原始需求已完成理解。\n\n## 目标\n收敛为后续设计与开发可直接使用的正式输入。\n\n> 澄清问题确认结果与后续补充需求将拼接至此文档。`,
  }
  const clarifications: ClarificationSeed[] = [
    {
      question: '该需求的目标用户范围是？',
      options: ['全部登录用户（推荐）', '仅内部运营人员', '仅特定灰度白名单用户'],
    },
    {
      question: '数据变更是否需要保留历史版本？',
      options: ['需要保留完整历史（推荐）', '仅保留最近一次', '不需要保留'],
    },
    {
      question: '异常情况下的默认处理策略？',
      options: ['失败回滚并提示（推荐）', '失败静默忽略', '失败进入人工处理队列'],
    },
  ]
  return { process, artifact, summary: artifact.summary as string, clarifications }
}

function designExecution(taskTitle: string, extraPrompt: string): ExecutionResult {
  const process: ProcessEvent[] = [
    thought(0, '基于已确认需求文档，拆分前后端设计边界。'),
    tool(1, 'load_requirement', '加载完整需求文档与确认结果'),
    thought(2, extraPrompt ? `结合附加提示词：${extraPrompt}` : '设计前后端接口契约。'),
    tool(3, 'draft_api', '生成接口文档草案'),
    text(4, '前端设计', '完成前端页面结构与状态设计'),
    text(5, '后端设计', '完成后端服务与数据模型设计'),
    text(6, '完成', '详细设计已生成，等待推进'),
  ]
  const artifact = {
    frontendDesign: `## 前端设计\n- 页面：${taskTitle} 主视图 + 详情面板\n- 状态：加载/成功/异常三态\n- 组件：列表、表单、结果卡片`,
    backendDesign: `## 后端设计\n- 服务：${taskTitle} 处理服务\n- 数据模型：主表 + 明细表 + 审计表\n- 事务边界：写操作统一事务提交`,
    apiDoc: `## 接口文档\n- POST /api/${taskTitle}/submit 提交\n- GET /api/${taskTitle}/list 列表\n- POST /api/${taskTitle}/confirm 确认`,
  }
  return { process, artifact, summary: '前后端设计与接口文档已生成，可进入并行开发。' }
}

function developmentExecution(
  branch: Branch,
  taskTitle: string,
  extraPrompt: string,
  rejectionNote: string,
): ExecutionResult {
  const label = branchLabel(branch)
  const process: ProcessEvent[] = [
    thought(0, `进入${label}本地仓库，读取设计与接口契约。`),
    rejectionNote
      ? text(1, '处理回流意见', `本次修复依据：${rejectionNote}`)
      : tool(1, 'read_design', '读取详细设计与接口文档'),
    thought(2, extraPrompt ? `结合附加提示词：${extraPrompt}` : `规划${label}改动点。`),
    tool(3, 'edit_files', `写入${label}代码变更`),
    tool(4, 'run_build', '本地构建与自检通过'),
    text(5, '完成', `${label}开发完成，自动进入功能验证`),
  ]
  const added =
    branch === 'frontend'
      ? ['src/pages/feature-page.tsx', 'src/components/feature-card.tsx']
      : ['src/service/feature-service.ts', 'src/model/feature.ts']
  const modified =
    branch === 'frontend'
      ? ['src/App.tsx', 'src/lib/api.ts']
      : ['src/index.ts', 'src/db.ts']
  const artifact = {
    changes: `${label}分支已按设计完成「${taskTitle}」的代码实现${rejectionNote ? '（含本次回流修复）' : ''}。`,
    addedFiles: added,
    modifiedFiles: modified,
  }
  return { process, artifact, summary: artifact.changes as string }
}

function reviewExecution(branch: Branch, taskTitle: string): ExecutionResult {
  const label = branchLabel(branch)
  const process: ProcessEvent[] = [
    thought(0, `基于固定代码规则审查${label}本次新增代码。`),
    tool(1, 'load_diff', '加载本次新增与修改文件'),
    tool(2, 'apply_rules', '按编码规范逐条扫描'),
    text(3, '汇总问题', '按高/中/低风险分级汇总问题'),
    text(4, '完成', '代码审查完成，等待人工决策'),
  ]
  const issues =
    branch === 'frontend'
      ? [
          { level: 'high', title: '未处理接口异常态', file: 'src/pages/feature-page.tsx' },
          { level: 'medium', title: '组件缺少 loading 骨架', file: 'src/components/feature-card.tsx' },
          { level: 'low', title: '存在未使用的 import', file: 'src/lib/api.ts' },
        ]
      : [
          { level: 'high', title: '缺少输入参数校验', file: 'src/service/feature-service.ts' },
          { level: 'medium', title: '事务边界不完整', file: 'src/model/feature.ts' },
          { level: 'low', title: '日志信息不足', file: 'src/index.ts' },
        ]
  const artifact = {
    high: issues.filter((i) => i.level === 'high').length,
    medium: issues.filter((i) => i.level === 'medium').length,
    low: issues.filter((i) => i.level === 'low').length,
    issues,
  }
  return { process, artifact, summary: `${label}代码审查完成：高危 ${artifact.high} / 中危 ${artifact.medium} / 低危 ${artifact.low}。` }
}
