import {
  Building2,
  ChevronRight,
  Filter,
  Pause,
  Play,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { apiPatch, apiPost, type Company, type Mailbox } from '@/api'
import { Button } from '@/components/ui/button'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import { StatusDot } from '@/components/ui/status-dot'
import { Toolbar, ToolbarSpacer } from '@/components/ui/toolbar'
import { faviconUrl, formatRelative } from '@/lib/format'
import { TABLE_SEARCH_DEBOUNCE_MS, type CompaniesTableFetchParams } from '@/lib/listFetchParams'
import { cn } from '@/lib/utils'

const filterSelectClass =
  'h-8 rounded-md border border-line bg-surface px-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/25'

const OUTREACH_STATUS_VALUES: readonly Company['outreachStatus'][] = [
  'dormant',
  'completed',
  'dead',
  'paused',
  'working'
]

interface Props {
  companies: Company[]
  mailboxes: Mailbox[]
  pendingDraftsByCompany: Map<string, number>
  loading: boolean
  hasMore: boolean
  mergeTableFetchParams: (patch: Partial<CompaniesTableFetchParams>) => void
  onRefresh: () => void
  onLoadMore: () => void
  onSelectCompany: (company: Company) => void
  selectedKey: string | null
  onError: (msg: string) => void
  agenticMatchIds: Set<string> | null
  onClearAgenticResults: () => void
  onVisibleIdsChange: (ids: string[]) => void
}

export function CompaniesPage({
  companies,
  mailboxes,
  pendingDraftsByCompany,
  loading,
  hasMore,
  mergeTableFetchParams,
  onRefresh,
  onLoadMore,
  onSelectCompany,
  selectedKey,
  onError,
  agenticMatchIds,
  onClearAgenticResults,
  onVisibleIdsChange
}: Props) {
  const [search, setSearch] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkMailboxId, setBulkMailboxId] = useState<string | null>(null)
  const [bulkStarting, setBulkStarting] = useState(false)
  const [bulkPausing, setBulkPausing] = useState(false)
  const [outreachFilter, setOutreachFilter] = useState<'all' | Company['outreachStatus']>('all')
  const [mailboxFilter, setMailboxFilter] = useState('all')
  const [peopleFilter, setPeopleFilter] = useState('all')
  const [draftFilter, setDraftFilter] = useState('all')

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const trimmed = search.trim()
      mergeTableFetchParams({ q: trimmed || undefined })
    }, TABLE_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [search, mergeTableFetchParams])

  useEffect(() => {
    const patch: Partial<CompaniesTableFetchParams> = {}
    if (outreachFilter === 'all') patch.outreachStatus = undefined
    else patch.outreachStatus = outreachFilter

    if (mailboxFilter === 'all') {
      patch.mailboxId = undefined
      patch.mailboxScope = undefined
    } else if (mailboxFilter === 'assigned') {
      patch.mailboxId = undefined
      patch.mailboxScope = 'assigned'
    } else if (mailboxFilter === 'unassigned') {
      patch.mailboxId = undefined
      patch.mailboxScope = 'unassigned'
    } else {
      patch.mailboxId = mailboxFilter
      patch.mailboxScope = undefined
    }

    if (peopleFilter === 'all') patch.hasPeople = undefined
    else if (peopleFilter === 'with_people') patch.hasPeople = 'true'
    else patch.hasPeople = 'false'

    if (draftFilter === 'all') patch.pendingDrafts = undefined
    else if (draftFilter === 'pending') patch.pendingDrafts = 'true'
    else patch.pendingDrafts = 'false'

    mergeTableFetchParams(patch)
  }, [outreachFilter, mailboxFilter, peopleFilter, draftFilter, mergeTableFetchParams])

  useEffect(() => {
    if (!agenticMatchIds) return
    setSelected(new Set(agenticMatchIds))
  }, [agenticMatchIds])

  const mailboxById = useMemo(() => new Map(mailboxes.map((m) => [m.id, m])), [mailboxes])

  const visibleRows = agenticMatchIds
    ? companies.filter((c) => agenticMatchIds.has(c.id))
    : companies

  useEffect(() => {
    onVisibleIdsChange(visibleRows.map((c) => c.id))
  }, [visibleRows, onVisibleIdsChange])

  const activeMailboxes = useMemo(
    () => mailboxes.filter((m) => m.status === 'active'),
    [mailboxes]
  )

  const activeFilterCount =
    (outreachFilter !== 'all' ? 1 : 0) +
    (mailboxFilter !== 'all' ? 1 : 0) +
    (peopleFilter !== 'all' ? 1 : 0) +
    (draftFilter !== 'all' ? 1 : 0)
  const hasActiveFilters = activeFilterCount > 0
  const filterSummary =
    activeFilterCount > 0 ? 'Clear filters (' + activeFilterCount + ')' : 'Clear filters'

  const trimmedSearch = search.trim()

  function clearFilters() {
    setOutreachFilter('all')
    setMailboxFilter('all')
    setPeopleFilter('all')
    setDraftFilter('all')
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAllVisible(check: boolean) {
    if (!check) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(visibleRows.map((c) => c.id)))
  }

  const allVisibleSelected =
    visibleRows.length > 0 && visibleRows.every((c) => selected.has(c.id))

  async function bulkStart() {
    if (selected.size === 0) return
    if (!bulkMailboxId) {
      onError('Pick a mailbox before starting.')
      return
    }
    setBulkStarting(true)
    try {
      await apiPost('/companies/outreach/start', {
        companyIds: Array.from(selected),
        mailboxId: bulkMailboxId
      })
      setSelected(new Set())
      onRefresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Bulk start failed')
    } finally {
      setBulkStarting(false)
    }
  }

  async function bulkSetStatus(status: 'paused' | 'completed' | 'dormant') {
    if (selected.size === 0) return
    setBulkPausing(true)
    try {
      await Promise.all(
        Array.from(selected).map((id) =>
          apiPatch('/companies/' + id + '/outreach/status', { status })
        )
      )
      setSelected(new Set())
      onRefresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Bulk update failed')
    } finally {
      setBulkPausing(false)
    }
  }

  const columns: DataTableColumn<Company>[] = [
    {
      id: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select all"
          checked={allVisibleSelected}
          onChange={(e) => selectAllVisible(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          className="size-3.5 rounded border-line accent-accent"
        />
      ),
      width: '36px',
      cell: (c) => (
        <input
          type="checkbox"
          aria-label={'Select ' + c.name}
          checked={selected.has(c.id)}
          onChange={() => toggleSelected(c.id)}
          onClick={(e) => e.stopPropagation()}
          className="size-3.5 rounded border-line accent-accent"
        />
      )
    },
    {
      id: 'name',
      header: 'Company',
      width: '24%',
      cell: (c) => {
        const fav = faviconUrl(c.domain ?? c.website)
        return (
          <div className="flex items-center gap-2.5">
            {fav ? (
              <img
                src={fav}
                alt=""
                className="size-5 rounded-sm border border-line"
                onError={(e) => ((e.currentTarget.style.visibility = 'hidden'))}
              />
            ) : (
              <span className="size-5 rounded-sm border border-line bg-surface-muted" />
            )}
            <span className="truncate font-medium text-ink">{c.name}</span>
          </div>
        )
      }
    },
    {
      id: 'outreach',
      header: 'Outreach',
      width: '140px',
      cell: (c) => <StatusDot status={c.outreachStatus} size="sm" />
    },
    {
      id: 'mailbox',
      header: 'Mailbox',
      width: '180px',
      cell: (c) => {
        if (!c.outreachMailboxId) return <span className="text-ink-faint">-</span>
        const m = mailboxById.get(c.outreachMailboxId)
        return (
          <span className="truncate font-mono text-[12px] text-ink-muted">
            {m?.email ?? '(missing)'}
          </span>
        )
      }
    },
    {
      id: 'drafts',
      header: 'Drafts',
      align: 'right',
      width: '70px',
      cell: (c) => {
        const n = pendingDraftsByCompany.get(c.id) ?? 0
        return (
          <span
            className={cn(
              'font-mono tabular text-[12.5px]',
              n > 0 ? 'text-warn' : 'text-ink-faint'
            )}
          >
            {n}
          </span>
        )
      }
    },
    {
      id: 'wake',
      header: 'Next wake',
      width: '140px',
      cell: (c) =>
        c.outreachStatus === 'working' && c.outreachNextWakeAt ? (
          <span className="truncate text-[12.5px] text-ink-muted">
            {formatRelative(c.outreachNextWakeAt) ?? '-'}
          </span>
        ) : (
          <span className="text-ink-faint">-</span>
        )
    },
    {
      id: 'domain',
      header: 'Domain',
      width: '18%',
      cell: (c) =>
        c.website || c.domain ? (
          <a
            href={
              c.website ?? (c.domain ? 'https://' + c.domain : '')
            }
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[12px] text-ink-muted underline-offset-4 hover:text-accent hover:underline"
          >
            {c.domain ?? c.website}
          </a>
        ) : (
          <span className="text-ink-faint">-</span>
        )
    },
    {
      id: 'people',
      header: 'People',
      align: 'right',
      width: '70px',
      cell: (c) => {
        const count = typeof c.peopleCount === 'number' ? c.peopleCount : 0
        return (
          <span className="font-mono tabular text-[12.5px] text-ink-muted">{count}</span>
        )
      }
    },
    {
      id: 'arrow',
      header: '',
      width: '40px',
      align: 'right',
      cell: () => (
        <ChevronRight className="size-3.5 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
      )
    }
  ]

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface">
      <Toolbar>
        <Input
          iconLeft={Search}
          placeholder="Search companies..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <ToolbarSpacer />
        <Button
          variant={hasActiveFilters || filtersOpen ? 'subtle' : 'outline'}
          size="md"
          iconLeft={Filter}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          {hasActiveFilters ? 'Filters (' + activeFilterCount + ')' : 'Filters'}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh"
          onClick={onRefresh}
          loading={loading && companies.length > 0}
        >
          {!(loading && companies.length > 0) ? <RefreshCw /> : null}
        </Button>
      </Toolbar>
      {filtersOpen ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-muted/35 px-4 py-2">
          <select
            aria-label="Filter companies by outreach status"
            value={outreachFilter}
            onChange={(e) =>
              setOutreachFilter(e.target.value as 'all' | Company['outreachStatus'])
            }
            className={filterSelectClass}
          >
            <option value="all">All statuses</option>
            {OUTREACH_STATUS_VALUES.map((status) => (
              <option key={status} value={status}>
                {status.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter companies by mailbox"
            value={mailboxFilter}
            onChange={(e) => setMailboxFilter(e.target.value)}
            className={filterSelectClass + ' max-w-[190px]'}
          >
            <option value="all">All mailboxes</option>
            <option value="assigned">Has mailbox</option>
            <option value="unassigned">No mailbox</option>
            {activeMailboxes.map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>
                {mailbox.email}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter companies by people count"
            value={peopleFilter}
            onChange={(e) => setPeopleFilter(e.target.value)}
            className={filterSelectClass}
          >
            <option value="all">Any people</option>
            <option value="with_people">Has people</option>
            <option value="without_people">No people</option>
          </select>
          <select
            aria-label="Filter companies by pending drafts"
            value={draftFilter}
            onChange={(e) => setDraftFilter(e.target.value)}
            className={filterSelectClass}
          >
            <option value="all">Any drafts</option>
            <option value="pending">Pending drafts</option>
            <option value="none">No pending drafts</option>
          </select>
          {hasActiveFilters ? (
            <Button variant="ghost" size="sm" iconLeft={X} onClick={clearFilters}>
              {filterSummary}
            </Button>
          ) : null}
        </div>
      ) : null}
      {agenticMatchIds ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-line bg-accent-soft px-5 py-2">
          <span className="text-sm font-medium text-ink">
            Agentic search matched {agenticMatchIds.size}{' '}
            {agenticMatchIds.size === 1 ? 'company' : 'companies'}
          </span>
          <ToolbarSpacer />
          <Button variant="ghost" size="sm" iconLeft={X} onClick={onClearAgenticResults}>
            Clear
          </Button>
        </div>
      ) : null}
      {selected.size > 0 ? (
        <div className="flex items-center gap-3 border-b border-line bg-accent-soft px-5 py-2">
          <span className="text-sm font-medium text-ink">{selected.size} selected</span>
          <select
            value={bulkMailboxId ?? ''}
            onChange={(e) => setBulkMailboxId(e.target.value || null)}
            className="h-8 rounded-md border border-line bg-surface px-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/25"
          >
            <option value="">Pick a mailbox...</option>
            {activeMailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.email}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            size="sm"
            iconLeft={Play}
            disabled={!bulkMailboxId}
            loading={bulkStarting}
            onClick={bulkStart}
          >
            Start working
          </Button>
          <Button
            variant="outline"
            size="sm"
            iconLeft={Pause}
            loading={bulkPausing}
            onClick={() => bulkSetStatus('paused')}
          >
            Pause
          </Button>
          <Button
            variant="outline"
            size="sm"
            loading={bulkPausing}
            onClick={() => bulkSetStatus('completed')}
          >
            Mark completed
          </Button>
          <ToolbarSpacer />
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}
      <DataTable
        columns={columns}
        rows={visibleRows}
        rowKey={(c) => c.id}
        loading={loading}
        hasMore={hasMore && !agenticMatchIds}
        onLoadMore={onLoadMore}
        onRowClick={onSelectCompany}
        selectedRowKey={selectedKey}
        minWidth="1100px"
        empty={
          trimmedSearch || hasActiveFilters || agenticMatchIds
            ? {
                icon: Filter,
                title: 'No matching companies',
                description: 'Try changing the search or filters.'
              }
            : {
                icon: Building2,
                title: 'No companies yet',
                description:
                  'Companies appear automatically as the crawler discovers prospects matching your ICP.'
              }
        }
      />
    </section>
  )
}
