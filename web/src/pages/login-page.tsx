import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useWorkspaceStore } from '@/state/workspace-store-context'
import { ROLE_LABELS, type User } from '@/lib/types'
import { cn } from '@/lib/utils'

const ROLE_ORDER: Record<string, number> = { pm: 0, dev: 1, observer: 2 }

// Mock login (PRD: pick an identity, no password). Independent page — does not
// touch the workspace layout.
export function LoginPage() {
  const { users, login, authLoading, authError, refreshUsers } = useWorkspaceStore()
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState('')

  const sortedUsers = [...users].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9))

  function handleLogin() {
    if (!selectedId) return
    login(selectedId)
    navigate('/')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-1 flex items-center gap-2 text-primary">
            <Sparkles className="h-5 w-5" />
            <span className="text-lg font-semibold">FlowMate</span>
          </div>
          <CardTitle>选择身份进入</CardTitle>
          <CardDescription>面向研发协作的任务流转系统 · Mock 登录，无需密码</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {authLoading ? (
            <p className="text-sm text-muted-foreground">加载用户中…</p>
          ) : authError ? (
            <div className="space-y-3 rounded-xl border border-destructive/20 bg-destructive/5 p-4">
              <p className="text-sm text-destructive">身份加载失败：{authError}</p>
              <Button variant="outline" className="w-full" onClick={() => void refreshUsers()}>
                重新加载身份
              </Button>
            </div>
          ) : sortedUsers.length === 0 ? (
            <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
              <p className="text-sm text-muted-foreground">当前没有可用身份，请先确认后端种子数据是否已初始化。</p>
              <Button variant="outline" className="w-full" onClick={() => void refreshUsers()}>
                重新加载身份
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {sortedUsers.map((user) => (
                <UserOption
                  key={user.id}
                  user={user}
                  selected={selectedId === user.id}
                  onSelect={() => setSelectedId(user.id)}
                />
              ))}
            </div>
          )}
          <Button className="w-full" disabled={!selectedId} onClick={handleLogin}>
            进入工作台
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function UserOption({ user, selected, onSelect }: { user: User; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors',
        selected ? 'border-primary bg-accent' : 'border-border hover:bg-accent/60',
      )}
    >
      <span className="font-medium">{user.name}</span>
      <span className="text-xs text-muted-foreground">{ROLE_LABELS[user.role]}</span>
    </button>
  )
}
