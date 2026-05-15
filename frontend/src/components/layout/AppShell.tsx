import { useEffect, useState } from 'react'

import { Sidebar, type SidebarSection } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'

interface AppShellProps<TId extends string> {
  sections: SidebarSection<TId>[]
  activeId: TId
  onSelect: (id: TId) => void
  sidebarFooter?: React.ReactNode
  onOpenSearch?: () => void
  userInitials?: string
  onSignOut?: () => void
  children: React.ReactNode
}

export function AppShell<TId extends string>({
  sections,
  activeId,
  onSelect,
  sidebarFooter,
  onOpenSearch,
  userInitials,
  onSignOut,
  children
}: AppShellProps<TId>) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    const saved = window.localStorage.getItem('theme')
    if (saved === 'dark' || saved === 'light') return saved
    return 'light'
  })

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    window.localStorage.setItem('theme', theme)
  }, [theme])

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-bg text-ink">
      <TopBar
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onOpenSearch={onOpenSearch}
        userInitials={userInitials}
        onSignOut={onSignOut}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          sections={sections}
          activeId={activeId}
          onSelect={onSelect}
          footer={sidebarFooter}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  )
}
