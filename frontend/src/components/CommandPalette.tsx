import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import * as React from 'react'

import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

export interface CommandItem {
  id: string
  label: string
  description?: string
  icon?: LucideIcon
  group?: string
  keywords?: string
  kbd?: string[]
  onSelect: () => void
}

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: CommandItem[]
  /** Controlled search text (required for directory search integration). */
  query: string
  onQueryChange: (query: string) => void
  /** Shown when `query` is non-empty and async record search is in flight. */
  recordSearchLoading?: boolean
  placeholder?: string
  emptyState?: React.ReactNode
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
  query,
  onQueryChange,
  recordSearchLoading = false,
  placeholder = 'Search commands, people, companies...',
  emptyState
}: CommandPaletteProps) {
  const [rawIndex, setRawIndex] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => {
      const haystack = [c.label, c.description ?? '', c.keywords ?? '', c.group ?? '']
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [commands, query])

  const grouped = React.useMemo(() => {
    const groups = new Map<string, CommandItem[]>()
    for (const item of filtered) {
      const key = item.group ?? ''
      const arr = groups.get(key)
      if (arr) arr.push(item)
      else groups.set(key, [item])
    }
    return Array.from(groups.entries()).map(([group, items]) => ({
      group,
      items
    }))
  }, [filtered])

  const activeIndex =
    filtered.length === 0 ? 0 : Math.min(Math.max(rawIndex, 0), filtered.length - 1)

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) {
        onQueryChange('')
        setRawIndex(0)
      }
      onOpenChange(next)
    },
    [onOpenChange, onQueryChange]
  )

  React.useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-command-index="${activeIndex}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filtered.length === 0) return
      setRawIndex((activeIndex + 1) % filtered.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (filtered.length === 0) return
      setRawIndex((activeIndex - 1 + filtered.length) % filtered.length)
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setRawIndex(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      if (filtered.length > 0) setRawIndex(filtered.length - 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = filtered[activeIndex]
      if (item) {
        item.onSelect()
        handleOpenChange(false)
      }
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/20',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-100',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-75'
          )}
        />
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            inputRef.current?.focus()
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            'fixed left-1/2 top-[10vh] z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2',
            'overflow-hidden rounded-xl border border-line bg-surface shadow-elevated',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 data-[state=open]:duration-100 data-[state=open]:ease-out',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=closed]:duration-75 data-[state=closed]:ease-in',
            'focus:outline-none'
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            Command palette
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search and run commands, or jump to a record.
          </DialogPrimitive.Description>

          <div className="flex items-center gap-2.5 border-b border-line px-3.5">
            <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                onQueryChange(e.target.value)
                setRawIndex(0)
              }}
              placeholder={placeholder}
              className={cn(
                'h-11 w-full bg-transparent text-sm text-ink placeholder:text-ink-faint',
                'focus:outline-none'
              )}
              autoComplete="off"
              spellCheck={false}
              aria-label="Command palette search"
              aria-controls="command-palette-list"
              aria-activedescendant={
                filtered[activeIndex]
                  ? `command-palette-item-${filtered[activeIndex].id}`
                  : undefined
              }
            />
            <Kbd>esc</Kbd>
          </div>

          <div
            ref={listRef}
            id="command-palette-list"
            role="listbox"
            className="max-h-[60vh] overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-ink-muted">
                {recordSearchLoading && query.trim().length > 0 ? (
                  <>Searching…</>
                ) : (
                  emptyState ?? <>No results for &ldquo;{query}&rdquo;</>
                )}
              </div>
            ) : (
              grouped.map(({ group, items }) => (
                <div key={group || 'default'} className="px-1 py-1">
                  {group ? (
                    <div className="px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-ink-faint">
                      {group}
                    </div>
                  ) : null}
                  {items.map((item) => {
                    const index = filtered.indexOf(item)
                    const Icon = item.icon
                    const active = index === activeIndex
                    return (
                      <button
                        key={item.id}
                        id={`command-palette-item-${item.id}`}
                        role="option"
                        aria-selected={active}
                        data-command-index={index}
                        type="button"
                        onMouseMove={() => setRawIndex(index)}
                        onClick={() => {
                          item.onSelect()
                          handleOpenChange(false)
                        }}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                          active
                            ? 'bg-surface-muted text-ink'
                            : 'text-ink hover:bg-surface-muted/60'
                        )}
                      >
                        {Icon ? (
                          <Icon
                            className={cn(
                              'size-4 shrink-0',
                              active ? 'text-ink' : 'text-ink-faint'
                            )}
                          />
                        ) : (
                          <span className="size-4 shrink-0" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.description ? (
                          <span className="ml-2 truncate text-xs text-ink-muted">
                            {item.description}
                          </span>
                        ) : null}
                        {item.kbd?.length ? (
                          <span className="ml-2 flex items-center gap-1">
                            {item.kbd.map((k, i) => (
                              <Kbd key={i}>{k}</Kbd>
                            ))}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>

          <div className="flex h-9 items-center justify-between gap-3 border-t border-line bg-surface-muted/60 px-3 text-[11px] text-ink-faint">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1">
                <Kbd>{String.fromCharCode(8593)}</Kbd>
                <Kbd>{String.fromCharCode(8595)}</Kbd>
                navigate
              </span>
              <span className="flex items-center gap-1">
                <Kbd>{String.fromCharCode(8629)}</Kbd>
                select
              </span>
              <span className="flex items-center gap-1">
                <Kbd>esc</Kbd>
                close
              </span>
            </div>
            <div className="font-mono">{filtered.length}</div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
