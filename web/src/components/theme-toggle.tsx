import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const themeOptions = [
  { value: 'light', label: '浅', icon: Sun },
  { value: 'dark', label: '深', icon: Moon },
  { value: 'system', label: '系统', icon: Monitor },
] as const

export function ThemeToggle() {
  const { resolvedTheme, setTheme, theme } = useTheme()

  return (
    <div className="inline-flex items-center rounded-xl border border-border bg-card/80 p-1 backdrop-blur">
      {themeOptions.map((option) => {
        const Icon = option.icon
        const isActive =
          theme === option.value || (option.value !== 'system' && theme === 'system' && resolvedTheme === option.value)

        return (
          <Button
            key={option.value}
            type="button"
            variant={isActive ? 'secondary' : 'ghost'}
            size="sm"
            className={cn(
              'h-8 rounded-lg px-3 text-xs',
              !isActive && 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setTheme(option.value)}
          >
            <Icon className="size-3.5" />
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}
