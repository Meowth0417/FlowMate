import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
  error?: string
  current_model_id?: string
  default_model_id?: string
  default_effort?: string
  default_fast_service?: string
  supports_fast_service?: boolean
  efforts?: string[]
  models?: AgentModelInfo[]
}

const CACHE_TTL_MS = 30_000
const AGENT_ORDER = ['gemini', 'codex', 'claude', 'copilot'] as const
const COPILOT_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_EFFORTS = ['low', 'medium', 'high']

let cachedAgents: AgentStatus[] | null = null
let cachedAt = 0

export function listDetectedAgents(): AgentStatus[] {
  const now = Date.now()
  if (cachedAgents && now - cachedAt < CACHE_TTL_MS) {
    return cloneAgents(cachedAgents)
  }

  const agents = [probeGemini(), probeCodex(), probeClaude(), probeCopilot()]
  cachedAgents = agents.sort((left, right) => AGENT_ORDER.indexOf(left.name as never) - AGENT_ORDER.indexOf(right.name as never))
  cachedAt = now
  return cloneAgents(cachedAgents)
}

function probeCopilot(): AgentStatus {
  const installed = commandExists('copilot')
  const settings = readJsonFile(join(homedir(), '.copilot', 'settings.json'))
  const currentModel = stringValue(settings?.model)
  const defaultModel = currentModel || latestDefaultModelFromLogs(join(homedir(), '.copilot', 'logs'))
  const defaultEffort = stringValue(settings?.effortLevel)
  const packageDir = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@github', 'copilot')
  const sessionStore = join(homedir(), '.copilot', 'session-store.db')
  const modelIds = uniqueStrings([
    currentModel,
    defaultModel,
    ...readCopilotSessionModels(sessionStore),
    ...extractMatches(readTextFile(join(packageDir, 'app.js')), /(?:claude-(?:sonnet|opus|haiku)-[0-9.]+(?:-fast)?|gpt-(?:4\.1|5(?:\.\d+)?(?:-codex|-mini|-nano)?|5-mini)|gemini-3(?:\.1)?-pro-preview)/g),
    ...extractMatches(readTextFile(join(packageDir, 'sdk', 'index.js')), /(?:claude-(?:sonnet|opus|haiku)-[0-9.]+(?:-fast)?|gpt-(?:4\.1|5(?:\.\d+)?(?:-codex|-mini|-nano)?|5-mini)|gemini-3(?:\.1)?-pro-preview)/g),
  ])

  const models = buildModels(modelIds, currentModel, defaultModel, describeCopilotModel, COPILOT_EFFORTS)
  const error = !installed
    ? '未检测到本机 Copilot CLI，请先安装并确保 `copilot` 命令可用。'
    : models.length === 0
      ? '已检测到 Copilot CLI，但未探测到可用模型。'
      : undefined
  return {
    name: 'copilot',
    installed,
    available: installed && models.length > 0,
    error,
    current_model_id: currentModel || undefined,
    default_model_id: defaultModel || currentModel || undefined,
    default_effort: defaultEffort || undefined,
    efforts: installed ? [...COPILOT_EFFORTS] : undefined,
    models,
  }
}

function probeCodex(): AgentStatus {
  const installed = commandExists('codex')
  const configText = readTextFile(join(homedir(), '.codex', 'config.toml'))
  const currentModel = firstTomlString(configText, 'model')
  const defaultEffort = firstTomlString(configText, 'model_reasoning_effort')
  const serviceTier = firstTomlString(configText, 'service_tier')
  const binaryPath = join(
    homedir(),
    'AppData',
    'Roaming',
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  )
  const binaryIds = extractMatches(readBinaryText(binaryPath), /(?:gpt|o4)(?:[-.][A-Za-z0-9]+)+/g)
    .map(normalizeCodexModelId)
    .filter(isRealCodexModel)
  const configIds = extractMatches(configText, /gpt-\d(?:\.\d+)?(?:-[a-z0-9]+)*/g).filter(isRealCodexModel)
  const defaultFastService = serviceTier === 'flex' || serviceTier === 'fast' ? 'on' : 'off'
  const modelIds = uniqueStrings([currentModel, ...configIds, ...binaryIds])
  const models = buildModels(modelIds, currentModel, currentModel, describeCodexModel, CODEX_EFFORTS)
  const error = !installed
    ? '未检测到本机 Codex CLI，请先安装并确保 `codex` 命令可用。'
    : models.length === 0
      ? '已检测到 Codex CLI，但未探测到可用模型。'
      : undefined

  return {
    name: 'codex',
    installed,
    available: installed && models.length > 0,
    error,
    current_model_id: currentModel || undefined,
    default_model_id: currentModel || undefined,
    default_effort: defaultEffort || undefined,
    default_fast_service: defaultFastService,
    supports_fast_service: installed,
    efforts: installed ? [...CODEX_EFFORTS] : undefined,
    models,
  }
}

function probeClaude(): AgentStatus {
  const installed = commandExists('claude')
  const settings = readJsonFile(join(homedir(), '.claude', 'settings.json'))
  const env = objectValue(settings?.env)
  const currentModel =
    stringValue(env?.ANTHROPIC_MODEL) ||
    stringValue(env?.ANTHROPIC_DEFAULT_SONNET_MODEL) ||
    stringValue(env?.ANTHROPIC_DEFAULT_OPUS_MODEL) ||
    stringValue(env?.CLAUDE_CODE_SUBAGENT_MODEL)
  const defaultModel = currentModel
  const defaultEffort = stringValue(env?.CLAUDE_CODE_EFFORT_LEVEL)
  const binaryPath = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  const binaryIds = extractMatches(readBinaryText(binaryPath), /claude-(?:sonnet|opus|haiku)(?:[-.][A-Za-z0-9]+)+/g)
    .map(normalizeClaudeModelId)
    .filter(Boolean)
  const modelIds = uniqueStrings([
    currentModel,
    stringValue(env?.ANTHROPIC_DEFAULT_SONNET_MODEL),
    stringValue(env?.ANTHROPIC_DEFAULT_OPUS_MODEL),
    stringValue(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    stringValue(env?.CLAUDE_CODE_SUBAGENT_MODEL),
    ...binaryIds,
  ])
  const models = buildModels(modelIds, currentModel, defaultModel, describeClaudeModel, CLAUDE_EFFORTS)
  const error = !installed
    ? '未检测到本机 Claude CLI，请先安装并确保 `claude` 命令可用。'
    : models.length === 0
      ? '已检测到 Claude CLI，但未探测到可用模型。'
      : undefined

  return {
    name: 'claude',
    installed,
    available: installed && models.length > 0,
    error,
    current_model_id: currentModel || undefined,
    default_model_id: defaultModel || undefined,
    default_effort: defaultEffort || undefined,
    efforts: installed ? [...CLAUDE_EFFORTS] : undefined,
    models,
  }
}

function probeGemini(): AgentStatus {
  const installed = commandExists('gemini')
  const settings = readJsonFile(join(homedir(), '.gemini', 'settings.json'))
  const currentModel = stringValue(settings?.model)
  const defaultModel = currentModel
  const docPath = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'docs', 'cli', 'model.md')
  const bundlePath = latestMatchingFile(
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle'),
    /^chunk-.*\.js$/,
  )
  const modelIds = uniqueStrings([
    currentModel,
    ...extractMatches(readTextFile(docPath), /gemini-\d(?:\.\d+)?-(?:pro|flash)(?:-preview)?/g),
    ...extractMatches(readTextFile(bundlePath), /gemini-\d(?:\.\d+)?-(?:pro|flash)(?:-preview)?/g),
  ])
  const models = buildModels(modelIds, currentModel, defaultModel, describeGeminiModel)
  const error = !installed
    ? '未检测到本机 Gemini CLI，请先安装并确保 `gemini` 命令可用。'
    : models.length === 0
      ? '已检测到 Gemini CLI，但未探测到可用模型。'
      : undefined

  return {
    name: 'gemini',
    installed,
    available: installed && models.length > 0,
    error,
    current_model_id: currentModel || undefined,
    default_model_id: defaultModel || undefined,
    models,
  }
}

function buildModels(
  ids: string[],
  currentModel: string | null,
  defaultModel: string | null,
  describe: (id: string) => string | undefined,
  efforts?: string[],
): AgentModelInfo[] {
  const priority = new Map<string, number>()
  if (currentModel) {
    priority.set(currentModel, -2)
  }
  if (defaultModel && !priority.has(defaultModel)) {
    priority.set(defaultModel, -1)
  }

  return ids
    .filter(Boolean)
    .sort((left, right) => {
      const leftRank = priority.get(left) ?? 0
      const rightRank = priority.get(right) ?? 0
      if (leftRank !== rightRank) {
        return leftRank - rightRank
      }
      return left.localeCompare(right)
    })
    .map((id) => ({
      id,
      name: displayName(id),
      description: describe(id),
      supportEffort: efforts ? efforts.length > 0 : undefined,
    }))
}

function cloneAgents(agents: AgentStatus[]): AgentStatus[] {
  return agents.map((agent) => ({
    ...agent,
    efforts: agent.efforts ? [...agent.efforts] : undefined,
    models: agent.models ? agent.models.map((model) => ({ ...model })) : undefined,
  }))
}

function commandExists(command: string): boolean {
  try {
    const result = execFileSync('where', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return Boolean(result.trim())
  } catch {
    return false
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) {
      return null
    }
    return objectValue(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

function readTextFile(path: string | null): string {
  try {
    if (!path || !existsSync(path)) {
      return ''
    }
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function readBinaryText(path: string): string {
  try {
    if (!existsSync(path)) {
      return ''
    }
    return readFileSync(path, 'latin1')
  } catch {
    return ''
  }
}

function extractMatches(text: string, pattern: RegExp): string[] {
  if (!text) {
    return []
  }
  return Array.from(new Set(text.match(pattern) ?? [])).filter(Boolean)
}

function readCopilotSessionModels(path: string): string[] {
  try {
    if (!existsSync(path)) {
      return []
    }
    const db = new DatabaseSync(path)
    try {
      const rows = db
        .prepare(
          `
            SELECT DISTINCT model
            FROM assistant_usage_events
            WHERE model IS NOT NULL AND model != ''
            ORDER BY MAX(created_at) OVER (PARTITION BY model) DESC
          `,
        )
        .all() as Array<{ model: string }>
      return rows.map((row) => row.model).filter(Boolean)
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

function latestDefaultModelFromLogs(logDir: string): string | null {
  try {
    if (!existsSync(logDir)) {
      return null
    }
    const files = readdirSync(logDir)
      .map((name) => join(logDir, name))
      .filter((path) => path.endsWith('.log') && existsSync(path))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)

    for (const file of files.slice(0, 10)) {
      const match = readTextFile(file).match(/Using default model:\s+([^\r\n]+)/)
      if (match?.[1]) {
        return match[1].trim()
      }
    }
  } catch {
    return null
  }
  return null
}

function latestMatchingFile(dir: string, pattern: RegExp): string | null {
  try {
    if (!existsSync(dir)) {
      return null
    }
    const matches = readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => join(dir, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    return matches[0] ?? null
  } catch {
    return null
  }
}

function firstTomlString(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"\\r\\n]+)"`, 'm'))
  return match?.[1]?.trim() || null
}

function normalizeCodexModelId(value: string): string {
  return value
    .replace(/gpt-5-4/g, 'gpt-5.4')
    .replace(/gpt-5-5/g, 'gpt-5.5')
    .replace(/gpt-4-1/g, 'gpt-4.1')
    .replace(/gpt-5p5/g, 'gpt-5.5')
}

function isRealCodexModel(value: string): boolean {
  return /^(?:gpt-4\.1-(?:mini|nano)|gpt-5(?:\.\d+)?(?:-(?:codex|max|mini|nano|pro))?|o4-mini)$/.test(value)
}

function normalizeClaudeModelId(value: string): string | null {
  if (/\d{8}/.test(value) || /-v\d+$/.test(value)) {
    return null
  }
  return value.replace(/^(claude-(?:sonnet|opus|haiku)-\d)-(\d)(?=$|-)/, '$1.$2')
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (!trimmed) {
      continue
    }
    seen.add(trimmed)
  }
  return Array.from(seen)
}

function displayName(id: string): string {
  if (/^gemini-\d/.test(id)) {
    return `Gemini ${id
      .replace(/^gemini-/, '')
      .split('-')
      .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(' ')}`
  }
  if (/^gpt-/.test(id)) {
    return id
  }
  if (/^claude-/.test(id)) {
    return id
  }
  return id
}

function describeCopilotModel(id: string): string | undefined {
  if (id.includes('codex')) {
    return 'Coding-oriented model exposed by the local Copilot CLI install.'
  }
  if (id.startsWith('claude-')) {
    return 'Anthropic family model discovered from local Copilot runtime metadata or recent sessions.'
  }
  if (id.startsWith('gemini-')) {
    return 'Gemini model discovered from local Copilot runtime metadata.'
  }
  if (id.startsWith('gpt-')) {
    return 'OpenAI family model discovered from local Copilot runtime metadata or recent sessions.'
  }
  return undefined
}

function describeCodexModel(id: string): string | undefined {
  if (id.includes('codex')) {
    return 'Coding-focused model discovered from local Codex config or binary metadata.'
  }
  if (id.endsWith('-pro')) {
    return 'Higher-capability variant discovered from the local Codex install.'
  }
  if (id.startsWith('o4-')) {
    return 'Reasoning model discovered from the local Codex install.'
  }
  return 'Model discovered from local Codex config or binary metadata.'
}

function describeClaudeModel(id: string): string | undefined {
  if (id.startsWith('deepseek-')) {
    return 'Current third-party provider model configured in local Claude settings.'
  }
  if (id.includes('haiku')) {
    return 'Fast Claude family model discovered from the local Claude install.'
  }
  if (id.includes('opus')) {
    return 'Deep-reasoning Claude family model discovered from the local Claude install.'
  }
  if (id.includes('sonnet')) {
    return 'Balanced Claude family model discovered from the local Claude install.'
  }
  return undefined
}

function describeGeminiModel(id: string): string | undefined {
  if (id.includes('flash')) {
    return 'Fast Gemini model discovered from local Gemini CLI docs or bundle metadata.'
  }
  if (id.includes('pro')) {
    return 'Higher-capability Gemini model discovered from local Gemini CLI docs or bundle metadata.'
  }
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
