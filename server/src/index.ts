import Fastify from 'fastify'
import cors from '@fastify/cors'
import { WorkflowService } from './service.js'
import type { Branch, StageKey, User } from './domain.js'

const app = Fastify({ logger: true })
const service = new WorkflowService()

await app.register(cors, { origin: true })

// Bodyless POSTs (execute/advance/deliver/cancel) still send a JSON
// content-type header; treat an empty body as undefined instead of erroring.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!text) {
    done(null, undefined)
    return
  }
  try {
    done(null, JSON.parse(text))
  } catch (error) {
    ;(error as { statusCode?: number }).statusCode = 400
    done(error as Error, undefined)
  }
})

// Resolve current user from X-User-Id header (mock auth, no password).
function currentUser(request: { headers: Record<string, unknown> }): User {
  const userId = request.headers['x-user-id']
  if (typeof userId !== 'string' || !userId) {
    throw new Error('缺少当前用户')
  }
  return service.getUser(userId)
}

function handleError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) {
  return reply.code(400).send({ message: (error as Error).message })
}

app.get('/health', async () => ({ ok: true }))

app.get('/api/users', async () => ({ users: service.listUsers() }))

app.get('/api/agents', async (request, reply) => {
  try {
    currentUser(request)
    return service.listAgents()
  } catch (error) {
    return handleError(reply, error)
  }
})

app.get('/api/local-dirs', async (request, reply) => {
  const { path } = request.query as { path?: string }
  try {
    currentUser(request)
    return service.listLocalDirs(path)
  } catch (error) {
    return handleError(reply, error)
  }
})

app.get('/api/tasks', async (request, reply) => {
  try {
    return { tasks: service.listTasks(currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.get('/api/tasks/:taskId', async (request, reply) => {
  const { taskId } = request.params as { taskId: string }
  try {
    return { task: service.getTaskView(taskId, currentUser(request)) }
  } catch (error) {
    return reply.code(404).send({ message: (error as Error).message })
  }
})

app.post('/api/tasks', async (request, reply) => {
  const body = request.body as {
    title?: string
    description?: string
    reqOwnerId?: string
    pmId?: string
    frontendDevId?: string
    backendDevId?: string
    testerId?: string
  }
  if (!body?.title?.trim() || !body?.description?.trim()) {
    return reply.code(400).send({ message: '标题与描述必填' })
  }
  if (!body.reqOwnerId || !body.pmId || !body.frontendDevId || !body.backendDevId || !body.testerId) {
    return reply.code(400).send({ message: '需求负责人、产品经理、前后端开发、测试负责人必选' })
  }
  try {
    return {
      task: service.createTask(
        {
          title: body.title.trim(),
          description: body.description.trim(),
          reqOwnerId: body.reqOwnerId,
          pmId: body.pmId,
          frontendDevId: body.frontendDevId,
          backendDevId: body.backendDevId,
          testerId: body.testerId,
        },
        currentUser(request),
      ),
    }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/cancel', async (request, reply) => {
  const { taskId } = request.params as { taskId: string }
  try {
    return { task: service.cancelTask(taskId, currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

function stageParams(request: { params: unknown }) {
  const { taskId, stageKey, branch } = request.params as {
    taskId: string
    stageKey: StageKey
    branch: Branch
  }
  return { taskId, stageKey, branch }
}

app.post('/api/tasks/:taskId/stages/:stageKey/:branch/prompt', async (request, reply) => {
  const { taskId, stageKey, branch } = stageParams(request)
  const body = request.body as { prompt?: string }
  try {
    return { task: service.saveExtraPrompt(taskId, stageKey, branch, body?.prompt ?? '', currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/stages/:stageKey/:branch/execute', async (request, reply) => {
  const { taskId, stageKey, branch } = stageParams(request)
  const body = request.body as { prompt?: string; agentName?: string; modelId?: string; effort?: string; fastMode?: 'on' | 'off' } | undefined
  try {
    return { task: service.executeStage(taskId, stageKey, branch, currentUser(request), body) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.get('/api/tasks/:taskId/stages/:stageKey/:branch/process', async (request, reply) => {
  const { taskId, stageKey, branch } = stageParams(request)
  try {
    return service.getActiveRunProcess(taskId, stageKey, branch, currentUser(request))
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/stages/:stageKey/advance', async (request, reply) => {
  const { taskId, stageKey } = request.params as { taskId: string; stageKey: StageKey }
  try {
    return { task: service.advanceStage(taskId, stageKey, currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/repo/:branch', async (request, reply) => {
  const { taskId, branch } = request.params as { taskId: string; branch: Branch }
  const body = request.body as {
    path?: string
    repo?: { path?: string } | null
    repos?: string[]
  }
  if (branch !== 'frontend' && branch !== 'backend') {
    return reply.code(400).send({ message: '仅前端/后端分支可绑定仓库' })
  }
  try {
    const path = typeof body?.path === 'string' ? body.path : typeof body?.repo?.path === 'string' ? body.repo.path : body?.repos?.[0] ?? ''
    return { task: service.bindRepo(taskId, branch, path, currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/clarifications/:clarificationId', async (request, reply) => {
  const { taskId, clarificationId } = request.params as { taskId: string; clarificationId: string }
  const body = request.body as { answer?: string }
  if (!body?.answer?.trim()) {
    return reply.code(400).send({ message: '答案不能为空' })
  }
  try {
    return { task: service.answerClarification(taskId, clarificationId, body.answer.trim(), currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/stages/requirement/reunderstand', async (request, reply) => {
  const { taskId } = request.params as { taskId: string }
  const body = request.body as { prompt?: string } | undefined
  try {
    return { task: service.reunderstandRequirement(taskId, currentUser(request), body?.prompt) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/verify/:branch', async (request, reply) => {
  const { taskId, branch } = request.params as { taskId: string; branch: Branch }
  const body = request.body as { pass?: boolean; reason?: string }
  try {
    return { task: service.verify(taskId, branch, Boolean(body?.pass), body?.reason ?? '', currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/review/:branch', async (request, reply) => {
  const { taskId, branch } = request.params as { taskId: string; branch: Branch }
  const body = request.body as { action?: 'pass' | 'reflow'; levels?: string[] }
  try {
    return {
      task: service.review(taskId, branch, body?.action ?? 'pass', body?.levels ?? [], currentUser(request)),
    }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/testing/pass', async (request, reply) => {
  const { taskId } = request.params as { taskId: string }
  try {
    return { task: service.passTesting(taskId, currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/testing/bugs', async (request, reply) => {
  const { taskId } = request.params as { taskId: string }
  const body = request.body as { target?: 'frontend' | 'backend' | 'both'; detail?: string }
  if (!body?.target) {
    return reply.code(400).send({ message: 'Bug 归属必填' })
  }
  try {
    return { task: service.reportTestingBug(taskId, body.target, body?.detail ?? '', currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/testing/bugs/:bugId/fix', async (request, reply) => {
  const { taskId, bugId } = request.params as { taskId: string; bugId: string }
  try {
    return { task: service.markTestingBugFixed(taskId, bugId, currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/testing/bugs/:bugId/close', async (request, reply) => {
  const { taskId, bugId } = request.params as { taskId: string; bugId: string }
  try {
    return { task: service.closeTestingBug(taskId, bugId, currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/deliver', async (request, reply) => {
  const { taskId } = request.params as { taskId: string }
  try {
    return { task: service.deliver(taskId, currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/deliver/rollback', async (request, reply) => {
  const { taskId } = request.params as { taskId: string }
  const body = request.body as { target?: string; reason?: string }
  if (!body?.target) {
    return reply.code(400).send({ message: '回退目标必填' })
  }
  try {
    return { task: service.rollbackFromDelivery(taskId, body.target, body?.reason ?? '', currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/supplement/requirement', async (request, reply) => {
  const { taskId } = request.params as { taskId: string }
  const body = request.body as { note?: string; impact?: 'frontend' | 'backend' | 'both'; reenterDesign?: boolean }
  try {
    return {
      task: service.supplementRequirement(
        taskId,
        body?.note ?? '',
        body?.impact ?? 'both',
        Boolean(body?.reenterDesign),
        currentUser(request),
      ),
    }
  } catch (error) {
    return handleError(reply, error)
  }
})

app.post('/api/tasks/:taskId/supplement/design', async (request, reply) => {
  const { taskId } = request.params as { taskId: string }
  const body = request.body as { note?: string }
  try {
    return { task: service.supplementDesign(taskId, body?.note ?? '', currentUser(request)) }
  } catch (error) {
    return handleError(reply, error)
  }
})

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '0.0.0.0'

app.listen({ port, host }).catch((error) => {
  app.log.error(error)
  process.exit(1)
})
