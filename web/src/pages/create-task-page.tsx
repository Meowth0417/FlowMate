import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronDown, FileText, FolderGit2, Link2, Sparkles } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ROLE_LABELS, type User } from '@/lib/types'
import { useWorkspaceStore } from '@/state/workspace-store-context'

interface FormState {
  title: string
  description: string
  reqOwnerId: string
  pmId: string
  frontendDevId: string
  backendDevId: string
  testerId: string
}

const initialForm: FormState = {
  title: '',
  description: '',
  reqOwnerId: '',
  pmId: '',
  frontendDevId: '',
  backendDevId: '',
  testerId: '',
}

export function CreateTaskPage() {
  const navigate = useNavigate()
  const { createTask, users, currentUser } = useWorkspaceStore()
  const [form, setForm] = useState<FormState>(initialForm)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const pmOptions = users.filter((user) => user.role === 'pm')
  const devOptions = users.filter((user) => user.role === 'dev')
  const testerOptions = users.filter((user) => user.role === 'tester')

  // Preselect sensible defaults once users load.
  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      reqOwnerId: prev.reqOwnerId || currentUser?.id || '',
      pmId: prev.pmId || pmOptions[0]?.id || '',
      frontendDevId: prev.frontendDevId || devOptions[0]?.id || '',
      backendDevId: prev.backendDevId || devOptions[1]?.id || devOptions[0]?.id || '',
      testerId: prev.testerId || testerOptions[0]?.id || '',
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, currentUser])

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => ({ ...prev, [key]: undefined }))
    setFeedback('')
  }

  function validate() {
    const nextErrors: Partial<Record<keyof FormState, string>> = {}

    if (!form.title.trim()) {
      nextErrors.title = '请填写任务标题'
    }

    if (!form.description.trim()) {
      nextErrors.description = '请填写需求描述'
    }

    if (!form.reqOwnerId) {
      nextErrors.reqOwnerId = '请选择需求负责人'
    }
    if (!form.pmId) {
      nextErrors.pmId = '请选择产品经理'
    }
    if (!form.frontendDevId) {
      nextErrors.frontendDevId = '请选择前端开发'
    }
    if (!form.backendDevId) {
      nextErrors.backendDevId = '请选择后端开发'
    }
    if (!form.testerId) {
      nextErrors.testerId = '请选择测试负责人'
    }

    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  async function handleCreateTask() {
    if (!validate()) {
      return
    }

    try {
      setSubmitting(true)
      await createTask({
        title: form.title.trim(),
        description: form.description.trim(),
        reqOwnerId: form.reqOwnerId,
        pmId: form.pmId,
        frontendDevId: form.frontendDevId,
        backendDevId: form.backendDevId,
        testerId: form.testerId,
      })
      navigate('/')
    } catch (requestError) {
      setFeedback((requestError as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center px-3 py-2">
          <div className="flex items-center">
            <Button variant="ghost" asChild className="rounded-xl">
              <Link to="/">
                <ArrowLeft className="size-4" />
                返回工作台
              </Link>
            </Button>
            <div>
              <h1 className="text-lg font-semibold">新建任务</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1600px] gap-3 px-3 py-3 xl:grid-cols-[1.25fr_0.75fr]">
        <section className="space-y-3">
          <Card className="rounded-[24px]">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>任务基础信息</CardTitle>
                  <CardDescription>先收集需求、仓库与流程入口，不接真实提交逻辑。</CardDescription>
                </div>
                <Badge variant="secondary">页面骨架</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <Field label="任务标题" error={errors.title}>
                <Input
                  placeholder="例如：优惠券规则配置全链路改版"
                  value={form.title}
                  onChange={(event) => updateField('title', event.target.value)}
                />
              </Field>
              <Field label="需求描述" error={errors.description}>
                <Textarea
                  placeholder="描述业务目标、涉及角色、关键约束、验收预期。这里后续会接需求理解 Agent。"
                  className="min-h-[220px]"
                  value={form.description}
                  onChange={(event) => updateField('description', event.target.value)}
                />
              </Field>
              <div className="grid gap-5 xl:grid-cols-2">
                <Field label="需求负责人" error={errors.reqOwnerId}>
                  <UserSelect
                    value={form.reqOwnerId}
                    options={users}
                    placeholder="选择需求负责人"
                    onChange={(value) => updateField('reqOwnerId', value)}
                  />
                </Field>
                <Field label="产品经理" error={errors.pmId}>
                  <UserSelect
                    value={form.pmId}
                    options={pmOptions}
                    placeholder="选择产品经理"
                    onChange={(value) => updateField('pmId', value)}
                  />
                </Field>
                <Field label="前端开发" error={errors.frontendDevId}>
                  <UserSelect
                    value={form.frontendDevId}
                    options={devOptions}
                    placeholder="选择前端开发"
                    onChange={(value) => updateField('frontendDevId', value)}
                  />
                </Field>
                <Field label="后端开发" error={errors.backendDevId}>
                  <UserSelect
                    value={form.backendDevId}
                    options={devOptions}
                    placeholder="选择后端开发"
                    onChange={(value) => updateField('backendDevId', value)}
                  />
                </Field>
                <Field label="测试负责人" error={errors.testerId}>
                  <UserSelect
                    value={form.testerId}
                    options={testerOptions}
                    placeholder="选择测试负责人"
                    onChange={(value) => updateField('testerId', value)}
                  />
                </Field>
              </div>
              {feedback ? <SuccessBanner>{feedback}</SuccessBanner> : null}
            </CardContent>
          </Card>

          <Card className="rounded-[24px]">
            <CardHeader>
              <CardTitle>上下文附件</CardTitle>
              <CardDescription>用卡片占位展示，后续再接真实上传与文档解析。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 xl:grid-cols-3">
              <AttachmentCard icon={FileText} title="需求文档" desc="PRD、会议纪要、需求补充" />
              <AttachmentCard icon={Link2} title="文档链接" desc="Wiki、设计稿、接口文档" />
              <AttachmentCard icon={FolderGit2} title="代码仓信息" desc="前后端仓库将在开发阶段绑定" />
            </CardContent>
          </Card>
        </section>

        <aside className="space-y-3">
          <Card className="rounded-[24px]">
            <CardHeader>
              <CardTitle>流程模板</CardTitle>
              <CardDescription>第一版直接选固定主流程，不做复杂配置。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-[18px] border border-border bg-muted/30 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">研发全链路主流程</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      需求理解 → 详细设计 → 开发拆分 → 前后端开发 → 功能验证 → 代码审查 → 交付沉淀
                    </p>
                  </div>
                  <ChevronDown className="size-4 text-muted-foreground" />
                </div>
              </div>
              <div className="space-y-3 rounded-[18px] border border-dashed border-border p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">默认接入方式</p>
                <p>需求理解：自研 requirement-agent</p>
                <p>其他阶段：先按 mock / 手工占位，后续接 codex、claude-code、copilot</p>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-[24px]">
            <CardHeader>
              <CardTitle>启动前提示</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <InfoLine>创建任务会直接进入“需求理解”，由需求负责人推进澄清与后续阶段。</InfoLine>
              <InfoLine>正式版将把需求描述先送入需求理解 Agent 进行澄清与验收标准提炼。</InfoLine>
              <InfoLine>你后续可以从这里继续补充：审批规则、阶段配置、Agent 入口。</InfoLine>
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-3">
            <Button className="rounded-xl px-5" onClick={() => void handleCreateTask()} disabled={submitting}>
              <Sparkles className="size-4" />
              创建并进入工作台
            </Button>
          </div>
        </aside>
      </main>
    </div>
  )
}

function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </label>
  )
}

function UserSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string
  options: User[]
  placeholder: string
  onChange: (value: string) => void
}) {
  return (
    <select
      className="flex h-11 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {options.map((user) => (
        <option key={user.id} value={user.id}>
          {user.name}（{ROLE_LABELS[user.role]}）
        </option>
      ))}
    </select>
  )
}

function AttachmentCard({
  icon: Icon,
  title,
  desc,
}: {
  icon: typeof FileText
  title: string
  desc: string
}) {
  return (
    <div className="rounded-[18px] border border-border bg-muted/30 p-5">
      <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-card">
        <Icon className="size-5 text-primary" />
      </div>
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
    </div>
  )
}

function InfoLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
      <p>{children}</p>
    </div>
  )
}

function SuccessBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
      {children}
    </div>
  )
}
