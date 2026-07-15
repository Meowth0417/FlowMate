import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  advanceStage as advanceStageRequest,
  answerClarification as answerClarificationRequest,
  bindRepo as bindRepoRequest,
  cancelTask as cancelTaskRequest,
  closeTestingBug as closeTestingBugRequest,
  createTask as createTaskRequest,
  deliver as deliverRequest,
  executeStage as executeStageRequest,
  fetchTasks,
  fetchUsers,
  markTestingBugFixed as markTestingBugFixedRequest,
  passTesting as passTestingRequest,
  reunderstandRequirement as reunderstandRequirementRequest,
  reportTestingBug as reportTestingBugRequest,
  reviewBranch as reviewBranchRequest,
  rollbackDelivery as rollbackDeliveryRequest,
  saveExtraPrompt as saveExtraPromptRequest,
  setApiUser,
  supplementDesign as supplementDesignRequest,
  supplementRequirement as supplementRequirementRequest,
  verifyBranch as verifyBranchRequest,
} from '@/lib/api'
import { WorkspaceStoreContext, type WorkspaceStoreValue } from '@/state/workspace-store-context'
import type { Branch, BugTarget, CreateTaskInput, StageKey, TaskView, User } from '@/lib/types'

const STORAGE_KEY = 'flowmate.currentUserId'

function canFixTestingBug(task: TaskView, currentUserId: string) {
  const testingStage = task.stages.find((item) => item.key === 'testing' && item.branch === 'shared')
  if (!testingStage) {
    return false
  }
  return testingStage.testingBugs.some((bug) => {
    if (bug.status === 'closed' || bug.status === 'fixed') {
      return false
    }
    if (bug.target === 'frontend') {
      return currentUserId === task.frontendDevId
    }
    if (bug.target === 'backend') {
      return currentUserId === task.backendDevId
    }
    return (
      (currentUserId === task.frontendDevId && !bug.frontendFixed) ||
      (currentUserId === task.backendDevId && !bug.backendFixed)
    )
  })
}

function canCloseTestingBug(task: TaskView, currentUserId: string) {
  const testingStage = task.stages.find((item) => item.key === 'testing' && item.branch === 'shared')
  if (!testingStage || currentUserId !== task.testerId) {
    return false
  }
  return testingStage.status === 'pending' && testingStage.testingBugs.some((bug) => bug.status === 'fixed')
}

function hasDesignConfirmationForUser(task: TaskView, stage: TaskView['stages'][number], currentUserId: string) {
  if (stage.key !== 'design' || stage.branch !== 'shared' || !stage.artifact || typeof stage.artifact !== 'object') {
    return false
  }
  const confirmations = (stage.artifact as { confirmations?: { frontend?: boolean; backend?: boolean } }).confirmations
  if (!confirmations) {
    return false
  }
  if (currentUserId === task.frontendDevId) {
    return Boolean(confirmations.frontend)
  }
  if (currentUserId === task.backendDevId) {
    return Boolean(confirmations.backend)
  }
  return false
}

function taskNeedsCurrentUserAction(task: TaskView, currentUserId: string) {
  if (!currentUserId) {
    return false
  }
  return task.stages.some((stage) => {
    if (stage.status === 'passed') {
      return false
    }
    if (stage.key === 'requirement') {
      if (stage.status === 'pending') {
        return stage.permission.execute
      }
      if (stage.status === 'review') {
        const hasOpenClarifications = task.clarifications.some((item) => item.status !== 'confirmed')
        return stage.permission.execute || (stage.permission.confirm && (hasOpenClarifications || !hasOpenClarifications))
      }
      return false
    }
    if ((stage.status === 'pending' && (stage.permission.execute || stage.permission.confirm)) || (stage.status === 'review' && stage.permission.confirm)) {
      if (stage.key === 'design' && stage.status === 'review' && hasDesignConfirmationForUser(task, stage, currentUserId)) {
        return false
      }
      return true
    }
    return false
  }) || canFixTestingBug(task, currentUserId) || canCloseTestingBug(task, currentUserId)
}

function defaultTaskId(tasks: TaskView[], currentUserId: string) {
  return tasks.find((task) => taskNeedsCurrentUserAction(task, currentUserId))?.id ?? tasks[0]?.id ?? ''
}

export function WorkspaceStoreProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<User[]>([])
  const [currentUserId, setCurrentUserId] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? '')
  const [authLoading, setAuthLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)

  const [tasks, setTasks] = useState<TaskView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState('')

  // Keep the API client's identity in sync so every request carries X-User-Id.
  useEffect(() => {
    setApiUser(currentUserId)
  }, [currentUserId])

  const refreshUsers = useCallback(async () => {
    setAuthLoading(true)
    try {
      const nextUsers = await fetchUsers()
      setUsers(nextUsers)
      setAuthError(null)
    } catch (requestError) {
      setUsers([])
      setAuthError((requestError as Error).message)
    } finally {
      setAuthLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshUsers()
  }, [refreshUsers])

  const currentUser = useMemo(
    () => users.find((user) => user.id === currentUserId) ?? null,
    [users, currentUserId],
  )

  const selectedTask = useMemo(
    () =>
      tasks.find((task) => task.id === selectedTaskId) ??
      tasks.find((task) => taskNeedsCurrentUserAction(task, currentUserId)) ??
      tasks[0] ??
      null,
    [currentUserId, selectedTaskId, tasks],
  )

  const mergeTask = useCallback((updatedTask: TaskView) => {
    setTasks((prev) => {
      if (!prev.some((task) => task.id === updatedTask.id)) {
        return [updatedTask, ...prev]
      }
      return prev.map((task) => (task.id === updatedTask.id ? updatedTask : task))
    })
    setSelectedTaskId(updatedTask.id)
  }, [])

  const refreshTasks = useCallback(async () => {
    if (!currentUserId) {
      setTasks([])
      return
    }
    setLoading(true)
    try {
      const nextTasks = await fetchTasks()
      setTasks(nextTasks)
      setSelectedTaskId((current) => (nextTasks.some((t) => t.id === current) ? current : defaultTaskId(nextTasks, currentUserId)))
      setError(null)
    } catch (requestError) {
      setError((requestError as Error).message)
    } finally {
      setLoading(false)
    }
  }, [currentUserId])

  useEffect(() => {
    void refreshTasks()
  }, [refreshTasks])

  const login = useCallback((userId: string) => {
    localStorage.setItem(STORAGE_KEY, userId)
    setApiUser(userId)
    setCurrentUserId(userId)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setApiUser('')
    setCurrentUserId('')
    setTasks([])
    setSelectedTaskId('')
  }, [])

  const createTask = useCallback(
    async (input: CreateTaskInput) => {
      const task = await createTaskRequest(input)
      mergeTask(task)
      return task
    },
    [mergeTask],
  )

  // Each mutation returns the updated TaskView; merge it into the list.
  const wrap = useCallback(
    <A extends unknown[]>(fn: (...args: A) => Promise<TaskView>) =>
      async (...args: A) => {
        const task = await fn(...args)
        mergeTask(task)
      },
    [mergeTask],
  )

  const cancelTask = useMemo(() => wrap(cancelTaskRequest), [wrap])
  const saveExtraPrompt = useMemo(
    () => wrap((taskId: string, key: StageKey, branch: Branch, prompt: string) => saveExtraPromptRequest(taskId, key, branch, prompt)),
    [wrap],
  )
  const executeStage = useMemo(
    () => wrap((taskId: string, key: StageKey, branch: Branch, prompt?: string) => executeStageRequest(taskId, key, branch, prompt)),
    [wrap],
  )
  const reunderstandRequirement = useMemo(() => wrap((taskId: string) => reunderstandRequirementRequest(taskId)), [wrap])
  const advanceStage = useMemo(() => wrap((taskId: string, key: StageKey) => advanceStageRequest(taskId, key)), [wrap])
  const bindRepo = useMemo(
    () => wrap((taskId: string, branch: Branch, path: string) => bindRepoRequest(taskId, branch, path)),
    [wrap],
  )
  const answerClarification = useMemo(
    () => wrap((taskId: string, clarificationId: string, answer: string) => answerClarificationRequest(taskId, clarificationId, answer)),
    [wrap],
  )
  const verifyBranch = useMemo(
    () => wrap((taskId: string, branch: Branch, pass: boolean, reason: string) => verifyBranchRequest(taskId, branch, pass, reason)),
    [wrap],
  )
  const reviewBranch = useMemo(
    () => wrap((taskId: string, branch: Branch, action: 'pass' | 'reflow', levels: string[]) => reviewBranchRequest(taskId, branch, action, levels)),
    [wrap],
  )
  const passTesting = useMemo(() => wrap((taskId: string) => passTestingRequest(taskId)), [wrap])
  const reportTestingBug = useMemo(
    () => wrap((taskId: string, target: BugTarget, detail: string) => reportTestingBugRequest(taskId, target, detail)),
    [wrap],
  )
  const markTestingBugFixed = useMemo(
    () => wrap((taskId: string, bugId: string) => markTestingBugFixedRequest(taskId, bugId)),
    [wrap],
  )
  const closeTestingBug = useMemo(
    () => wrap((taskId: string, bugId: string) => closeTestingBugRequest(taskId, bugId)),
    [wrap],
  )
  const deliver = useMemo(() => wrap((taskId: string) => deliverRequest(taskId)), [wrap])
  const rollbackDelivery = useMemo(
    () => wrap((taskId: string, target: string, reason: string) => rollbackDeliveryRequest(taskId, target, reason)),
    [wrap],
  )
  const supplementRequirement = useMemo(
    () =>
      wrap((taskId: string, note: string, impact: 'frontend' | 'backend' | 'both', reenterDesign: boolean) =>
        supplementRequirementRequest(taskId, note, impact, reenterDesign),
      ),
    [wrap],
  )
  const supplementDesign = useMemo(() => wrap((taskId: string, note: string) => supplementDesignRequest(taskId, note)), [wrap])

  const value = useMemo<WorkspaceStoreValue>(
    () => ({
      users,
      currentUser,
      authLoading,
      authError,
      login,
      logout,
      refreshUsers,
      tasks,
      loading,
      error,
      selectedTaskId,
      selectedTask,
      setSelectedTaskId,
      refreshTasks,
      createTask,
      cancelTask,
      saveExtraPrompt,
      executeStage,
      reunderstandRequirement,
      advanceStage,
      bindRepo,
      answerClarification,
      verifyBranch,
      reviewBranch,
      passTesting,
      reportTestingBug,
      markTestingBugFixed,
      closeTestingBug,
      deliver,
      rollbackDelivery,
      supplementRequirement,
      supplementDesign,
    }),
    [
      users,
      currentUser,
      authLoading,
      authError,
      login,
      logout,
      refreshUsers,
      tasks,
      loading,
      error,
      selectedTaskId,
      selectedTask,
      refreshTasks,
      createTask,
      cancelTask,
      saveExtraPrompt,
      executeStage,
      reunderstandRequirement,
      advanceStage,
      bindRepo,
      answerClarification,
      verifyBranch,
      reviewBranch,
      passTesting,
      reportTestingBug,
      markTestingBugFixed,
      closeTestingBug,
      deliver,
      rollbackDelivery,
      supplementRequirement,
      supplementDesign,
    ],
  )

  return <WorkspaceStoreContext.Provider value={value}>{children}</WorkspaceStoreContext.Provider>
}
