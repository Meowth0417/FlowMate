import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProcessEvent } from './executor.js'
import { branchLabel, type Branch } from './domain.js'

const execFileAsync = promisify(execFile)

export interface RealAgentExecutionOptions {
  modelId?: string
  effort?: string
  cwd?: string
  enableTools?: boolean
}

export interface RealAgentExecutionResult {
  process: ProcessEvent[]
  artifact: Record<string, unknown>
  summary: string
  clarifications?: { question: string; options: string[] }[]
}

export async function runCopilotRequirement(
  input: {
    title: string
    description: string
    extraPrompt: string
  },
  options: RealAgentExecutionOptions,
): Promise<RealAgentExecutionResult> {
  const prompt = [
    '你是企业研发流程中的需求理解助手。',
    '请基于输入需求，输出一个且仅一个 JSON 对象，不要输出 markdown、解释、代码块或额外文字。',
    'JSON 结构必须为：',
    '{',
    '  "summary": string,',
    '  "keyConclusions": string[],',
    '  "downstreamInputs": string[],',
    '  "risks": string[],',
    '  "acceptance": string[],',
    '  "impactScope": string,',
    '  "fullDoc": string,',
    '  "clarifications": [{"question": string, "options": [string, string, string]}]',
    '}',
    '要求：clarifications 恰好 3 条，每条 options 恰好 3 个候选。',
    `任务标题：${input.title}`,
    `任务描述：${input.description}`,
    input.extraPrompt.trim() ? `附加说明：${input.extraPrompt.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const started = Date.now()
  const parsed = parseJsonObject(await runCopilotPrompt(prompt, options))
  const clarifications = normalizeClarifications(parsed.clarifications)
  const artifact = {
    summary: requiredString(parsed.summary, 'summary'),
    keyConclusions: requiredStringArray(parsed.keyConclusions, 'keyConclusions'),
    downstreamInputs: requiredStringArray(parsed.downstreamInputs, 'downstreamInputs'),
    risks: requiredStringArray(parsed.risks, 'risks'),
    acceptance: requiredStringArray(parsed.acceptance, 'acceptance'),
    impactScope: requiredString(parsed.impactScope, 'impactScope'),
    fullDoc: requiredString(parsed.fullDoc, 'fullDoc'),
  }
  return {
    process: buildProcessEvents('需求理解', started),
    artifact,
    summary: artifact.summary,
    clarifications,
  }
}

export async function runCopilotDesign(
  input: {
    title: string
    description: string
    requirementDoc: string
    extraPrompt: string
  },
  options: RealAgentExecutionOptions,
): Promise<RealAgentExecutionResult> {
  const prompt = [
    '你是企业研发流程中的详细设计助手。',
    '请基于输入需求包输出一个且仅一个 JSON 对象，不要输出 markdown、解释、代码块或额外文字。',
    'JSON 结构必须为：',
    '{',
    '  "summary": string,',
    '  "keyConclusions": string[],',
    '  "downstreamInputs": string[],',
    '  "frontendDesign": string,',
    '  "backendDesign": string,',
    '  "apiDoc": string,',
    '  "testCases": string',
    '}',
    '要求：testCases 必须是按“主流程 / 异常流程 / 边界场景”组织的文档化测试用例文本。',
    `任务标题：${input.title}`,
    `任务描述：${input.description}`,
    `需求包：\n${input.requirementDoc}`,
    input.extraPrompt.trim() ? `附加说明：${input.extraPrompt.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const started = Date.now()
  const parsed = parseJsonObject(await runCopilotPrompt(prompt, options))
  const artifact = {
    summary: requiredString(parsed.summary, 'summary'),
    keyConclusions: requiredStringArray(parsed.keyConclusions, 'keyConclusions'),
    downstreamInputs: requiredStringArray(parsed.downstreamInputs, 'downstreamInputs'),
    frontendDesign: requiredString(parsed.frontendDesign, 'frontendDesign'),
    backendDesign: requiredString(parsed.backendDesign, 'backendDesign'),
    apiDoc: requiredString(parsed.apiDoc, 'apiDoc'),
    testCases: requiredString(parsed.testCases, 'testCases'),
    supplements: [] as string[],
    confirmations: { frontend: false, backend: false },
  }
  return {
    process: buildProcessEvents('详细设计', started),
    artifact,
    summary: artifact.summary,
  }
}

export async function runCopilotDevelopment(
  input: {
    branch: Extract<Branch, 'frontend' | 'backend'>
    title: string
    description: string
    requirementDoc: string
    designDoc: string
    extraPrompt: string
    rejectionNote: string
  },
  options: RealAgentExecutionOptions,
): Promise<RealAgentExecutionResult> {
  const label = branchLabel(input.branch)
  const prompt = [
    `你是企业研发流程中的${label}开发助手。`,
    '请先阅读当前工作区代码以及输入上下文，再输出一个且仅一个 JSON 对象；不要输出 markdown、解释、代码块或额外文字。',
    'JSON 结构必须为：',
    '{',
    '  "summary": string,',
    '  "keyConclusions": string[],',
    '  "downstreamInputs": string[],',
    '  "changes": string,',
    '  "addedFiles": string[],',
    '  "modifiedFiles": string[]',
    '}',
    '要求：addedFiles 和 modifiedFiles 必须是相对当前工作区的文件路径；若本轮无需新增文件，可返回空数组。',
    `任务标题：${input.title}`,
    `任务描述：${input.description}`,
    `需求包：\n${input.requirementDoc}`,
    `设计包：\n${input.designDoc}`,
    input.rejectionNote.trim() ? `本轮回流/修复说明：${input.rejectionNote.trim()}` : '',
    input.extraPrompt.trim() ? `附加说明：${input.extraPrompt.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const started = Date.now()
  const parsed = parseJsonObject(await runCopilotPrompt(prompt, { ...options, enableTools: true }))
  const artifact = {
    summary: requiredString(parsed.summary, 'summary'),
    keyConclusions: requiredStringArray(parsed.keyConclusions, 'keyConclusions'),
    downstreamInputs: requiredStringArray(parsed.downstreamInputs, 'downstreamInputs'),
    changes: requiredString(parsed.changes, 'changes'),
    addedFiles: stringArray(parsed.addedFiles, 'addedFiles'),
    modifiedFiles: stringArray(parsed.modifiedFiles, 'modifiedFiles'),
  }
  return {
    process: buildProcessEvents(`${label}开发`, started),
    artifact,
    summary: artifact.summary,
  }
}

export async function runCopilotVerification(
  input: {
    branch: Extract<Branch, 'frontend' | 'backend'>
    title: string
    description: string
    designDoc: string
    developmentArtifact: string
    extraPrompt: string
  },
  options: RealAgentExecutionOptions,
): Promise<RealAgentExecutionResult> {
  const label = branchLabel(input.branch)
  const prompt = [
    `你是企业研发流程中的${label}功能验证助手。`,
    '请结合当前工作区代码与输入上下文，输出一个且仅一个 JSON 对象；不要输出 markdown、解释、代码块或额外文字。',
    'JSON 结构必须为：',
    '{',
    '  "summary": string,',
    '  "keyConclusions": string[],',
    '  "downstreamInputs": string[],',
    '  "verificationScope": string[],',
    '  "verificationResult": string,',
    '  "rejectionReason": string,',
    '  "passBasis": string',
    '}',
    '要求：verificationResult 使用“待验证 / 通过 / 驳回”之一；若尚未人工判定，则返回“待验证”。',
    `任务标题：${input.title}`,
    `任务描述：${input.description}`,
    `设计包：\n${input.designDoc}`,
    `开发变更集：\n${input.developmentArtifact}`,
    input.extraPrompt.trim() ? `附加说明：${input.extraPrompt.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const started = Date.now()
  const parsed = parseJsonObject(await runCopilotPrompt(prompt, { ...options, enableTools: true }))
  const artifact = {
    summary: requiredString(parsed.summary, 'summary'),
    keyConclusions: requiredStringArray(parsed.keyConclusions, 'keyConclusions'),
    downstreamInputs: requiredStringArray(parsed.downstreamInputs, 'downstreamInputs'),
    verificationScope: requiredStringArray(parsed.verificationScope, 'verificationScope'),
    verificationResult: requiredString(parsed.verificationResult, 'verificationResult'),
    rejectionReason: optionalString(parsed.rejectionReason),
    passBasis: optionalString(parsed.passBasis),
  }
  return {
    process: buildProcessEvents(`${label}功能验证`, started),
    artifact,
    summary: artifact.summary,
  }
}

export async function runCopilotReview(
  input: {
    branch: Extract<Branch, 'frontend' | 'backend'>
    title: string
    description: string
    requirementDoc: string
    designDoc: string
    developmentArtifact: string
    extraPrompt: string
  },
  options: RealAgentExecutionOptions,
): Promise<RealAgentExecutionResult> {
  const label = branchLabel(input.branch)
  const prompt = [
    `你是企业研发流程中的${label}代码审查助手。`,
    '请只做审查，不要修改工作区文件。输出一个且仅一个 JSON 对象；不要输出 markdown、解释、代码块或额外文字。',
    'JSON 结构必须为：',
    '{',
    '  "summary": string,',
    '  "keyConclusions": string[],',
    '  "downstreamInputs": string[],',
    '  "high": number,',
    '  "medium": number,',
    '  "low": number,',
    '  "issues": [{"level": "high" | "medium" | "low", "title": string, "file": string}]',
    '}',
    `任务标题：${input.title}`,
    `任务描述：${input.description}`,
    `需求包：\n${input.requirementDoc}`,
    `设计包：\n${input.designDoc}`,
    `开发变更集：\n${input.developmentArtifact}`,
    input.extraPrompt.trim() ? `附加说明：${input.extraPrompt.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const started = Date.now()
  const parsed = parseJsonObject(await runCopilotPrompt(prompt, { ...options, enableTools: true }))
  const issues = normalizeReviewIssues(parsed.issues)
  const artifact = {
    summary: requiredString(parsed.summary, 'summary'),
    keyConclusions: requiredStringArray(parsed.keyConclusions, 'keyConclusions'),
    downstreamInputs: requiredStringArray(parsed.downstreamInputs, 'downstreamInputs'),
    high: numberValue(parsed.high, 'high'),
    medium: numberValue(parsed.medium, 'medium'),
    low: numberValue(parsed.low, 'low'),
    issues,
  }
  return {
    process: buildProcessEvents(`${label}代码审查`, started),
    artifact,
    summary: artifact.summary,
  }
}

export async function runCopilotTesting(
  input: {
    title: string
    description: string
    requirementDoc: string
    designDoc: string
    frontendDevelopmentArtifact: string
    backendDevelopmentArtifact: string
    frontendReviewArtifact: string
    backendReviewArtifact: string
    bugContext: string
    extraPrompt: string
  },
  options: RealAgentExecutionOptions,
): Promise<RealAgentExecutionResult> {
  const prompt = [
    '你是企业研发流程中的测试阶段助手。',
    '请基于输入上下文输出一个且仅一个 JSON 对象；不要输出 markdown、解释、代码块或额外文字。',
    'JSON 结构必须为：',
    '{',
    '  "summary": string,',
    '  "keyConclusions": string[],',
    '  "downstreamInputs": string[],',
    '  "testScope": string[],',
    '  "executionResult": string,',
    '  "bugSummary": string,',
    '  "regressionConclusion": string,',
    '  "testConclusion": string',
    '}',
    `任务标题：${input.title}`,
    `任务描述：${input.description}`,
    `需求包：\n${input.requirementDoc}`,
    `设计包：\n${input.designDoc}`,
    `前端开发变更集：\n${input.frontendDevelopmentArtifact}`,
    `后端开发变更集：\n${input.backendDevelopmentArtifact}`,
    `前端审查问题清单：\n${input.frontendReviewArtifact}`,
    `后端审查问题清单：\n${input.backendReviewArtifact}`,
    input.bugContext.trim() ? `当前 Bug 列表：\n${input.bugContext.trim()}` : '当前 Bug 列表：暂无',
    input.extraPrompt.trim() ? `附加说明：${input.extraPrompt.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const started = Date.now()
  const parsed = parseJsonObject(await runCopilotPrompt(prompt, options))
  const artifact = {
    summary: requiredString(parsed.summary, 'summary'),
    keyConclusions: requiredStringArray(parsed.keyConclusions, 'keyConclusions'),
    downstreamInputs: requiredStringArray(parsed.downstreamInputs, 'downstreamInputs'),
    testScope: requiredStringArray(parsed.testScope, 'testScope'),
    executionResult: requiredString(parsed.executionResult, 'executionResult'),
    bugSummary: requiredString(parsed.bugSummary, 'bugSummary'),
    regressionConclusion: requiredString(parsed.regressionConclusion, 'regressionConclusion'),
    testConclusion: requiredString(parsed.testConclusion, 'testConclusion'),
  }
  return {
    process: buildProcessEvents('测试', started),
    artifact,
    summary: artifact.summary,
  }
}

export async function runCopilotDelivery(
  input: {
    title: string
    description: string
    requirementDoc: string
    designDoc: string
    testingArtifact: string
    frontendRepoLabel: string
    backendRepoLabel: string
    extraPrompt: string
  },
  options: RealAgentExecutionOptions,
): Promise<RealAgentExecutionResult> {
  const prompt = [
    '你是企业研发流程中的交付沉淀助手。',
    '请基于输入上下文输出一个且仅一个 JSON 对象；不要输出 markdown、解释、代码块或额外文字。',
    'JSON 结构必须为：',
    '{',
    '  "summary": string,',
    '  "keyConclusions": string[],',
    '  "downstreamInputs": string[],',
    '  "deliveryItems": string[],',
    '  "releaseNotes": string,',
    '  "rollbackPlan": string,',
    '  "handoffConclusion": string',
    '}',
    `任务标题：${input.title}`,
    `任务描述：${input.description}`,
    `需求包：\n${input.requirementDoc}`,
    `设计包：\n${input.designDoc}`,
    `测试报告：\n${input.testingArtifact}`,
    `前端仓库：${input.frontendRepoLabel}`,
    `后端仓库：${input.backendRepoLabel}`,
    input.extraPrompt.trim() ? `附加说明：${input.extraPrompt.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const started = Date.now()
  const parsed = parseJsonObject(await runCopilotPrompt(prompt, options))
  const artifact = {
    summary: requiredString(parsed.summary, 'summary'),
    keyConclusions: requiredStringArray(parsed.keyConclusions, 'keyConclusions'),
    downstreamInputs: requiredStringArray(parsed.downstreamInputs, 'downstreamInputs'),
    deliveryItems: requiredStringArray(parsed.deliveryItems, 'deliveryItems'),
    releaseNotes: requiredString(parsed.releaseNotes, 'releaseNotes'),
    rollbackPlan: requiredString(parsed.rollbackPlan, 'rollbackPlan'),
    handoffConclusion: requiredString(parsed.handoffConclusion, 'handoffConclusion'),
  }
  return {
    process: buildProcessEvents('交付沉淀', started),
    artifact,
    summary: artifact.summary,
  }
}

async function runCopilotPrompt(prompt: string, options: RealAgentExecutionOptions) {
  const copilotArgs: string[] = []
  if (options.cwd?.trim()) {
    copilotArgs.push('-C', options.cwd.trim())
  }
  copilotArgs.push('-p', prompt, '--silent', '--no-ask-user', '--no-custom-instructions', '--output-format', 'text')
  if (options.enableTools) {
    copilotArgs.push('--allow-all-tools', '--allow-all-paths')
  }
  if (options.modelId?.trim()) {
    copilotArgs.push('--model', options.modelId.trim())
  }
  if (options.effort?.trim()) {
    copilotArgs.push('--effort', options.effort.trim())
  }
  const { stdout } = await execFileAsync('copilot', copilotArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 1024 * 1024 * 4,
  })
  return stdout.trim()
}

function buildProcessEvents(stageName: string, startedAt: number): ProcessEvent[] {
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
  return [
    { order: 0, type: 'thought', title: '准备输入', content: `已组装${stageName}执行输入。` },
    { order: 1, type: 'tool', title: 'copilot', content: `Copilot 真实执行已完成（约 ${seconds}s）。`, tool: { name: 'copilot', status: 'complete', detail: `耗时约 ${seconds}s` } },
    { order: 2, type: 'text', title: '解析结果', content: '已通过 JSON 契约解析真实 agent 输出。' },
  ]
}

function parseJsonObject(output: string) {
  const trimmed = output.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('真实 agent 未返回合法 JSON 对象')
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    throw new Error('真实 agent 返回的 JSON 解析失败')
  }
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`真实 agent 输出缺少有效字段：${field}`)
  }
  return value.trim()
}

function optionalString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function requiredStringArray(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw new Error(`真实 agent 输出缺少有效字段：${field}`)
  }
  const items = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  if (!items.length) {
    throw new Error(`真实 agent 输出缺少有效字段：${field}`)
  }
  return items
}

function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw new Error(`真实 agent 输出缺少有效字段：${field}`)
  }
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
}

function numberValue(value: unknown, field: string) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`真实 agent 输出缺少有效字段：${field}`)
  }
  return value
}

function normalizeClarifications(value: unknown) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('真实 agent 输出的 clarifications 必须恰好 3 条')
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`真实 agent 输出的 clarification #${index + 1} 非法`)
    }
    const record = item as { question?: unknown; options?: unknown }
    const question = requiredString(record.question, `clarifications[${index}].question`)
    const options = requiredStringArray(record.options, `clarifications[${index}].options`).slice(0, 3)
    if (options.length !== 3) {
      throw new Error(`真实 agent 输出的 clarification #${index + 1} options 必须恰好 3 个`)
    }
    return { question, options }
  })
}

function normalizeReviewIssues(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error('真实 agent 输出缺少有效字段：issues')
  }
  return value
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`真实 agent 输出的 issue #${index + 1} 非法`)
      }
      const record = item as { level?: unknown; title?: unknown; file?: unknown }
      const level = requiredString(record.level, `issues[${index}].level`)
      if (level !== 'high' && level !== 'medium' && level !== 'low') {
        throw new Error(`真实 agent 输出的 issue #${index + 1} level 非法`)
      }
      return {
        level,
        title: requiredString(record.title, `issues[${index}].title`),
        file: requiredString(record.file, `issues[${index}].file`),
      }
    })
}
