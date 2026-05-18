import {
  Check,
  ChevronDown,
  Inbox,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import {
  apiGet,
  type DraftDetail,
  type DraftQueueRow,
  type Mailbox,
  type OutreachDraftStatus
} from '@/api'
import { Badge } from '@/components/ui/badge'
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'

import {
  DraftDetailPanel,
  type DraftDetailPanelHandle
} from '@/features/drafts/DraftDetailPanel'
import { DraftListItem } from '@/features/drafts/DraftListItem'

type StatusFilter = OutreachDraftStatus | 'all'

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'pending_review', label: 'Pending' },
  { value: 'sent', label: 'Sent' },
  { value: 'discarded', label: 'Discarded' },
  { value: 'failed', label: 'Failed' },
  { value: 'all', label: 'All' }
]

type LoadResult = { ok: true; selectedId: string | null } | { ok: false }

interface Props {
  mailboxes: Mailbox[]
  onPendingReviewChanged?: () => void
}

export function DraftsPage({ mailboxes, onPendingReviewChanged }: Props) {
  const [status, setStatus] = useState<StatusFilter>('pending_review')
  const [mailboxId, setMailboxId] = useState<string | 'all'>('all')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<DraftQueueRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DraftDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [railOpen, setRailOpen] = useState(true)

  const detailRef = useRef<DraftDetailPanelHandle | null>(null)

  const load = useCallback(
    async (preferredSelectedId: string | null): Promise<LoadResult> => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (status !== 'all') params.set('status', status)
        else params.set('status', '')
        if (mailboxId !== 'all') params.set('mailboxId', mailboxId)
        const qs = params.toString()
        const res = await apiGet<{ data: DraftQueueRow[] }>(
          '/drafts' + (qs ? '?' + qs : '')
        )
        setRows(res.data)
        let nextSelectedId = preferredSelectedId
        if (
          res.data.length > 0 &&
          !res.data.some((r) => r.draft.id === preferredSelectedId)
        ) {
          nextSelectedId = res.data[0].draft.id
        } else if (res.data.length === 0) {
          nextSelectedId = null
        }
        setSelectedId(nextSelectedId)
        return { ok: true, selectedId: nextSelectedId }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load drafts')
        return { ok: false }
      } finally {
        setLoading(false)
      }
    },
    [status, mailboxId]
  )

  useEffect(() => {
    void load(selectedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, mailboxId])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    apiGet<DraftDetail>('/drafts/' + selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load draft')
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const refreshAfterAction = useCallback(async () => {
    const currentSelectedId = selectedId
    const result = await load(currentSelectedId)
    onPendingReviewChanged?.()
    if (!result.ok) return
    if (result.selectedId !== currentSelectedId) {
      setDetail(null)
      return
    }
    if (result.selectedId) {
      setDetailLoading(true)
      apiGet<DraftDetail>('/drafts/' + result.selectedId)
        .then(setDetail)
        .catch((err) =>
          setError(err instanceof Error ? err.message : 'Refresh failed')
        )
        .finally(() => setDetailLoading(false))
    }
  }, [selectedId, load, onPendingReviewChanged])

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => {
      const hay = [
        r.company?.name,
        r.draft.subject,
        r.draft.toEmail,
        r.person?.fullName,
        r.draft.agentRationale
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [rows, search])

  const statusCounts = useMemo(() => {
    const map = new Map<StatusFilter, number>()
    for (const r of rows) {
      map.set(r.draft.status, (map.get(r.draft.status) ?? 0) + 1)
    }
    map.set('all', rows.length)
    return map
  }, [rows])

  const mailboxOptions = useMemo(
    () => [
      { id: 'all' as const, email: 'All mailboxes' },
      ...mailboxes.map((m) => ({ id: m.id, email: m.email }))
    ],
    [mailboxes]
  )

  const selectedIndex = useMemo(
    () => filteredRows.findIndex((r) => r.draft.id === selectedId),
    [filteredRows, selectedId]
  )

  const navigate = useCallback(
    (delta: 1 | -1) => {
      if (filteredRows.length === 0) return
      const base = selectedIndex >= 0 ? selectedIndex : 0
      const next = Math.min(
        filteredRows.length - 1,
        Math.max(0, base + delta)
      )
      const id = filteredRows[next]?.draft.id
      if (id) setSelectedId(id)
    },
    [filteredRows, selectedIndex]
  )

  // Keyboard shortcuts (queue navigation + actions)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const inField =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)

      // Cmd/Ctrl+Enter: approve & send (even from inside fields)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void detailRef.current?.approve()
        return
      }

      if (inField) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
        e.preventDefault()
        navigate(1)
      } else if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
        e.preventDefault()
        navigate(-1)
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        detailRef.current?.focusRegenerate()
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        void detailRef.current?.discard()
      } else if (e.key === '[') {
        e.preventDefault()
        setRailOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate])

  const queueLabel =
    status === 'pending_review'
      ? 'pending review'
      : status === 'all'
        ? 'all drafts'
        : status.replace(/_/g, ' ')

  const showStatusDot = status === 'all'

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {error ? (
        <div className="border-b border-line bg-bg px-5 py-2.5">
          <Banner
            tone="error"
            title="Something went wrong"
            description={error}
            onDismiss={() => setError(null)}
          />
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] divide-x divide-line">
        {/* Queue column */}
        <div className="flex min-h-0 flex-col">
          {/* Queue header */}
          <div className="shrink-0 border-b border-line px-3 py-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="flex items-baseline gap-1.5">
                <Mail className="size-3.5 text-ink-faint" />
                <span className="text-[13px] font-semibold text-ink">
                  {filteredRows.length}
                </span>
                <span className="text-2xs text-ink-muted">{queueLabel}</span>
                {search && filteredRows.length !== rows.length ? (
                  <span className="text-2xs text-ink-faint">
                    of {rows.length}
                  </span>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                onClick={() => {
                  void load(selectedId)
                  onPendingReviewChanged?.()
                }}
                loading={loading && rows.length > 0}
                title="Refresh"
              >
                {!(loading && rows.length > 0) ? <RefreshCw /> : null}
              </Button>
            </div>

            <div className="flex flex-wrap gap-1">
              {STATUS_OPTIONS.map((opt) => {
                const active = status === opt.value
                const count = active ? statusCounts.get(opt.value) ?? 0 : null
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setStatus(opt.value)}
                    className={
                      'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-2xs transition-colors ' +
                      (active
                        ? 'border-accent/30 bg-accent-soft text-accent'
                        : 'border-line bg-surface text-ink-muted hover:bg-surface-muted hover:text-ink')
                    }
                  >
                    {opt.label}
                    {active && count !== null ? (
                      <span className="font-medium tabular-nums">{count}</span>
                    ) : null}
                  </button>
                )
              })}
            </div>

            <Input
              iconLeft={Search}
              placeholder="Search subject, person, rationale…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              iconRight={
                search ? (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="rounded p-0.5 hover:bg-surface-muted hover:text-ink"
                    aria-label="Clear search"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null
              }
            />

            {mailboxes.length > 1 ? (
              <div className="relative">
                <select
                  value={mailboxId}
                  onChange={(e) => setMailboxId(e.target.value as 'all' | string)}
                  className="h-7 w-full appearance-none rounded-md border border-line bg-surface px-2.5 pr-7 text-xs text-ink-muted focus:outline-none focus:ring-2 focus:ring-accent/25"
                >
                  {mailboxOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.email}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
              </div>
            ) : null}
          </div>

          {/* Queue list */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && rows.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-6 text-sm text-ink-muted">
                <Loader2 className="size-4 animate-spin" /> Loading drafts…
              </div>
            ) : filteredRows.length === 0 ? (
              <EmptyState
                icon={status === 'pending_review' ? Check : Inbox}
                title={
                  search
                    ? 'No matches'
                    : status === 'pending_review'
                      ? 'Inbox zero'
                      : 'Nothing here'
                }
                description={
                  search
                    ? 'Try a different keyword, or clear the search.'
                    : status === 'pending_review'
                      ? 'No drafts waiting on you. New ones land here as the agent works accounts.'
                      : 'Switch the filter above to see other drafts.'
                }
                compact
              />
            ) : (
              <ul className="divide-y divide-line">
                {filteredRows.map((row) => (
                  <DraftListItem
                    key={row.draft.id}
                    row={row}
                    selected={selectedId === row.draft.id}
                    showStatusDot={showStatusDot}
                    onSelect={() => setSelectedId(row.draft.id)}
                  />
                ))}
              </ul>
            )}
          </div>

          {/* Pending counter footer */}
          {status === 'pending_review' && filteredRows.length > 0 ? (
            <div className="shrink-0 border-t border-line bg-surface-muted/40 px-3 py-1.5 text-2xs text-ink-faint">
              <Badge variant="accent" className="h-5 px-1.5 text-2xs">
                {selectedIndex >= 0 ? selectedIndex + 1 : '–'}
              </Badge>
              <span className="ml-2">
                of {filteredRows.length} — use <span className="font-mono">J</span>/
                <span className="font-mono">K</span> to navigate
              </span>
            </div>
          ) : null}
        </div>

        {/* Detail column */}
        <div className="min-h-0 overflow-hidden">
          {!selectedId ? (
            <div className="grid h-full place-items-center p-10 text-center text-sm text-ink-muted">
              {rows.length === 0
                ? 'Pick a filter to see drafts.'
                : 'Select a draft to review.'}
            </div>
          ) : detailLoading && !detail ? (
            <div className="flex h-full items-center justify-center gap-2 p-10 text-sm text-ink-muted">
              <Loader2 className="size-4 animate-spin" /> Loading draft…
            </div>
          ) : detail ? (
            <DraftDetailPanel
              ref={detailRef}
              detail={detail}
              railOpen={railOpen}
              onToggleRail={() => setRailOpen((v) => !v)}
              onChanged={refreshAfterAction}
              onError={setError}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
