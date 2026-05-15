const apiBase = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? ''

export function buildUrl(path: string): string {
  const p = path.startsWith('/') ? path : '/' + path
  if (apiBase) return apiBase + p
  return '/api' + p
}

let onUnauthorized: (() => void) | undefined

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  onUnauthorized = handler
}

export type Organization = {
  id: string
  name: string
  slug: string
  emailDomain: string
  role?: string
}

export type AuthUser = { id: string; email: string }

export type AuthSession = {
  user: AuthUser
  organizations: Organization[]
  activeOrganization: Organization | null
  domainClaimed?: boolean
  needsOrganizationSetup: boolean
}

export type AuthMeResponse =
  | ({ user: null } & Partial<Omit<AuthSession, 'user'>>)
  | AuthSession

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (res.status === 401) {
    onUnauthorized?.()
  }
  if (!res.ok) {
    throw new Error(text || res.statusText)
  }
  return text ? (JSON.parse(text) as T) : ({} as T)
}

const cred: RequestInit = { credentials: 'include' }

export async function apiAuthMe(): Promise<AuthMeResponse> {
  const res = await fetch(buildUrl('/auth/me'), cred)
  return parseJson<AuthMeResponse>(res)
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(buildUrl(path), { ...cred, ...init })
  return parseJson<T>(res)
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(buildUrl(path), {
    ...cred,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return parseJson<T>(res)
}

export async function apiPostNdjson<T>(
  path: string,
  body: unknown,
  onEvent: (event: T) => void
): Promise<void> {
  const res = await fetch(buildUrl(path), {
    ...cred,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (res.status === 401) {
    onUnauthorized?.()
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || res.statusText)
  }
  if (!res.body) {
    throw new Error('Streaming response was empty')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line) onEvent(JSON.parse(line) as T)
      newlineIndex = buffer.indexOf('\n')
    }
  }

  const finalLine = (buffer + decoder.decode()).trim()
  if (finalLine) onEvent(JSON.parse(finalLine) as T)
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(buildUrl(path), {
    ...cred,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return parseJson<T>(res)
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(buildUrl(path), { ...cred, method: 'DELETE' })
  return parseJson<T>(res)
}

export type Campaign = {
  id: string
  name: string
  icpDocument: string
  targetCount: number
  status: string
  createdAt: string
  updatedAt: string
}

export type CampaignRun = {
  id: string
  campaignId: string
  status: string
  qualifiedCount: number
  checkpoint: Record<string, unknown>
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type OutreachStatus =
  | 'dormant'
  | 'working'
  | 'paused'
  | 'completed'
  | 'dead'

export type Company = {
  id: string
  name: string
  /** Present on list endpoints; total people linked to this company. */
  peopleCount?: number
  domain: string | null
  website: string | null
  industry: string | null
  employeeRange: string | null
  hqLocation: string | null
  notes: string | null
  enrichmentPayload: Record<string, unknown> | null
  outreachStatus: OutreachStatus
  outreachMailboxId: string | null
  outreachStrategy: string | null
  outreachEmailInstructions: string | null
  outreachNextWakeAt: string | null
  outreachStartedAt: string | null
  outreachLastWorkedAt: string | null
  outreachCompletedAt: string | null
  createdAt: string
  updatedAt: string
}

export type Mailbox = {
  id: string
  email: string
  displayName: string | null
  signature: string | null
  senderBio: string | null
  outreachEmailInstructions: string | null
  scopes: string | null
  status: 'active' | 'revoked'
  hasRefreshToken: boolean
  hasAccessToken: boolean
  oauthExpiresAt: string | null
  createdAt: string
  updatedAt: string
}

export type ProspectListType = 'people' | 'companies'

export type ProspectList = {
  id: string
  name: string
  type: ProspectListType
  personCount: number
  companyCount: number
  createdAt: string
  updatedAt: string
}

export type ProspectListDetail = ProspectList & {
  people: Person[]
  companies: Company[]
}

export type OutreachEvent = {
  id: string
  companyId: string
  kind: string
  summary: string
  details: Record<string, unknown> | null
  sourceUrl: string | null
  createdAt: string
}

export type OutreachDraftStatus =
  | 'pending_review'
  | 'approved'
  | 'sent'
  | 'discarded'
  | 'failed'

export type OutreachDraft = {
  id: string
  companyId: string
  mailboxId: string
  personId: string | null
  toEmail: string
  subject: string
  body: string
  bodyHtml: string | null
  status: OutreachDraftStatus
  reviewNotes: string | null
  agentRationale: string | null
  sentAt: string | null
  gmailMessageId: string | null
  gmailThreadId: string | null
  sendError: string | null
  createdAt: string
  updatedAt: string
}

export type DraftMailbox = {
  id: string
  email: string
  displayName: string | null
  signature: string | null
}

export type DraftQueueRow = {
  draft: OutreachDraft
  company: { id: string; name: string; domain: string | null } | null
  mailbox: DraftMailbox | null
  person: { id: string; fullName: string | null; title: string | null } | null
}

export type SentEmailRow = {
  id: string
  toEmail: string
  subject: string
  sentAt: string | null
  gmailMessageId: string | null
  person: { id: string; fullName: string | null; title: string | null } | null
}

export type DraftDetail = {
  draft: OutreachDraft
  company: Company | null
  mailbox: DraftMailbox | null
  person: Person | null
  strategy: string | null
  sentEmails: SentEmailRow[]
}

export type UsageTotals = {
  events: number
  costUsd: string
  promptTokens: string
  completionTokens: string
  totalTokens: string
  units: string
}

export type UsageOverall = UsageTotals

export type UsageProviderBreakdown = UsageTotals & {
  provider: string
  operation: string
}

export type UsageModelBreakdown = UsageTotals & {
  model: string | null
}

export type UsageSummaryResponse = {
  days: number | null
  overall: UsageOverall
  byProvider: UsageProviderBreakdown[]
  byModel: UsageModelBreakdown[]
}

export type UsageByCampaignRow = UsageTotals & {
  campaignId: string | null
  campaignName: string | null
  campaignStatus: string | null
}

export type UsageByCompanyRow = UsageTotals & {
  companyId: string | null
  companyName: string | null
  companyDomain: string | null
}

export type UsageByPersonRow = UsageTotals & {
  personId: string | null
  personName: string | null
  personTitle: string | null
  companyId: string | null
  companyName: string | null
}

export type UsageByRunRow = UsageTotals & {
  campaignRunId: string | null
  campaignId: string | null
  campaignName: string | null
  runStatus: string | null
  runCreatedAt: string | null
  qualifiedCount: number | null
}

export type UsageEvent = {
  id: string
  provider: string
  operation: string
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  units: number | null
  costUsd: string | null
  estimated: boolean
  campaignId: string | null
  campaignRunId: string | null
  companyId: string | null
  personId: string | null
  slotIndex: number | null
  metadata: Record<string, unknown> | null
  createdAt: string
  campaignName: string | null
  personName: string | null
  companyName: string | null
}

export type Person = {
  id: string
  companyId: string | null
  fullName: string | null
  email: string | null
  phone: string | null
  linkedinUrl: string | null
  twitterUrl: string | null
  title: string | null
  seniority: string | null
  department: string | null
  notes: string | null
  context: string | null
  icpKeywords: string[] | null
  enrichmentSources: Record<string, unknown> | null
  lifecycleStatus: string
  firstSeenCampaignId: string | null
  discoveryCampaignIds: string[]
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}
