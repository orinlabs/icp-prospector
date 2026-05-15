import {
  appendOutreachEvent,
  deleteOutreachDraft,
  getCompanyForOutreach,
  insertDraft,
  listPeopleAtCompany,
  listRecentDrafts,
  listRecentOutreachEvents,
  markCompanyOutreachStatus,
  setNextWake,
  writeStrategy
} from './repoOutreach.js'
import {
  exaFetchUrl,
  exaSearch,
  getPerson,
  requiredEnv,
  searchCompanies,
  searchPeople,
  upsertPerson
} from './repo.js'
import { LAVENDER_COLD_EMAIL_101_PROMPT_BLOCK } from '../lib/lavenderColdEmail101.js'

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
        "Read this account's timeline (most recent first): emails sent, send failures, operator discards/regenerates, strategy revisions, and session notes. You cannot append to it — use update_strategy for durable notes between runs.",
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
        "Read this account's recent drafts (status, subject, body preview, to_email, agent_rationale, review_notes). Look here before drafting another email so you don't repeat angles or addressees.",
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
      name: 'upsert_person',
      description:
        'Add (or merge with) a person at THIS account. Use when you discover a new exec, mutual, investor, or other contact worth tracking. Returns the person id you can use in draft_email.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          full_name: { type: 'string' },
          title: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          linkedin_url: { type: ['string', 'null'] },
          twitter_url: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] },
          context: { type: 'string', description: 'One paragraph: who they are, why relevant to outreach.' }
        },
        required: ['full_name', 'title', 'email', 'linkedin_url', 'twitter_url', 'notes', 'context']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_draft',
      description:
        'Permanently remove a pending-review draft for THIS account (e.g. wrong recipient, bad angle, superseded). Only works while status is pending_review; cannot delete sent mail.',
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
        'Create an in-app email draft for the user to review and approve from the Drafts page. Does NOT touch Gmail. The user will approve and send (or discard) themselves. Include `agent_rationale`: a short justification for why this person, this angle, this content.',
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
}

type ToolCtx = {
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
        await writeStrategy(ctx.companyId, newText, reason)
        return { kind: 'continue', content: JSON.stringify({ ok: true }) }
      }
      case 'list_recent_events': {
        const limit = clamp(Number(args.limit) || 20, 1, 50)
        const events = await listRecentOutreachEvents(ctx.companyId, limit)
        return {
          kind: 'continue',
          content: JSON.stringify({
            results: events.map((e) => ({
              id: e.id,
              kind: e.kind,
              summary: e.summary,
              source_url: e.sourceUrl,
              created_at: e.createdAt
            }))
          })
        }
      }
      case 'list_drafts': {
        const limit = clamp(Number(args.limit) || 10, 1, 25)
        const drafts = await listRecentDrafts(ctx.companyId, limit)
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
              created_at: d.createdAt
            }))
          })
        }
      }
      case 'list_people_at_company': {
        const limit = clamp(Number(args.limit) || 25, 1, 50)
        const rows = await listPeopleAtCompany(ctx.companyId, limit)
        return {
          kind: 'continue',
          content: JSON.stringify({
            results: rows.map((r) => ({
              id: r.id,
              full_name: r.fullName,
              title: r.title,
              email: r.email,
              linkedin_url: r.linkedinUrl,
              twitter_url: r.twitterUrl,
              notes: r.notes,
              context: r.context
            }))
          })
        }
      }
      case 'search_existing_people': {
        const { rows, total } = await searchPeople({
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
        const person = await getPerson(id)
        if (!person) return { kind: 'continue', content: JSON.stringify({ error: 'not_found' }) }
        return {
          kind: 'continue',
          content: JSON.stringify({
            id: person.id,
            full_name: person.fullName,
            title: person.title,
            email: person.email,
            linkedin_url: person.linkedinUrl,
            notes: person.notes,
            context: person.context,
            company: person.company
              ? { id: person.company.id, name: person.company.name, domain: person.company.domain }
              : null
          })
        }
      }
      case 'search_existing_companies': {
        const { rows, total } = await searchCompanies({
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
      case 'upsert_person': {
        const fullName = typeof args.full_name === 'string' ? args.full_name : ''
        const context = typeof args.context === 'string' ? args.context : ''
        if (!fullName.trim() || !context.trim()) {
          return {
            kind: 'continue',
            content: JSON.stringify({ error: 'full_name and context are required' })
          }
        }
        const result = await upsertPerson(
          {
            fullName,
            title: (args.title as string | null | undefined) ?? null,
            email: (args.email as string | null | undefined) ?? null,
            linkedinUrl: (args.linkedin_url as string | null | undefined) ?? null,
            twitterUrl: (args.twitter_url as string | null | undefined) ?? null,
            notes: (args.notes as string | null | undefined) ?? null,
            context
          },
          // Use a synthetic campaign id of the company id — we don't have a campaign here.
          // upsertPerson stores it on first_seen_campaign_id which is nullable-on-delete.
          ctx.companyId,
          ctx.companyId
        )
        if (!result.ok) {
          if (result.reason === 'duplicate') {
            return {
              kind: 'continue',
              content: JSON.stringify({
                ok: true,
                person_id: result.personId,
                note: 'matched existing person'
              })
            }
          }
          return {
            kind: 'continue',
            content: JSON.stringify({ error: result.reason, message: result.message })
          }
        }
        return {
          kind: 'continue',
          content: JSON.stringify({ ok: true, person_id: result.personId, created: result.created })
        }
      }
      case 'delete_draft': {
        const draftId = typeof args.draft_id === 'string' ? args.draft_id : ''
        const reason = typeof args.reason === 'string' ? args.reason : ''
        if (!draftId.trim()) {
          return { kind: 'continue', content: JSON.stringify({ error: 'draft_id required' }) }
        }
        const out = await deleteOutreachDraft(ctx.companyId, draftId)
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
        const draft = await insertDraft({
          companyId: ctx.companyId,
          mailboxId: ctx.mailboxId,
          personId: typeof args.person_id === 'string' ? args.person_id : null,
          toEmail,
          subject,
          body,
          bodyHtml: typeof args.body_html === 'string' ? args.body_html : null,
          agentRationale: typeof args.agent_rationale === 'string' ? args.agent_rationale : null
        })
        ctx.draftsCreated += 1
        return {
          kind: 'continue',
          content: JSON.stringify({ ok: true, draft_id: draft.id, status: draft.status })
        }
      }
      case 'mark_completed': {
        const reason = typeof args.reason === 'string' ? args.reason : 'completed by agent'
        await markCompanyOutreachStatus(ctx.companyId, 'completed', { clearWake: true })
        await appendOutreachEvent({
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
        await markCompanyOutreachStatus(ctx.companyId, 'paused', { clearWake: true })
        await appendOutreachEvent({
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
        await setNextWake(ctx.companyId, wakeAt, { lastWorkedAt: new Date() })
        await appendOutreachEvent({
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
      parallel_tool_calls: false
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
    '3. Maintain the strategy document so the next wake-up has full context. Use list_recent_events to see what already happened (sends, operator actions); use update_strategy for your working plan.',
    '',
    'Channels and angles you are encouraged to explore:',
    '- Cold email to a named exec / IC with a specific reason (recent news, hire, product launch, talk).',
    '- Warm intro paths: shared investors, shared employers, shared board members, shared advisors.',
    '- Public events: conferences they speak at, podcasts they appear on, summits they attend.',
    '- Content hooks: their recent blog posts, tweets, talks, hiring patterns, jobs posted.',
    '- Mutuals already in our DB (use search_existing_people).',
    '',
    LAVENDER_COLD_EMAIL_101_PROMPT_BLOCK,
    '',
    'Recipient and email-address rules:',
    '- Never draft_email to generic role inboxes (hello@, info@, contact@, sales@, support@, team@, office@, media@) unless the strategy explicitly targets that inbox AND you have sourced proof that this thread or owner is correct.',
    '- Never use an address you cannot defend: prefer a verified address from the web, press, filings, or our DB. If you cannot find the exact address but you did find the company’s real pattern (e.g. first.last@domain.com, flast@, f.last@) from staff listings, press quotes, or similar, you MAY construct the likely address for a named individual and explain the pattern + sources in agent_rationale — that is acceptable when the pattern is well-supported even if the exact mailbox is unlisted.',
    '- Do not fabricate domains, patterns, or people. If you lack both a verified address and a sourced pattern, do not draft — research more, update_strategy if needed, then sleep or pause.',
    '- If you wrote a bad draft, delete_draft it and replace with a corrected one rather than leaving junk in the queue.',
    '',
    'Hard rules:',
    '- Use only real, sourced information. Never invent a person, email, or fact.',
    '- Drafts you create with draft_email do NOT get sent automatically. The operator reviews them in the Drafts UI and approves them; only then do they send.',
    '- Be specific. Generic cold copy is rejected by the operator.',
    '- In draft_email subject and body: do not use an em dash (the long punctuation dash, U+2014). Use a comma, period, colon, hyphen, or parentheses instead.',
    '- When emails are actually sent from the Drafts UI, the system records that on the timeline automatically; use list_recent_events to see sends and failures.',
    '- Always end the session with sleep, pause, or mark_completed. Never just stop talking.',
    '- Communicate only through tool calls; do not produce a final text answer.'
  ].join('\n')
}

function buildSeedUserMessage(input: {
  company: NonNullable<Awaited<ReturnType<typeof getCompanyForOutreach>>>
  strategy: string | null
  events: Awaited<ReturnType<typeof listRecentOutreachEvents>>
  drafts: Awaited<ReturnType<typeof listRecentDrafts>>
  people: Awaited<ReturnType<typeof listPeopleAtCompany>>
}): string {
  const { company, strategy, events, drafts, people: peopleList } = input
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
          .map((e) => `- [${e.kind}] ${e.summary}${e.sourceUrl ? ` (${e.sourceUrl})` : ''}`)
          .join('\n')

  const draftsBlock =
    drafts.length === 0
      ? 'Drafts so far: none.'
      : 'Recent drafts:\n' +
        drafts
          .slice(0, 6)
          .map(
            (d) =>
              `- [${d.status}] to=${d.toEmail} | "${d.subject}"${
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
    `Target account: ${company.name}` +
      (company.domain ? ` (${company.domain})` : company.website ? ` (${company.website})` : ''),
    company.industry ? `Industry: ${company.industry}` : '',
    company.hqLocation ? `HQ: ${company.hqLocation}` : '',
    '',
    mailboxBlock,
    '',
    operatorEmailInstructionsBlock,
    '',
    strategyBlock,
    '',
    eventsBlock,
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
  const company = await getCompanyForOutreach(input.companyId)
  if (!company) {
    return { status: 'error', error: `company not found: ${input.companyId}`, steps: 0, draftsCreated: 0 }
  }
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

  const [strategy, events, drafts, peopleList] = await Promise.all([
    Promise.resolve(company.outreachStrategy),
    listRecentOutreachEvents(company.id, 25),
    listRecentDrafts(company.id, 10),
    listPeopleAtCompany(company.id, 25)
  ])

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: buildSeedUserMessage({ company, strategy, events, drafts, people: peopleList })
    }
  ]

  const ctx: ToolCtx = {
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
        await setNextWake(ctx.companyId, wakeAt, { lastWorkedAt: new Date() })
        await appendOutreachEvent({
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
      const out = await dispatchTool(ctx, call)
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
  await setNextWake(ctx.companyId, wakeAt, { lastWorkedAt: new Date() })
  await appendOutreachEvent({
    companyId: ctx.companyId,
    kind: 'note',
    summary: `Agent step budget (${MAX_STEPS}) exhausted; sleeping 24h.`
  })
  return { status: 'exhausted', steps, draftsCreated: ctx.draftsCreated }
}
