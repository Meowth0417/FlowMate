import type {
  AgentStatus,
  BugTarget,
  Branch,
  CreateTaskInput,
  LocalDirsResponse,
  ProcessResponse,
  StageExecutionOptions,
  StageKey,
  TaskView,
  User,
} from '@/lib/types'

function resolveApiBaseUrl() {
  const configured = import.meta.env.VITE_API_BASE_URL
  if (configured) {
    return configured
  }
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8787/api`
  }
  return 'http://127.0.0.1:8787/api'
}

const API_BASE_URL = resolveApiBaseUrl()

let currentUserId = ''

// The backend resolves the acting user from the X-User-Id header (mock auth).
export function setApiUser(userId: string) {
  currentUserId = userId
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(currentUserId ? { 'x-user-id': currentUserId } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(payload?.message || '请求失败')
  }
  return (await response.json()) as T
}

// Bodyless POSTs must not send an empty JSON body (Fastify rejects it); omit body entirely.
function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
}

export async function fetchUsers(): Promise<User[]> {
  const payload = await request<{ users: User[] }>('/users')
  return payload.users
}

export async function fetchLocalDirs(path?: string): Promise<LocalDirsResponse> {
  const query = typeof path === 'string' && path.trim() ? `?path=${encodeURIComponent(path.trim())}` : ''
  return request<LocalDirsResponse>(`/local-dirs${query}`)
}

export async function fetchAgents(): Promise<AgentStatus[]> {
  return request<AgentStatus[]>('/agents')
}

export async function fetchTasks(): Promise<TaskView[]> {
  const payload = await request<{ tasks: TaskView[] }>('/tasks')
  return payload.tasks
}

export async function fetchTask(taskId: string): Promise<TaskView> {
  const payload = await request<{ task: TaskView }>(`/tasks/${taskId}`)
  return payload.task
}

export async function createTask(input: CreateTaskInput): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>('/tasks', input)
  return payload.task
}

export async function cancelTask(taskId: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/cancel`)
  return payload.task
}

export async function saveExtraPrompt(taskId: string, key: StageKey, branch: Branch, prompt: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/stages/${key}/${branch}/prompt`, { prompt })
  return payload.task
}

export async function executeStage(taskId: string, key: StageKey, branch: Branch, options?: StageExecutionOptions): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/stages/${key}/${branch}/execute`, options)
  return payload.task
}

export async function fetchProcess(taskId: string, key: StageKey, branch: Branch): Promise<ProcessResponse> {
  return request<ProcessResponse>(`/tasks/${taskId}/stages/${key}/${branch}/process`)
}

export async function advanceStage(taskId: string, key: StageKey): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/stages/${key}/advance`)
  return payload.task
}

export async function bindRepo(taskId: string, branch: Branch, path: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/repo/${branch}`, { path })
  return payload.task
}

export async function answerClarification(taskId: string, clarificationId: string, answer: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/clarifications/${clarificationId}`, { answer })
  return payload.task
}

export async function reunderstandRequirement(taskId: string, prompt?: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(
    `/tasks/${taskId}/stages/requirement/reunderstand`,
    prompt === undefined ? undefined : { prompt },
  )
  return payload.task
}

export async function verifyBranch(taskId: string, branch: Branch, pass: boolean, reason: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/verify/${branch}`, { pass, reason })
  return payload.task
}

export async function reviewBranch(
  taskId: string,
  branch: Branch,
  action: 'pass' | 'reflow',
  levels: string[],
): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/review/${branch}`, { action, levels })
  return payload.task
}

export async function passTesting(taskId: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/testing/pass`)
  return payload.task
}

export async function reportTestingBug(taskId: string, target: BugTarget, detail: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/testing/bugs`, { target, detail })
  return payload.task
}

export async function markTestingBugFixed(taskId: string, bugId: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/testing/bugs/${bugId}/fix`)
  return payload.task
}

export async function closeTestingBug(taskId: string, bugId: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/testing/bugs/${bugId}/close`)
  return payload.task
}

export async function deliver(taskId: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/deliver`)
  return payload.task
}

export async function rollbackDelivery(taskId: string, target: string, reason: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/deliver/rollback`, { target, reason })
  return payload.task
}

export async function supplementRequirement(
  taskId: string,
  note: string,
  impact: 'frontend' | 'backend' | 'both',
  reenterDesign: boolean,
): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/supplement/requirement`, { note, impact, reenterDesign })
  return payload.task
}

export async function supplementDesign(taskId: string, note: string): Promise<TaskView> {
  const payload = await post<{ task: TaskView }>(`/tasks/${taskId}/supplement/design`, { note })
  return payload.task
}
