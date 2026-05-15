import {
  Building2,
  Loader2,
  Mail,
  Play,
  RefreshCw,
  Search,
  Users
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  apiGet,
  apiPost,
  type Campaign,
  type Company,
  type Person
} from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

type TabId = 'people' | 'companies' | 'crawls' | 'campaigns'

const navItems: Array<{ id: TabId; label: string; description: string; icon: typeof Users }> = [
  {
    id: 'people',
    label: 'People',
    description: 'Prospects discovered from crawls.',
    icon: Users
  },
  {
    id: 'companies',
    label: 'Companies',
    description: 'Accounts found during research.',
    icon: Building2
  },
  {
    id: 'crawls',
    label: 'Crawls',
    description: 'ICP research jobs and workflow runs.',
    icon: Search
  },
  {
    id: 'campaigns',
    label: 'Campaigns',
    description: 'Email campaigns and drafts.',
    icon: Mail
  }
]

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('people')
  const [crawls, setCrawls] = useState<Campaign[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [crawlsLoading, setCrawlsLoading] = useState(true)
  const [companiesLoading, setCompaniesLoading] = useState(true)
  const [peopleLoading, setPeopleLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)

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

  const loadPeople = useCallback(async () => {
    setPeopleLoading(true)
    setError(null)
    try {
      const res = await apiGet<{ data: Person[] }>('/people?limit=25')
      setPeople(res.data)
    } finally {
      setPeopleLoading(false)
    }
  }, [])

  const loadCompanies = useCallback(async () => {
    setCompaniesLoading(true)
    setError(null)
    try {
      const data = await apiGet<Company[]>('/companies')
      setCompanies(data)
    } finally {
      setCompaniesLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setCrawlsLoading(true)
      try {
        await loadCrawls()
        await loadCompanies()
        await loadPeople()
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
  }, [loadCompanies, loadCrawls, loadPeople])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      await apiPost<Campaign>('/campaigns', {
        name,
        icpDocument,
        targetCount
      })
      await loadCrawls()
      setActiveTab('crawls')
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
      await apiPost<{ workflowTriggered: boolean }>('/campaigns/' + crawlId + '/runs')
      await loadCrawls()
      await loadPeople()
      await loadCompanies()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Start crawl failed')
    } finally {
      setRunningId(null)
    }
  }

  const activeNav = navItems.find((item) => item.id === activeTab) ?? navItems[0]

  return (
    <div className="min-h-svh bg-muted/20 text-left">
      <div className="grid min-h-svh md:grid-cols-[260px_1fr]">
        <aside className="border-r bg-background p-4">
          <div className="mb-6 px-2">
            <h1 className="text-xl font-semibold tracking-tight">ICP Prospector</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Research crawls now. Email campaigns next.
            </p>
          </div>

          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon
              const selected = activeTab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={[
                    'flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                    selected
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  ].join(' ')}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium">{item.label}</span>
                    <span
                      className={[
                        'block text-xs',
                        selected ? 'text-primary-foreground/80' : 'text-muted-foreground'
                      ].join(' ')}
                    >
                      {item.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </nav>
        </aside>

        <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
          <header>
            <h2 className="text-2xl font-semibold tracking-tight">{activeNav.label}</h2>
            <p className="text-muted-foreground text-sm">{activeNav.description}</p>
          </header>

          {error ? (
            <Card className="border-destructive/50 bg-destructive/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-destructive text-base">Error</CardTitle>
                <CardDescription className="text-destructive/90">{error}</CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          {activeTab === 'people' ? (
            <PeoplePage
              people={people}
              loading={peopleLoading}
              onRefresh={() => void loadPeople()}
            />
          ) : null}

          {activeTab === 'companies' ? (
            <CompaniesPage
              companies={companies}
              loading={companiesLoading}
              onRefresh={() => void loadCompanies()}
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
            />
          ) : null}

          {activeTab === 'campaigns' ? <CampaignsPage /> : null}
        </main>
      </div>
    </div>
  )
}

function PeoplePage({
  people,
  loading,
  onRefresh
}: {
  people: Person[]
  loading: boolean
  onRefresh: () => void
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>People</CardTitle>
          <CardDescription>Prospects discovered by crawls.</CardDescription>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>LinkedIn</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-center text-sm">
                  No people yet. Start a crawl to populate this table.
                </TableCell>
              </TableRow>
            ) : (
              people.map((person) => (
                <TableRow key={person.id}>
                  <TableCell className="font-medium">{person.fullName ?? '-'}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {person.title ?? '-'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {person.email ?? '-'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {person.linkedinUrl ? (
                      <a className="underline" href={person.linkedinUrl} target="_blank" rel="noreferrer">
                        Profile
                      </a>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{person.lifecycleStatus}</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function CompaniesPage({
  companies,
  loading,
  onRefresh
}: {
  companies: Company[]
  loading: boolean
  onRefresh: () => void
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Companies</CardTitle>
          <CardDescription>Accounts discovered during research.</CardDescription>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Domain</TableHead>
              <TableHead>Industry</TableHead>
              <TableHead>HQ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {companies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground text-center text-sm">
                  No companies yet.
                </TableCell>
              </TableRow>
            ) : (
              companies.map((company) => (
                <TableRow key={company.id}>
                  <TableCell className="font-medium">{company.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {company.website ? (
                      <a className="underline" href={company.website} target="_blank" rel="noreferrer">
                        {company.domain ?? company.website}
                      </a>
                    ) : (
                      company.domain ?? '-'
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {company.industry ?? '-'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {company.hqLocation ?? '-'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function CrawlsPage({
  crawls,
  crawlsLoading,
  creating,
  runningId,
  name,
  icpDocument,
  targetCount,
  onNameChange,
  onIcpDocumentChange,
  onTargetCountChange,
  onCreate,
  onRun,
  onRefresh
}: {
  crawls: Campaign[]
  crawlsLoading: boolean
  creating: boolean
  runningId: string | null
  name: string
  icpDocument: string
  targetCount: number
  onNameChange: (value: string) => void
  onIcpDocumentChange: (value: string) => void
  onTargetCountChange: (value: number) => void
  onCreate: (event: React.FormEvent) => void
  onRun: (crawlId: string) => void
  onRefresh: () => void
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>New crawl</CardTitle>
          <CardDescription>
            Describe an ICP and start a Render Workflow research crawl.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="icp">ICP document</Label>
              <Textarea
                id="icp"
                value={icpDocument}
                onChange={(e) => onIcpDocumentChange(e.target.value)}
                rows={5}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="target">Target count</Label>
              <Input
                id="target"
                type="number"
                min={1}
                value={targetCount}
                onChange={(e) => onTargetCountChange(Number(e.target.value))}
                required
              />
            </div>
            <Button type="submit" disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="animate-spin" />
                  Creating...
                </>
              ) : (
                'Create crawl'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Crawls</CardTitle>
            <CardDescription>Start or inspect ICP research workflow runs.</CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={crawlsLoading}>
            {crawlsLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crawlsLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm">
                    <Loader2 className="mx-auto animate-spin" />
                  </TableCell>
                </TableRow>
              ) : crawls.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground text-center text-sm">
                    No crawls yet.
                  </TableCell>
                </TableRow>
              ) : (
                crawls.map((crawl) => (
                  <TableRow key={crawl.id}>
                    <TableCell className="font-medium">{crawl.name}</TableCell>
                    <TableCell>{crawl.targetCount}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{crawl.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={runningId === crawl.id}
                        onClick={() => onRun(crawl.id)}
                      >
                        {runningId === crawl.id ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Play />
                        )}
                        <span className="ml-1">Run</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function CampaignsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email campaigns</CardTitle>
        <CardDescription>
          This will become the workspace for selecting people, generating drafts, and tracking outreach.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-dashed p-8 text-center">
          <Mail className="text-muted-foreground mx-auto mb-3 h-8 w-8" />
          <h3 className="font-medium">No email campaigns yet</h3>
          <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">
            Crawls feed the people and company database. Campaigns will use those records for Gmail draft
            generation and outreach review.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
