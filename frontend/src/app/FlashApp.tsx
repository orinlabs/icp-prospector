import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'

import {
  AgenticSearchModal,
  type AgenticSearchProgress,
  type AgenticSearchTarget
} from '@/components/AgenticSearchModal'
import {
  apiGet,
  apiPost,
  apiPostNdjson,
  type AuthSession,
  type AuthUser,
  type Campaign,
  type CampaignRun,
  type Company,
  type DraftQueueRow,
  type Mailbox,
  type Person,
  type ProspectList,
  type UsageByCampaignRow,
  type UsageByRunRow
} from '@/api'
import { CommandPalette } from '@/components/CommandPalette'
import { AppShell } from '@/components/layout/AppShell'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Banner } from '@/components/ui/banner'
import { CampaignsPage } from '@/pages/CampaignsPage'
import { CompaniesPage } from '@/pages/CompaniesPage'
import { CrawlsPage } from '@/pages/CrawlsPage'
import { DetailDrawer } from '@/pages/DetailDrawer'
import { DraftsPage } from '@/pages/DraftsPage'
import { MailboxesPage } from '@/pages/MailboxesPage'
import { PeoplePage } from '@/pages/PeoplePage'
import { ListsPage } from '@/pages/ListsPage'
import { UsagePage } from '@/pages/UsagePage'
import {
  buildCrawlPeopleListPath,
  type CompaniesTableFetchParams,
  type PeopleTableFetchParams
} from '@/lib/listFetchParams'
import { emailToInitials } from '@/lib/userDisplay'
import { buildCommandItems } from './commandPaletteItems'
import { useDrawerPeople } from './useDrawerPeople'
import { usePaletteRecordSearch } from './usePaletteRecordSearch'
import { buildCompaniesPath, buildPeoplePath } from './listPaths'
import { headerCopy, isTabId, sections, type TabId } from './navigation'
import { TabHeaderActions } from './TabHeaderActions'
import type {
  AgenticCompanySearchResponse,
  AgenticCompanySearchStreamEvent,
  AgenticPeopleSearchResponse,
  AgenticPeopleSearchStreamEvent,
  DetailSelection,
  PagedResponse,
  PeopleCrawlFilter
} from './types'

const PAGE_SIZE = 100

function parseDetailFromSearch(search: URLSearchParams): DetailSelection | null {
  const kind = search.get('kind')
  const id = search.get('id')
  if (!kind || !id) return null
  if (kind === 'person' || kind === 'company' || kind === 'crawl') {
    return { type: kind, id }
  }
  return null
}

export function FlashApp({
  authUser,
  activeOrganization,
  setAuthSession
}: {
  authUser: AuthUser
  activeOrganization: AuthSession['activeOrganization']
  setAuthSession: Dispatch<SetStateAction<AuthSession | null>>
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { tab: tabParam } = useParams<{ tab: string }>()
  const tabValid = isTabId(tabParam)
  const activeTab: TabId = tabValid ? tabParam : 'people'

  const detail = useMemo(
    () => parseDetailFromSearch(new URLSearchParams(location.search)),
    [location.search]
  )

  const openDetail = useCallback(
    (sel: DetailSelection | null) => {
      if (!sel) {
        navigate({ pathname: location.pathname, search: '' }, { replace: true })
        return
      }
      const sp = new URLSearchParams(location.search)
      sp.set('kind', sel.type)
      sp.set('id', sel.id)
      navigate({ pathname: location.pathname, search: sp.toString() })
    },
    [navigate, location.pathname, location.search]
  )

  const goToTab = useCallback(
    (id: TabId) => {
      navigate({ pathname: '/' + id, search: location.search })
    },
    [navigate, location.search]
  )

  const [crawls, setCrawls] = useState<Campaign[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [lists, setLists] = useState<ProspectList[]>([])
  const [peopleHasMore, setPeopleHasMore] = useState(true)
  const [companiesHasMore, setCompaniesHasMore] = useState(true)
  const [crawlsLoading, setCrawlsLoading] = useState(true)
  const [companiesLoading, setCompaniesLoading] = useState(true)
  const [peopleLoading, setPeopleLoading] = useState(false)
  const [listsLoading, setListsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [crawlRunsByCrawlId, setCrawlRunsByCrawlId] = useState<
    Record<string, CampaignRun[]>
  >({})
  const [crawlRunsLoading, setCrawlRunsLoading] = useState(false)
  const [crawlUsageByCrawlId, setCrawlUsageByCrawlId] = useState<
    Record<
      string,
      { totals: UsageByCampaignRow | null; runs: UsageByRunRow[] } | undefined
    >
  >({})
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [mailboxesLoading, setMailboxesLoading] = useState(false)
  const [pendingDraftsByCompany, setPendingDraftsByCompany] = useState<Map<string, number>>(
    new Map()
  )
  const [pendingDraftCount, setPendingDraftCount] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const {
    people: palettePeopleHits,
    companies: paletteCompanyHits,
    loading: paletteRecordSearchLoading
  } = usePaletteRecordSearch({
    open: paletteOpen,
    query: paletteQuery,
    onError: setError
  })
  const [agenticSearchOpen, setAgenticSearchOpen] = useState(false)
  const [peopleFetchParams, setPeopleFetchParams] = useState<PeopleTableFetchParams>({})
  const [companiesFetchParams, setCompaniesFetchParams] = useState<CompaniesTableFetchParams>({})
  const peopleFetchParamsRef = useRef(peopleFetchParams)
  peopleFetchParamsRef.current = peopleFetchParams
  const companiesFetchParamsRef = useRef(companiesFetchParams)
  companiesFetchParamsRef.current = companiesFetchParams

  const peopleLoadAbortRef = useRef<AbortController | null>(null)
  const companiesLoadAbortRef = useRef<AbortController | null>(null)
  const [agenticPeopleMatchIds, setAgenticPeopleMatchIds] = useState<Set<string> | null>(null)
  const [agenticCompanyMatchIds, setAgenticCompanyMatchIds] = useState<Set<string> | null>(null)
  const [peopleCrawlFilter, setPeopleCrawlFilter] = useState<PeopleCrawlFilter | null>(null)
  const [companyCrawlSelection, setCompanyCrawlSelection] = useState<{
    key: string
    campaignId: string
    campaignRunId: string | null
    label: string
    runLabel?: string
  } | null>(null)
  const [visiblePersonIds, setVisiblePersonIds] = useState<string[]>([])
  const [visibleCompanyIds, setVisibleCompanyIds] = useState<string[]>([])
  const {
    companyPeople: companyDrawerPeople,
    companyPeopleLoading: companyDrawerPeopleLoading,
    crawlPeople: crawlDrawerPeople,
    crawlPeopleLoading: crawlDrawerPeopleLoading,
    setCrawlPeople: setCrawlDrawerPeople
  } = useDrawerPeople({ detail, onError: setError })

  const [name, setName] = useState('My ICP run')
  const [icpDocument, setIcpDocument] = useState(
    'Describe your ideal customer profile here.'
  )
  const [targetCount, setTargetCount] = useState(10)

  const loadCrawls = useCallback(async () => {
    setError(null)
    const data = await apiGet<Campaign[]>('/campaigns')
    setCrawls(data)
  }, [])

  const loadCrawlRuns = useCallback(async (crawlId: string) => {
    setCrawlRunsLoading(true)
    try {
      const [runs, byCampaign, byRun] = await Promise.all([
        apiGet<CampaignRun[]>('/campaigns/' + crawlId + '/runs'),
        apiGet<{ data: UsageByCampaignRow[] }>('/usage/by-campaign'),
        apiGet<{ data: UsageByRunRow[] }>(
          '/usage/by-run?campaign_id=' + crawlId
        )
      ])
      setCrawlRunsByCrawlId((current) => ({ ...current, [crawlId]: runs }))
      const totals =
        byCampaign.data.find((r) => r.campaignId === crawlId) ?? null
      setCrawlUsageByCrawlId((current) => ({
        ...current,
        [crawlId]: { totals, runs: byRun.data }
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runs')
    } finally {
      setCrawlRunsLoading(false)
    }
  }, [])

  const mergePeopleFetchParams = useCallback((patch: Partial<PeopleTableFetchParams>) => {
    setPeopleFetchParams((prev) => {
      const next: PeopleTableFetchParams = { ...prev }
      for (const k of Object.keys(patch) as (keyof PeopleTableFetchParams)[]) {
        const v = patch[k]
        if (v === undefined) delete next[k]
        else next[k] = v as never
      }
      return next
    })
  }, [])

  const mergeCompaniesFetchParams = useCallback((patch: Partial<CompaniesTableFetchParams>) => {
    setCompaniesFetchParams((prev) => {
      const next: CompaniesTableFetchParams = { ...prev }
      for (const k of Object.keys(patch) as (keyof CompaniesTableFetchParams)[]) {
        const v = patch[k]
        if (v === undefined) delete next[k]
        else next[k] = v as never
      }
      return next
    })
  }, [])

  const loadPeople = useCallback(
    async (offset = 0, crawlOverride?: PeopleCrawlFilter | null) => {
      const activeCrawl = crawlOverride === undefined ? peopleCrawlFilter : crawlOverride
      peopleLoadAbortRef.current?.abort()
      const ac = new AbortController()
      peopleLoadAbortRef.current = ac
      setPeopleLoading(true)
      setError(null)
      try {
        const path = buildPeoplePath(
          offset,
          activeCrawl,
          peopleFetchParamsRef.current,
          PAGE_SIZE
        )
        const res = await apiGet<PagedResponse<Person>>(path, { signal: ac.signal })
        setPeople((current) => (offset === 0 ? res.data : [...current, ...res.data]))
        setPeopleHasMore(res.data.length === PAGE_SIZE)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Failed to load people')
      } finally {
        if (!ac.signal.aborted) setPeopleLoading(false)
      }
    },
    [peopleCrawlFilter]
  )

  const loadCompanies = useCallback(async (offset = 0) => {
    companiesLoadAbortRef.current?.abort()
    const ac = new AbortController()
    companiesLoadAbortRef.current = ac
    setCompaniesLoading(true)
    setError(null)
    try {
      const path = buildCompaniesPath(offset, companiesFetchParamsRef.current, PAGE_SIZE)
      const res = await apiGet<PagedResponse<Company>>(path, { signal: ac.signal })
      setCompanies((current) => (offset === 0 ? res.data : [...current, ...res.data]))
      setCompaniesHasMore(res.data.length === PAGE_SIZE)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Failed to load companies')
    } finally {
      if (!ac.signal.aborted) setCompaniesLoading(false)
    }
  }, [])

  const loadMailboxes = useCallback(async () => {
    setMailboxesLoading(true)
    try {
      const data = await apiGet<Mailbox[]>('/mailboxes')
      setMailboxes(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mailboxes')
    } finally {
      setMailboxesLoading(false)
    }
  }, [])

  const loadLists = useCallback(async () => {
    setListsLoading(true)
    try {
      const res = await apiGet<{ data: ProspectList[] }>('/lists')
      setLists(res.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load lists')
    } finally {
      setListsLoading(false)
    }
  }, [])

  const loadPendingDrafts = useCallback(async () => {
    try {
      const res = await apiGet<{ data: DraftQueueRow[]; total: number }>(
        '/drafts?status=pending_review&limit=200'
      )
      const map = new Map<string, number>()
      for (const row of res.data) {
        if (!row.company) continue
        map.set(row.company.id, (map.get(row.company.id) ?? 0) + 1)
      }
      setPendingDraftsByCompany(map)
      setPendingDraftCount(res.total)
    } catch {
      // non-fatal
    }
  }, [])

  useEffect(() => {
    if (!authUser) return
    let cancelled = false
    ;(async () => {
      setCrawlsLoading(true)
      try {
        await loadCrawls()
        await loadMailboxes()
        await loadLists()
        await loadPendingDrafts()
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load data')
        }
      } finally {
        if (!cancelled) setCrawlsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authUser, loadCrawls, loadMailboxes, loadLists, loadPendingDrafts])

  useEffect(() => {
    if (!authUser) return
    void loadPeople(0)
  }, [authUser, peopleCrawlFilter, peopleFetchParams, loadPeople])

  useEffect(() => {
    if (!authUser) return
    void loadCompanies(0)
  }, [authUser, companiesFetchParams, loadCompanies])

  async function runCompanyOutreach(companyId: string) {
    setRunningId(companyId)
    setError(null)
    try {
      await apiPost('/companies/' + companyId + '/outreach/run')
      await loadCompanies(0)
      await loadPendingDrafts()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed')
    } finally {
      setRunningId(null)
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      await apiPost<Campaign>('/campaigns', { name, icpDocument, targetCount })
      await loadCrawls()
      goToTab('crawls')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create crawl failed')
    } finally {
      setCreating(false)
    }
  }

  async function startRun(crawlId: string) {
    setRunningId(crawlId)
    setError(null)
    try {
      await apiPost<{ workflowTriggered: boolean }>(
        '/campaigns/' + crawlId + '/runs'
      )
      await loadCrawls()
      await loadCrawlRuns(crawlId)
      await loadPeople(0)
      await loadCompanies(0)
      if (detail?.type === 'crawl' && detail.id === crawlId) {
        const res = await apiGet<PagedResponse<Person>>(buildCrawlPeopleListPath(crawlId))
        setCrawlDrawerPeople(res.data)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Start crawl failed')
    } finally {
      setRunningId(null)
    }
  }

  const companyById = useMemo(
    () => new Map(companies.map((company) => [company.id, company])),
    [companies]
  )
  const personById = useMemo(
    () => new Map(people.map((person) => [person.id, person])),
    [people]
  )
  const crawlById = useMemo(
    () => new Map(crawls.map((c) => [c.id, c])),
    [crawls]
  )

  const selectedPerson =
    detail?.type === 'person' ? (personById.get(detail.id) ?? null) : null
  const selectedCompanyDirect =
    detail?.type === 'company' ? (companyById.get(detail.id) ?? null) : null
  const selectedCompany =
    selectedCompanyDirect ??
    (selectedPerson?.companyId ? (companyById.get(selectedPerson.companyId) ?? null) : null)

  const selectedCrawl =
    detail?.type === 'crawl' ? (crawlById.get(detail.id) ?? null) : null
  const selectedCrawlRuns = selectedCrawl
    ? (crawlRunsByCrawlId[selectedCrawl.id] ?? [])
    : []
  const selectedCrawlUsage = selectedCrawl
    ? (crawlUsageByCrawlId[selectedCrawl.id] ?? null)
    : null

  useEffect(() => {
    if (detail?.type !== 'crawl') return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCrawlRuns(detail.id)
  }, [detail, loadCrawlRuns])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const cmdOrCtrl = e.metaKey || e.ctrlKey
      if (cmdOrCtrl && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteQuery('')
        setPaletteOpen((wasOpen) => !wasOpen)
        return
      }
      if (e.key === 'Escape' && !paletteOpen && detail) {
        openDetail(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [paletteOpen, detail, openDetail])

  const paletteCommands = useMemo(
    () =>
      buildCommandItems({
        lists,
        crawls,
        companyById,
        people: palettePeopleHits,
        companies: paletteCompanyHits,
        goToTab,
        openDetail
      }),
    [lists, crawls, companyById, palettePeopleHits, paletteCompanyHits, goToTab, openDetail]
  )

  function loadMorePeople() {
    if (!peopleLoading && peopleHasMore) {
      void loadPeople(people.length)
    }
  }

  const viewPeopleForCrawl = useCallback(
    (campaignId: string, campaignRunId: string | null = null) => {
      setAgenticPeopleMatchIds(null)
      const nextFilter: PeopleCrawlFilter = { campaignId, campaignRunId }
      setPeopleCrawlFilter(nextFilter)
      void loadCrawlRuns(campaignId)
      openDetail(null)
      goToTab('people')
    },
    [loadCrawlRuns, openDetail, goToTab]
  )

  const selectCompaniesForCrawl = useCallback(
    (campaignId: string, campaignRunId: string | null = null) => {
      setAgenticCompanyMatchIds(null)
      setCompaniesFetchParams(
        campaignRunId ? { campaignId, campaignRunId } : { campaignId }
      )

      const crawl = crawlById.get(campaignId)
      const runs = crawlRunsByCrawlId[campaignId] ?? []
      const runIndex = campaignRunId
        ? runs.findIndex((run) => run.id === campaignRunId)
        : -1
      const runLabel =
        campaignRunId && runIndex >= 0 ? 'Run #' + (runs.length - runIndex) : undefined

      setCompanyCrawlSelection({
        key: campaignId + ':' + (campaignRunId ?? 'all'),
        campaignId,
        campaignRunId,
        label: crawl?.name ?? 'crawl',
        runLabel
      })
      openDetail(null)
      goToTab('companies')
    },
    [crawlById, crawlRunsByCrawlId, openDetail, goToTab]
  )

  function clearCompanyCrawlSelection() {
    setCompanyCrawlSelection(null)
    setCompaniesFetchParams({})
  }

  function handlePeopleCrawlFilterChange(
    campaignId: string | null,
    campaignRunId: string | null
  ) {
    setAgenticPeopleMatchIds(null)
    if (!campaignId) {
      setPeopleCrawlFilter(null)
      return
    }
    const nextFilter: PeopleCrawlFilter = { campaignId, campaignRunId }
    setPeopleCrawlFilter(nextFilter)
    void loadCrawlRuns(campaignId)
  }

  function clearPeopleCrawlFilter() {
    setPeopleCrawlFilter(null)
  }

  function loadMoreCompanies() {
    if (!companiesLoading && companiesHasMore) void loadCompanies(companies.length)
  }

  async function handleAgenticSearch(
    target: AgenticSearchTarget,
    criteria: string,
    onProgress: (progress: AgenticSearchProgress) => void
  ) {
    if (target === 'people') {
      const personIds =
        activeTab === 'people' ? visiblePersonIds : people.map((person) => person.id)
      if (personIds.length > 200) {
        throw new Error('Agentic search can judge up to 200 loaded people. Add filters first.')
      }
      let completed = 0
      let matched = 0
      let errors = 0
      let total = personIds.length
      const response: { current?: AgenticPeopleSearchResponse } = {}
      onProgress({ completed, total, matched, errors })
      await apiPostNdjson<AgenticPeopleSearchStreamEvent>(
        '/people/agentic-search/stream',
        { criteria, personIds },
        (event) => {
          if (event.type === 'start') {
            total = event.total
            onProgress({ completed, total, matched, errors })
            return
          }
          if (event.type === 'result') {
            completed += 1
            if (event.result.fits) matched += 1
            if (event.result.error) errors += 1
            onProgress({ completed, total, matched, errors })
            return
          }
          response.current = event
        }
      )
      if (!response.current) {
        throw new Error('Agentic search stream ended before returning results')
      }
      const res = response.current
      setAgenticPeopleMatchIds(new Set(res.selectedPersonIds))
      setAgenticCompanyMatchIds(null)
      goToTab('people')
      if (res.errors.length > 0) {
        setError('Agentic search had errors for ' + res.errors.length + ' people.')
      }
      return {
        selectedCount: res.selectedPersonIds.length,
        totalCount: personIds.length,
        errorCount: res.errors.length,
        selectedIds: res.selectedPersonIds
      }
    }

    const companyIds =
      activeTab === 'companies' ? visibleCompanyIds : companies.map((company) => company.id)
    if (companyIds.length > 200) {
      throw new Error('Agentic search can judge up to 200 loaded companies. Add filters first.')
    }
    let completed = 0
    let matched = 0
    let errors = 0
    let total = companyIds.length
    const response: { current?: AgenticCompanySearchResponse } = {}
    onProgress({ completed, total, matched, errors })
    await apiPostNdjson<AgenticCompanySearchStreamEvent>(
      '/companies/agentic-search/stream',
      { criteria, companyIds },
      (event) => {
        if (event.type === 'start') {
          total = event.total
          onProgress({ completed, total, matched, errors })
          return
        }
        if (event.type === 'result') {
          completed += 1
          if (event.result.fits) matched += 1
          if (event.result.error) errors += 1
          onProgress({ completed, total, matched, errors })
          return
        }
        response.current = event
      }
    )
    if (!response.current) {
      throw new Error('Agentic search stream ended before returning results')
    }
    const res = response.current
    setAgenticCompanyMatchIds(new Set(res.selectedCompanyIds))
    setAgenticPeopleMatchIds(null)
    goToTab('companies')
    if (res.errors.length > 0) {
      setError('Agentic search had errors for ' + res.errors.length + ' companies.')
    }
    return {
      selectedCount: res.selectedCompanyIds.length,
      totalCount: companyIds.length,
      errorCount: res.errors.length,
      selectedIds: res.selectedCompanyIds
    }
  }

  async function handleCreateListFromAgenticSearch(
    target: AgenticSearchTarget,
    name: string,
    selectedIds: string[]
  ) {
    await apiPost('/lists', {
      name,
      type: target,
      personIds: target === 'people' ? selectedIds : [],
      companyIds: target === 'companies' ? selectedIds : []
    })
    await loadLists()
    setAgenticSearchOpen(false)
    goToTab('lists')
  }

  const peoplePageCrawlRuns = peopleCrawlFilter
    ? (crawlRunsByCrawlId[peopleCrawlFilter.campaignId] ?? [])
    : []

  const header = headerCopy[activeTab]
  const drawerOpen = detail !== null
  const selectedKey = detail?.id ?? null
  const agenticDefaultTarget: AgenticSearchTarget =
    activeTab === 'companies' ? 'companies' : 'people'
  const agenticPeopleCount = activeTab === 'people' ? visiblePersonIds.length : people.length
  const agenticCompanyCount =
    activeTab === 'companies' ? visibleCompanyIds.length : companies.length

  const headerActions = (
    <TabHeaderActions
      activeTab={activeTab}
      people={people}
      peopleLoading={peopleLoading}
      companies={companies}
      companiesLoading={companiesLoading}
      lists={lists}
      listsLoading={listsLoading}
      crawls={crawls}
      crawlsLoading={crawlsLoading}
      mailboxes={mailboxes}
      mailboxesLoading={mailboxesLoading}
      onOpenAgenticSearch={() => setAgenticSearchOpen(true)}
      onLoadPeople={() => void loadPeople(0)}
      onLoadCompanies={() => void loadCompanies(0)}
      onLoadLists={() => void loadLists()}
      onLoadCrawls={() => void loadCrawls()}
      onLoadMailboxes={() => void loadMailboxes()}
      onLoadPendingDrafts={() => void loadPendingDrafts()}
      onNewCrawl={() => goToTab('crawls')}
    />
  )

  async function handleSignOut() {
    try {
      await apiPost('/auth/logout')
    } catch {
      // still sign out locally
    }
    setAuthSession(null)
  }

  if (!tabValid) {
    return <Navigate to="/people" replace />
  }

  const sidebarSections = sections.map((section) => ({
    ...section,
    items: section.items.map((item) =>
      item.id === 'drafts' && pendingDraftCount > 0
        ? {
            ...item,
            badge: (
              <Badge
                variant="accent"
                className="h-5 min-w-5 justify-center px-1.5 text-[11px]"
                aria-label={pendingDraftCount + ' pending review drafts'}
              >
                {pendingDraftCount}
              </Badge>
            )
          }
        : item
    )
  }))

  return (
    <AppShell
      sections={sidebarSections}
      activeId={activeTab}
      onSelect={goToTab}
      onOpenSearch={() => {
        setPaletteQuery('')
        setPaletteOpen(true)
      }}
      userInitials={emailToInitials(authUser.email)}
      organizationName={activeOrganization?.name ?? undefined}
      organizationDomain={activeOrganization?.emailDomain ?? undefined}
      onSignOut={() => void handleSignOut()}
      sidebarFooter={
        <div className="text-2xs leading-relaxed text-ink-faint">
          <div className="font-medium text-ink-muted">v0.1 - preview</div>
          <div>Crawls now. Outreach next.</div>
        </div>
      }
    >
      <PageHeader
        title={header.title}
        description={header.description}
        actions={headerActions}
      />

      <AgenticSearchModal
        open={agenticSearchOpen}
        defaultTarget={agenticDefaultTarget}
        peopleCount={agenticPeopleCount}
        companyCount={agenticCompanyCount}
        onOpenChange={setAgenticSearchOpen}
        onSearch={handleAgenticSearch}
        onCreateList={handleCreateListFromAgenticSearch}
      />

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

      {activeTab === 'people' ? (
        <PeoplePage
          people={people}
          companyById={companyById}
          crawls={crawls}
          crawlRuns={peoplePageCrawlRuns}
          crawlFilter={peopleCrawlFilter}
          loading={peopleLoading}
          hasMore={peopleHasMore}
          mergeTableFetchParams={mergePeopleFetchParams}
          onRefresh={() => void loadPeople(0)}
          onLoadMore={loadMorePeople}
          onSelectPerson={(person) => openDetail({ type: 'person', id: person.id })}
          onSelectCompany={(companyId) => openDetail({ type: 'company', id: companyId })}
          selectedKey={selectedKey}
          agenticMatchIds={agenticPeopleMatchIds}
          onClearAgenticResults={() => setAgenticPeopleMatchIds(null)}
          onCrawlFilterChange={handlePeopleCrawlFilterChange}
          onClearCrawlFilter={clearPeopleCrawlFilter}
          onVisibleIdsChange={setVisiblePersonIds}
        />
      ) : null}

      {activeTab === 'companies' ? (
        <CompaniesPage
          companies={companies}
          mailboxes={mailboxes}
          pendingDraftsByCompany={pendingDraftsByCompany}
          loading={companiesLoading}
          hasMore={companiesHasMore}
          mergeTableFetchParams={mergeCompaniesFetchParams}
          onRefresh={() => {
            void loadCompanies(0)
            void loadPendingDrafts()
          }}
          onLoadMore={loadMoreCompanies}
          onSelectCompany={(company) => openDetail({ type: 'company', id: company.id })}
          selectedKey={selectedKey}
          onError={(msg) => setError(msg)}
          agenticMatchIds={agenticCompanyMatchIds}
          onClearAgenticResults={() => setAgenticCompanyMatchIds(null)}
          crawlSelection={companyCrawlSelection}
          onClearCrawlSelection={clearCompanyCrawlSelection}
          onVisibleIdsChange={setVisibleCompanyIds}
        />
      ) : null}

      {activeTab === 'lists' ? (
        <ListsPage
          lists={lists}
          loading={listsLoading}
          onRefresh={() => void loadLists()}
          onSelectPerson={(person) => openDetail({ type: 'person', id: person.id })}
          onSelectCompany={(company) => openDetail({ type: 'company', id: company.id })}
          onError={(msg) => setError(msg)}
        />
      ) : null}

      {activeTab === 'crawls' ? (
        <CrawlsPage
          crawls={crawls}
          crawlsLoading={crawlsLoading}
          creating={creating}
          runningId={runningId}
          name={name}
          icpDocument={icpDocument}
          targetCount={targetCount}
          onNameChange={setName}
          onIcpDocumentChange={setIcpDocument}
          onTargetCountChange={setTargetCount}
          onCreate={handleCreate}
          onRun={startRun}
          onRefresh={() => void loadCrawls()}
          onSelectCrawl={(crawl) => openDetail({ type: 'crawl', id: crawl.id })}
          selectedKey={selectedKey}
        />
      ) : null}

      {activeTab === 'campaigns' ? (
        <CampaignsPage
          companies={companies}
          mailboxes={mailboxes}
          pendingDraftsByCompany={pendingDraftsByCompany}
          loading={companiesLoading}
          onRefresh={() => {
            void loadCompanies(0)
            void loadPendingDrafts()
          }}
          onSelectCompany={(company) => openDetail({ type: 'company', id: company.id })}
          onGoToDrafts={() => goToTab('drafts')}
          onGoToCompanies={() => goToTab('companies')}
          onRunCompany={(id) => void runCompanyOutreach(id)}
          runningId={runningId}
          selectedKey={selectedKey}
        />
      ) : null}

      {activeTab === 'drafts' ? (
        <DraftsPage mailboxes={mailboxes} onPendingReviewChanged={loadPendingDrafts} />
      ) : null}

      {activeTab === 'mailboxes' ? (
        <MailboxesPage
          mailboxes={mailboxes}
          loading={mailboxesLoading}
          onRefresh={() => void loadMailboxes()}
        />
      ) : null}

      {activeTab === 'usage' ? (
        <UsagePage
          crawls={crawls}
          companyById={companyById}
          personById={personById}
          onSelectCrawl={(crawl) => openDetail({ type: 'crawl', id: crawl.id })}
          onSelectCompany={(companyId) => openDetail({ type: 'company', id: companyId })}
          onSelectPerson={(person) => openDetail({ type: 'person', id: person.id })}
        />
      ) : null}

      <DetailDrawer
        open={drawerOpen}
        onOpenChange={(open) => {
          if (!open) openDetail(null)
        }}
        person={selectedPerson}
        company={selectedCompany}
        crawl={selectedCrawl}
        companyPeople={detail?.type === 'company' ? companyDrawerPeople : []}
        companyPeopleLoading={detail?.type === 'company' ? companyDrawerPeopleLoading : false}
        crawlPeople={detail?.type === 'crawl' ? crawlDrawerPeople : []}
        crawlPeopleLoading={detail?.type === 'crawl' ? crawlDrawerPeopleLoading : false}
        crawlRuns={selectedCrawlRuns}
        crawlRunsLoading={crawlRunsLoading}
        crawlUsage={selectedCrawlUsage}
        runningId={runningId}
        mailboxes={mailboxes}
        onSelectPerson={(person) => openDetail({ type: 'person', id: person.id })}
        onSelectCompany={(companyId) => openDetail({ type: 'company', id: companyId })}
        onRunCrawl={startRun}
        onViewPeopleForCrawl={viewPeopleForCrawl}
        onSelectCompaniesForCrawl={selectCompaniesForCrawl}
        onCompanyChanged={() => {
          void loadCompanies(0)
          void loadPendingDrafts()
        }}
        onError={(msg) => setError(msg)}
      />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        query={paletteQuery}
        onQueryChange={setPaletteQuery}
        recordSearchLoading={paletteRecordSearchLoading}
        commands={paletteCommands}
      />
    </AppShell>
  )
}
