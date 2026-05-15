import { cn } from '@/lib/utils'

export type StatusTone = 'success' | 'info' | 'warning' | 'error' | 'neutral' | 'accent'

const toneClass: Record<StatusTone, string> = {
  success: 'bg-ok',
  info: 'bg-info',
  warning: 'bg-warn',
  error: 'bg-bad',
  neutral: 'bg-ink-faint',
  accent: 'bg-accent'
}

const toneRing: Record<StatusTone, string> = {
  success: 'ring-ok/15',
  info: 'ring-info/15',
  warning: 'ring-warn/15',
  error: 'ring-bad/15',
  neutral: 'ring-ink-faint/15',
  accent: 'ring-accent/15'
}

/** Statuses that show a soft pulse (in-flight / waiting attention). */
const PULSE_STATUSES = new Set([
  'pending',
  'queued',
  'running',
  'in_progress',
  'working',
  'pending_review'
])

const STATUS_MAP: Record<string, { tone: StatusTone; label?: string }> = {
  // Crawl / campaign statuses
  draft: { tone: 'neutral' },
  pending: { tone: 'warning' },
  queued: { tone: 'warning' },
  running: { tone: 'info' },
  in_progress: { tone: 'info', label: 'in progress' },
  succeeded: { tone: 'success' },
  completed: { tone: 'success' },
  partial: { tone: 'warning' },
  failed: { tone: 'error' },
  // Mailboxes
  active: { tone: 'success' },
  // Person lifecycle
  new: { tone: 'accent' },
  qualified: { tone: 'success' },
  contacted: { tone: 'info' },
  unqualified: { tone: 'neutral' },
  // Outreach (account-level)
  dormant: { tone: 'neutral' },
  working: { tone: 'info' },
  paused: { tone: 'warning' },
  dead: { tone: 'error' },
  // Outreach drafts
  pending_review: { tone: 'warning', label: 'pending review' },
  approved: { tone: 'success' },
  sent: { tone: 'success' },
  discarded: { tone: 'neutral' }
}

export function statusToTone(status: string): { tone: StatusTone; label: string } {
  const mapped = STATUS_MAP[status?.toLowerCase?.() ?? '']
  return {
    tone: mapped?.tone ?? 'neutral',
    label: mapped?.label ?? status?.replace(/_/g, ' ') ?? 'unknown'
  }
}

export interface StatusDotProps {
  tone?: StatusTone
  status?: string
  label?: React.ReactNode
  className?: string
  /** When omitted, pulse is on for in-flight statuses (see PULSE_STATUSES). */
  pulse?: boolean
  size?: 'sm' | 'md'
}

export function StatusDot({
  tone,
  status,
  label,
  className,
  pulse,
  size = 'md'
}: StatusDotProps) {
  let resolvedTone: StatusTone = tone ?? 'neutral'
  let resolvedLabel: React.ReactNode = label
  if (status && !tone) {
    const m = statusToTone(status)
    resolvedTone = m.tone
    if (resolvedLabel === undefined) resolvedLabel = m.label
  } else if (status && resolvedLabel === undefined) {
    resolvedLabel = status
  }

  const normalizedStatus = status?.toLowerCase?.() ?? ''
  const shouldPulse =
    pulse !== undefined ? pulse : Boolean(status && PULSE_STATUSES.has(normalizedStatus))

  const dotSize = size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2'
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm text-ink', className)}>
      <span className="relative inline-flex">
        <span
          className={cn(
            'inline-block rounded-full ring-4',
            dotSize,
            toneClass[resolvedTone],
            toneRing[resolvedTone],
            shouldPulse && 'animate-statusDotPulse'
          )}
        />
      </span>
      {resolvedLabel ? (
        <span className="capitalize text-[13px] text-ink">{resolvedLabel}</span>
      ) : null}
    </span>
  )
}
