import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Plus, Save } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ProjectMemoryItemView } from '@/lib/types'
import { useWorkspaceStore } from '@/state/workspace-store-context'

const CATEGORY_OPTIONS = [
  'business-domain-map',
  'permission-rule',
  'api-convention',
  'platform-group-rule',
  'known-risk',
  'best-practice',
  'delivery-rule',
  'route-menu-rule',
  'page-service-pattern',
  'component-pattern',
  'dict-enum-rule',
  'ui-interaction-rule',
  'global-utility-rule',
  'service-boundary-rule',
  'data-model-rule',
  'api-implementation-rule',
  'transaction-rule',
  'logging-error-rule',
  'auth-security-rule',
]

type EditableMemoryItem = Omit<ProjectMemoryItemView, 'id' | 'createdAt' | 'updatedAt'>
type PageMode = 'list' | 'detail' | 'create'

export function ProjectManagementPage() {
  const { projects, saveProject, saveProjectMemory } = useWorkspaceStore()
  const [mode, setMode] = useState<PageMode>('list')
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [summary, setSummary] = useState('')
  const [items, setItems] = useState<EditableMemoryItem[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (mode === 'create') {
      setName('')
      setDescription('')
      setSummary('')
      setItems([])
      return
    }
    if (!selectedProject) {
      return
    }
    setName(selectedProject.name)
    setDescription(selectedProject.description)
    setSummary(selectedProject.activeSnapshot?.summary ?? '')
    setItems(
      (selectedProject.activeSnapshot?.items ?? []).map((item) => ({
        category: item.category,
        title: item.title,
        content: item.content,
        structuredData: item.structuredData,
        scope: item.scope,
        stageScope: item.stageScope,
        priority: item.priority,
        status: item.status,
        sourceType: item.sourceType,
        sourceRef: item.sourceRef,
      })),
    )
  }, [mode, selectedProject])

  async function handleSaveProject() {
    setSaving(true)
    try {
      const project = await saveProject({ projectId: selectedProject?.id, name, description })
      setSelectedProjectId(project.id)
      setMode('detail')
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveMemory() {
    if (!selectedProject) return
    setSaving(true)
    try {
      await saveProjectMemory(selectedProject.id, summary, items)
    } finally {
      setSaving(false)
    }
  }

  function handleCreateProject() {
    setSelectedProjectId('')
    setMode('create')
  }

  function handleSelectProject(projectId: string) {
    setSelectedProjectId(projectId)
    setMode('detail')
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-3 py-2">
          <Button variant="ghost" asChild className="rounded-xl">
            <Link to="/">
              <ArrowLeft className="size-4" />
              返回工作台
            </Link>
          </Button>
          <Button variant="outline" className="rounded-xl" onClick={handleCreateProject}>
            <Plus className="size-4" />
            新建项目
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-3 py-3">
        {mode === 'list' ? (
          <Card className="rounded-[24px]">
            <CardHeader>
              <CardTitle>项目列表</CardTitle>
              <CardDescription>进入项目管理默认先查看已有项目，点击项目可查看详情，点击右上角可新建项目。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {projects.length ? (
                projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="w-full rounded-[18px] border border-border px-4 py-3 text-left hover:bg-muted/20"
                    onClick={() => handleSelectProject(project.id)}
                  >
                    <div className="text-sm font-medium">{project.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {project.activeSnapshot ? `当前版本 v${project.activeSnapshot.version}` : '暂无 active snapshot'}
                    </div>
                  </button>
                ))
              ) : (
                <div className="rounded-[18px] border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
                  暂无项目，点击右上角“新建项目”开始创建。
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 xl:grid-cols-[280px_1fr]">
            <aside className="space-y-3">
              <Card className="rounded-[24px]">
                <CardHeader>
                  <CardTitle>项目列表</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="w-full rounded-[18px] border border-border px-4 py-3 text-left hover:bg-muted/20"
                      onClick={() => handleSelectProject(project.id)}
                    >
                      <div className="text-sm font-medium">{project.name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {project.activeSnapshot ? `当前版本 v${project.activeSnapshot.version}` : '暂无 active snapshot'}
                      </div>
                    </button>
                  ))}
                </CardContent>
              </Card>
            </aside>
            <section className="space-y-3">
              <Card className="rounded-[24px]">
                <CardHeader>
                  <CardTitle>{mode === 'create' ? '新建项目' : '项目信息'}</CardTitle>
                  <CardDescription>第一版项目页只维护项目基础信息与项目记忆。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="项目名称" />
                  <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="项目说明" className="min-h-[100px]" />
                  <div className="flex justify-end gap-3">
                    <Button variant="outline" className="rounded-xl" onClick={() => setMode('list')}>
                      返回列表
                    </Button>
                    <Button className="rounded-xl" onClick={() => void handleSaveProject()} disabled={saving || !name.trim()}>
                      <Save className="size-4" />
                      保存项目
                    </Button>
                  </div>
                </CardContent>
              </Card>
              {mode === 'detail' ? (
                <Card className="rounded-[24px]">
                  <CardHeader>
                    <CardTitle>项目记忆</CardTitle>
                    <CardDescription>编辑会基于当前 active 生成新的 draft，再发布为新的 active。</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="快照摘要" className="min-h-[100px]" />
                    <div className="space-y-3">
                      {items.map((item, index) => (
                        <div key={`${item.scope}-${index}`} className="rounded-[18px] border border-border p-4">
                          <div className="grid gap-3 xl:grid-cols-3">
                            <select className="h-11 rounded-lg border border-input bg-background px-3 text-sm" value={item.scope} onChange={(event) => setItems((prev) => prev.map((entry, entryIndex) => (entryIndex === index ? { ...entry, scope: event.target.value as EditableMemoryItem['scope'] } : entry)))}>
                              <option value="shared">shared</option>
                              <option value="frontend">frontend</option>
                              <option value="backend">backend</option>
                            </select>
                            <select className="h-11 rounded-lg border border-input bg-background px-3 text-sm" value={item.category} onChange={(event) => setItems((prev) => prev.map((entry, entryIndex) => (entryIndex === index ? { ...entry, category: event.target.value } : entry)))}>
                              {CATEGORY_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                            <Input value={item.title} onChange={(event) => setItems((prev) => prev.map((entry, entryIndex) => (entryIndex === index ? { ...entry, title: event.target.value } : entry)))} placeholder="条目标题" />
                          </div>
                          <Textarea className="mt-3 min-h-[120px]" value={item.content} onChange={(event) => setItems((prev) => prev.map((entry, entryIndex) => (entryIndex === index ? { ...entry, content: event.target.value } : entry)))} placeholder="条目内容" />
                        </div>
                      ))}
                      <Button
                        variant="outline"
                        className="rounded-xl"
                        onClick={() =>
                          setItems((prev) => [
                            ...prev,
                            {
                              category: CATEGORY_OPTIONS[0],
                              title: '',
                              content: '',
                              structuredData: null,
                              scope: 'shared',
                              stageScope: 'all',
                              priority: 'medium',
                              status: 'confirmed',
                              sourceType: 'manual',
                              sourceRef: '',
                            },
                          ])
                        }
                      >
                        <Plus className="size-4" />
                        新增记忆条目
                      </Button>
                    </div>
                    <div className="flex justify-end">
                      <Button className="rounded-xl" onClick={() => void handleSaveMemory()} disabled={saving || !selectedProject}>
                        <Save className="size-4" />
                        发布项目记忆
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : null}
            </section>
          </div>
        )}
      </main>
    </div>
  )
}
