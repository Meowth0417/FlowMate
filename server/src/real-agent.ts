import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProcessEvent } from './executor.js'

const execFileAsync = promisify(execFile)

export interface RealAgentExecutionOptions {
  modelId?: string
  effort?: string
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
  const output = await runCopilotPrompt(prompt, options)
  const parsed = parseJsonObject(output)
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
    process: buildProcessEvents('requirement', started),
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
  const output = await runCopilotPrompt(prompt, options)
  const parsed = parseJsonObject(output)
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
    process: buildProcessEvents('design', started),
    artifact,
    summary: artifact.summary,
  }
}

async function runCopilotPrompt(prompt: string, options: RealAgentExecutionOptions) {
  const copilotArgs = ['-p', prompt, '--silent', '--no-ask-user', '--no-custom-instructions', '--output-format', 'text']
  if (options.modelId?.trim()) {
    copilotArgs.push('--model', options.modelId.trim())
  }
  if (options.effort?.trim()) {
    copilotArgs.push('--effort', options.effort.trim())
  }
  const { stdout } = await execFileAsync('gh', ['copilot', '--', ...copilotArgs], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 1024 * 1024 * 4,
  })
  return stdout.trim()
}

function buildProcessEvents(stage: 'requirement' | 'design', startedAt: number): ProcessEvent[] {
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
  return [
    { order: 0, type: 'thought', title: '准备输入', content: stage === 'requirement' ? '已组装需求理解输入。' : '已组装详细设计输入。' },
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
