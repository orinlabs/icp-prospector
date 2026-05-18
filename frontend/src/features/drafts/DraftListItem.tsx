import { Sparkles } from 'lucide-react'

import type { DraftQueueRow } from '@/api'
import { StatusDot } from '@/components/ui/status-dot'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

function snippet(text: string | null | undefined, max = 110): string | null {
  if (!text) return null
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= max) return cleaned
  return cleaned.slice(0, max - 1).trimEnd() + '…'
}

export function DraftListItem({
  row,
  selected,
  showStatusDot,
  onSelect
}: {
  row: DraftQueueRow
  selected: boolean
  showStatusDot: boolean
  onSelect: () => void
}) {
  const { draft, company, person } = row
  const rationale = snippet(draft.agentRationale)
  const personLine = person?.fullName
    ? person.fullName + (person.title ? ' · ' + person.title : '')
    : draft.toEmail
  const time = formatRelative(draft.createdAt)

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'group relative flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors',
          'hover:bg-surface-muted/60',
          selected && 'bg-surface-muted'
        )}
      >
        {selected ? (
          <span
            aria-hidden
            className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent"
          />
        ) : null}

        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-ink">
              {company?.name ?? '(unknown company)'}
            </span>
            {showStatusDot ? <StatusDot status={draft.status} size="sm" /> : null}
          </div>
          {time ? (
            <span className="shrink-0 text-2xs text-ink-faint" title={draft.createdAt}>
              {time}
            </span>
          ) : null}
        </div>

        <div className="truncate text-[13px] text-ink">{draft.subject || '(no subject)'}</div>

        {rationale ? (
          <div className="flex items-start gap-1.5 text-2xs text-ink-muted">
            <Sparkles className="mt-0.5 size-3 shrink-0 text-accent/70" />
            <span className="line-clamp-2 leading-snug">{rationale}</span>
          </div>
        ) : null}

        <div className="truncate text-2xs text-ink-faint">{personLine}</div>
      </button>
    </li>
  )
}
