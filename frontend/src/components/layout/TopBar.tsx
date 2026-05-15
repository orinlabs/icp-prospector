import { Moon, Search, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

interface TopBarProps {
  userInitials?: string
  theme?: 'light' | 'dark'
  onThemeToggle?: () => void
  onOpenSearch?: () => void
  onSignOut?: () => void
}

export function TopBar({
  userInitials = 'BH',
  theme = 'light',
  onThemeToggle,
  onOpenSearch,
  onSignOut
}: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-bg px-4">
      <BrandMark />

      <div className="ml-2 flex flex-1 justify-center">
        <CommandInput onOpen={onOpenSearch} />
      </div>

      <div className="flex items-center gap-1">
        {onSignOut ? (
          <Button variant="ghost" size="sm" className="text-ink-muted" onClick={onSignOut}>
            Sign out
          </Button>
        ) : null}
        {onThemeToggle ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onThemeToggle}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        ) : null}
        <UserAvatar initials={userInitials} />
      </div>
    </header>
  )
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2 pr-1">
      <img src="/favicon.svg" alt="" className="size-6 rounded-md" aria-hidden />
      <span className="text-[13px] font-semibold tracking-tight">Flash</span>
    </div>
  )
}

function CommandInput({ onOpen }: { onOpen?: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex h-8 w-full max-w-md items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm text-ink-faint',
        'hover:border-line-strong transition-colors duration-120'
      )}
      aria-label="Search"
      aria-keyshortcuts="Meta+K Control+K"
    >
      <Search className="size-3.5" />
      <span className="flex-1 text-left">Search people, companies, crawls...</span>
      <span className="flex items-center gap-1">
        <Kbd>{String.fromCharCode(8984)}</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  )
}

function UserAvatar({ initials }: { initials: string }) {
  return (
    <button
      type="button"
      className="ml-1 inline-flex size-7 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground ring-1 ring-line"
      aria-label="Account menu"
    >
      {initials.slice(0, 2)}
    </button>
  )
}
