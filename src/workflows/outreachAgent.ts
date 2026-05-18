import {
  appendOutreachEvent,
  deleteOutreachDraft,
  getCompanyForOutreach,
  insertDraft,
  listPeopleAtCompany,
  listRecentDrafts,
  listRecentOutreachEvents,
  listSentDraftEngagement,
  listThreadMessagesForCompany,
  markCompanyOutreachStatus,
  setNextWake,
  updateCompanyDetails,
  updatePersonAtCompany,
  upsertPersonAtCompany,
  writeStrategy
} from './repoOutreach.js'
import {
  exaFetchUrl,
  exaSearch,
  getPerson,
  requiredEnv,
  searchCompanies,
  searchPeople
} from './repo.js'
import { syncCompanyDraftThreads } from '../lib/gmail/threadSync.js'
import { LAVENDER_COLD_EMAIL_101_PROMPT_BLOCK } from '../lib/lavenderColdEmail101.js'
import { openRouterReasoningConfig } from '../lib/openrouter.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
/** Work-account agent only; override with OPENROUTER_WORK_ACCOUNT_MODEL. */
const WORK_ACCOUNT_MODEL = 'openai/gpt-5'

const MAX_STEPS = 50
const MAX_WEB_SEARCHES = 5
const MAX_FETCH_URLS = 4

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenRouterResponse = {
  choices?: Array<{
    finish_reason?: string
    message?: {
      role: string
      content?: string | null
      tool_calls?: ToolCall[]
      refusal?: string
    }
  }>
  error?: { message?: string }
}

type JsonObject = Record<string, unknown>

const LOG_TEXT_KEYS = new Set([
  'agent_rationale',
  'body',
  'context',
  'new_text',
  'notes',
  'outreach_email_instructions',
  'reasoning',
  'sender_bio'
])

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function sanitizeForLog(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && LOG_TEXT_KEYS.has(key)) return { chars: value.length }
    return value.length > 180 ? value.slice(0, 180) + '...' : value
  }
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitizeForLog(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeForLog(entryValue, entryKey)
      ])
    )
  }
  return value
}

function toolCallArgsForLog(call: ToolCall): unknown {
  const parsed = safeJsonParse(call.function.arguments)
  if (!parsed || typeof parsed !== 'object') return { parse_error: true }
  return sanitizeForLog(parsed)
}

function toolResultForLog(out: ToolDispatchResult): JsonObject {
  if (out.kind === 'terminate') {
    return {
      kind: out.kind,
      status: out.outcome.status,
      reason: sanitizeForLog(out.outcome.reason, 'reason'),
      wakeAt:
        out.outcome.status === 'slept' && out.outcome.wakeAt
          ? out.outcome.wakeAt.toISOString()
          : undefined
    }
  }

  const parsed = safeJsonParse(out.content)
  if (!parsed || typeof parsed !== 'object') return { kind: out.kind }
  const obj = parsed as JsonObject
  return {
    kind: out.kind,
    ok: obj.ok,
    error: obj.error,
    message: sanitizeForLog(obj.message),
    rows: Array.isArray(obj.rows) ? obj.rows.length : undefined,
    data: Array.isArray(obj.data) ? obj.data.length : undefined,
    events: Array.isArray(obj.events) ? obj.events.length : undefined,
    drafts: Array.isArray(obj.drafts) ? obj.drafts.length : undefined,
    people: Array.isArray(obj.people) ? obj.people.length : undefined,
    companies: Array.isArray(obj.companies) ? obj.companies.length : undefined
  }
}

function logToolCallStart(companyId: string, step: number, call: ToolCall): number {
  const startedAt = Date.now()
  console.info(
    '[workAccount] agent_tool_call:start',
    JSON.stringify({
      companyId,
      step,
      toolCallId: call.id,
      toolName: call.function.name,
      args: toolCallArgsForLog(call)
    })
  )
  return startedAt
}

function logToolCallEnd(
  companyId: string,
  step: number,
  call: ToolCall,
  startedAt: number,
  out: ToolDispatchResult
) {
  console.info(
    '[workAccount] agent_tool_call:end',
    JSON.stringify({
      companyId,
      step,
      toolCallId: call.id,
      toolName: call.function.name,
      durationMs: Date.now() - startedAt,
      result: toolResultForLog(out)
    })
  )
}

export type WorkAccountAgentResult =
  | { status: 'slept'; reason: string; wakeAt: Date | null; steps: number; draftsCreated: number }
  | { status: 'paused'; reason: string; steps: number; draftsCreated: number }
  | { status: 'completed'; reason: string; steps: number; draftsCreated: number }
  | { status: 'error'; error: string; steps: number; draftsCreated: number }
  | { status: 'exhausted'; steps: number; draftsCreated: number }

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'update_strategy',
      description:
        "Overwrite the outreach strategy document for THIS account. Use this to record (a) your current angle of attack, (b) what you've already tried and what's next, (c) names of people / mutuals / events / investors worth pursuing. The user reads this between wake-ups and may edit it. The next wake-up reads it back verbatim.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          new_text: { type: 'string', description: 'Full replacement strategy text.' },
          reason: {
            type: 'string',
            description: 'Why you are updating the strategy (one short sentence).'
          }
        },
        required: ['new_text', 'reason']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_recent_events',
      description:
        "Read this account's timeline (most recent first): emails sent, opens, replies, bounces, send failures, operator discards/regenerates, strategy revisions, and session notes. You cannot append to it — use update_strategy for durable notes between runs.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
        required: ['limit']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_drafts',
      description:
        "Read this account's recent drafts (status, subject, body preview, to_email, open tracking for sent mail, agent_rationale, review_notes). Always call this before draft_email. At most one pending-review draft may exist per recipient address — if you need to rewrite to the same person, note the existing draft id and delete_draft it before drafting again.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 25 } },
        required: ['limit']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_email_engagement',
      description:
        'Read sent-email engagement for this account: open counts/timestamps and any captured replies or bounces (full message bodies when available). Call this when deciding follow-ups.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent_limit: { type: 'integer', minimum: 1, maximum: 25 },
          thread_limit: { type: 'integer', minimum: 1, maximum: 25 }
        },
        required: ['sent_limit', 'thread_limit']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_people_at_company',
      description:
        'Read the known contacts at this account, including any emails or social URLs we have.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
        required: ['limit']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_existing_people',
      description:
        'Search ALL people in the DB (not just this account) for mutuals, prior contacts, etc.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: ['string', 'null'] },
          company_name: { type: ['string', 'null'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          offset: { type: 'integer', minimum: 0 }
        },
        required: ['query', 'company_name', 'limit', 'offset']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_person',
      description: 'Fetch a full person record (notes, context, contact fields) by id.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_existing_companies',
      description: 'Search companies in the DB by name or domain (use for finding overlap, parent, mutual).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: ['string', 'null'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          offset: { type: 'integer', minimum: 0 }
        },
        required: ['query', 'limit', 'offset']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: `Search the web via Exa for any angle: company news, leadership pages, podcasts, investor lists, conference attendees, mutuals, hires. Budget: ${MAX_WEB_SEARCHES} calls.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          num_results: { type: 'integer', minimum: 1, maximum: 10 }
        },
        required: ['query', 'num_results']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_url',
      description: `Fetch the readable text of a specific URL (~4000 chars). Budget: ${MAX_FETCH_URLS} calls.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { url: { type: 'string' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_company_details',
      description:
        "Edit source-backed company/account details for THIS account: profile fields, notes, or account-specific email instructions. Use only when you have better information than what's already stored.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: ['string', 'null'] },
          domain: { type: ['string', 'null'] },
          website: { type: ['string', 'null'] },
          industry: { type: ['string', 'null'] },
          employee_range: { type: ['string', 'null'] },
          hq_location: { type: ['string', 'null'] },
          notes: {
            type: ['string', 'null'],
            description:
              'Full replacement company notes. Preserve useful existing notes unless you are intentionally rewriting them.'
          },
          outreach_email_instructions: {
            type: ['string', 'null'],
            description:
              'Full replacement account-specific cold email instructions for this company.'
          },
          reason: {
            type: 'string',
            description: 'One short sentence explaining the source-backed update.'
          }
        },
        required: ['reason']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_person',
      description:
        'Edit an existing person who belongs to THIS account. Use after list_people_at_company or get_person when sourced research corrects or enriches contact/profile fields.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          person_id: { type: 'string', description: 'Person id from list_people_at_company/get_person.' },
          full_name: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          seniority: { type: ['string', 'null'] },
          department: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          linkedin_url: { type: ['string', 'null'] },
          twitter_url: { type: ['string', 'null'] },
          notes: {
            type: ['string', 'null'],
            description:
              'Full replacement person notes. Preserve useful existing notes unless you are intentionally rewriting them.'
          },
          context: {
            type: ['string', 'null'],
            description: 'Why this person matters for outreach, if known.'
          },
          lifecycle_status: { type: ['string', 'null'] },
          reason: {
            type: 'string',
            description: 'One short sentence explaining the source-backed update.'
          }
        },
        required: ['person_id', 'reason']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'upsert_person',
      description:
        'Add (or merge with) a person at THIS account. Use when you discover a new exec, mutual, investor, or other contact worth tracking. If the person already exists at this account, supplied fields are merged into that record. Returns the person id you can use in draft_email.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          full_name: { type: 'string' },
          title: { type: ['string', 'null'] },
          seniority: { type: ['string', 'null'] },
          department: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          linkedin_url: { type: ['string', 'null'] },
          twitter_url: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] },
          context: { type: 'string', description: 'One paragraph: who they are, why relevant to outreach.' },
          lifecycle_status: { type: ['string', 'null'] },
          reason: {
            type: 'string',
            description: 'One short sentence explaining why this person belongs on the account.'
          }
        },
        required: [
          'full_name',
          'title',
          'seniority',
          'department',
          'email',
          'phone',
          'linkedin_url',
          'twitter_url',
          'notes',
          'context',
          'lifecycle_status',
          'reason'
        ]
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_draft',
      description:
        'Permanently remove a pending-review draft for THIS account. Use this to replace a draft to the same recipient: delete_draft the old one, then draft_email the revised version. Only works while status is pending_review; cannot delete sent mail.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draft_id: { type: 'string', description: 'Draft id from list_drafts.' },
          reason: { type: 'string', description: 'One short sentence why you are deleting it.' }
        },
        required: ['draft_id', 'reason']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'draft_email',
      description:
        'Create an in-app email draft for the user to review and approve from the Drafts page. Does NOT touch Gmail. Only one pending-review draft is allowed per to_email on this account — to revise an existing draft, delete_draft it first, then call draft_email again. Include `agent_rationale`: a short justification for why this person, this angle, this content.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          person_id: {
            type: ['string', 'null'],
            description: 'Linked person id (preferred). Use upsert_person first if needed.'
          },
          to_email: {
            type: 'string',
            description:
              'Recipient address you can defend: verified from web/DB, OR constructed from a company email pattern you found (e.g. first.last@domain) plus the person\'s real name — say so in agent_rationale. Never guess blindly.'
          },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plaintext body.' },
          body_html: {
            type: ['string', 'null'],
            description: 'Optional HTML version. Leave null for plaintext-only.'
          },
          agent_rationale: {
            type: 'string',
            description:
              'Why this person and hook; if to_email was inferred from a company pattern, cite how you found the pattern and your confidence. Never omit evidence for the address.'
          }
        },
        required: ['person_id', 'to_email', 'subject', 'body', 'body_html', 'agent_rationale']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'mark_completed',
      description:
        'Mark this account as complete (e.g. landed a meeting via a draft, or out of paths to pursue). Clears next-wake; the user can re-open it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { reason: { type: 'string' } },
        required: ['reason']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'pause',
      description:
        "Pause work on this account (e.g. need user input, or strategy needs human revision). Clears next-wake until the user re-triggers.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { reason: { type: 'string' } },
        required: ['reason']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'sleep',
      description:
        'Terminate this session and schedule the next wake-up. Use after you have produced any drafts and updated the strategy, or when waiting for the user to respond / send what you drafted. wake_after_hours defaults to 24 if you do not supply it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string' },
          wake_after_hours: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 24 * 30
          }
        },
        required: ['reason', 'wake_after_hours']
      }
    }
  }
]

type AgentInput = {
  companyId: string
  organizationId?: string
}

type ToolCtx = {
  organizationId: string
  companyId: string
  mailboxId: string
  used: { webSearches: number; fetchUrls: number }
  draftsCreated: number
  lastSourceUrlHinted: string | null
  lastWebSearchQuery: string | null
}

type ToolDispatchResult =
  | { kind: 'continue'; content: string }
  | {
      kind: 'terminate'
      outcome:
        | { status: 'slept'; reason: string; wakeAt: Date | null }
        | { status: 'paused'; reason: string }
        | { status: 'completed'; reason: string }
      content: string
    }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

async function dispatchTool(ctx: ToolCtx, call: ToolCall): Promise<ToolDispatchResult> {
  const name = call.function.name
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
  } catch (err) {
    return {
      kind: 'continue',
      content: JSON.stringify({
        error: 'invalid_json_arguments',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  try {
    switch (name) {
      case 'update_strategy': {
        const newText = typeof args.new_text === 'string' ? args.new_text : ''
        const reason = typeof args.reason === 'string' ? args.reason : null
        if (!newText.trim()) {
          return { kind: 'continue', content: JSON.stringify({ error: 'new_text required' }) }
        }
        await writeStrategy(ctx.companyId, ctx.organizationId, newText, reason)
        return { kind: 'continue', content: JSON.stringify({ ok: true }) }
      }
      case 'list_recent_events': {
        const limit = clamp(Number(args.limit) || 20, 1, 50)
        const events = await listRecentOutreachEvents(ctx.companyId, ctx.organizationId, limit)
        return {
          kind: 'continue',
          content: JSON.stringify({
            results: events.map((e) => ({
              id: e.id,
              kind: e.kind,
              summary: e.summary,
              details: e.details ?? null,
              source_url: e.sourceUrl,
              created_at: e.createdAt
            }))
          })
        }
      }
      case 'list_email_engagement': {
        const sentLimit = clamp(Number(args.sent_limit) || 15, 1, 25)
        const threadLimit = clamp(Number(args.thread_limit) || 15, 1, 25)
        const [sent, threads] = await Promise.all([
          listSentDraftEngagement(ctx.companyId, ctx.organizationId, sentLimit),
          listThreadMessagesForCompany(ctx.companyId, ctx.organizationId, threadLimit)
        ])
        return {
          kind: 'continue',
          content: JSON.stringify({
            sent_emails: sent.map((d) => ({
              draft_id: d.id,
              to_email: d.toEmail,
              subject: d.subject,
              sent_at: d.sentAt,
              open_count: d.openCount,
              first_opened_at: d.firstOpenedAt,
              last_opened_at: d.lastOpenedAt
            })),
            thread_messages: threads.map((m) => ({
              draft_id: m.draftId,
              kind: m.kind,
              from_email: m.fromEmail,
              subject: m.subject,
              body_text: m.bodyText,
              received_at: m.receivedAt
            }))
          })
        }
      }
      case 'list_drafts': {
        const limit = clamp(Number(args.limit) || 10, 1, 25)
        const drafts = await listRecentDrafts(ctx.companyId, ctx.organizationId, limit)
        return {
          kind: 'continue',
          content: JSON.stringify({
            results: drafts.map((d) => ({
              id: d.id,
              status: d.status,
              to_email: d.toEmail,
              subject: d.subject,
              body_preview: d.body.slice(0, 280),
              agent_rationale: d.agentRationale,
              review_notes: d.reviewNotes,
              sent_at: d.sentAt,
              open_count: d.openCount,
              first_opened_at: d.firstOpenedAt,
              last_opened_at: d.lastOpenedAt,
              created_at: d.createdAt
            }))
          })
        }
      }
      case 'list_people_at_company': {
        const limit = clamp(Number(args.limit) || 25, 1, 50)
        const rows = await listPeopleAtCompany(ctx.companyId, ctx.organizationId, limit)
        return {
          kind: 'continue',
          content: JSON.stringify({
            results: rows.map((r) => ({
              id: r.id,
              full_name: r.fullName,
              title: r.title,
              seniority: r.seniority,
              department: r.department,
              email: r.email,
              phone: r.phone,
              linkedin_url: r.linkedinUrl,
              twitter_url: r.twitterUrl,
              notes: r.notes,
              context: r.context,
              lifecycle_status: r.lifecycleStatus
            }))
          })
        }
      }
      case 'search_existing_people': {
        const { rows, total } = await searchPeople({
          organizationId: ctx.organizationId,
          query: typeof args.query === 'string' ? args.query : null,
          companyName: typeof args.company_name === 'string' ? args.company_name : null,
          limit: typeof args.limit === 'number' ? args.limit : 20,
          offset: typeof args.offset === 'number' ? args.offset : 0
        })
        return {
          kind: 'continue',
          content: JSON.stringify({
            total,
            results: rows.map((r) => ({
              id: r.id,
              full_name: r.fullName,
              title: r.title,
              company_name: r.companyName,
              has_email: Boolean(r.email),
              has_linkedin: Boolean(r.linkedinUrl)
            }))
          })
        }
      }
      case 'get_person': {
        const id = typeof args.id === 'string' ? args.id : null
        if (!id) return { kind: 'continue', content: JSON.stringify({ error: 'id required' }) }
        const person = await getPerson(id, ctx.organizationId)
        if (!person) return { kind: 'continue', content: JSON.stringify({ error: 'not_found' }) }
        return {
          kind: 'continue',
          content: JSON.stringify({
            id: person.id,
            full_name: person.fullName,
            title: person.title,
            seniority: person.seniority,
            department: person.department,
            email: person.email,
            phone: person.phone,
            linkedin_url: person.linkedinUrl,
            twitter_url: person.twitterUrl,
            notes: person.notes,
            context: person.context,
            lifecycle_status: person.lifecycleStatus,
            company: person.company
              ? { id: person.company.id, name: person.company.name, domain: person.company.domain }
              : null
          })
        }
      }
      case 'search_existing_companies': {
        const { rows, total } = await searchCompanies({
          organizationId: ctx.organizationId,
          query: typeof args.query === 'string' ? args.query : null,
          limit: typeof args.limit === 'number' ? args.limit : 20,
          offset: typeof args.offset === 'number' ? args.offset : 0
        })
        return {
          kind: 'continue',
          content: JSON.stringify({
            total,
            results: rows.map((r) => ({
              id: r.id,
              name: r.name,
              domain: r.domain,
              website: r.website,
              industry: r.industry
            }))
          })
        }
      }
      case 'web_search': {
        if (ctx.used.webSearches >= MAX_WEB_SEARCHES) {
          return {
            kind: 'continue',
            content: JSON.stringify({ error: 'web_search budget exhausted', limit: MAX_WEB_SEARCHES })
          }
        }
        const query = typeof args.query === 'string' ? args.query : ''
        if (!query.trim()) {
          return { kind: 'continue', content: JSON.stringify({ error: 'query required' }) }
        }
        const numResults = clamp(Number(args.num_results) || 5, 1, 10)
        const results = await exaSearch(query, numResults)
        ctx.used.webSearches += 1
        ctx.lastWebSearchQuery = query
        return {
          kind: 'continue',
          content: JSON.stringify({
            remaining_web_searches: MAX_WEB_SEARCHES - ctx.used.webSearches,
            results: results.map((r) => ({
              title: r.title,
              url: r.url,
              summary: r.summary,
              highlights: r.highlights
            }))
          })
        }
      }
      case 'fetch_url': {
        if (ctx.used.fetchUrls >= MAX_FETCH_URLS) {
          return {
            kind: 'continue',
            content: JSON.stringify({ error: 'fetch_url budget exhausted', limit: MAX_FETCH_URLS })
          }
        }
        const url = typeof args.url === 'string' ? args.url : ''
        if (!url) return { kind: 'continue', content: JSON.stringify({ error: 'url required' }) }
        const out = await exaFetchUrl(url)
        ctx.used.fetchUrls += 1
        ctx.lastSourceUrlHinted = url
        return {
          kind: 'continue',
          content: JSON.stringify({
            remaining_fetch_urls: MAX_FETCH_URLS - ctx.used.fetchUrls,
            url,
            title: out.title,
            text: out.text
          })
        }
      }
      case 'update_company_details': {
        const out = await updateCompanyDetails(
          ctx.companyId,
          ctx.organizationId,
          {
            ...(Object.prototype.hasOwnProperty.call(args, 'name')
              ? { name: (args.name as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'domain')
              ? { domain: (args.domain as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'website')
              ? { website: (args.website as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'industry')
              ? { industry: (args.industry as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'employee_range')
              ? { employeeRange: (args.employee_range as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'hq_location')
              ? { hqLocation: (args.hq_location as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'notes')
              ? { notes: (args.notes as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'outreach_email_instructions')
              ? {
                  outreachEmailInstructions:
                    (args.outreach_email_instructions as string | null | undefined) ?? null
                }
              : {})
          },
          typeof args.reason === 'string' ? args.reason : null
        )
        if (!out.ok) return { kind: 'continue', content: JSON.stringify({ error: out.error }) }
        return {
          kind: 'continue',
          content: JSON.stringify({ ok: true, changed_fields: out.changedFields })
        }
      }
      case 'update_person': {
        const personId = typeof args.person_id === 'string' ? args.person_id : ''
        if (!personId.trim()) {
          return { kind: 'continue', content: JSON.stringify({ error: 'person_id required' }) }
        }
        const out = await updatePersonAtCompany(
          ctx.companyId,
          ctx.organizationId,
          personId,
          {
            ...(Object.prototype.hasOwnProperty.call(args, 'full_name')
              ? { fullName: (args.full_name as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'title')
              ? { title: (args.title as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'seniority')
              ? { seniority: (args.seniority as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'department')
              ? { department: (args.department as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'email')
              ? { email: (args.email as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'phone')
              ? { phone: (args.phone as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'linkedin_url')
              ? { linkedinUrl: (args.linkedin_url as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'twitter_url')
              ? { twitterUrl: (args.twitter_url as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'notes')
              ? { notes: (args.notes as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'context')
              ? { context: (args.context as string | null | undefined) ?? null }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'lifecycle_status')
              ? { lifecycleStatus: (args.lifecycle_status as string | null | undefined) ?? null }
              : {})
          },
          typeof args.reason === 'string' ? args.reason : null
        )
        if (!out.ok) return { kind: 'continue', content: JSON.stringify({ error: out.error }) }
        return {
          kind: 'continue',
          content: JSON.stringify({ ok: true, person_id: personId, changed_fields: out.changedFields })
        }
      }
      case 'upsert_person': {
        const fullName = typeof args.full_name === 'string' ? args.full_name : ''
        const context = typeof args.context === 'string' ? args.context : ''
        if (!fullName.trim() || !context.trim()) {
          return {
            kind: 'continue',
            content: JSON.stringify({ error: 'full_name and context are required' })
          }
        }
        const result = await upsertPersonAtCompany(
          ctx.companyId,
          ctx.organizationId,
          {
            fullName,
            title: (args.title as string | null | undefined) ?? null,
            seniority: (args.seniority as string | null | undefined) ?? null,
            department: (args.department as string | null | undefined) ?? null,
            email: (args.email as string | null | undefined) ?? null,
            phone: (args.phone as string | null | undefined) ?? null,
            linkedinUrl: (args.linkedin_url as string | null | undefined) ?? null,
            twitterUrl: (args.twitter_url as string | null | undefined) ?? null,
            notes: (args.notes as string | null | undefined) ?? null,
            context,
            lifecycleStatus: (args.lifecycle_status as string | null | undefined) ?? null
          },
          typeof args.reason === 'string' ? args.reason : null
        )
        if (!result.ok) {
          return {
            kind: 'continue',
            content: JSON.stringify({ error: result.error, person_id: result.personId })
          }
        }
        return {
          kind: 'continue',
          content: JSON.stringify({
            ok: true,
            person_id: result.personId,
            created: result.created,
            merged: result.merged,
            changed_fields: result.changedFields
          })
        }
      }
      case 'delete_draft': {
        const draftId = typeof args.draft_id === 'string' ? args.draft_id : ''
        const reason = typeof args.reason === 'string' ? args.reason : ''
        if (!draftId.trim()) {
          return { kind: 'continue', content: JSON.stringify({ error: 'draft_id required' }) }
        }
        const out = await deleteOutreachDraft(ctx.companyId, ctx.organizationId, draftId)
        if (!out.ok) {
          return { kind: 'continue', content: JSON.stringify({ error: out.error, reason }) }
        }
        return {
          kind: 'continue',
          content: JSON.stringify({ ok: true, deleted_draft_id: draftId, reason })
        }
      }
      case 'draft_email': {
        const toEmail = typeof args.to_email === 'string' ? args.to_email : ''
        const subject = typeof args.subject === 'string' ? args.subject : ''
        const body = typeof args.body === 'string' ? args.body : ''
        if (!toEmail.trim() || !subject.trim() || !body.trim()) {
          return {
            kind: 'continue',
            content: JSON.stringify({ error: 'to_email, subject, and body are required' })
          }
        }
        const inserted = await insertDraft({
          organizationId: ctx.organizationId,
          companyId: ctx.companyId,
          mailboxId: ctx.mailboxId,
          personId: typeof args.person_id === 'string' ? args.person_id : null,
          toEmail,
          subject,
          body,
          bodyHtml: typeof args.body_html === 'string' ? args.body_html : null,
          agentRationale: typeof args.agent_rationale === 'string' ? args.agent_rationale : null
        })
        if (!inserted.ok) {
          return {
            kind: 'continue',
            content: JSON.stringify({
              error: 'duplicate_pending_draft',
              message: inserted.error,
              existing_draft_id: inserted.existingDraftId,
              existing_subject: inserted.existingSubject,
              hint: 'Call delete_draft with existing_draft_id, then draft_email again.'
            })
          }
        }
        ctx.draftsCreated += 1
        return {
          kind: 'continue',
          content: JSON.stringify({
            ok: true,
            draft_id: inserted.draft.id,
            status: inserted.draft.status
          })
        }
      }
      case 'mark_completed': {
        const reason = typeof args.reason === 'string' ? args.reason : 'completed by agent'
        await markCompanyOutreachStatus(ctx.companyId, 'completed', ctx.organizationId, { clearWake: true })
        await appendOutreachEvent({
          organizationId: ctx.organizationId,
          companyId: ctx.companyId,
          kind: 'decision',
          summary: `Marked completed: ${reason}`
        })
        return {
          kind: 'terminate',
          outcome: { status: 'completed', reason },
          content: JSON.stringify({ ok: true })
        }
      }
      case 'pause': {
        const reason = typeof args.reason === 'string' ? args.reason : 'paused by agent'
        await markCompanyOutreachStatus(ctx.companyId, 'paused', ctx.organizationId, { clearWake: true })
        await appendOutreachEvent({
          organizationId: ctx.organizationId,
          companyId: ctx.companyId,
          kind: 'decision',
          summary: `Paused: ${reason}`
        })
        return {
          kind: 'terminate',
          outcome: { status: 'paused', reason },
          content: JSON.stringify({ ok: true })
        }
      }
      case 'sleep': {
        const reason = typeof args.reason === 'string' ? args.reason : 'session complete'
        const hoursRaw = args.wake_after_hours
        const hours =
          typeof hoursRaw === 'number' && Number.isFinite(hoursRaw)
            ? clamp(Math.round(hoursRaw), 1, 24 * 30)
            : 24
        const wakeAt = new Date(Date.now() + hours * 60 * 60 * 1000)
        await setNextWake(ctx.companyId, ctx.organizationId, wakeAt, { lastWorkedAt: new Date() })
        await appendOutreachEvent({
          organizationId: ctx.organizationId,
          companyId: ctx.companyId,
          kind: 'note',
          summary: `Sleeping for ${hours}h: ${reason}`,
          details: { wakeAt: wakeAt.toISOString() }
        })
        return {
          kind: 'terminate',
          outcome: { status: 'slept', reason, wakeAt },
          content: JSON.stringify({ ok: true, wake_at: wakeAt.toISOString() })
        }
      }
      default:
        return { kind: 'continue', content: JSON.stringify({ error: `unknown tool: ${name}` }) }
    }
  } catch (err) {
    return {
      kind: 'continue',
      content: JSON.stringify({
        error: 'tool_error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

async function callOpenRouter(messages: ChatMessage[]): Promise<{
  toolCalls: ToolCall[]
  text: string | null
  finishReason: string | null
}> {
  const model = process.env.OPENROUTER_WORK_ACCOUNT_MODEL ?? WORK_ACCOUNT_MODEL
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requiredEnv('OPENROUTER_API_KEY')}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://api.flash.orinlabs.ai',
      'X-Title': 'Flash Outreach Agent'
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: openRouterReasoningConfig()
    })
  })

  if (!res.ok) {
    throw new Error(`OpenRouter call failed (${res.status}): ${await res.text()}`)
  }

  const payload = (await res.json()) as OpenRouterResponse
  if (payload.error?.message) {
    throw new Error(`OpenRouter error: ${payload.error.message}`)
  }
  const choice = payload.choices?.[0]
  const message = choice?.message
  if (message?.refusal) {
    throw new Error(`Model refused: ${message.refusal}`)
  }
  return {
    toolCalls: message?.tool_calls ?? [],
    text: message?.content ?? null,
    finishReason: choice?.finish_reason ?? null
  }
}

function buildSystemPrompt(): string {
  return [
    'You are an outreach agent working a single target account on behalf of the operator.',
    '',
    'Your goals, in priority order:',
    '1. Find a credible path to a real human inside this company.',
    '2. Draft a thoughtful, specific email (or several) that the operator can review and send from the assigned mailbox.',
    '3. Maintain account records as you learn sourced facts: add useful people with upsert_person, correct existing people with update_person, and update company details with update_company_details.',
    '4. Maintain the strategy document so the next wake-up has full context. Use list_recent_events to see what already happened (sends, operator actions); use update_strategy for your working plan.',
    '',
    'Channels and angles you are encouraged to explore:',
    '- Cold email to a named exec / IC with a specific reason (recent news, hire, product launch, talk).',
    '- Warm intro paths: shared investors, shared employers, shared board members, shared advisors.',
    '- Public events: conferences they speak at, podcasts they appear on, summits they attend.',
    '- Content hooks: their recent blog posts, tweets, talks, hiring patterns, jobs posted.',
    '- Mutuals already in our DB (use search_existing_people).',
    '',
    'Outreach pacing:',
    '- Do not parallelize too much across many contacts. First identify the best 1-2 people or paths for this account.',
    '- Reach out to that small set once or twice with the strongest angle before moving on.',
    '- Only expand to additional people after the first 1-2 targets are clearly exhausted, unavailable, or a much stronger path appears.',
    '- Prefer quality and continuity over breadth: keep the strategy focused on who you are trying now, why them, and what would make you move to the next person.',
    '- The current time is included in the account context. Use it when interpreting timeline and draft timestamps.',
    '- If an email was recently sent and not enough time has passed for the next touch, do not draft the next email yet. Update the strategy if useful, then sleep until the next appropriate send window. If no explicit cadence is saved, wait at least 24 hours after the most recent sent email before drafting another email for this account.',
    '',
    'Record maintenance:',
    '- Use upsert_person when you discover a real named person at this account worth tracking, even if you are not ready to draft to them yet.',
    '- Use update_person when a known contact has stale or incomplete title, department, email, phone, LinkedIn/Twitter, notes, context, or lifecycle status.',
    '- Use update_company_details for sourced corrections or enrichments to the company profile: name, domain, website, industry, employee range, HQ, notes, or account email instructions.',
    '- Do not overwrite useful existing notes or instructions with shorter weaker text. If replacing notes/instructions, preserve the important prior details in your new value.',
    '- Never clear a field just because you could not verify it in this session. Clear only when you have evidence it is wrong or obsolete.',
    '',
    LAVENDER_COLD_EMAIL_101_PROMPT_BLOCK,
    '',
    'Recipient and email-address rules:',
    '- Never draft_email to generic role inboxes (hello@, info@, contact@, sales@, support@, team@, office@, media@) unless the strategy explicitly targets that inbox AND you have sourced proof that this thread or owner is correct.',
    '- Never use an address you cannot defend: prefer a verified address from the web, press, filings, or our DB. If you cannot find the exact address but you did find the company’s real pattern (e.g. first.last@domain.com, flast@, f.last@) from staff listings, press quotes, or similar, you MAY construct the likely address for a named individual and explain the pattern + sources in agent_rationale — that is acceptable when the pattern is well-supported even if the exact mailbox is unlisted.',
    '- Do not fabricate domains, patterns, or people. If you lack both a verified address and a sourced pattern, do not draft — research more, update_strategy if needed, then sleep or pause.',
    'Draft queue rules:',
    '- At most one pending-review draft per recipient address (to_email) on this account. The system rejects a second draft to the same address.',
    '- Before draft_email, call list_drafts. If a pending draft already exists for that recipient, delete_draft it first, then draft_email your revised version.',
    '- If you wrote a bad draft, delete_draft it and replace with a corrected one rather than leaving junk in the queue.',
    '',
    'Hard rules:',
    '- Use only real, sourced information. Never invent a person, email, or fact.',
    '- Drafts you create with draft_email do NOT get sent automatically. The operator reviews them in the Drafts UI and approves them; only then do they send.',
    '- Be specific. Generic cold copy is rejected by the operator.',
    '- In draft_email subject and body: do not use an em dash (the long punctuation dash, U+2014). Use a comma, period, colon, hyphen, or parentheses instead.',
    '- When emails are sent from the Drafts UI, the system records sends/opens/replies/bounces on the timeline. Use list_recent_events, list_email_engagement, and list_drafts before deciding follow-ups.',
    '- Always end the session with sleep, pause, or mark_completed. Never just stop talking.',
    '- Communicate only through tool calls; do not produce a final text answer.'
  ].join('\n')
}

function buildSeedUserMessage(input: {
  company: NonNullable<Awaited<ReturnType<typeof getCompanyForOutreach>>>
  strategy: string | null
  events: Awaited<ReturnType<typeof listRecentOutreachEvents>>
  drafts: Awaited<ReturnType<typeof listRecentDrafts>>
  sentEngagement: Awaited<ReturnType<typeof listSentDraftEngagement>>
  threadMessages: Awaited<ReturnType<typeof listThreadMessagesForCompany>>
  people: Awaited<ReturnType<typeof listPeopleAtCompany>>
  now: Date
}): string {
  const { company, strategy, events, drafts, sentEngagement, threadMessages, people: peopleList, now } =
    input
  const mailboxBlock = company.mailbox
    ? [
        `You are sending from: ${company.mailbox.email}` +
          (company.mailbox.displayName ? ` (${company.mailbox.displayName})` : ''),
        company.mailbox.senderBio
          ? `Sender bio:\n${company.mailbox.senderBio}`
          : '(No sender bio set — keep the voice generic but professional.)',
        company.mailbox.signature
          ? `Signature (already appended on send; do NOT include in body):\n${company.mailbox.signature}`
          : ''
      ]
        .filter(Boolean)
        .join('\n')
    : 'WARNING: no mailbox is assigned. Do NOT call draft_email. Update the strategy and sleep.'

  const mailboxInstr = company.mailbox?.outreachEmailInstructions?.trim()
  const accountInstr = company.outreachEmailInstructions?.trim()
  const operatorEmailInstructionsBlock =
    mailboxInstr || accountInstr
      ? [
          mailboxInstr
            ? `Mailbox-wide operator email instructions (every account using this mailbox):\n"""\n${mailboxInstr}\n"""`
            : '',
          accountInstr
            ? `This account's operator email instructions:\n"""\n${accountInstr}\n"""`
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      : 'Operator email instructions: (none saved yet — the operator can add them from draft feedback or company/mailbox settings.)'

  const strategyBlock = strategy?.trim()
    ? `Current strategy (verbatim, editable by operator between runs):\n"""\n${strategy.trim()}\n"""`
    : 'No strategy doc yet. Your first job is to write one with update_strategy.'

  const eventsBlock =
    events.length === 0
      ? 'Timeline: (empty — this is the first session)'
      : 'Timeline (newest first):\n' +
        events
          .slice(0, 15)
          .map(
            (e) =>
              `- ${e.createdAt.toISOString()} [${e.kind}] ${e.summary}${
                e.sourceUrl ? ` (${e.sourceUrl})` : ''
              }${
                e.details && Object.keys(e.details).length > 0
                  ? ` | ${JSON.stringify(e.details).slice(0, 240)}`
                  : ''
              }`
          )
          .join('\n')

  const engagementBlock =
    sentEngagement.length === 0 && threadMessages.length === 0
      ? 'Email engagement: no sent mail tracked yet.'
      : [
          sentEngagement.length > 0
            ? 'Sent mail (opens):\n' +
              sentEngagement
                .map(
                  (d) =>
                    `- to=${d.toEmail} | "${d.subject}" | sent=${d.sentAt?.toISOString() ?? '?'} | opens=${d.openCount}${
                      d.firstOpenedAt ? ` | first_open=${d.firstOpenedAt.toISOString()}` : ''
                    }`
                )
                .join('\n')
            : '',
          threadMessages.length > 0
            ? 'Replies / bounces:\n' +
              threadMessages
                .map(
                  (m) =>
                    `- [${m.kind}] ${m.receivedAt.toISOString()} from=${m.fromEmail ?? '?'} re: ${m.subject ?? '(no subject)'}\n  ${(m.bodyText ?? '').slice(0, 400).replace(/\s+/g, ' ')}`
                )
                .join('\n')
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')

  const draftsBlock =
    drafts.length === 0
      ? 'Drafts so far: none.'
      : 'Recent drafts:\n' +
        drafts
          .slice(0, 6)
          .map(
            (d) =>
              `- [${d.status}] to=${d.toEmail} | "${d.subject}" | created_at=${d.createdAt.toISOString()}${
                d.sentAt ? ` | sent_at=${d.sentAt.toISOString()}` : ''
              }${d.status === 'sent' ? ` | opens=${d.openCount}` : ''}${
                d.reviewNotes ? ` | user notes: ${d.reviewNotes}` : ''
              }`
          )
          .join('\n')

  const peopleBlock =
    peopleList.length === 0
      ? 'Known people at this account: none yet. Use search/web to find some.'
      : 'Known people at this account:\n' +
        peopleList
          .slice(0, 15)
          .map(
            (p) =>
              `- ${p.fullName ?? '(no name)'}${p.title ? ` — ${p.title}` : ''}${
                p.email ? ` <${p.email}>` : ''
              }${p.linkedinUrl ? ` | ${p.linkedinUrl}` : ''}`
          )
          .join('\n')

  return [
    `Current time: ${now.toISOString()}`,
    '',
    `Target account: ${company.name}` +
      (company.domain ? ` (${company.domain})` : company.website ? ` (${company.website})` : ''),
    company.industry ? `Industry: ${company.industry}` : '',
    company.hqLocation ? `HQ: ${company.hqLocation}` : '',
    company.notes ? `Company notes:\n${company.notes}` : '',
    '',
    mailboxBlock,
    '',
    operatorEmailInstructionsBlock,
    '',
    strategyBlock,
    '',
    eventsBlock,
    '',
    engagementBlock,
    '',
    draftsBlock,
    '',
    peopleBlock,
    '',
    'Begin. Do at most one full pass: update the strategy if needed, research the most promising angle, optionally draft one or two emails for review, then sleep (or pause/mark_completed).'
  ]
    .filter(Boolean)
    .join('\n')
}

export async function workAccountAgent(input: AgentInput): Promise<WorkAccountAgentResult> {
  const now = new Date()
  const company = await getCompanyForOutreach(input.companyId, input.organizationId)
  if (!company) {
    return { status: 'error', error: `company not found: ${input.companyId}`, steps: 0, draftsCreated: 0 }
  }
  const organizationId = company.organizationId
  if (!company.outreachMailboxId || !company.mailbox) {
    return {
      status: 'error',
      error: `company ${company.id} has no mailbox assigned`,
      steps: 0,
      draftsCreated: 0
    }
  }
  if (company.outreachStatus !== 'working') {
    return {
      status: 'error',
      error: `company ${company.id} is not in working status (${company.outreachStatus})`,
      steps: 0,
      draftsCreated: 0
    }
  }

  try {
    await syncCompanyDraftThreads(company.id, organizationId)
  } catch (err) {
    console.warn(
      `[outreachAgent] thread sync failed for company ${company.id}:`,
      err instanceof Error ? err.message : err
    )
  }

  const [strategy, events, drafts, sentEngagement, threadMessages, peopleList] = await Promise.all([
    Promise.resolve(company.outreachStrategy),
    listRecentOutreachEvents(company.id, organizationId, 25),
    listRecentDrafts(company.id, organizationId, 10),
    listSentDraftEngagement(company.id, organizationId, 12),
    listThreadMessagesForCompany(company.id, organizationId, 12),
    listPeopleAtCompany(company.id, organizationId, 25)
  ])

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: buildSeedUserMessage({
        company,
        strategy,
        events,
        drafts,
        sentEngagement,
        threadMessages,
        people: peopleList,
        now
      })
    }
  ]

  const ctx: ToolCtx = {
    organizationId,
    companyId: company.id,
    mailboxId: company.outreachMailboxId,
    used: { webSearches: 0, fetchUrls: 0 },
    draftsCreated: 0,
    lastSourceUrlHinted: null,
    lastWebSearchQuery: null
  }

  let steps = 0
  while (steps < MAX_STEPS) {
    steps += 1
    let llmResult: Awaited<ReturnType<typeof callOpenRouter>>
    try {
      llmResult = await callOpenRouter(messages)
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        steps,
        draftsCreated: ctx.draftsCreated
      }
    }
    const { toolCalls, text, finishReason } = llmResult

    if (toolCalls.length === 0) {
      if (finishReason === 'stop') {
        // Auto-sleep so we don't leave the account hanging.
        const wakeAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
        await setNextWake(ctx.companyId, ctx.organizationId, wakeAt, { lastWorkedAt: new Date() })
        await appendOutreachEvent({
          organizationId: ctx.organizationId,
          companyId: ctx.companyId,
          kind: 'note',
          summary: 'Agent ended without a sleep tool call; defaulting to 24h sleep.'
        })
        return {
          status: 'slept',
          reason: text?.slice(0, 200) ?? 'no tool call from model',
          wakeAt,
          steps,
          draftsCreated: ctx.draftsCreated
        }
      }
      messages.push({ role: 'assistant', content: text })
      messages.push({
        role: 'user',
        content: 'Respond only via tool calls. End every session with sleep, pause, or mark_completed.'
      })
      continue
    }

    messages.push({ role: 'assistant', content: text, tool_calls: toolCalls })

    let terminated: ToolDispatchResult['kind'] | null = null
    let terminateOutcome: Extract<ToolDispatchResult, { kind: 'terminate' }>['outcome'] | null =
      null

    for (const call of toolCalls) {
      const toolCallStartedAt = logToolCallStart(ctx.companyId, steps, call)
      const out = await dispatchTool(ctx, call)
      logToolCallEnd(ctx.companyId, steps, call, toolCallStartedAt, out)
      if (out.kind === 'continue') {
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.content })
      } else {
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.content })
        terminated = 'terminate'
        terminateOutcome = out.outcome
        break
      }
    }

    if (terminated === 'terminate' && terminateOutcome) {
      if (terminateOutcome.status === 'slept') {
        return {
          status: 'slept',
          reason: terminateOutcome.reason,
          wakeAt: terminateOutcome.wakeAt,
          steps,
          draftsCreated: ctx.draftsCreated
        }
      }
      if (terminateOutcome.status === 'paused') {
        return {
          status: 'paused',
          reason: terminateOutcome.reason,
          steps,
          draftsCreated: ctx.draftsCreated
        }
      }
      if (terminateOutcome.status === 'completed') {
        return {
          status: 'completed',
          reason: terminateOutcome.reason,
          steps,
          draftsCreated: ctx.draftsCreated
        }
      }
    }
  }

  // Step budget exhausted without an explicit terminator: park it.
  const wakeAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  await setNextWake(ctx.companyId, ctx.organizationId, wakeAt, { lastWorkedAt: new Date() })
  await appendOutreachEvent({
    organizationId: ctx.organizationId,
    companyId: ctx.companyId,
    kind: 'note',
    summary: `Agent step budget (${MAX_STEPS}) exhausted; sleeping 24h.`
  })
  return { status: 'exhausted', steps, draftsCreated: ctx.draftsCreated }
}
