import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  Bot,
  Check,
  ChevronRight,
  ClipboardCheck,
  Code2,
  CircleHelp,
  FolderGit2,
  FolderPlus,
  LogOut,
  Moon,
  Plus,
  RotateCcw,
  SearchCheck,
  Sparkles,
  SquareTerminal,
  Sun,
  UserRound,
  X,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { NavLink } from 'react-router-dom'
import { fetchAgents, fetchLocalDirs, fetchProcess } from '@/lib/api'
import {
  type AgentStatus,
  type BugTarget,
  type LocalDirItem,
  ROLE_LABELS,
  type Branch,
  type ClarificationView,
  type ProcessEvent,
  type RepoBinding,
  type StageKey,
  type StageStatus,
  type StageView,
  type TaskView,
  type TestingBugView,
  type TimelineView,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useWorkspaceStore } from '@/state/workspace-store-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

const stageIcons: Record<StageKey, ComponentType<{ className?: string }>> = {
  projectContext: FolderGit2,
  requirement: SearchCheck,
  design: SquareTerminal,
  development: Code2,
  verification: ClipboardCheck,
  review: Bot,
  testing: CircleHelp,
  delivery: Sparkles,
}

function TestingBugPromptCard({
  detail,
  target,
  submitting,
  submitError,
  onDetailChange,
  onTargetChange,
  onSubmit,
}: {
  detail: string
  target: BugTarget
  submitting: boolean
  submitError: string | null
  onDetailChange: (value: string) => void
  onTargetChange: (value: BugTarget) => void
  onSubmit: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!textareaRef.current) {
      return
    }
    textareaRef.current.style.height = '0px'
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
  }, [detail])

  return (
    <div className="rounded-[18px] border border-border bg-card px-4 py-3 shadow-sm">
      <Textarea
        ref={textareaRef}
        rows={3}
        className="min-h-0 resize-none border-0 bg-transparent px-0 py-0 text-[15px] leading-7 text-foreground shadow-none focus-visible:ring-0"
        placeholder="描述复现路径、现象、预期结果和影响范围"
        value={detail}
        onChange={(event) => onDetailChange(event.target.value)}
        onInput={(event) => {
          const target = event.currentTarget
          target.style.height = '0px'
          target.style.height = `${Math.min(target.scrollHeight, 160)}px`
        }}
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-full border border-border bg-muted/20 text-muted-foreground"
          title="预留入口"
        >
          <Plus className="size-3.5" />
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-8 rounded-full border border-border bg-background px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
            value={target}
            onChange={(event) => onTargetChange(event.target.value as BugTarget)}
          >
            <option value="frontend">前端</option>
            <option value="backend">后端</option>
            <option value="both">前后端</option>
          </select>
          <Button className="h-8 rounded-full px-3 text-sm" variant="destructive" onClick={onSubmit} disabled={submitting}>
            <Plus className="size-3.5" />
            {submitting ? '提交中...' : '提交 Bug'}
          </Button>
        </div>
      </div>
      {submitError ? <p className="mt-3 text-sm text-destructive">{submitError}</p> : null}
    </div>
  )
}

const statusBadgeMap: Record<
  StageStatus,
  { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'default' }
> = {
  blocked: { label: '已阻塞', variant: 'destructive' },
  pending: { label: '待处理', variant: 'warning' },
  running: { label: '执行中', variant: 'default' },
  review: { label: '待确认', variant: 'warning' },
  passed: { label: '已通过', variant: 'success' },
}

const notReachedBadge = { label: '未到达', variant: 'secondary' } as const

type ActionType =
  | 'advance'
  | 'reunderstand-requirement'
  | 'verify-pass'
  | 'verify-reject'
  | 'review-pass'
  | 'review-reflow'
  | 'testing-pass'
  | 'report-bug'
  | 'deliver'
  | 'rollback'
  | 'supplement-requirement'
  | 'supplement-design'

type Impact = 'frontend' | 'backend' | 'both'
type ReviewLevel = 'high' | 'medium' | 'low'
type AgentOptionId = string
type FastMode = 'on' | 'off'

interface ActionDialogState {
  type: ActionType
}

interface ClarificationDraft {
  option: string
  freeform: string
}

interface LocalDirBrowserState {
  open: boolean
  path: string
  parent: string
  items: LocalDirItem[]
  drives: LocalDirItem[]
  selectedPath: string
  loading: boolean
  error: string
}

interface ToolbarAction {
  type: ActionType
  label: string
  variant: 'outline' | 'destructive' | 'default'
  icon: ComponentType<{ className?: string }>
}

interface AgentPanelState {
  modelId: string
  effort: string
  fastMode: FastMode
}

export function WorkspacePage() {
  const {
    users,
    currentUser,
    logout,
    tasks,
    loading,
    error,
    selectedTask,
    selectedTaskId,
    setSelectedTaskId,
    refreshTasks,
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
  } = useWorkspaceStore()
  const [selectedStageKey, setSelectedStageKey] = useState('')
  const [promptDraft, setPromptDraft] = useState('')
  const [processEvents, setProcessEvents] = useState<ProcessEvent[]>([])
  const [processRunning, setProcessRunning] = useState(false)
  const [dialog, setDialog] = useState<ActionDialogState | null>(null)
  const [dialogNote, setDialogNote] = useState('')
  const [dialogImpact, setDialogImpact] = useState<Impact>('both')
  const [dialogReenterDesign, setDialogReenterDesign] = useState(true)
  const [dialogRollbackTarget, setDialogRollbackTarget] = useState('frontend')
  const [dialogReflowLevels, setDialogReflowLevels] = useState<ReviewLevel[]>(['high'])
  const [actionSubmitting, setActionSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [bugActionPendingId, setBugActionPendingId] = useState('')
  const [bugActionError, setBugActionError] = useState<string | null>(null)
  const [testingBugDraft, setTestingBugDraft] = useState('')
  const [testingBugTarget, setTestingBugTarget] = useState<BugTarget>('both')
  const [testingBugSubmitting, setTestingBugSubmitting] = useState(false)
  const [testingBugSubmitError, setTestingBugSubmitError] = useState<string | null>(null)
  const [executeSubmitting, setExecuteSubmitting] = useState(false)
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [repoSaving, setRepoSaving] = useState(false)
  const [stageAgentSelections, setStageAgentSelections] = useState<Record<string, AgentOptionId>>({})
  const [stageAgentModels, setStageAgentModels] = useState<Record<string, string>>({})
  const [stageAgentEfforts, setStageAgentEfforts] = useState<Record<string, string>>({})
  const [stageAgentFastModes, setStageAgentFastModes] = useState<Record<string, FastMode>>({})
  const [projectWorkspacePath, setProjectWorkspacePath] = useState('')
  const [repoBrowser, setRepoBrowser] = useState<LocalDirBrowserState>({
    open: false,
    path: '',
    parent: '',
    items: [],
    drives: [],
    selectedPath: '',
    loading: false,
    error: '',
  })
  const [clarificationSavingId, setClarificationSavingId] = useState('')
  const [clarificationDrafts, setClarificationDrafts] = useState<Record<string, ClarificationDraft>>({})
  const processIntervalRef = useRef<number | null>(null)
  const repoBrowserRef = useRef<HTMLDivElement | null>(null)
  const selectionContextRef = useRef('')
  const { resolvedTheme, setTheme } = useTheme()

  const selectedStage = useMemo(() => {
    if (!selectedTask) {
      return null
    }
    return selectedTask.stages.find((stage) => stageKey(stage) === selectedStageKey) ?? selectedTask.stages[0] ?? null
  }, [selectedStageKey, selectedTask])

  const openStages = useMemo(
    () => selectedTask?.stages.filter((stage) => stage.status === 'running' || stage.status === 'review' || stage.status === 'pending') ?? [],
    [selectedTask],
  )

  const toolbarActions = useMemo(() => getToolbarActions(selectedTask, selectedStage, currentUser?.id ?? ''), [currentUser?.id, selectedStage, selectedTask])
  const currentThemeLabel = resolvedTheme === 'dark' ? '暗色' : '亮色'
  const sharedStages = useMemo(
    () => selectedTask?.stages.filter((stage) => stage.branch === 'shared' && stage.key !== 'testing' && stage.key !== 'delivery') ?? [],
    [selectedTask],
  )
  const frontendStages = useMemo(
    () => selectedTask?.stages.filter((stage) => stage.branch === 'frontend') ?? [],
    [selectedTask],
  )
  const backendStages = useMemo(
    () => selectedTask?.stages.filter((stage) => stage.branch === 'backend') ?? [],
    [selectedTask],
  )
  const testingStage = useMemo(
    () => selectedTask?.stages.find((stage) => stage.branch === 'shared' && stage.key === 'testing') ?? null,
    [selectedTask],
  )
  const deliveryStage = useMemo(
    () => selectedTask?.stages.find((stage) => stage.branch === 'shared' && stage.key === 'delivery') ?? null,
    [selectedTask],
  )
  const showDevelopmentRepoToolbar = useMemo(() => {
    if (!selectedTask || !selectedStage || !currentUser || selectedStage.key !== 'development') {
      return false
    }
    if (selectedStage.branch === 'frontend') {
      return currentUser.id === selectedTask.frontendDevId
    }
    if (selectedStage.branch === 'backend') {
      return currentUser.id === selectedTask.backendDevId
    }
    return false
  }, [currentUser, selectedStage, selectedTask])
  const showProjectContextWorkspaceToolbar = useMemo(() => {
    if (!selectedTask || !selectedStage || !currentUser || selectedStage.key !== 'projectContext') {
      return false
    }
    return currentUser.id === selectedTask.frontendDevId || currentUser.id === selectedTask.backendDevId
  }, [currentUser, selectedStage, selectedTask])
  const selectedRepo = useMemo(() => {
    if (!selectedTask || !selectedStage) {
      return null
    }
    return getRepoForStage(selectedTask, selectedStage)
  }, [selectedStage, selectedTask])
  const selectedStageAgent = useMemo(() => {
    const fallbackAgent = defaultAgentForStage(selectedStage, agents)
    if (!selectedTask || !selectedStage) {
      return fallbackAgent
    }
    const selected = stageAgentSelections[stageAgentSelectionKey(selectedTask.id, selectedStage)] ?? fallbackAgent
    return agentStatusByName(agents, selected)?.name ?? fallbackAgent
  }, [agents, selectedStage, selectedTask, stageAgentSelections])
  const selectedStageAgentPanels = useMemo(() => {
    const panels = {} as Record<AgentOptionId, AgentPanelState>
    for (const agent of agents) {
      if (!selectedTask || !selectedStage) {
        panels[agent.name] = defaultAgentPanelState(agent)
        continue
      }
      const settingKey = stageAgentSettingKey(selectedTask.id, selectedStage, agent.name)
      const defaults = defaultAgentPanelState(agent)
      panels[agent.name] = {
        modelId: stageAgentModels[settingKey] ?? defaults.modelId,
        effort: stageAgentEfforts[settingKey] ?? defaults.effort,
        fastMode: stageAgentFastModes[settingKey] ?? defaults.fastMode,
      }
    }
    return panels
  }, [agents, selectedStage, selectedTask, stageAgentEfforts, stageAgentFastModes, stageAgentModels])
  const canBindLocalRepo = Boolean(showDevelopmentRepoToolbar && !selectedRepo)
  const showProcessCard = Boolean(selectedStage?.status === 'running' && processRunning)
  const showTestingBugPrompt = Boolean(selectedStage && canReportTestingBug(selectedStage))
  const canOperateRequirementClarifications = Boolean(selectedTask && selectedStage?.key === 'requirement' && currentUser?.id === selectedTask.pmId)
  const canExecuteSelectedStage = Boolean(selectedTask && selectedStage && currentUser && canExecuteStageAction(selectedTask, selectedStage, currentUser.id))
  const pendingTasks = useMemo(
    () => tasks.filter((task) => taskNeedsCurrentUserAction(task, currentUser?.id ?? '')),
    [currentUser?.id, tasks],
  )
  const otherTasks = useMemo(() => {
    const pendingTaskIds = new Set(pendingTasks.map((task) => task.id))
    return tasks.filter((task) => !pendingTaskIds.has(task.id))
  }, [pendingTasks, tasks])

  useEffect(() => {
    if (!currentUser) {
      setAgents([])
      return
    }

    let cancelled = false

    void fetchAgents()
      .then((items) => {
        if (cancelled) {
          return
        }
        setAgents(items)
      })
      .catch(() => {
        if (cancelled) {
          return
        }
        setAgents([])
      })

    return () => {
      cancelled = true
    }
  }, [currentUser])

  useEffect(() => {
    if (!selectedTask) {
      selectionContextRef.current = ''
      setSelectedStageKey('')
      return
    }
    const nextDefaultStageKey = getDefaultStageKey(selectedTask)
    const nextContext = `${selectedTask.id}:${currentUser?.id ?? ''}`
    setSelectedStageKey((current) => {
      const contextChanged = selectionContextRef.current !== nextContext
      selectionContextRef.current = nextContext
      if (!contextChanged && current && selectedTask.stages.some((stage) => stageKey(stage) === current)) {
        return current
      }
      return nextDefaultStageKey
    })
  }, [currentUser?.id, selectedTask])

  useEffect(() => {
    setPromptDraft(selectedStage ? selectedStage.pendingNote || selectedStage.extraPrompt || '' : '')
  }, [selectedStage])

  useEffect(() => {
    setTestingBugDraft('')
    setTestingBugTarget('both')
    setTestingBugSubmitError(null)
    setProjectWorkspacePath('')
  }, [selectedTask?.id, selectedStageKey])

  useEffect(() => {
    if (!selectedTask || !selectedStage || !currentUser || !isAgentStage(selectedStage.key) || selectedStage.status !== 'running') {
      if (processIntervalRef.current !== null) {
        window.clearInterval(processIntervalRef.current)
        processIntervalRef.current = null
      }
      setProcessEvents([])
      setProcessRunning(false)
      return
    }

    let cancelled = false
    const stopPolling = () => {
      if (processIntervalRef.current !== null) {
        window.clearInterval(processIntervalRef.current)
        processIntervalRef.current = null
      }
    }

    const loadProcess = async () => {
      try {
        const result = await fetchProcess(selectedTask.id, selectedStage.key, selectedStage.branch)
        if (cancelled) {
          return
        }
        setProcessEvents(result.events)
        setProcessRunning(result.running)
        if (!result.running) {
          stopPolling()
          void refreshTasks()
        }
      } catch {
        if (!cancelled) {
          stopPolling()
          setProcessEvents([])
          setProcessRunning(false)
        }
      }
    }

    void loadProcess()
    processIntervalRef.current = window.setInterval(() => {
      void loadProcess()
    }, 1000)

    return () => {
      cancelled = true
      stopPolling()
    }
  }, [currentUser, refreshTasks, selectedTask, selectedStage])

  useEffect(() => {
    if (!selectedTask) {
      setClarificationDrafts({})
      return
    }
    setClarificationDrafts((current) => {
      const next: Record<string, ClarificationDraft> = {}
      for (const clarification of selectedTask.clarifications) {
        next[clarification.id] = current[clarification.id] ?? {
          option: clarification.options[0] ?? '',
          freeform: '',
        }
      }
      return next
    })
  }, [selectedTask])

  useEffect(() => {
    if (!repoBrowser.open) {
      return
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (repoBrowserRef.current?.contains(event.target as Node)) {
        return
      }
      setRepoBrowser((current) => ({ ...current, open: false, error: '' }))
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [repoBrowser.open])

  function openDialog(type: ActionType) {
    setDialog({ type })
    setDialogNote(type === 'reunderstand-requirement' ? selectedStage?.extraPrompt ?? '' : '')
    setDialogImpact('both')
    setDialogReenterDesign(true)
    setDialogRollbackTarget('frontend')
    setDialogReflowLevels(['high'])
    setActionError(null)
  }

  function closeDialog() {
    setDialog(null)
    setActionError(null)
    setActionSubmitting(false)
  }

  async function handleExecuteStage() {
    if (!selectedTask || !selectedStage) {
      return
    }
    try {
      setExecuteSubmitting(true)
      const panel = selectedStageAgentPanels[selectedStageAgent]
      await executeStage(selectedTask.id, selectedStage.key, selectedStage.branch, {
        prompt: promptDraft.trim(),
        agentName: selectedStageAgent,
        modelId: panel?.modelId || '',
        effort: panel?.effort || '',
        fastMode: panel?.fastMode || 'off',
        workspacePath: selectedStage.key === 'projectContext' ? projectWorkspacePath : '',
      })
    } finally {
      setExecuteSubmitting(false)
    }
  }

  async function handleReunderstandRequirement() {
    if (!selectedTask || !selectedStage || selectedStage.key !== 'requirement' || selectedStage.status !== 'review') {
      return
    }
    await reunderstandRequirement(selectedTask.id, dialogNote.trim())
  }

  async function loadLocalDirs(path?: string) {
    setRepoBrowser((current) => ({
      ...current,
      open: true,
      loading: true,
      error: '',
      ...(path === undefined ? {} : { path }),
      selectedPath: '',
    }))
    try {
      const result = await fetchLocalDirs(path)
      setRepoBrowser((current) => {
        const drives = !result.path
          ? result.items.filter((item) => item.isDir)
          : current.drives
        return {
          open: true,
          path: result.path,
          parent: result.parent,
          items: result.items,
          drives,
          selectedPath: '',
          loading: false,
          error: '',
        }
      })
    } catch (requestError) {
      setRepoBrowser((current) => ({
        ...current,
        open: true,
        loading: false,
        error: (requestError as Error).message,
      }))
    }
  }

  function handleOpenRepoBrowser() {
    void loadLocalDirs()
  }

  function handleSelectRepoPath(path: string) {
    setRepoBrowser((current) => ({ ...current, selectedPath: path }))
  }

  async function handleBindSelectedDirectory() {
    if (!selectedTask || !selectedStage || !repoBrowser.selectedPath) {
      return
    }
    if (selectedStage.key === 'projectContext') {
      setProjectWorkspacePath(repoBrowser.selectedPath)
      setRepoBrowser((current) => ({ ...current, open: false, error: '' }))
      return
    }
    if (selectedStage.branch === 'shared') {
      return
    }
    try {
      setRepoSaving(true)
      await bindRepo(selectedTask.id, selectedStage.branch, repoBrowser.selectedPath)
      setRepoBrowser((current) => ({ ...current, open: false, error: '' }))
    } finally {
      setRepoSaving(false)
    }
  }

  async function handleAnswerClarification(clarification: ClarificationView) {
    if (!selectedTask) {
      return
    }
    const draft = clarificationDrafts[clarification.id]
    const answer = (draft?.freeform.trim() || draft?.option || '').trim()
    if (!answer) {
      return
    }
    try {
      setClarificationSavingId(clarification.id)
      await answerClarification(selectedTask.id, clarification.id, answer)
    } finally {
      setClarificationSavingId('')
    }
  }

  async function handleMarkTestingBugFixed(bugId: string) {
    if (!selectedTask) {
      return
    }
    try {
      setBugActionPendingId(`fix:${bugId}`)
      setBugActionError(null)
      await markTestingBugFixed(selectedTask.id, bugId)
    } catch (requestError) {
      setBugActionError((requestError as Error).message)
    } finally {
      setBugActionPendingId('')
    }
  }

  async function handleCloseTestingBug(bugId: string) {
    if (!selectedTask) {
      return
    }
    try {
      setBugActionPendingId(`close:${bugId}`)
      setBugActionError(null)
      await closeTestingBug(selectedTask.id, bugId)
    } catch (requestError) {
      setBugActionError((requestError as Error).message)
    } finally {
      setBugActionPendingId('')
    }
  }

  async function handleSubmitTestingBug() {
    if (!selectedTask || !selectedStage || selectedStage.key !== 'testing') {
      return
    }
    if (!testingBugDraft.trim()) {
      setTestingBugSubmitError('请填写 Bug 描述')
      return
    }
    try {
      setTestingBugSubmitting(true)
      setTestingBugSubmitError(null)
      await reportTestingBug(selectedTask.id, testingBugTarget, testingBugDraft.trim())
      setTestingBugDraft('')
    } catch (requestError) {
      setTestingBugSubmitError((requestError as Error).message)
    } finally {
      setTestingBugSubmitting(false)
    }
  }

  async function handleConfirmAction() {
    if (!dialog || !selectedTask || !selectedStage) {
      return
    }

    try {
      setActionSubmitting(true)
      setActionError(null)

      if (dialog.type === 'advance') {
        await advanceStage(selectedTask.id, selectedStage.key)
      } else if (dialog.type === 'reunderstand-requirement') {
        await handleReunderstandRequirement()
      } else if (dialog.type === 'verify-pass') {
        await verifyBranch(selectedTask.id, selectedStage.branch, true, '')
      } else if (dialog.type === 'verify-reject') {
        if (!dialogNote.trim()) {
          throw new Error('请填写驳回原因')
        }
        await verifyBranch(selectedTask.id, selectedStage.branch, false, dialogNote.trim())
      } else if (dialog.type === 'review-pass') {
        await reviewBranch(selectedTask.id, selectedStage.branch, 'pass', [])
      } else if (dialog.type === 'review-reflow') {
        if (!dialogReflowLevels.length) {
          throw new Error('请至少选择一个风险级别')
        }
        await reviewBranch(selectedTask.id, selectedStage.branch, 'reflow', dialogReflowLevels)
      } else if (dialog.type === 'testing-pass') {
        await passTesting(selectedTask.id)
      } else if (dialog.type === 'report-bug') {
        if (!dialogNote.trim()) {
          throw new Error('请填写 Bug 描述')
        }
        await reportTestingBug(selectedTask.id, dialogImpact as BugTarget, dialogNote.trim())
      } else if (dialog.type === 'deliver') {
        await deliver(selectedTask.id)
      } else if (dialog.type === 'rollback') {
        if (!dialogNote.trim()) {
          throw new Error('请填写回退原因')
        }
        await rollbackDelivery(selectedTask.id, dialogRollbackTarget, dialogNote.trim())
      } else if (dialog.type === 'supplement-requirement') {
        if (!dialogNote.trim()) {
          throw new Error('请填写补充内容')
        }
        await supplementRequirement(selectedTask.id, dialogNote.trim(), dialogImpact, dialogReenterDesign)
      } else if (dialog.type === 'supplement-design') {
        if (!dialogNote.trim()) {
          throw new Error('请填写补充内容')
        }
        await supplementDesign(selectedTask.id, dialogNote.trim())
      }

      closeDialog()
    } catch (requestError) {
      setActionError((requestError as Error).message)
    } finally {
      setActionSubmitting(false)
    }
  }

  if (loading) {
    return <CenteredState title="正在加载任务..." />
  }

  if (error && !selectedTask) {
    return (
      <CenteredState title="后端服务暂不可用" description={error}>
        <Button className="rounded-xl" onClick={() => void refreshTasks()}>
          重新加载
        </Button>
      </CenteredState>
    )
  }

  if (!selectedTask || !selectedStage) {
    return <CenteredState title="暂无任务数据" />
  }

  return (
    <>
      <div className="flex h-screen overflow-hidden bg-background">
        <aside className="flex w-[248px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
          <div className="flex-1 overflow-y-auto px-2 py-2">
            <Button
              asChild
              variant="secondary"
              className="h-10 w-full justify-start rounded-lg border border-border/80 bg-white px-3.5 text-sm text-primary shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:bg-white/95 hover:shadow-[0_1px_2px_rgba(15,23,42,0.06)] dark:bg-card dark:hover:bg-card/95"
            >
              <NavLink to="/tasks/new">
                <FolderPlus className="size-4.5" />
                新建任务
              </NavLink>
            </Button>

            <Button
              asChild
              variant="ghost"
              className="mt-2 h-10 w-full justify-start rounded-lg px-3.5 text-sm"
            >
              <NavLink to="/projects">
                <FolderGit2 className="size-4.5" />
                项目管理
              </NavLink>
            </Button>

            <div className="mt-4">
              <TaskListSection
                title="待你处理"
                tasks={pendingTasks}
                selectedTaskId={selectedTaskId}
                onSelect={setSelectedTaskId}
                emptyHint="当前没有待你处理的任务。"
              />
            </div>

            <div className="mt-4">
              <TaskListSection title="其他任务" tasks={otherTasks} selectedTaskId={selectedTaskId} onSelect={setSelectedTaskId} />
            </div>
          </div>

          <div className="border-t border-sidebar-border px-3 py-3">
            <div className="rounded-[18px] border border-border bg-card/70 p-3">
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-lg bg-lime-300 text-lime-900">
                  <UserRound className="size-4.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{currentUser?.name ?? '未登录'}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {currentUser ? ROLE_LABELS[currentUser.role] : ''}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <Button
                  variant="outline"
                  className="h-9 flex-1 rounded-lg"
                  onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                >
                  {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  {currentThemeLabel}
                </Button>
                <Button variant="secondary" className="h-9 rounded-lg" onClick={logout}>
                  <LogOut className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="border-b border-border bg-background/92 px-3 py-3 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="min-w-0 text-lg font-semibold leading-tight">{selectedTask.title}</h1>
                <p className="shrink-0 text-sm text-muted-foreground">{selectedStage.name}</p>
                {selectedStage.branch !== 'shared' ? (
                  <Badge variant="outline" className="px-2 py-0.5">
                    {branchLabel(selectedStage.branch)}
                  </Badge>
                ) : null}
                <p className="shrink-0 text-sm text-muted-foreground">{stageRoleLabel(selectedTask, selectedStage, users)}</p>
              </div>
              <Badge variant={stageBadge(selectedTask, selectedStage).variant} className="px-2 py-0.5">
                {selectedTask.stateLabel}
              </Badge>
            </div>
          </div>

          <div className="grid min-h-0 min-w-0 flex-1 overflow-hidden xl:grid-cols-[292px_minmax(0,1fr)_360px]">
            <aside className="hidden min-h-0 border-r border-sidebar-border bg-sidebar xl:flex xl:flex-col">
              <div className="flex-1 overflow-y-auto px-2 py-2">
                <div className="space-y-2">
                  {sharedStages.map((stage) => (
                    <StageNavButton
                      key={stageKey(stage)}
                      task={selectedTask}
                      stage={stage}
                      users={users}
                      selected={stageKey(stage) === stageKey(selectedStage)}
                      onSelect={() => setSelectedStageKey(stageKey(stage))}
                    />
                  ))}

                  <div className="grid grid-cols-2 gap-2">
                    <StageBranchColumn
                      title="前端"
                      task={selectedTask}
                      stages={frontendStages}
                      users={users}
                      selectedStage={selectedStage}
                      onSelect={setSelectedStageKey}
                    />
                    <StageBranchColumn
                      title="后端"
                      task={selectedTask}
                      stages={backendStages}
                      users={users}
                      selectedStage={selectedStage}
                      onSelect={setSelectedStageKey}
                    />
                  </div>

                  {testingStage ? (
                    <StageNavButton
                      key={stageKey(testingStage)}
                      task={selectedTask}
                      stage={testingStage}
                      users={users}
                      selected={stageKey(testingStage) === stageKey(selectedStage)}
                      onSelect={() => setSelectedStageKey(stageKey(testingStage))}
                    />
                  ) : null}

                  {deliveryStage ? (
                    <StageNavButton
                      key={stageKey(deliveryStage)}
                      task={selectedTask}
                      stage={deliveryStage}
                      users={users}
                      selected={stageKey(deliveryStage) === stageKey(selectedStage)}
                      onSelect={() => setSelectedStageKey(stageKey(deliveryStage))}
                    />
                  ) : null}
                </div>
              </div>
            </aside>

            <section className="flex min-h-0 min-w-0 flex-col border-r border-border">
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="sticky top-0 z-10 border-b border-border bg-background/96 px-3 py-2 backdrop-blur">
                  <div className="flex min-h-8 min-w-0 items-center gap-2">
                    <Badge variant={stageBadge(selectedTask, selectedStage).variant}>
                      {stageBadge(selectedTask, selectedStage).label}
                    </Badge>
                    {selectedStage.branch !== 'shared' ? (
                      <Badge variant="outline">{branchLabel(selectedStage.branch)}</Badge>
                    ) : null}
                    {showDevelopmentRepoToolbar || showProjectContextWorkspaceToolbar ? (
                      showDevelopmentRepoToolbar && selectedRepo ? (
                        <div
                          className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground"
                          title={selectedRepo.path}
                        >
                          <FolderPlus className="size-3.5 text-muted-foreground" />
                          <span className="max-w-36 truncate font-medium">{selectedRepo.name}</span>
                          {selectedRepo.branch ? (
                            <Badge variant="outline" className="max-w-40 truncate rounded-full px-2 py-0 text-[11px] font-normal">
                              {selectedRepo.branch}
                            </Badge>
                          ) : null}
                        </div>
                      ) : canBindLocalRepo || showProjectContextWorkspaceToolbar ? (
                        <div ref={repoBrowserRef} className="relative shrink-0">
                          {showProjectContextWorkspaceToolbar && projectWorkspacePath ? (
                            <div
                              className="mb-2 flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground"
                              title={projectWorkspacePath}
                            >
                              <FolderGit2 className="size-3.5 text-muted-foreground" />
                              <span className="max-w-48 truncate font-medium">{projectWorkspacePath}</span>
                            </div>
                          ) : null}
                          <Button
                            variant="outline"
                            className="h-7 shrink-0 rounded-full px-3 text-xs"
                            onClick={handleOpenRepoBrowser}
                            disabled={repoSaving}
                          >
                            <FolderPlus className="size-3.5" />
                            {showProjectContextWorkspaceToolbar ? '选择工作区' : repoSaving ? '绑定中...' : '绑定仓库'}
                          </Button>

                          {repoBrowser.open ? (
                            <div className="absolute left-0 top-[calc(100%+8px)] z-30 w-[248px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-popover p-2.5 shadow-[0_12px_30px_rgba(15,23,42,0.14)]">
                              <MindfsStyleRepoPicker
                                browser={repoBrowser}
                                repoSaving={repoSaving}
                                onNavigate={(path) => void loadLocalDirs(path)}
                                onSelect={handleSelectRepoPath}
                                onBind={() => void handleBindSelectedDirectory()}
                                bindLabel={showProjectContextWorkspaceToolbar ? '使用该工作区' : '绑定仓库'}
                              />
                            </div>
                          ) : null}
                        </div>
                      ) : null
                    ) : null}

                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                      {selectedStage.key === 'requirement' &&
                      selectedStage.status === 'review' &&
                      canExecuteSelectedStage ? (
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-8 rounded-md"
                          title="重新理解"
                          aria-label="重新理解"
                          onClick={() => openDialog('reunderstand-requirement')}
                          disabled={executeSubmitting}
                        >
                          <RotateCcw className="size-3.5" />
                        </Button>
                      ) : null}
                      {toolbarActions.map((action) => (
                        <Button
                          key={action.type}
                          variant={action.variant}
                          size="icon"
                          className="size-8 rounded-md"
                          title={action.label}
                          aria-label={action.label}
                          onClick={() => openDialog(action.type)}
                        >
                          <action.icon className="size-3.5" />
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-3 px-3 py-3">
                  {selectedStage.pendingNote ? (
                    <Card className="rounded-[18px] border-warning/30 bg-warning/5">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">待处理说明</CardTitle>
                        <CardDescription>该说明来自验证/审查/补充后的回流要求。</CardDescription>
                      </CardHeader>
                      <CardContent className="text-sm text-muted-foreground">{selectedStage.pendingNote}</CardContent>
                    </Card>
                  ) : null}

                  {(selectedStage.status === 'pending' || (selectedStage.key === 'projectContext' && selectedStage.status === 'review')) &&
                  canExecuteSelectedStage &&
                  isAgentStage(selectedStage.key) ? (
                    <StagePromptCard
                      stage={selectedStage}
                      promptDraft={promptDraft}
                      setPromptDraft={setPromptDraft}
                      agents={agents}
                      selectedAgent={selectedStageAgent}
                      agentPanels={selectedStageAgentPanels}
                      onSelectAgent={(agentId) => {
                        if (!selectedTask || !selectedStage) {
                          return
                        }
                        setStageAgentSelections((current) => ({
                          ...current,
                          [stageAgentSelectionKey(selectedTask.id, selectedStage)]: agentId,
                        }))
                      }}
                      onSelectAgentModel={(agentId, modelId) => {
                        if (!selectedTask || !selectedStage) {
                          return
                        }
                        setStageAgentModels((current) => ({
                          ...current,
                          [stageAgentSettingKey(selectedTask.id, selectedStage, agentId)]: modelId,
                        }))
                      }}
                      onSelectAgentEffort={(agentId, effort) => {
                        if (!selectedTask || !selectedStage) {
                          return
                        }
                        setStageAgentEfforts((current) => ({
                          ...current,
                          [stageAgentSettingKey(selectedTask.id, selectedStage, agentId)]: effort,
                        }))
                      }}
                      onSelectAgentFastMode={(agentId, fastMode) => {
                        if (!selectedTask || !selectedStage) {
                          return
                        }
                        setStageAgentFastModes((current) => ({
                          ...current,
                          [stageAgentSettingKey(selectedTask.id, selectedStage, agentId)]: fastMode,
                        }))
                      }}
                      executeSubmitting={executeSubmitting}
                      onExecute={() => void handleExecuteStage()}
                    />
                  ) : null}

                  {selectedStage.key === 'testing' && showTestingBugPrompt ? (
                    <TestingBugPromptCard
                      detail={testingBugDraft}
                      target={testingBugTarget}
                      submitting={testingBugSubmitting}
                      submitError={testingBugSubmitError}
                      onDetailChange={setTestingBugDraft}
                      onTargetChange={setTestingBugTarget}
                      onSubmit={() => void handleSubmitTestingBug()}
                    />
                  ) : null}

                  {selectedStage.key === 'requirement' ? (
                    <ClarificationPanel
                      clarifications={selectedTask.clarifications}
                      drafts={clarificationDrafts}
                      savingId={clarificationSavingId}
                      canConfirm={canOperateRequirementClarifications}
                      onDraftChange={(clarificationId, patch) =>
                        setClarificationDrafts((current) => ({
                          ...current,
                          [clarificationId]: {
                            option: current[clarificationId]?.option ?? '',
                            freeform: current[clarificationId]?.freeform ?? '',
                            ...patch,
                          },
                        }))
                      }
                      onConfirm={(clarification) => void handleAnswerClarification(clarification)}
                    />
                  ) : null}

                  {showProcessCard ? <ProcessTimelineCard events={processEvents} running={processRunning} /> : null}

                  <StageArtifactView
                    task={selectedTask}
                    stage={selectedStage}
                    users={users}
                    currentUserId={currentUser?.id ?? ''}
                    bugActionPendingId={bugActionPendingId}
                    bugActionError={bugActionError}
                    onMarkTestingBugFixed={handleMarkTestingBugFixed}
                    onCloseTestingBug={handleCloseTestingBug}
                  />
                </div>
              </div>
            </section>

            <aside className="hidden min-h-0 bg-muted/20 xl:block">
              <div className="h-full overflow-y-auto px-3 py-3">
                <div className="space-y-3">
                  <Card className="rounded-[18px]">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm">任务摘要</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm text-muted-foreground">
                      <InfoRow label="任务状态" value={selectedTask.stateLabel} />
                      <InfoRow label="当前查看" value={selectedStage.name} />
                      <InfoRow label="开放阶段" value={openStages.map((stage) => stage.name).join('、') || '无'} />
                      <InfoRow label="最近更新" value={formatDateTime(selectedTask.updatedAt)} />
                      <InfoRow label="前端仓库" value={formatRepoBinding(selectedTask.frontendRepo)} />
                      <InfoRow label="后端仓库" value={formatRepoBinding(selectedTask.backendRepo)} />
                    </CardContent>
                  </Card>

                  <Card className="rounded-[18px]">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm">阶段产物快照</CardTitle>
                      <CardDescription>优先看结构化摘要，不先看聊天记录。</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {getSnapshotItems(selectedTask, selectedStage).map((item) => (
                        <SnapshotLine key={item.label} label={item.label} value={item.value} />
                      ))}
                    </CardContent>
                  </Card>

                  <Card className="rounded-[18px]">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm">任务时间线</CardTitle>
                      <CardDescription>展示创建、执行、确认、回流、交付等关键节点。</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      {selectedTask.timeline.map((event) => (
                        <TimelineCard key={event.id} event={event} actorName={userName(event.actorId, users)} />
                      ))}
                    </CardContent>
                  </Card>

                  <Card className="rounded-[18px]">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm">阶段 Agent</CardTitle>
                      <CardDescription>按阶段默认映射，可在提示词框右下切换。</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                      {(agents.length ? agents.map((entry) => entry.name) : [selectedStageAgent]).map((entry) => (
                        <Badge key={entry} variant={entry === selectedStageAgent ? 'default' : 'outline'}>
                          {entry}
                        </Badge>
                      ))}
                    </CardContent>
                  </Card>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>

      {dialog ? (
        <ActionDialog
          dialog={dialog}
          stage={selectedStage}
          note={dialogNote}
          setNote={setDialogNote}
          impact={dialogImpact}
          setImpact={setDialogImpact}
          reenterDesign={dialogReenterDesign}
          setReenterDesign={setDialogReenterDesign}
          rollbackTarget={dialogRollbackTarget}
          setRollbackTarget={setDialogRollbackTarget}
          reflowLevels={dialogReflowLevels}
          setReflowLevels={setDialogReflowLevels}
          actionSubmitting={actionSubmitting}
          actionError={actionError}
          onClose={closeDialog}
          onConfirm={() => void handleConfirmAction()}
        />
      ) : null}
    </>
  )
}

function StagePromptCard({
  stage,
  promptDraft,
  setPromptDraft,
  agents,
  selectedAgent,
  agentPanels,
  onSelectAgent,
  onSelectAgentModel,
  onSelectAgentEffort,
  onSelectAgentFastMode,
  executeSubmitting,
  onExecute,
}: {
  stage: StageView
  promptDraft: string
  setPromptDraft: (value: string) => void
  agents: AgentStatus[]
  selectedAgent: AgentOptionId
  agentPanels: Record<AgentOptionId, AgentPanelState>
  onSelectAgent: (agentId: AgentOptionId) => void
  onSelectAgentModel: (agentId: AgentOptionId, modelId: string) => void
  onSelectAgentEffort: (agentId: AgentOptionId, effort: string) => void
  onSelectAgentFastMode: (agentId: AgentOptionId, fastMode: FastMode) => void
  executeSubmitting: boolean
  onExecute: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const agentMenuRef = useRef<HTMLDivElement | null>(null)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const selectedAgentOption = agentStatusByName(agents, selectedAgent)
  const selectedAgentPanel = selectedAgentOption ? (agentPanels[selectedAgent] ?? defaultAgentPanelState(selectedAgentOption)) : null
  const selectedAgentModel =
    selectedAgentOption && selectedAgentPanel
      ? agentModelOptionById(selectedAgentOption, selectedAgentPanel.modelId) ?? selectedAgentOption.models?.[0] ?? null
      : null
  const selectedAgentEffort = selectedAgentPanel?.effort?.trim() ?? ''

  useEffect(() => {
    if (!textareaRef.current) {
      return
    }
    textareaRef.current.style.height = '0px'
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
  }, [promptDraft])

  useEffect(() => {
    if (!agentMenuOpen) {
      return
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (agentMenuRef.current?.contains(event.target as Node)) {
        return
      }
      setAgentMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [agentMenuOpen])

  return (
    <div className="rounded-[18px] border border-border bg-card px-4 py-3 shadow-sm">
      <Textarea
        ref={textareaRef}
        rows={2}
        className="min-h-0 resize-none border-0 bg-transparent px-0 py-0 text-[15px] leading-7 text-foreground shadow-none focus-visible:ring-0"
        placeholder={`补充 ${stage.name} 需要特别关注的说明`}
        value={promptDraft}
        onChange={(event) => setPromptDraft(event.target.value)}
        onInput={(event) => {
          const target = event.currentTarget
          target.style.height = '0px'
          target.style.height = `${Math.min(target.scrollHeight, 160)}px`
        }}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-full border border-border bg-muted/20 text-muted-foreground"
          title="预留入口"
        >
          <Plus className="size-3.5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="relative" ref={agentMenuRef}>
            <button
              type="button"
              onClick={() => setAgentMenuOpen((current) => !current)}
              className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-xs transition-colors hover:bg-muted/30"
              title={`当前 Agent：${selectedAgentOption?.name ?? selectedAgent}${selectedAgentModel ? ` / ${agentModelLabel(selectedAgentModel)}` : ''}${selectedAgentEffort ? ` / ${selectedAgentEffort}` : ''}`}
              aria-label={`当前 Agent：${selectedAgentOption?.name ?? selectedAgent}${selectedAgentModel ? ` ${agentModelLabel(selectedAgentModel)}` : ''}${selectedAgentEffort ? ` ${selectedAgentEffort}` : ''}`}
            >
              <AgentIcon agentName={selectedAgentOption?.name ?? selectedAgent} className="size-3.5 shrink-0" />
              <span className="truncate font-medium text-foreground">
                {selectedAgentModel ? agentModelLabel(selectedAgentModel) : selectedAgentOption?.name ?? selectedAgent}
              </span>
              {selectedAgentEffort ? <span className="shrink-0 font-medium lowercase text-muted-foreground">{selectedAgentEffort}</span> : null}
            </button>
            {agentMenuOpen ? (
              <AgentSelectorCard
                agents={agents}
                selectedAgent={selectedAgent}
                agentPanels={agentPanels}
                onSelectAgent={onSelectAgent}
                onSelectModel={onSelectAgentModel}
                onSelectEffort={onSelectAgentEffort}
                onSelectFastMode={onSelectAgentFastMode}
              />
            ) : null}
          </div>
          <Button className="h-8 rounded-full px-3 text-sm" onClick={onExecute} disabled={executeSubmitting}>
            <SquareTerminal className="size-3.5" />
            开始执行
          </Button>
        </div>
      </div>
    </div>
  )
}

function AgentSelectorCard({
  agents,
  selectedAgent,
  agentPanels,
  onSelectAgent,
  onSelectModel,
  onSelectEffort,
  onSelectFastMode,
}: {
  agents: AgentStatus[]
  selectedAgent: AgentOptionId
  agentPanels: Record<AgentOptionId, AgentPanelState>
  onSelectAgent: (agentId: AgentOptionId) => void
  onSelectModel: (agentId: AgentOptionId, modelId: string) => void
  onSelectEffort: (agentId: AgentOptionId, effort: string) => void
  onSelectFastMode: (agentId: AgentOptionId, fastMode: FastMode) => void
}) {
  const [panelAgent, setPanelAgent] = useState<AgentOptionId>(selectedAgent)
  const [expandedSection, setExpandedSection] = useState<'models' | 'effort' | 'fast'>('models')
  const [openIssueAgent, setOpenIssueAgent] = useState<AgentOptionId | ''>('')

  useEffect(() => {
    const nextAgent = agentStatusByName(agents, selectedAgent)?.name ?? preferredAgentName(agents, selectedAgent)
    setPanelAgent(nextAgent)
    setExpandedSection('models')
    setOpenIssueAgent('')
  }, [agents, selectedAgent])

  const panelOption = agentStatusByName(agents, panelAgent)

  if (!panelOption) {
    return (
      <div className="absolute right-0 top-[calc(100%+8px)] z-30 flex w-[300px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border border-border/80 bg-popover shadow-[0_16px_40px_rgba(15,23,42,0.18)]">
        <div className="w-full px-4 py-5 text-sm text-muted-foreground">加载 Agent 中...</div>
      </div>
    )
  }

  const panelState = agentPanels[panelAgent] ?? defaultAgentPanelState(panelOption)
  const selectedModel = agentModelOptionById(panelOption, panelState.modelId) ?? panelOption.models?.[0] ?? null
  const currentEffort = panelState.effort || panelOption.default_effort || ''
  const currentFastMode = panelState.fastMode ?? normalizeFastMode(panelOption.default_fast_service)
  const panelModels = panelOption.models ?? []
  const panelEfforts = panelOption.efforts ?? []

  return (
    <div className="absolute right-0 top-[calc(100%+8px)] z-30 flex w-[432px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border border-border/80 bg-popover shadow-[0_16px_40px_rgba(15,23,42,0.18)]">
      <div className="w-[170px] border-r border-border/70 bg-background/95 px-0 py-2">
        <div className="px-4 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Agent</div>
        <div className="space-y-0.5">
          {agents.map((agent) => {
            const active = agent.name === panelAgent
            const issue = agentIssueReason(agent)
            return (
              <div
                key={agent.name}
                className={cn('flex items-center gap-1 px-2', active ? 'bg-primary/8 text-primary' : 'text-foreground')}
              >
                <button
                  type="button"
                  onClick={() => {
                    setPanelAgent(agent.name)
                    onSelectAgent(agent.name)
                    setExpandedSection('models')
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left text-sm"
                >
                  <AgentIcon agentName={agent.name} className="size-4" />
                  <span className="min-w-0 flex-1 font-medium">{agent.name}</span>
                </button>
                {issue ? (
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        setOpenIssueAgent((current) => (current === agent.name ? '' : agent.name))
                      }}
                      className="inline-flex size-7 items-center justify-center rounded-lg text-amber-500 hover:bg-amber-500/10"
                      aria-label={`查看 ${agent.name} 异常原因`}
                    >
                      <CircleHelp className="size-3.5" />
                    </button>
                    {openIssueAgent === agent.name ? (
                      <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-[220px] rounded-xl border border-border bg-popover p-2.5 text-[12px] leading-5 text-popover-foreground shadow-[0_12px_30px_rgba(15,23,42,0.14)]">
                        {issue}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setPanelAgent(agent.name)
                    onSelectAgent(agent.name)
                    setExpandedSection('models')
                    setOpenIssueAgent('')
                  }}
                  className={cn(
                    'inline-flex size-7 shrink-0 items-center justify-center rounded-lg',
                    active ? 'text-primary' : 'text-muted-foreground hover:bg-muted/40',
                  )}
                  aria-label={`查看 ${agent.name} 模型信息`}
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex min-h-[260px] min-w-0 flex-1 flex-col bg-background/98">
        <div className="max-h-[336px] overflow-y-auto">
          <AgentSectionHeader
            label="模型"
            value={selectedModel ? agentModelLabel(selectedModel) : ''}
            expanded={expandedSection === 'models'}
            onToggle={() => setExpandedSection('models')}
            accent
          />
          {expandedSection === 'models'
            ? panelModels.map((model) => {
                const active = model.id === panelState.modelId
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => onSelectModel(panelAgent, model.id)}
                    className={cn(
                      'block w-full border-b border-border/60 px-4 py-3 text-left transition-colors',
                      active ? 'bg-primary/10 text-primary' : 'hover:bg-muted/35',
                    )}
                  >
                    <div className="text-[13px] font-medium leading-5">{agentModelLabel(model)}</div>
                    <div
                      className={cn(
                        'mt-0.5 whitespace-normal text-[12px] leading-4',
                        active ? 'text-primary/80' : 'text-muted-foreground',
                      )}
                    >
                      {model.description ?? ''}
                    </div>
                  </button>
                )
              })
            : null}

          {panelEfforts.length ? (
            <>
              <AgentSectionHeader
                label="思考等级"
                value={currentEffort}
                expanded={expandedSection === 'effort'}
                onToggle={() => setExpandedSection('effort')}
              />
              {expandedSection === 'effort'
                ? panelEfforts.map((item, index) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => onSelectEffort(panelAgent, item)}
                      className={cn(
                        'block w-full px-4 py-3 text-left text-[13px] font-medium capitalize transition-colors',
                        index > 0 ? 'border-t border-border/60' : '',
                        item === currentEffort ? 'bg-primary/10 text-primary' : 'hover:bg-muted/35',
                      )}
                    >
                      {item}
                    </button>
                  ))
                : null}
            </>
          ) : null}

          {panelOption.supports_fast_service ? (
            <>
              <AgentSectionHeader
                label="FAST 模式"
                value={currentFastMode === 'on' ? '开启' : '关闭'}
                expanded={expandedSection === 'fast'}
                onToggle={() => setExpandedSection('fast')}
              />
              {expandedSection === 'fast' ? (
                <>
                  {(['off', 'on'] as const).map((item, index) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => onSelectFastMode(panelAgent, item)}
                      className={cn(
                        'block w-full px-4 py-3 text-left text-[13px] font-medium transition-colors',
                        index > 0 ? 'border-t border-border/60' : '',
                        item === currentFastMode ? 'bg-primary/10 text-primary' : 'hover:bg-muted/35',
                      )}
                    >
                      {item === 'on' ? '开启' : '关闭'}
                    </button>
                  ))}
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function AgentIcon({ agentName, className }: { agentName: string; className?: string }) {
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    setLoadFailed(false)
  }, [agentName])

  const normalizedName = agentName.trim().toLowerCase()
  if (!normalizedName || loadFailed) {
    return <Bot className={cn('shrink-0 text-muted-foreground', className)} />
  }

  return (
    <img
      src={`/assets/agents/${normalizedName}.svg`}
      alt={agentName}
      className={cn('shrink-0', className)}
      onError={() => setLoadFailed(true)}
    />
  )
}

function AgentSectionHeader({
  label,
  value,
  expanded,
  onToggle,
  accent = false,
}: {
  label: string
  value: string
  expanded: boolean
  onToggle: () => void
  accent?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex w-full items-center justify-between gap-3 border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-muted/35',
        expanded ? 'bg-primary/10' : '',
      )}
    >
      <span className={cn('text-[12px] font-semibold tracking-[0.12em]', accent || expanded ? 'text-primary' : 'text-foreground')}>
        {label}
      </span>
      <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
        <span className="truncate">{value}</span>
        <ChevronRight className={cn('size-3.5 transition-transform', expanded ? 'rotate-90' : '')} />
      </span>
    </button>
  )
}

function MindfsStyleRepoPicker({
  browser,
  repoSaving,
  bindLabel,
  onSelect,
  onNavigate,
  onBind,
}: {
  browser: LocalDirBrowserState
  repoSaving: boolean
  bindLabel: string
  onSelect: (path: string) => void
  onNavigate: (path?: string) => void
  onBind: () => void
}) {
  const bindDisabled = !browser.selectedPath || repoSaving
  const showingDriveRootList = !browser.path

  return (
    <div className="space-y-2.5">
      <DriveSwitcher drives={browser.drives} currentPath={browser.path} onNavigate={onNavigate} />
      <PathBreadcrumb path={browser.path} onNavigate={onNavigate} />

      <div className="flex max-h-60 flex-col overflow-auto">
        {browser.loading ? <div className="px-2.5 py-2 text-xs text-muted-foreground">加载中...</div> : null}
        {!browser.loading && browser.error ? <div className="px-2.5 py-2 text-xs text-warning">{browser.error}</div> : null}
        {!browser.loading && !browser.error && showingDriveRootList ? (
          <div className="px-2.5 py-2 text-xs text-muted-foreground">请选择上方盘符后再进入目录。</div>
        ) : null}
        {!browser.loading && !browser.error && !showingDriveRootList && browser.items.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-muted-foreground">当前目录为空</div>
        ) : null}
        {!browser.loading &&
          !browser.error &&
          !showingDriveRootList &&
          browser.items.map((item) => {
            const selected = browser.selectedPath === item.path
            return (
              <div key={item.path} className="flex items-center gap-1.5 rounded-lg">
                <button
                  type="button"
                  onClick={() => onSelect(item.path)}
                  className={cn(
                    'min-w-0 flex-1 rounded-lg border border-transparent px-2.5 py-2 text-left text-xs text-foreground',
                    selected ? 'bg-primary/10 font-semibold text-primary' : 'hover:bg-muted/40',
                  )}
                  title={item.path}
                >
                  <span className="block truncate">{item.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate(item.path)}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/40"
                  title={`进入 ${item.name}`}
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
            )
          })}
      </div>

      <button
        type="button"
        disabled={bindDisabled}
        onClick={onBind}
        className={cn(
          'w-full rounded-lg px-2.5 py-2 text-xs font-semibold text-white',
          bindDisabled ? 'cursor-not-allowed bg-primary/65' : 'bg-primary hover:opacity-90',
        )}
      >
        {repoSaving ? '处理中...' : bindLabel}
      </button>
    </div>
  )
}

function DriveSwitcher({
  drives,
  currentPath,
  onNavigate,
}: {
  drives: LocalDirItem[]
  currentPath: string
  onNavigate: (path?: string) => void
}) {
  if (!drives.length) {
    return null
  }

  const currentDrive = driveRootFromPath(currentPath)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {drives.map((drive) => {
        const active = currentDrive === drive.path
        return (
          <button
            key={drive.path}
            type="button"
            onClick={() => onNavigate(drive.path)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border bg-background text-muted-foreground hover:text-foreground',
            )}
          >
            {drive.name}
          </button>
        )
      })}
    </div>
  )
}

function PathBreadcrumb({
  path,
  onNavigate,
}: {
  path: string
  onNavigate: (path?: string) => void
}) {
  const segments = splitPathSegments(path)
  if (!path.trim()) {
    return (
      <div className="min-h-5 text-xs text-muted-foreground">请选择盘符</div>
    )
  }

  const visibleSegments = /^[A-Za-z]:\\$/.test(segments[0] ?? '') ? segments.slice(1) : segments
  if (!visibleSegments.length) {
    return <div className="min-h-5 text-xs text-muted-foreground">根目录</div>
  }

  const hiddenCount = Math.max(0, visibleSegments.length - 3)
  const shownSegments = hiddenCount > 0 ? visibleSegments.slice(-3) : visibleSegments
  const driveRoot = driveRootFromPath(path)

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
      {hiddenCount > 0 ? (
        <>
          <button
            type="button"
            onClick={() => onNavigate(buildPathFromSegments(visibleSegments.slice(0, hiddenCount), driveRoot))}
            className="text-muted-foreground hover:text-foreground"
          >
            ...
          </button>
          <span className="text-muted-foreground">&gt;</span>
        </>
      ) : null}
      {shownSegments.map((segment, index) => {
        const absoluteIndex = hiddenCount + index
        const segmentPath = buildPathFromSegments(visibleSegments.slice(0, absoluteIndex + 1), driveRoot)
        const isLast = index === shownSegments.length - 1
        return (
          <div key={`${segmentPath}-${segment}`} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onNavigate(segmentPath)}
              className={cn('truncate', isLast ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground')}
              title={segmentPath}
            >
              {segment}
            </button>
            {!isLast ? <span className="text-muted-foreground">&gt;</span> : null}
          </div>
        )
      })}
    </div>
  )
}

function splitPathSegments(path: string) {
  const normalized = path.replace(/\//g, '\\').trim()
  if (!normalized) {
    return []
  }

  const driveMatch = /^[A-Za-z]:\\/.exec(normalized)
  if (driveMatch) {
    const drive = normalized.slice(0, 3)
    const rest = normalized.slice(3).split('\\').filter(Boolean)
    return [drive, ...rest]
  }

  if (normalized.startsWith('\\')) {
    return normalized.split('\\').filter(Boolean)
  }

  return normalized.split('\\').filter(Boolean)
}

function driveRootFromPath(path: string) {
  const normalized = path.replace(/\//g, '\\').trim()
  const match = /^[A-Za-z]:\\/.exec(normalized)
  return match ? normalized.slice(0, 3) : ''
}

function buildPathFromSegments(segments: string[], driveRoot = '') {
  if (driveRoot) {
    return segments.length ? `${driveRoot}${segments.join('\\')}` : driveRoot
  }
  if (!segments.length) {
    return undefined
  }
  return `\\${segments.join('\\')}`
}

function StageBranchColumn({
  title,
  task,
  stages,
  users,
  selectedStage,
  onSelect,
}: {
  title: string
  task: TaskView
  stages: StageView[]
  users: { id: string; name: string }[]
  selectedStage: StageView
  onSelect: (value: string) => void
}) {
  return (
    <div className="rounded-[18px] border border-sidebar-border/70 bg-card/35 p-2">
      <div className="mb-2 px-1 text-center text-[11px] font-medium tracking-[0.18em] text-muted-foreground">{title}</div>
      <div className="space-y-2">
        {stages.map((stage) => (
          <StageNavButton
            key={stageKey(stage)}
            task={task}
            stage={stage}
            users={users}
            selected={stageKey(stage) === stageKey(selectedStage)}
            compact
            onSelect={() => onSelect(stageKey(stage))}
          />
        ))}
      </div>
    </div>
  )
}

function StageNavButton({
  task,
  stage,
  users,
  selected,
  compact = false,
  onSelect,
}: {
  task: TaskView
  stage: StageView
  users: { id: string; name: string }[]
  selected: boolean
  compact?: boolean
  onSelect: () => void
}) {
  const Icon = stageIcons[stage.key]
  const badge = stageBadge(task, stage)
  const actionable = isStageActionable(stage)
  const reachable = isStageReachable(task, stage)
  const splitMetaLines = stage.branch !== 'shared'
  const ownerName = stageOwnerName(task, stage, users)

  if (compact) {
    return (
      <button
        type="button"
        className={cn(
          'w-full rounded-[18px] border px-3 py-3 text-left transition-colors',
          selected
            ? actionable
              ? 'border-warning/50 bg-warning/10 ring-1 ring-primary/20'
              : 'border-primary/40 bg-background'
            : actionable
              ? 'border-warning/35 bg-warning/8 hover:bg-warning/10'
              : 'border-sidebar-border/70 bg-background hover:border-sidebar-border',
        )}
        onClick={onSelect}
      >
        <div className="flex min-h-[104px] flex-col">
          <div className="flex items-center justify-between gap-2">
            <div
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg border',
                selected ? 'border-primary/30 bg-primary/10 text-primary' : 'border-sidebar-border bg-card',
              )}
            >
              <Icon className="size-4" />
            </div>
            <Badge variant={badge.variant} className="h-6 shrink-0 px-2 text-[11px]">
              {badge.label}
            </Badge>
          </div>

          <p className="mt-3 text-[14px] font-semibold leading-5 text-foreground">{compactStageLabel(stage)}</p>

          <p className="mt-1 truncate text-xs text-muted-foreground">{ownerName}</p>

          {splitMetaLines ? (
            <>
              <div className="mt-2 text-xs text-muted-foreground">Run {stage.runCount}</div>
              <div className="mt-1 text-xs text-muted-foreground">{reachable ? formatDateTime(stage.updatedAt) : '\u00A0'}</div>
            </>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground">
              Run {stage.runCount}
              {reachable ? ` · ${formatDateTime(stage.updatedAt)}` : ''}
            </div>
          )}

          <div className="mt-auto pt-1" />
        </div>
      </button>
    )
  }

  return (
    <button
      type="button"
      className={cn(
        'w-full rounded-[18px] border px-2.5 py-2 text-left transition-colors',
        selected
          ? actionable
            ? 'border-warning/50 bg-warning/10 ring-1 ring-primary/20'
            : 'border-primary/40 bg-background'
          : actionable
            ? 'border-warning/35 bg-warning/8 hover:bg-warning/10'
            : 'border-sidebar-border/70 bg-background hover:border-sidebar-border',
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'mt-0.5 flex size-10 items-center justify-center rounded-lg border',
            selected ? 'border-primary/30 bg-primary/10 text-primary' : 'border-sidebar-border bg-card',
          )}
        >
          <Icon className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium">{stage.name}</p>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{ownerName}</p>
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {stage.branch !== 'shared' ? <span>{branchLabel(stage.branch)}</span> : null}
            <span>Run {stage.runCount}</span>
            {!splitMetaLines && reachable ? <span>·</span> : null}
            {!splitMetaLines && reachable ? <span>{formatDateTime(stage.updatedAt)}</span> : null}
          </p>
          {splitMetaLines ? <p className="mt-1 text-xs text-muted-foreground">{reachable ? formatDateTime(stage.updatedAt) : '\u00A0'}</p> : null}
        </div>
      </div>
    </button>
  )
}

function ClarificationPanel({
  clarifications,
  drafts,
  savingId,
  canConfirm,
  onDraftChange,
  onConfirm,
}: {
  clarifications: ClarificationView[]
  drafts: Record<string, ClarificationDraft>
  savingId: string
  canConfirm: boolean
  onDraftChange: (clarificationId: string, patch: Partial<ClarificationDraft>) => void
  onConfirm: (clarification: ClarificationView) => void
}) {
  return (
    <Card className="rounded-[18px]">
      <CardHeader>
        <CardTitle>问题澄清</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {clarifications.length ? (
          clarifications.map((clarification) => {
            const draft = drafts[clarification.id]
            const confirmed = clarification.status === 'confirmed'

            return (
              <div key={clarification.id} className="rounded-[14px] border border-border bg-muted/25 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {clarification.seq + 1}. {clarification.question}
                    </p>
                    {confirmed ? (
                      <p className="mt-2 text-sm text-muted-foreground">已确认：{clarification.answer}</p>
                    ) : !canConfirm ? (
                      <p className="mt-2 text-sm text-muted-foreground">待对应产品经理确认。</p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        <select
                          className="flex h-10 w-full rounded-[10px] border border-input bg-background px-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                          value={draft?.option ?? ''}
                          onChange={(event) => onDraftChange(clarification.id, { option: event.target.value })}
                        >
                          {clarification.options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                        <Textarea
                          className="min-h-[20px]"
                          placeholder="如果以上选项都不合适，可填写自定义答案。"
                          value={draft?.freeform ?? ''}
                          onChange={(event) => onDraftChange(clarification.id, { freeform: event.target.value })}
                        />
                      </div>
                    )}
                  </div>
                  <Badge variant={confirmed ? 'success' : 'warning'}>{confirmed ? '已确认' : '待确认'}</Badge>
                </div>

                {!confirmed && canConfirm ? (
                  <div className="mt-2.5 flex justify-end">
                    <Button
                      className="h-9 rounded-lg px-3.5"
                      onClick={() => onConfirm(clarification)}
                      disabled={savingId === clarification.id}
                    >
                      确认答案
                    </Button>
                  </div>
                ) : null}
              </div>
            )
          })
        ) : (
          <EmptyHint>当前阶段暂无问题澄清。</EmptyHint>
        )}
      </CardContent>
    </Card>
  )
}

function StageArtifactView({
  task,
  stage,
  users,
  currentUserId,
  bugActionPendingId,
  bugActionError,
  onMarkTestingBugFixed,
  onCloseTestingBug,
}: {
  task: TaskView
  stage: StageView
  users: { id: string; name: string }[]
  currentUserId: string
  bugActionPendingId: string
  bugActionError: string | null
  onMarkTestingBugFixed: (bugId: string) => void
  onCloseTestingBug: (bugId: string) => void
}) {
  if (stage.key === 'projectContext') {
    const artifact = (stage.artifact && typeof stage.artifact === 'object' ? stage.artifact : {}) as {
      summary?: string
      items?: Array<{ scope?: string; category?: string; title?: string; content?: string }>
    }

    return (
      <div className="space-y-3">
        <Card className="rounded-[18px]">
          <CardHeader>
            <CardTitle>项目上下文快照</CardTitle>
            <CardDescription>{artifact.summary || stage.summary || '项目上下文刷新完成后，这里会展示最新快照摘要。'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(artifact.items ?? []).length ? (
              artifact.items!.map((item, index) => (
                <div key={`${item.scope ?? 'shared'}-${item.category ?? 'memory'}-${index}`} className="rounded-[18px] border border-border bg-muted/20 p-4">
                  <div className="text-sm font-medium">{item.title || '未命名条目'}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{item.scope || 'shared'} · {item.category || 'memory'}</div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.content || '暂无内容'}</p>
                </div>
              ))
            ) : (
              <EmptyHint>当前还没有项目记忆条目。</EmptyHint>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  if (stage.key === 'requirement') {
    const artifact = requirementArtifact(stage.artifact)

    return (
      <div className="space-y-3">
        <div className="grid gap-3 xl:grid-cols-[1.2fr_1fr]">
          <Card className="rounded-[18px]">
            <CardHeader>
              <CardTitle>需求摘要</CardTitle>
              <CardDescription>{stage.summary || '尚未生成需求摘要。'}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-7 text-muted-foreground">{artifact.summary || task.description}</p>
            </CardContent>
          </Card>
          <Card className="rounded-[18px]">
            <CardHeader>
              <CardTitle>关键风险</CardTitle>
              <CardDescription>优先暴露会影响设计与开发判断的风险。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {artifact.risks.length ? (
                artifact.risks.map((risk) => (
                  <div key={risk} className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
                    {risk}
                  </div>
                ))
              ) : (
                <EmptyHint>执行后这里会生成风险列表。</EmptyHint>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-3 xl:grid-cols-2">
          <Card className="rounded-[18px]">
            <CardHeader>
              <CardTitle>验收标准</CardTitle>
              <CardDescription>直接供设计、开发、验证阶段消费。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {artifact.acceptance.length ? (
                artifact.acceptance.map((criterion) => (
                  <div key={criterion} className="rounded-[18px] border border-border px-4 py-3 text-sm text-muted-foreground">
                    {criterion}
                  </div>
                ))
              ) : (
                <EmptyHint>执行后这里会生成验收标准。</EmptyHint>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-[18px]">
            <CardHeader>
              <CardTitle>影响范围</CardTitle>
              <CardDescription>标注本轮变更主要影响的系统范围。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <SnapshotLine label="影响面" value={artifact.impactScope || '待生成'} />
              <SnapshotLine label="已确认问题澄清" value={`${task.clarifications.filter((item) => item.status === 'confirmed').length} 条`} />
              <SnapshotLine label="待确认问题澄清" value={`${task.clarifications.filter((item) => item.status !== 'confirmed').length} 条`} />
            </CardContent>
          </Card>
        </div>

        <Card className="rounded-[24px]">
          <CardHeader>
            <CardTitle>需求文档</CardTitle>
            <CardDescription>补充需求与问题澄清确认结果会持续拼接到这里。</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{artifact.fullDoc || '尚未生成需求文档。'}</pre>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (stage.key === 'design') {
    const artifact = designArtifact(stage.artifact)

    return (
      <div className="space-y-3">
        <Card className="rounded-[18px]">
          <CardHeader>
            <CardTitle>设计摘要</CardTitle>
            <CardDescription>{stage.summary || '尚未生成详细设计。'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <ArtifactSection title="前端设计" content={artifact.frontendDesign} />
            <ArtifactSection title="后端设计" content={artifact.backendDesign} />
            <ArtifactSection title="接口文档" content={artifact.apiDoc} />
            <ArtifactSection title="测试用例" content={artifact.testCases} />
          </CardContent>
        </Card>

        {artifact.supplements.length ? (
          <Card className="rounded-[18px]">
            <CardHeader>
              <CardTitle>设计补充记录</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {artifact.supplements.map((item) => (
                <div key={item} className="rounded-lg border border-border bg-muted/25 px-4 py-3 text-sm text-muted-foreground">
                  {item}
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>
    )
  }

  if (stage.key === 'development') {
    const artifact = developmentArtifact(stage.artifact)

    return (
      <Card className="rounded-[18px]">
        <CardHeader>
          <CardTitle>开发产物</CardTitle>
          <CardDescription>{stage.summary || '开发执行完成后，这里会展示代码改动摘要。'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ArtifactSection title="变更摘要" content={artifact.changes} />
          <FileListSection title="新增文件" items={artifact.addedFiles} />
          <FileListSection title="修改文件" items={artifact.modifiedFiles} />
        </CardContent>
      </Card>
    )
  }

  if (stage.key === 'review') {
    const artifact = reviewArtifact(stage.artifact)

    return (
      <div className="space-y-3">
        <Card className="rounded-[18px]">
          <CardHeader>
            <CardTitle>审查摘要</CardTitle>
            <CardDescription>{stage.summary || '代码审查执行后，这里会展示风险分级。'}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 xl:grid-cols-3">
            <SnapshotLine label="高危" value={`${artifact.high}`} />
            <SnapshotLine label="中危" value={`${artifact.medium}`} />
            <SnapshotLine label="低危" value={`${artifact.low}`} />
          </CardContent>
        </Card>

        <Card className="rounded-[18px]">
          <CardHeader>
            <CardTitle>问题列表</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {artifact.issues.length ? (
              artifact.issues.map((issue) => (
                <div key={`${issue.level}-${issue.file}-${issue.title}`} className="rounded-[18px] border border-border bg-muted/25 p-4">
                  <div className="flex items-center gap-2">
                    <Badge variant={issue.level === 'high' ? 'destructive' : issue.level === 'medium' ? 'warning' : 'secondary'}>
                      {reviewLevelLabel(issue.level)}
                    </Badge>
                    <p className="text-sm font-medium">{issue.title}</p>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{issue.file}</p>
                </div>
              ))
            ) : (
              <EmptyHint>执行后这里会生成风险问题明细。</EmptyHint>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  if (stage.key === 'verification') {
    const artifact = verificationArtifact(stage.artifact)
    const rejections = stage.verificationHistory.filter((record) => record.result === 'reject')
    const rejectionsLatestFirst = [...rejections].reverse()
    return (
      <div className="space-y-3">
        <Card className="rounded-[18px]">
          <CardHeader>
            <CardTitle>功能验证</CardTitle>
            <CardDescription>{artifact.summary || '该阶段由人工确认是否通过, 驳回会回流到对应开发分支。'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 xl:grid-cols-3">
              <SnapshotLine label="阶段状态" value={stageBadge(task, stage).label} />
              <SnapshotLine label="分支" value={branchLabel(stage.branch)} />
              <SnapshotLine label="验证结果" value={artifact.verificationResult || '待验证'} />
            </div>
            <ArtifactSection title="关键结论" content={artifact.keyConclusions.join('\n')} />
            <ArtifactSection title="下游输入" content={artifact.downstreamInputs.join('\n')} />
            <ArtifactSection title="验证范围" content={artifact.verificationScope.join('\n')} />
            <ArtifactSection title="验证依据" content={artifact.passBasis || artifact.rejectionReason || stage.pendingNote || '通过后进入代码审查，驳回时需填写原因。'} />
          </CardContent>
        </Card>

        <Card className="rounded-[18px]">
          <CardHeader>
            <CardTitle>驳回记录</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {rejectionsLatestFirst.length ? (
              rejectionsLatestFirst.map((record, index) => (
                <div key={record.id} className="rounded-[14px] border border-border bg-muted/30 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="destructive">第 {rejectionsLatestFirst.length - index} 次驳回</Badge>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">{record.reason}</p>
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      <p>{userName(record.operatorId, users)}</p>
                      <p className="mt-1">{formatDateTime(record.createdAt)}</p>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <EmptyHint>暂无驳回记录。</EmptyHint>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  if (stage.key === 'testing') {
    const artifact = testingArtifact(stage.artifact)
    return (
      <div className="space-y-3">
        <Card className="rounded-[18px]">
          <CardHeader>
            <CardTitle>测试阶段</CardTitle>
            <CardDescription>{artifact.summary || '测试环境联调、提 Bug、回归与测试结论统一在这里完成。'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <SnapshotLine label="阶段状态" value={stageBadge(task, stage).label} />
            <SnapshotLine label="测试负责人" value={userName(task.testerId, users)} />
            <SnapshotLine
              label="未关闭 Bug"
              value={`${stage.testingBugs.filter((bug) => bug.status !== 'closed').length} 条`}
            />
            <p className="text-sm text-muted-foreground">{stage.pendingNote || artifact.testConclusion || '当前暂无测试说明。'}</p>
          </CardContent>
        </Card>

        <Card className="rounded-[18px]">
          <CardHeader>
            <CardTitle>测试报告</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <ArtifactSection title="关键结论" content={artifact.keyConclusions.join('\n')} />
            <ArtifactSection title="下游输入" content={artifact.downstreamInputs.join('\n')} />
            <ArtifactSection title="测试范围" content={artifact.testScope.join('\n')} />
            <ArtifactSection title="执行结果" content={artifact.executionResult} />
            <ArtifactSection title="Bug 汇总" content={artifact.bugSummary} />
            <ArtifactSection title="回归结论" content={artifact.regressionConclusion} />
            <ArtifactSection title="测试结论" content={artifact.testConclusion} />
          </CardContent>
        </Card>

        <Card className="rounded-[18px]">
          <CardHeader>
            <CardTitle>Bug 列表</CardTitle>
            <CardDescription>保留全部历史记录，未关闭项优先展示。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {stage.testingBugs.length ? (
              stage.testingBugs.map((bug) => (
                <div key={bug.id} className="rounded-[18px] border border-border bg-muted/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={bug.status === 'open' ? 'destructive' : bug.status === 'fixed' ? 'warning' : 'success'}>
                          Bug #{bug.seq}
                        </Badge>
                        <Badge variant="outline">{testingBugTargetLabel(bug.target)}</Badge>
                        <Badge variant={bug.status === 'open' ? 'destructive' : bug.status === 'fixed' ? 'warning' : 'success'}>
                          {testingBugStatusLabel(bug.status)}
                        </Badge>
                        {bug.target === 'both' ? (
                          <Badge variant="secondary">
                            FE {bug.frontendFixed ? '已修' : '未修'} / BE {bug.backendFixed ? '已修' : '未修'}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-3 text-sm leading-6 text-muted-foreground">{bug.detail}</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        提交人：{userName(bug.reporterId, users)} · {formatDateTime(bug.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {canMarkTestingBugFixed(task, bug, currentUserId) ? (
                        <Button
                          variant="outline"
                          className="h-8 rounded-lg px-3 text-xs"
                          disabled={bugActionPendingId === `fix:${bug.id}`}
                          onClick={() => onMarkTestingBugFixed(bug.id)}
                        >
                          标记已修复
                        </Button>
                      ) : null}
                      {canCloseTestingBug(task, stage, bug, currentUserId) ? (
                        <Button
                          className="h-8 rounded-lg px-3 text-xs"
                          disabled={bugActionPendingId === `close:${bug.id}`}
                          onClick={() => onCloseTestingBug(bug.id)}
                        >
                          回归关闭
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <EmptyHint>测试阶段暂无 Bug，回归通过后可直接测试通过。</EmptyHint>
            )}
            {bugActionError ? <p className="text-sm text-destructive">{bugActionError}</p> : null}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    (() => {
      const artifact = deliveryArtifact(stage.artifact)
      return (
        <Card className="rounded-[18px]">
          <CardHeader>
            <CardTitle>交付沉淀</CardTitle>
            <CardDescription>{artifact.summary || '测试通过后，进入最终交付与沉淀。'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <SnapshotLine label="前端仓库" value={formatRepoBinding(task.frontendRepo)} />
            <SnapshotLine label="后端仓库" value={formatRepoBinding(task.backendRepo)} />
            <ArtifactSection title="关键结论" content={artifact.keyConclusions.join('\n')} />
            <ArtifactSection title="下游输入" content={artifact.downstreamInputs.join('\n')} />
            <ArtifactSection title="交付清单" content={artifact.deliveryItems.join('\n')} />
            <ArtifactSection title="上线说明" content={artifact.releaseNotes} />
            <ArtifactSection title="回滚方案" content={artifact.rollbackPlan} />
            <ArtifactSection title="沉淀结论" content={artifact.handoffConclusion} />
          </CardContent>
        </Card>
      )
    })()
  )
}

function ProcessTimelineCard({ events, running }: { events: ProcessEvent[]; running: boolean }) {
  return (
    <Card className="rounded-[18px]">
      <CardHeader>
        <CardTitle>执行过程</CardTitle>
        <CardDescription>{running ? 'Agent 正在持续输出过程事件。' : '仅当前执行人可见，完成后保留本轮过程快照。'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {events.length ? (
          events.map((event) => (
            <div key={`${event.order}-${event.title}`} className="rounded-[18px] border border-border bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={event.type === 'tool' ? 'default' : event.type === 'thought' ? 'warning' : 'secondary'}>
                    {processTypeLabel(event.type)}
                  </Badge>
                  <p className="text-sm font-medium">{event.title}</p>
                </div>
                <span className="text-xs text-muted-foreground">#{event.order + 1}</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{event.content}</p>
              {event.tool ? (
                <div className="mt-3 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                  {event.tool.name} · {event.tool.status} · {event.tool.detail}
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <EmptyHint>当前阶段还没有可见的执行过程。</EmptyHint>
        )}
      </CardContent>
    </Card>
  )
}

function ActionDialog({
  dialog,
  stage,
  note,
  setNote,
  impact,
  setImpact,
  reenterDesign,
  setReenterDesign,
  rollbackTarget,
  setRollbackTarget,
  reflowLevels,
  setReflowLevels,
  actionSubmitting,
  actionError,
  onClose,
  onConfirm,
}: {
  dialog: ActionDialogState
  stage: StageView
  note: string
  setNote: (value: string) => void
  impact: Impact
  setImpact: (value: Impact) => void
  reenterDesign: boolean
  setReenterDesign: (value: boolean) => void
  rollbackTarget: string
  setRollbackTarget: (value: string) => void
  reflowLevels: ReviewLevel[]
  setReflowLevels: (value: ReviewLevel[]) => void
  actionSubmitting: boolean
  actionError: string | null
  onClose: () => void
  onConfirm: () => void
}) {
  const config = getDialogConfig(dialog.type, stage)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      <Card className="w-full max-w-lg rounded-[22px] shadow-xl">
        <CardHeader>
          <CardTitle>{config.title}</CardTitle>
          <CardDescription>{config.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {dialog.type === 'supplement-requirement' ? (
            <>
              <label className="block space-y-2">
                <span className="text-sm font-medium">影响范围</span>
                <select
                  className="flex h-11 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                  value={impact}
                  onChange={(event) => setImpact(event.target.value as Impact)}
                >
                  <option value="frontend">前端</option>
                  <option value="backend">后端</option>
                  <option value="both">前后端</option>
                </select>
              </label>

              <label className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm">
                <input
                  type="checkbox"
                  checked={reenterDesign}
                  onChange={(event) => setReenterDesign(event.target.checked)}
                />
                <span>重新进入详细设计</span>
              </label>
            </>
          ) : null}

          {dialog.type === 'rollback' ? (
            <label className="block space-y-2">
              <span className="text-sm font-medium">回退目标</span>
              <select
                className="flex h-11 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                value={rollbackTarget}
                onChange={(event) => setRollbackTarget(event.target.value)}
              >
                <option value="requirement">需求理解</option>
                <option value="design">详细设计</option>
                <option value="frontend">前端开发</option>
                <option value="backend">后端开发</option>
              </select>
            </label>
          ) : null}

          {dialog.type === 'review-reflow' ? (
            <div className="space-y-2">
              <span className="text-sm font-medium">回流风险级别</span>
              {(['high', 'medium', 'low'] as ReviewLevel[]).map((level) => {
                const checked = reflowLevels.includes(level)
                return (
                  <label key={level} className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) =>
                        setReflowLevels(
                          event.target.checked
                            ? [...reflowLevels, level]
                            : reflowLevels.filter((item) => item !== level),
                        )
                      }
                    />
                    <span>{reviewLevelLabel(level)}</span>
                  </label>
                )
              })}
            </div>
          ) : null}

          {dialog.type === 'report-bug' ? (
            <label className="block space-y-2">
              <span className="text-sm font-medium">Bug 归属</span>
              <select
                className="flex h-11 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                value={impact}
                onChange={(event) => setImpact(event.target.value as Impact)}
              >
                <option value="frontend">前端</option>
                <option value="backend">后端</option>
                <option value="both">前后端</option>
              </select>
            </label>
          ) : null}

          {config.noteLabel ? (
            <label className="block space-y-2">
              <span className="text-sm font-medium">{config.noteLabel}</span>
              <Textarea
                className="min-h-[132px]"
                placeholder={config.notePlaceholder}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          ) : null}

          {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}

          <div className="flex items-center justify-end gap-3">
            <Button variant="outline" className="rounded-xl" onClick={onClose} disabled={actionSubmitting}>
              取消
            </Button>
            <Button variant={config.confirmVariant} className="rounded-xl" onClick={onConfirm} disabled={actionSubmitting}>
              {config.confirmLabel}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function TimelineCard({ event, actorName }: { event: TimelineView; actorName: string }) {
  return (
    <div className="rounded-[18px] border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant={timelineBadgeVariant(event.kind)}>{timelineBadgeLabel(event.kind)}</Badge>
            <p className="text-sm font-medium">{event.title}</p>
          </div>
          {event.detail ? <p className="mt-2 text-sm text-muted-foreground">{event.detail}</p> : null}
          {(event.stageKey || event.branch) ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {[event.stageKey ? stageKeyLabel(event.stageKey) : '', event.branch ? branchLabel(event.branch as Branch) : '']
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-xs text-muted-foreground">
          <p>{actorName}</p>
          <p className="mt-1">{formatDateTime(event.createdAt)}</p>
        </div>
      </div>
    </div>
  )
}

function ArtifactSection({ title, content }: { title: string; content: string }) {
  return (
    <section className="space-y-2">
      <p className="text-sm font-semibold">{title}</p>
      <pre className="whitespace-pre-wrap rounded-[18px] border border-border bg-muted/15 px-4 py-3 text-sm leading-7 text-muted-foreground">
        {content || '暂无内容'}
      </pre>
    </section>
  )
}

function FileListSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="space-y-2">
      <p className="text-sm font-semibold">{title}</p>
      {items.length ? (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item} className="rounded-lg border border-border bg-muted/15 px-4 py-3 text-sm text-muted-foreground">
              {item}
            </div>
          ))}
        </div>
      ) : (
        <EmptyHint>暂无文件清单。</EmptyHint>
      )}
    </section>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  )
}

function SnapshotLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-muted/25 px-4 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">{children}</div>
}

function TaskListSection({
  title,
  tasks,
  selectedTaskId,
  onSelect,
  emptyHint,
}: {
  title: string
  tasks: TaskView[]
  selectedTaskId: string
  onSelect: (taskId: string) => void
  emptyHint?: string
}) {
  return (
    <>
      <div className="mb-2 px-1 text-xs uppercase tracking-[0.24em] text-muted-foreground">{title}</div>
      {tasks.length ? (
        <div className="space-y-1">
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={cn(
                'w-full rounded-lg px-3 py-2 text-left transition-colors',
                task.id === selectedTaskId ? 'bg-primary/8' : 'hover:bg-card/70',
              )}
              onClick={() => onSelect(task.id)}
            >
              <p className="truncate text-sm font-medium">{task.title}</p>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="truncate">{task.stateLabel}</span>
                <span>{formatDateTime(task.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      ) : emptyHint ? (
        <EmptyHint>{emptyHint}</EmptyHint>
      ) : null}
    </>
  )
}

function CenteredState({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="space-y-3 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        {children}
      </div>
    </div>
  )
}

function getToolbarActions(task: TaskView | null, stage: StageView | null, currentUserId: string): ToolbarAction[] {
  if (!task || !stage) {
    return []
  }

  const actions: ToolbarAction[] = []

  if (stage.key === 'requirement' && stage.permission.supplement) {
    actions.push({ type: 'supplement-requirement', label: '补充需求', variant: 'outline', icon: Plus })
  }

  if (stage.key === 'design' && stage.permission.supplement) {
    actions.push({ type: 'supplement-design', label: '补充设计', variant: 'outline', icon: Plus })
  }

  if (
    ((stage.key === 'requirement' && !task.clarifications.some((item) => item.status !== 'confirmed')) || stage.key === 'design') &&
    stage.status === 'review' &&
    stage.permission.confirm &&
    !(stage.key === 'design' && hasDesignConfirmationForUser(task, stage, currentUserId))
  ) {
    actions.push({ type: 'advance', label: stage.key === 'design' ? '确认设计' : '通过并推进', variant: 'default', icon: ChevronRight })
  }

  if (stage.key === 'verification' && stage.status === 'pending' && stage.permission.confirm) {
    actions.push({ type: 'verify-reject', label: '验证驳回', variant: 'destructive', icon: X })
    actions.push({ type: 'verify-pass', label: '验证通过', variant: 'default', icon: Check })
  }

  if (stage.key === 'review' && stage.status === 'review' && stage.permission.confirm) {
    actions.push({ type: 'review-reflow', label: '审查回流', variant: 'destructive', icon: RotateCcw })
    actions.push({ type: 'review-pass', label: '审查通过', variant: 'default', icon: Check })
  }

  if (stage.key === 'testing' && stage.status === 'pending' && stage.permission.confirm) {
    actions.push({ type: 'testing-pass', label: '测试通过', variant: 'default', icon: Check })
  }

  if (stage.key === 'delivery' && stage.status === 'pending' && stage.permission.confirm) {
    actions.push({ type: 'rollback', label: '交付驳回', variant: 'destructive', icon: RotateCcw })
    actions.push({ type: 'deliver', label: '确认交付', variant: 'default', icon: Check })
  }

  return actions
}

function isStageActionable(stage: StageView) {
  return (
    (stage.status === 'pending' && (stage.permission.execute || stage.permission.confirm)) ||
    (stage.status === 'review' && stage.permission.confirm)
  )
}

function canReportTestingBug(stage: StageView) {
  return (
    stage.key === 'testing' &&
    stage.permission.supplement &&
    stage.status !== 'passed' &&
    (stage.status === 'pending' || stage.testingBugs.length > 0)
  )
}

function hasDesignConfirmationForUser(task: TaskView, stage: StageView, currentUserId: string) {
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

function canExecuteStageAction(task: TaskView, stage: StageView, currentUserId: string) {
  if (stage.key === 'requirement') {
    return currentUserId === task.pmId || currentUserId === task.reqOwnerId
  }
  return stage.permission.execute
}

function taskNeedsCurrentUserAction(task: TaskView, currentUserId: string) {
  if (!currentUserId) {
    return false
  }
  const testingStage = task.stages.find((stage) => stage.key === 'testing' && stage.branch === 'shared')
  return task.stages.some((stage) => {
    if (stage.status === 'passed') {
      return false
    }
    if (stage.key === 'requirement') {
      if (stage.status === 'pending') {
        return canExecuteStageAction(task, stage, currentUserId)
      }
      if (stage.status === 'review') {
        const canReunderstand = canExecuteStageAction(task, stage, currentUserId)
        const canClarify = currentUserId === task.pmId && task.clarifications.some((item) => item.status !== 'confirmed')
        const canAdvance = currentUserId === task.pmId && !task.clarifications.some((item) => item.status !== 'confirmed')
        return canReunderstand || canClarify || canAdvance
      }
      return false
    }
    if (isStageActionable(stage)) {
      if (stage.key === 'design' && stage.status === 'review' && hasDesignConfirmationForUser(task, stage, currentUserId)) {
        return false
      }
      return true
    }
    return false
  }) || (testingStage ? canTaskTestingNeedAction(task, testingStage, currentUserId) : false)
}

function canTaskTestingNeedAction(task: TaskView, testingStage: StageView, currentUserId: string) {
  if (currentUserId === task.testerId) {
    return testingStage.status === 'pending' && testingStage.testingBugs.some((bug) => bug.status === 'fixed')
  }
  return testingStage.testingBugs.some((bug) => canMarkTestingBugFixed(task, bug, currentUserId))
}

function getDialogConfig(type: ActionType, stage: StageView) {
  if (type === 'reunderstand-requirement') {
    return {
      title: '重新理解需求',
      description: '会带着已确认的问题澄清重新执行需求理解，并覆盖当前结果。',
      noteLabel: '附加提示词',
      notePlaceholder: '补充本轮重新理解需要重点关注的背景、边界或约束。',
      confirmLabel: '确认重新理解',
      confirmVariant: 'default' as const,
    }
  }

  if (type === 'advance') {
    return {
      title: stage.key === 'design' ? '确认设计' : '通过并推进',
      description: stage.key === 'requirement' ? '会推进到详细设计。' : '前后端都确认后才会推进到并行开发。',
      noteLabel: '',
      notePlaceholder: '',
      confirmLabel: stage.key === 'design' ? '确认设计' : '确认推进',
      confirmVariant: 'default' as const,
    }
  }

  if (type === 'verify-pass') {
    return {
      title: '功能验证通过',
      description: '通过后将进入对应分支的代码审查。',
      noteLabel: '',
      notePlaceholder: '',
      confirmLabel: '确认通过',
      confirmVariant: 'default' as const,
    }
  }

  if (type === 'verify-reject') {
    return {
      title: '功能验证驳回',
      description: '会回流到对应开发分支，并记录驳回原因。',
      noteLabel: '驳回原因',
      notePlaceholder: `说明为什么驳回 ${stage.name}。`,
      confirmLabel: '确认驳回',
      confirmVariant: 'destructive' as const,
    }
  }

  if (type === 'review-pass') {
    return {
      title: '代码审查通过',
      description: '前后端审查都通过后将开放测试阶段。',
      noteLabel: '',
      notePlaceholder: '',
      confirmLabel: '确认通过',
      confirmVariant: 'default' as const,
    }
  }

  if (type === 'review-reflow') {
    return {
      title: '代码审查回流',
      description: '按选择的风险级别回流到对应开发分支。',
      noteLabel: '',
      notePlaceholder: '',
      confirmLabel: '确认回流',
      confirmVariant: 'destructive' as const,
    }
  }

  if (type === 'testing-pass') {
    return {
      title: '测试通过',
      description: '仅测试负责人可执行。通过后任务进入交付沉淀。',
      noteLabel: '',
      notePlaceholder: '',
      confirmLabel: '确认通过',
      confirmVariant: 'default' as const,
    }
  }

  if (type === 'report-bug') {
    return {
      title: '提交 Bug',
      description: '测试阶段所有相关用户都可提交 Bug，并按归属回流到对应开发分支。',
      noteLabel: 'Bug 描述',
      notePlaceholder: '描述复现路径、现象、预期结果和影响范围。',
      confirmLabel: '确认提交',
      confirmVariant: 'destructive' as const,
    }
  }

  if (type === 'deliver') {
    return {
      title: '确认交付',
      description: '该动作会将任务标记为完成。',
      noteLabel: '',
      notePlaceholder: '',
      confirmLabel: '确认交付',
      confirmVariant: 'default' as const,
    }
  }

  if (type === 'rollback') {
    return {
      title: '交付驳回',
      description: '可将任务回退到需求、设计或某个开发分支。',
      noteLabel: '驳回原因',
      notePlaceholder: '说明为什么要回退，以及回退后要修正什么。',
      confirmLabel: '确认回退',
      confirmVariant: 'destructive' as const,
    }
  }

  if (type === 'supplement-requirement') {
    return {
      title: '补充需求',
      description: '补充需求后可选择重回设计，或仅影响前/后端开发。',
      noteLabel: '补充内容',
      notePlaceholder: '填写新增需求、边界变化或最新确认结果。',
      confirmLabel: '提交补充',
      confirmVariant: 'default' as const,
    }
  }

  return {
    title: '补充设计',
    description: '在详细设计阶段追加补充说明。',
    noteLabel: '补充内容',
    notePlaceholder: '填写需要补充的设计约束、接口或流程。',
    confirmLabel: '提交补充',
    confirmVariant: 'default' as const,
  }
}

function branchLabel(branch: Branch): string {
  if (branch === 'frontend') return '前端'
  if (branch === 'backend') return '后端'
  return '共享'
}

function stageBadge(task: TaskView, stage: StageView) {
  if (stage.key === 'design' && stage.status === 'review' && stage.pendingNote) {
    return { label: stage.pendingNote, variant: 'warning' as const }
  }
  if (stage.status !== 'blocked') {
    return statusBadgeMap[stage.status]
  }
  return isStageReachable(task, stage) ? statusBadgeMap.blocked : notReachedBadge
}

function isStageReachable(task: TaskView, stage: StageView) {
  if (stage.key === 'projectContext') {
    return true
  }
  if (stage.key === 'requirement') {
    return getStageStatus(task, 'projectContext', 'shared') === 'passed'
  }
  if (stage.key === 'design') {
    return getStageStatus(task, 'requirement', 'shared') === 'passed'
  }
  if (stage.key === 'development') {
    return getStageStatus(task, 'design', 'shared') === 'passed'
  }
  if (stage.key === 'verification') {
    return stage.branch !== 'shared' && getStageStatus(task, 'development', stage.branch) === 'passed'
  }
  if (stage.key === 'review') {
    return stage.branch !== 'shared' && getStageStatus(task, 'verification', stage.branch) === 'passed'
  }
  if (stage.key === 'testing') {
    return (
      stage.testingBugs.length > 0 ||
      (getStageStatus(task, 'review', 'frontend') === 'passed' && getStageStatus(task, 'review', 'backend') === 'passed')
    )
  }
  return getStageStatus(task, 'testing', 'shared') === 'passed'
}

function getStageStatus(task: TaskView, key: StageKey, branch: Branch) {
  return task.stages.find((stage) => stage.key === key && stage.branch === branch)?.status
}

function compactStageLabel(stage: StageView) {
  if (stage.branch === 'shared') {
    return stage.name
  }
  const prefix = branchLabel(stage.branch)
  return stage.name.startsWith(prefix) ? stage.name.slice(prefix.length) || stage.name : stage.name
}

function stageKey(stage: StageView) {
  return `${stage.key}:${stage.branch}`
}

function getDefaultStageKey(task: TaskView) {
  const actionableStage = task.stages.find((stage) => stage.status === 'running' || isStageActionable(stage))
  if (actionableStage) {
    return stageKey(actionableStage)
  }
  const requirementStage = task.stages.find((stage) => stage.key === 'requirement' && stage.branch === 'shared')
  return stageKey(requirementStage ?? task.stages[0])
}

function isAgentStage(key: StageKey) {
  return key === 'projectContext' || key === 'requirement' || key === 'design' || key === 'development' || key === 'review'
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function getRepoForStage(task: TaskView, stage: StageView) {
  if (stage.branch === 'frontend') return task.frontendRepo
  if (stage.branch === 'backend') return task.backendRepo
  return null
}

function formatRepoBinding(repo: RepoBinding | null) {
  if (!repo) return '未绑定'
  return repo.branch ? `${repo.name} @ ${repo.branch}` : repo.name
}

function stageRoleLabel(task: TaskView, stage: StageView, users: { id: string; name: string }[]) {
  if (stage.key === 'requirement') {
    return `产品经理 · ${userName(task.pmId, users)}`
  }
  if (stage.key === 'projectContext') {
    return `前后端负责人 · ${userName(task.frontendDevId, users)} / ${userName(task.backendDevId, users)}`
  }
  if (stage.key === 'design' || stage.key === 'delivery') {
    return `创建人/负责人 · ${userName(task.reqOwnerId, users)}`
  }
  if (stage.key === 'testing') {
    return `测试负责人 · ${userName(task.testerId, users)}`
  }
  if (stage.branch === 'frontend') {
    return `前端开发 · ${userName(task.frontendDevId, users)}`
  }
  if (stage.branch === 'backend') {
    return `后端开发 · ${userName(task.backendDevId, users)}`
  }
  return '相关人员'
}

function stageOwnerName(task: TaskView, stage: StageView, users: { id: string; name: string }[]) {
  if (stage.key === 'requirement') {
    return userName(task.pmId, users)
  }
  if (stage.key === 'projectContext') {
    return `${userName(task.frontendDevId, users)} / ${userName(task.backendDevId, users)}`
  }
  if (stage.key === 'design' || stage.key === 'delivery') {
    return userName(task.reqOwnerId, users)
  }
  if (stage.key === 'testing') {
    return userName(task.testerId, users)
  }
  if (stage.branch === 'frontend') {
    return userName(task.frontendDevId, users)
  }
  if (stage.branch === 'backend') {
    return userName(task.backendDevId, users)
  }
  return '系统'
}

function userName(userId: string | null | undefined, users: { id: string; name: string }[]) {
  if (!userId) return '系统'
  return users.find((user) => user.id === userId)?.name ?? userId
}

function testingBugTargetLabel(target: BugTarget) {
  if (target === 'frontend') return '前端'
  if (target === 'backend') return '后端'
  return '前后端'
}

function testingBugStatusLabel(status: TestingBugView['status']) {
  if (status === 'open') return '待修复'
  if (status === 'fixed') return '待回归'
  return '已关闭'
}

function canMarkTestingBugFixed(task: TaskView, bug: TestingBugView, currentUserId: string) {
  if (!currentUserId || bug.status === 'closed' || bug.status === 'fixed') {
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
}

function canCloseTestingBug(task: TaskView, stage: StageView, bug: TestingBugView, currentUserId: string) {
  return stage.key === 'testing' && stage.status === 'pending' && currentUserId === task.testerId && bug.status === 'fixed'
}

function processTypeLabel(type: ProcessEvent['type']) {
  if (type === 'thought') return '思考'
  if (type === 'tool') return '工具'
  return '文本'
}

function timelineBadgeVariant(kind: string): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' {
  if (kind === 'rejected' || kind === 'rollback' || kind === 'cancelled' || kind === 'reflow' || kind === 'bug') return 'destructive'
  if (kind === 'verified' || kind === 'reviewed' || kind === 'advanced' || kind === 'delivered' || kind === 'tested' || kind === 'bug-closed') return 'success'
  if (kind === 'supplement' || kind === 'clarified' || kind === 'bug-fixed') return 'warning'
  return 'secondary'
}

function timelineBadgeLabel(kind: string) {
  const map: Record<string, string> = {
    created: '创建',
    cancelled: '撤销',
    prompt: '提示词',
    repo: '仓库',
    executing: '执行',
    stage: '阶段',
    clarified: '澄清',
    advanced: '推进',
    verified: '验证',
    rejected: '驳回',
    reviewed: '审查',
    reflow: '回流',
    tested: '测试',
    bug: 'Bug',
    'bug-fixed': '修复',
    'bug-closed': '回归',
    delivered: '交付',
    rollback: '回退',
    supplement: '补充',
  }
  return map[kind] ?? kind
}

function stageKeyLabel(key: string) {
  const map: Record<string, string> = {
    projectContext: '项目上下文刷新',
    requirement: '需求理解',
    design: '详细设计',
    development: '开发',
    verification: '功能验证',
    review: '代码审查',
    testing: '测试',
    delivery: '交付沉淀',
  }
  return map[key] ?? key
}

function stageAgentSelectionKey(taskId: string, stage: StageView) {
  return `${taskId}:${stage.key}:${stage.branch ?? 'shared'}`
}

function stageAgentSettingKey(taskId: string, stage: StageView, agentId: AgentOptionId) {
  return `${stageAgentSelectionKey(taskId, stage)}:${agentId}`
}

function defaultAgentForStage(stage: StageView | null, agents: AgentStatus[]): AgentOptionId {
  const preferred =
    stage?.key === 'requirement'
      ? 'copilot'
      : stage?.key === 'design'
        ? 'copilot'
        : stage?.key === 'development'
          ? 'codex'
          : stage?.key === 'review' || stage?.key === 'verification'
            ? 'copilot'
            : 'gemini'

  return preferredAgentName(agents, preferred)
}

function defaultAgentPanelState(agent: AgentStatus): AgentPanelState {
  return {
    modelId: agent.default_model_id || agent.current_model_id || agent.models?.[0]?.id || '',
    effort: agent.default_effort ?? '',
    fastMode: normalizeFastMode(agent.default_fast_service),
  }
}

function preferredAgentName(agents: AgentStatus[], preferred: string) {
  return (
    agentStatusByName(agents, preferred)?.name ??
    agents.find((agent) => agent.available)?.name ??
    agents[0]?.name ??
    preferred
  )
}

function agentStatusByName(agents: AgentStatus[], agentName: string) {
  return agents.find((entry) => entry.name === agentName) ?? null
}

function agentModelOptionById(agent: AgentStatus, modelId: string) {
  return (agent.models ?? []).find((entry) => entry.id === modelId) ?? null
}

function agentModelLabel(model: { id: string; name?: string }) {
  return typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id
}

function normalizeFastMode(value: string | undefined) {
  return value === 'on' ? 'on' : 'off'
}

function agentIssueReason(agent: AgentStatus) {
  if (typeof agent.error === 'string' && agent.error.trim()) {
    return agent.error.trim()
  }
  if (!agent.installed) {
    return `未检测到本机 ${agent.name} CLI。`
  }
  if (!agent.available) {
    return `${agent.name} 当前不可用。`
  }
  return ''
}

function getSnapshotItems(task: TaskView, stage: StageView) {
  if (stage.key === 'projectContext') {
    const artifact = (stage.artifact && typeof stage.artifact === 'object' ? stage.artifact : {}) as {
      summary?: string
      items?: unknown[]
      refreshState?: { frontend?: boolean; backend?: boolean }
    }
    const refreshState = artifact.refreshState ?? {}
    return [
      { label: '前端刷新', value: refreshState.frontend ? '已完成' : '未完成' },
      { label: '后端刷新', value: refreshState.backend ? '已完成' : '未完成' },
      { label: '提炼条目', value: `${Array.isArray(artifact.items) ? artifact.items.length : 0} 条` },
    ]
  }

  if (stage.key === 'requirement') {
    const artifact = requirementArtifact(stage.artifact)
    return [
      { label: '问题澄清', value: `${task.clarifications.length} 条` },
      { label: '验收标准', value: `${artifact.acceptance.length} 条` },
      { label: '风险', value: `${artifact.risks.length} 条` },
    ]
  }

  if (stage.key === 'design') {
    const artifact = designArtifact(stage.artifact)
    return [
      { label: '前端设计', value: artifact.frontendDesign ? '已生成' : '未生成' },
      { label: '后端设计', value: artifact.backendDesign ? '已生成' : '未生成' },
      { label: '测试用例', value: artifact.testCases ? '已生成' : '未生成' },
      { label: '补充记录', value: `${artifact.supplements.length} 条` },
    ]
  }

  if (stage.key === 'development') {
    const artifact = developmentArtifact(stage.artifact)
    return [
      { label: '新增文件', value: `${artifact.addedFiles.length} 个` },
      { label: '修改文件', value: `${artifact.modifiedFiles.length} 个` },
      { label: '运行次数', value: `${stage.runCount}` },
    ]
  }

  if (stage.key === 'review') {
    const artifact = reviewArtifact(stage.artifact)
    return [
      { label: '高危', value: `${artifact.high}` },
      { label: '中危', value: `${artifact.medium}` },
      { label: '低危', value: `${artifact.low}` },
    ]
  }

  if (stage.key === 'verification') {
    return [
      { label: '分支', value: branchLabel(stage.branch) },
      { label: '状态', value: stageBadge(task, stage).label },
      { label: '运行次数', value: `${stage.runCount}` },
    ]
  }

  if (stage.key === 'testing') {
    return [
      { label: '未关闭 Bug', value: `${stage.testingBugs.filter((bug) => bug.status !== 'closed').length} 条` },
      { label: '已关闭 Bug', value: `${stage.testingBugs.filter((bug) => bug.status === 'closed').length} 条` },
      { label: '测试结论', value: stageBadge(task, stage).label },
    ]
  }

  return [
    { label: '前端仓库', value: formatRepoBinding(task.frontendRepo) },
    { label: '后端仓库', value: formatRepoBinding(task.backendRepo) },
    { label: '任务状态', value: task.stateLabel },
  ]
}

function requirementArtifact(value: unknown) {
  const obj = asRecord(value)
  return {
    summary: asString(obj?.summary),
    risks: asStringArray(obj?.risks),
    acceptance: asStringArray(obj?.acceptance),
    impactScope: asString(obj?.impactScope),
    fullDoc: asString(obj?.fullDoc),
  }
}

function designArtifact(value: unknown) {
  const obj = asRecord(value)
  return {
    frontendDesign: asString(obj?.frontendDesign),
    backendDesign: asString(obj?.backendDesign),
    apiDoc: asString(obj?.apiDoc),
    testCases: asString(obj?.testCases),
    supplements: asStringArray(obj?.supplements),
  }
}

function developmentArtifact(value: unknown) {
  const obj = asRecord(value)
  return {
    changes: asString(obj?.changes),
    addedFiles: asStringArray(obj?.addedFiles),
    modifiedFiles: asStringArray(obj?.modifiedFiles),
  }
}

function reviewArtifact(value: unknown) {
  const obj = asRecord(value)
  return {
    summary: asString(obj?.summary),
    keyConclusions: asStringArray(obj?.keyConclusions),
    downstreamInputs: asStringArray(obj?.downstreamInputs),
    high: asNumber(obj?.high),
    medium: asNumber(obj?.medium),
    low: asNumber(obj?.low),
    issues: asReviewIssues(obj?.issues),
  }
}

function verificationArtifact(value: unknown) {
  const obj = asRecord(value)
  return {
    summary: asString(obj?.summary),
    keyConclusions: asStringArray(obj?.keyConclusions),
    downstreamInputs: asStringArray(obj?.downstreamInputs),
    verificationScope: asStringArray(obj?.verificationScope),
    verificationResult: asString(obj?.verificationResult),
    rejectionReason: asString(obj?.rejectionReason),
    passBasis: asString(obj?.passBasis),
  }
}

function testingArtifact(value: unknown) {
  const obj = asRecord(value)
  return {
    summary: asString(obj?.summary),
    keyConclusions: asStringArray(obj?.keyConclusions),
    downstreamInputs: asStringArray(obj?.downstreamInputs),
    testScope: asStringArray(obj?.testScope),
    executionResult: asString(obj?.executionResult),
    bugSummary: asString(obj?.bugSummary),
    regressionConclusion: asString(obj?.regressionConclusion),
    testConclusion: asString(obj?.testConclusion),
  }
}

function deliveryArtifact(value: unknown) {
  const obj = asRecord(value)
  return {
    summary: asString(obj?.summary),
    keyConclusions: asStringArray(obj?.keyConclusions),
    downstreamInputs: asStringArray(obj?.downstreamInputs),
    deliveryItems: asStringArray(obj?.deliveryItems),
    releaseNotes: asString(obj?.releaseNotes),
    rollbackPlan: asString(obj?.rollbackPlan),
    handoffConclusion: asString(obj?.handoffConclusion),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown) {
  return typeof value === 'number' ? value : 0
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function asReviewIssues(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as Array<{ level: string; title: string; file: string }>
  }
  return value
    .map((item) => {
      const obj = asRecord(item)
      return obj
        ? {
            level: asString(obj.level),
            title: asString(obj.title),
            file: asString(obj.file),
          }
        : null
    })
    .filter((item): item is { level: string; title: string; file: string } => item !== null)
}

function reviewLevelLabel(level: string) {
  if (level === 'high') return '高危'
  if (level === 'medium') return '中危'
  if (level === 'low') return '低危'
  return level
}
