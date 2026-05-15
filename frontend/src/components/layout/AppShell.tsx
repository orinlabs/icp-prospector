import { useEffect, useState } from 'react'

import { Sidebar, type SidebarSection } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'

type Theme = 'light' | 'dark'

interface AppShellProps<TId extends string> {
  sections: SidebarSection<TId>[]
  activeId: TId
  onSelect: (id: TId) => void
  sidebarFooter?: React.ReactNode
  onOpenSearch?: () => void
  userInitials?: string
  organizationName?: string
  organizationDomain?: string
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
  organizationName,
  organizationDomain,
  onSignOut,
  children
}: AppShellProps<TId>) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    function syncSystemTheme(event: MediaQueryList | MediaQueryListEvent) {
      setTheme(event.matches ? 'dark' : 'light')
    }

    syncSystemTheme(media)
    media.addEventListener('change', syncSystemTheme)

    return () => {
      media.removeEventListener('change', syncSystemTheme)
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
  }, [theme])

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-bg text-ink">
      <TopBar
        theme={theme}
        onOpenSearch={onOpenSearch}
        userInitials={userInitials}
        organizationName={organizationName}
        organizationDomain={organizationDomain}
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
