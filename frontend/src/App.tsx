import {
  Activity,
  Building2,
  Inbox,
  ListChecks,
  Mail,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Users
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from 'react-router-dom'

import {
  AgenticSearchModal,
  type AgenticSearchProgress,
  type AgenticSearchTarget
} from '@/components/AgenticSearchModal'
import {
  apiAuthMe,
  apiGet,
  apiPost,
  apiPostNdjson,
  setUnauthorizedHandler,
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
import { CommandPalette, type CommandItem } from '@/components/CommandPalette'
import { AppShell } from '@/components/layout/AppShell'
import type { SidebarSection } from '@/components/layout/Sidebar'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { CampaignsPage } from '@/pages/CampaignsPage'
import { CompaniesPage } from '@/pages/CompaniesPage'
import { CrawlsPage } from '@/pages/CrawlsPage'
import { DetailDrawer } from '@/pages/DetailDrawer'
import { DraftsPage } from '@/pages/DraftsPage'
import { MailboxesPage } from '@/pages/MailboxesPage'
import { PeoplePage } from '@/pages/PeoplePage'
import { LoginPage } from '@/pages/LoginPage'
import { ListsPage } from '@/pages/ListsPage'
import { UsagePage } from '@/pages/UsagePage'
import type { CompaniesTableFetchParams, PeopleTableFetchParams } from '@/lib/listFetchParams'
import { emailToInitials } from '@/lib/userDisplay'

type TabId =
  | 'people'
  | 'companies'
  | 'lists'
  | 'crawls'
  | 'campaigns'
  | 'drafts'
  | 'mailboxes'
  | 'usage'
type DetailSelection =
  | { type: 'person'; id: string }
  | { type: 'company'; id: string }
  | { type: 'crawl'; id: string }
type PeopleCrawlFilter = {
  campaignId: string
  campaignRunId: string | null
}
type PagedResponse<T> = { data: T[]; limit: number; offset: number }
type AgenticPeopleSearchResponse = {
  selectedPersonIds: string[]
  errors: Array<{ personId: string; error: string }>
}
type AgenticCompanySearchResponse = {
  selectedCompanyIds: string[]
  errors: Array<{ companyId: string; error: string }>
}
type AgenticPeopleSearchStreamEvent =
  | { type: 'start'; total: number }
  | {
      type: 'result'
      result: { personId: string; fits: boolean; error?: string }
    }
  | AgenticPeopleSearchResponse & { type: 'done' }
type AgenticCompanySearchStreamEvent =
  | { type: 'start'; total: number }
  | {
      type: 'result'
      result: { companyId: string; fits: boolean; error?: string }
    }
  | AgenticCompanySearchResponse & { type: 'done' }

const PAGE_SIZE = 100
const PALETTE_RECORD_LIMIT = 40

function buildPeoplePath(
  offset: number,
  crawlFilter: PeopleCrawlFilter | null,
  list: PeopleTableFetchParams,
  limit: number
): string {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (crawlFilter?.campaignId) params.set('campaign_id', crawlFilter.campaignId)
  if (crawlFilter?.campaignRunId) params.set('campaign_run_id', crawlFilter.campaignRunId)
  const q = list.q?.trim()
  if (q) params.set('q', q)
  if (list.lifecycle) params.set('lifecycle', list.lifecycle)
  if (list.companyId) params.set('company_id', list.companyId)
  else if (list.companyScope) params.set('company_scope', list.companyScope)
  if (list.hasEmail) params.set('has_email', list.hasEmail)
  if (list.hasLinkedin) params.set('has_linkedin', list.hasLinkedin)
  return '/people?' + params.toString()
}

function buildCompaniesPath(offset: number, list: CompaniesTableFetchParams, limit: number): string {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  const q = list.q?.trim()
  if (q) params.set('q', q)
  if (list.outreachStatus) params.set('outreach_status', list.outreachStatus)
  if (list.mailboxId) params.set('mailbox_id', list.mailboxId)
  else if (list.mailboxScope === 'assigned') params.set('has_mailbox', 'true')
  else if (list.mailboxScope === 'unassigned') params.set('has_mailbox', 'false')
  if (list.hasPeople) params.set('has_people', list.hasPeople)
  if (list.pendingDrafts) params.set('pending_drafts', list.pendingDrafts)
  return '/companies?' + params.toString()
}

const sections: SidebarSection<TabId>[] = [
  {
    label: 'Pipeline',
    items: [
      { id: 'people', label: 'People', icon: Users },
      { id: 'companies', label: 'Companies', icon: Building2 },
      { id: 'lists', label: 'Lists', icon: ListChecks }
    ]
  },
  {
    label: 'Workflows',
    items: [
      { id: 'crawls', label: 'Crawls', icon: Search },
      { id: 'campaigns', label: 'Campaigns', icon: Mail },
      { id: 'drafts', label: 'Drafts', icon: Inbox }
    ]
  },
  {
    label: 'Operations',
    items: [
      { id: 'mailboxes', label: 'Mailboxes', icon: Plug },
      { id: 'usage', label: 'Usage', icon: Activity }
    ]
  }
]

const headerCopy: Record<TabId, { title: string; description: string }> = {
  people: { title: 'People', description: 'Prospects discovered from crawls.' },
  companies: { title: 'Companies', description: 'Accounts found during research.' },
  lists: { title: 'Lists', description: 'Saved groups of people and companies.' },
  crawls: { title: 'Crawls', description: 'ICP research jobs and workflow runs.' },
  campaigns: {
    title: 'Campaigns',
    description: 'Accounts the outreach agent is currently working.'
  },
  drafts: {
    title: 'Drafts',
    description: 'Daily review queue. Approve to send, discard, or regenerate.'
  },
  mailboxes: {
    title: 'Mailboxes',
    description: 'Connect Gmail accounts the agent can send from on your approval.'
  },
  usage: {
    title: 'Usage',
    description: 'Spend, tokens, and call volume across crawls and accounts.'
  }
}

const TAB_IDS: TabId[] = [
  'people',
  'companies',
  'lists',
  'crawls',
  'campaigns',
  'drafts',
  'mailboxes',
  'usage'
]

function isTabId(value: string | undefined): value is TabId {
  return value !== undefined && (TAB_IDS as readonly string[]).includes(value)
}

function parseDetailFromSearch(search: URLSearchParams): DetailSelection | null {
  const kind = search.get('kind')
  const id = search.get('id')
  if (!kind || !id) return null
  if (kind === 'person' || kind === 'company' || kind === 'crawl') {
    return { type: kind, id }
  }
  return null
}

function NavigateToLogin() {
  const loc = useLocation()
  const target = loc.pathname + (loc.search || '')
  return <Navigate to="/login" replace state={{ from: target || '/' }} />
}

function HomeRoute({ authUser }: { authUser: AuthUser | null }) {
  if (authUser) return <Navigate to="/people" replace />
  return <Navigate to="/login" replace state={{ from: '/' }} />
}

function FlashApp({
  authUser,
  setAuthUser
}: {
  authUser: AuthUser
  setAuthUser: React.Dispatch<React.SetStateAction<AuthUser | null>>
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
  const [palettePeopleHits, setPalettePeopleHits] = useState<Person[]>([])
  const [paletteCompanyHits, setPaletteCompanyHits] = useState<Company[]>([])
  const [paletteRecordSearchLoading, setPaletteRecordSearchLoading] = useState(false)
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
  const [visiblePersonIds, setVisiblePersonIds] = useState<string[]>([])
  const [visibleCompanyIds, setVisibleCompanyIds] = useState<string[]>([])
  const [companyDrawerPeople, setCompanyDrawerPeople] = useState<Person[]>([])
  const [companyDrawerPeopleLoading, setCompanyDrawerPeopleLoading] = useState(false)

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

  async function handleCreate(e: React.FormEvent) {
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
  const selectedCrawlPeople = useMemo(
    () =>
      selectedCrawl
        ? people.filter((p) => p.discoveryCampaignIds.includes(selectedCrawl.id))
        : [],
    [selectedCrawl, people]
  )
  const selectedCrawlRuns = selectedCrawl
    ? (crawlRunsByCrawlId[selectedCrawl.id] ?? [])
    : []
  const selectedCrawlUsage = selectedCrawl
    ? (crawlUsageByCrawlId[selectedCrawl.id] ?? null)
    : null

  const companyDrawerFetchKey = detail?.type === 'company' ? detail.id : null

  useEffect(() => {
    if (!companyDrawerFetchKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when leaving company detail
      setCompanyDrawerPeople([])
      setCompanyDrawerPeopleLoading(false)
      return
    }
    let cancelled = false
    setCompanyDrawerPeopleLoading(true)
    setCompanyDrawerPeople([])
    void apiGet<PagedResponse<Person>>(
      '/people?company_id=' + companyDrawerFetchKey + '&limit=200&offset=0'
    )
      .then((res) => {
        if (!cancelled) setCompanyDrawerPeople(res.data)
      })
      .catch((err) => {
        if (!cancelled) {
          setCompanyDrawerPeople([])
          setError(err instanceof Error ? err.message : 'Failed to load company people')
        }
      })
      .finally(() => {
        if (!cancelled) setCompanyDrawerPeopleLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [companyDrawerFetchKey])

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

  useEffect(() => {
    if (!paletteOpen) {
      setPaletteRecordSearchLoading(false)
      setPalettePeopleHits([])
      setPaletteCompanyHits([])
      return
    }
    const trimmed = paletteQuery.trim()
    if (trimmed.length === 0) {
      setPaletteRecordSearchLoading(false)
      setPalettePeopleHits([])
      setPaletteCompanyHits([])
      return
    }

    setPaletteRecordSearchLoading(true)
    const ac = new AbortController()
    const timer = window.setTimeout(() => {
      const q = encodeURIComponent(trimmed)
      void Promise.all([
        apiGet<PagedResponse<Person>>(
          '/people?limit=' +
            String(PALETTE_RECORD_LIMIT) +
            '&offset=0&q=' +
            q,
          { signal: ac.signal }
        ),
        apiGet<PagedResponse<Company>>(
          '/companies?limit=' +
            String(PALETTE_RECORD_LIMIT) +
            '&offset=0&q=' +
            q,
          { signal: ac.signal }
        )
      ])
        .then(([pe, co]) => {
          if (ac.signal.aborted) return
          setPalettePeopleHits(pe.data)
          setPaletteCompanyHits(co.data)
        })
        .catch((err) => {
          if (ac.signal.aborted) return
          setPalettePeopleHits([])
          setPaletteCompanyHits([])
          setError(err instanceof Error ? err.message : 'Command palette search failed')
        })
        .finally(() => {
          if (!ac.signal.aborted) setPaletteRecordSearchLoading(false)
        })
    }, 260)

    return () => {
      window.clearTimeout(timer)
      ac.abort()
    }
  }, [paletteOpen, paletteQuery])

  const paletteCommands = useMemo<CommandItem[]>(() => {
    const navItems: CommandItem[] = [
      {
        id: 'nav:people',
        label: 'Go to People',
        group: 'Jump to',
        icon: Users,
        keywords: 'prospects contacts',
        onSelect: () => goToTab('people')
      },
      {
        id: 'nav:companies',
        label: 'Go to Companies',
        group: 'Jump to',
        icon: Building2,
        keywords: 'accounts',
        onSelect: () => goToTab('companies')
      },
      {
        id: 'nav:lists',
        label: 'Go to Lists',
        group: 'Jump to',
        icon: ListChecks,
        keywords: 'saved groups segments',
        onSelect: () => goToTab('lists')
      },
      {
        id: 'nav:crawls',
        label: 'Go to Crawls',
        group: 'Jump to',
        icon: Search,
        keywords: 'jobs workflows research',
        onSelect: () => goToTab('crawls')
      },
      {
        id: 'nav:campaigns',
        label: 'Go to Campaigns',
        group: 'Jump to',
        icon: Mail,
        keywords: 'outreach emails working accounts',
        onSelect: () => goToTab('campaigns')
      },
      {
        id: 'nav:drafts',
        label: 'Go to Drafts',
        group: 'Jump to',
        icon: Inbox,
        keywords: 'review approve outreach pending',
        onSelect: () => goToTab('drafts')
      },
      {
        id: 'nav:mailboxes',
        label: 'Go to Mailboxes',
        group: 'Jump to',
        icon: Plug,
        keywords: 'gmail connect oauth inbox',
        onSelect: () => goToTab('mailboxes')
      },
      {
        id: 'nav:usage',
        label: 'Go to Usage',
        group: 'Jump to',
        icon: Activity,
        keywords: 'spend cost tokens billing',
        onSelect: () => goToTab('usage')
      }
    ]

    const peopleItems: CommandItem[] = palettePeopleHits.map((p) => {
      const company = p.companyId ? companyById.get(p.companyId) : null
      const description = [p.title, company?.name].filter(Boolean).join(' - ')
      return {
        id: 'person:' + p.id,
        label: p.fullName ?? p.email ?? 'Unnamed person',
        description: description || undefined,
        group: 'People',
        icon: Users,
        keywords: [p.email, p.title, p.fullName, company?.name, company?.domain]
          .filter(Boolean)
          .join(' '),
        onSelect: () => openDetail({ type: 'person', id: p.id })
      }
    })

    const companyItems: CommandItem[] = paletteCompanyHits.map((c) => ({
      id: 'company:' + c.id,
      label: c.name,
      description: c.domain ?? c.website ?? undefined,
      group: 'Companies',
      icon: Building2,
      keywords: [c.domain, c.website, c.industry, c.name].filter(Boolean).join(' '),
      onSelect: () => openDetail({ type: 'company', id: c.id })
    }))

    const crawlItems: CommandItem[] = crawls.map((c) => ({
      id: 'crawl:' + c.id,
      label: c.name,
      description: c.status,
      group: 'Crawls',
      icon: Search,
      keywords: c.status,
      onSelect: () => openDetail({ type: 'crawl', id: c.id })
    }))

    const listItems: CommandItem[] = lists.map((list) => ({
      id: 'list:' + list.id,
      label: list.name,
      description: list.type === 'people' ? 'People list' : 'Company list',
      group: 'Lists',
      icon: ListChecks,
      keywords: list.type,
      onSelect: () => goToTab('lists')
    }))

    return [...navItems, ...listItems, ...crawlItems, ...companyItems, ...peopleItems]
  }, [
    lists,
    crawls,
    companyById,
    palettePeopleHits,
    paletteCompanyHits,
    goToTab,
    openDetail
  ])

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

  const headerActions = (() => {
    switch (activeTab) {
      case 'people':
        return (
          <>
            <Button
              variant="outline"
              size="icon"
              aria-label="Agentic search"
              onClick={() => setAgenticSearchOpen(true)}
            >
              <Sparkles />
            </Button>
            <Button
              variant="outline"
              size="md"
              iconLeft={RefreshCw}
              onClick={() => void loadPeople(0)}
              loading={peopleLoading && people.length > 0}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              size="md"
              iconLeft={Plus}
              onClick={() => goToTab('crawls')}
            >
              New crawl
            </Button>
          </>
        )
      case 'companies':
        return (
          <>
            <Button
              variant="outline"
              size="icon"
              aria-label="Agentic search"
              onClick={() => setAgenticSearchOpen(true)}
            >
              <Sparkles />
            </Button>
            <Button
              variant="outline"
              size="md"
              iconLeft={RefreshCw}
              onClick={() => void loadCompanies(0)}
              loading={companiesLoading && companies.length > 0}
            >
              Refresh
            </Button>
          </>
        )
      case 'lists':
        return (
          <Button
            variant="outline"
            size="md"
            iconLeft={RefreshCw}
            onClick={() => void loadLists()}
            loading={listsLoading && lists.length > 0}
          >
            Refresh
          </Button>
        )
      case 'crawls':
        return (
          <Button
            variant="outline"
            size="md"
            iconLeft={RefreshCw}
            onClick={() => void loadCrawls()}
            loading={crawlsLoading && crawls.length > 0}
          >
            Refresh
          </Button>
        )
      case 'campaigns':
        return (
          <Button
            variant="outline"
            size="md"
            iconLeft={RefreshCw}
            onClick={() => {
              void loadCompanies(0)
              void loadPendingDrafts()
            }}
            loading={companiesLoading && companies.length > 0}
          >
            Refresh
          </Button>
        )
      case 'drafts':
        return null
      case 'mailboxes':
        return (
          <Button
            variant="outline"
            size="md"
            iconLeft={RefreshCw}
            onClick={() => void loadMailboxes()}
            loading={mailboxesLoading && mailboxes.length > 0}
          >
            Refresh
          </Button>
        )
      case 'usage':
        return null
    }
  })()

  async function handleSignOut() {
    try {
      await apiPost('/auth/logout')
    } catch {
      // still sign out locally
    }
    setAuthUser(null)
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
        crawlPeople={selectedCrawlPeople}
        crawlRuns={selectedCrawlRuns}
        crawlRunsLoading={crawlRunsLoading}
        crawlUsage={selectedCrawlUsage}
        runningId={runningId}
        mailboxes={mailboxes}
        onSelectPerson={(person) => openDetail({ type: 'person', id: person.id })}
        onSelectCompany={(companyId) => openDetail({ type: 'company', id: companyId })}
        onRunCrawl={startRun}
        onViewPeopleForCrawl={viewPeopleForCrawl}
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

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthUser(null)
    })
    return () => {
      setUnauthorizedHandler(undefined)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { user } = await apiAuthMe()
        if (!cancelled) setAuthUser(user)
      } catch {
        if (!cancelled) setAuthUser(null)
      } finally {
        if (!cancelled) setAuthChecked(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!authChecked) {
    return (
      <div className="flex h-svh items-center justify-center bg-bg text-sm text-ink-muted">
        Loading…
      </div>
    )
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          authUser ? <Navigate to="/people" replace /> : <LoginPage onAuthed={setAuthUser} />
        }
      />
      <Route path="/" element={<HomeRoute authUser={authUser} />} />
      <Route
        path="/:tab"
        element={
          authUser ? (
            <FlashApp authUser={authUser} setAuthUser={setAuthUser} />
          ) : (
            <NavigateToLogin />
          )
        }
      />
      <Route
        path="*"
        element={authUser ? <Navigate to="/people" replace /> : <NavigateToLogin />}
      />
    </Routes>
  )
}
