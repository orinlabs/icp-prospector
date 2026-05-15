import { estimateChatCostUsd } from '../lib/pricing.js'
import { openRouterReasoningConfig } from '../lib/openrouter.js'
import { attributeUsageToPerson, recordUsageEvent } from '../lib/usage.js'
import {
  appendCompanyNotes,
  exaFetchUrl,
  exaSearch,
  getCampaignDiscoveredPersonIds,
  getCompany,
  getPerson,
  getPersonCompanyId,
  recordDiscoveryEvent,
  requiredEnv,
  searchCompanies,
  searchPeople,
  upsertCompany,
  upsertPerson
} from './repo.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-5-mini'

const MAX_STEPS = 14
const MAX_WEB_SEARCHES = 4
const MAX_FETCH_URLS = 3

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
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    cost?: number
  }
  error?: { message?: string }
}

export type FindPersonAgentResult =
  | { status: 'found'; personId: string; steps: number }
  | { status: 'no_candidate'; reason: string; steps: number }
  | { status: 'duplicate'; personId: string; reason: string; steps: number }
  | { status: 'error'; error: string; steps: number }

type AgentInput = {
  organizationId: string
  campaignId: string
  campaignRunId: string
  campaignName: string
  icpDocument: string
  slotIndex: number
  totalSlots: number
}

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_existing_people',
      description:
        "Search people already in the database. Returns id, fullName, title, email presence, linkedinUrl presence, companyName. Use this BEFORE web searches to (a) see what's already discovered for this campaign and (b) avoid proposing duplicates.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: ['string', 'null'],
            description:
              "Free-text query matched against fullName, title, context, notes (ILIKE). Pass null to list everything."
          },
          company_name: {
            type: ['string', 'null'],
            description: 'Filter to people whose company name contains this substring.'
          },
          campaign_only: {
            type: 'boolean',
            description: 'If true, only show people already discovered for this campaign.'
          },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          offset: { type: 'integer', minimum: 0 }
        },
        required: ['query', 'company_name', 'campaign_only', 'limit', 'offset']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_person',
      description: 'Fetch a full person record (notes, context, keywords, contact fields) by id.',
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
      description:
        'Search companies in the database. Returns id, name, domain, website, industry, notes. Use before proposing a person so you can link them to an existing company instead of creating a duplicate.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: ['string', 'null'],
            description: 'Substring matched against name or domain. Pass null to list everything.'
          },
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
      name: 'get_company',
      description: 'Fetch a full company record by id.',
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
      name: 'web_search',
      description:
        "Search the web via Exa for pages about real people or companies matching the ICP. Returns title, url, summary, and short highlights for each result. Budget: 4 calls.",
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
      description:
        'Fetch the readable text of a specific URL (up to ~4000 chars). Use to dig into a LinkedIn profile page, leadership page, or news article. Budget: 3 calls.',
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
      name: 'record_person',
      description:
        "Final action: add one net-new person to the database for this campaign. You MUST supply either company_id (to link to an existing company) OR company_draft (to create a new one). Only call this once you've verified the person isn't already in the DB.",
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
          context: {
            type: 'string',
            description: 'One paragraph summarizing why this person fits the ICP. Required.'
          },
          company_notes: {
            type: ['string', 'null'],
            description:
              'Concise company-level notes from your research: what the company does, why it fits the ICP, notable signals, source-backed details. Do not duplicate person-specific notes.'
          },
          icp_keywords: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 12
          },
          source_url: {
            type: ['string', 'null'],
            description: 'The URL the evidence came from (LinkedIn, leadership page, etc.).'
          },
          company_id: {
            type: ['string', 'null'],
            description: 'Existing company UUID to link this person to. Set to null if creating a new company.'
          },
          company_draft: {
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  domain: { type: ['string', 'null'] },
                  website: { type: ['string', 'null'] },
                  industry: { type: ['string', 'null'] },
                  hq_location: { type: ['string', 'null'] },
                  notes: {
                    type: ['string', 'null'],
                    description:
                      'Concise company-level notes from your research. Prefer the same value as company_notes unless the draft needs extra company context.'
                  }
                },
                required: ['name', 'domain', 'website', 'industry', 'hq_location', 'notes']
              },
              { type: 'null' }
            ],
            description: 'New company to create. Required if company_id is null. Provide website if at all possible.'
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
          'company_notes',
          'icp_keywords',
          'source_url',
          'company_id',
          'company_draft'
        ]
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'give_up',
      description:
        "Call this if, after using the tools, you cannot find a credible net-new person that matches the ICP within budget. Provide a brief reason.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { reason: { type: 'string' } },
        required: ['reason']
      }
    }
  }
]

function buildSystemPrompt(input: AgentInput): string {
  return [
    `You are research agent ${input.slotIndex + 1} of ${input.totalSlots} working on campaign "${input.campaignName}".`,
    '',
    'Your single goal: add exactly ONE net-new real person who matches the ICP to the database, via the `record_person` tool.',
    '',
    'ICP description (verbatim from the user):',
    '"""',
    input.icpDocument,
    '"""',
    '',
    'Hard rules:',
    '- Only propose REAL, specifically-named people you can point to in a source. Never invent.',
    '- Do not invent emails, phones, or LinkedIn URLs. Leave them null if unverified.',
    '- A person is "net-new" if they are not already in the campaign (use `search_existing_people` with `campaign_only=true`) and not already in the global DB.',
    '- Before calling `record_person`, search the company DB with `search_existing_companies` to find an existing company to link to. Only create a new company (company_draft) if no plausible match exists. Prefer matching by domain or normalized name.',
    '- Fill `company_notes` with source-backed company context from your crawl. Keep it about the company, not the person: business model, ICP fit, notable growth/hiring/news signals, or why this account matters.',
    '- Many other agents are working in parallel on this same campaign. Diversify your angle (different sub-industry, geography, role) to reduce overlap.',
    '',
    'Workflow guidance:',
    '1. Briefly look at what is already in the campaign (`search_existing_people` with `campaign_only=true`). Note their companies/roles so you can avoid them.',
    '2. Run 1-3 targeted `web_search` queries grounded in the ICP. Make queries specific (named operators, executive titles, industry niches).',
    '3. If a result looks promising, optionally `fetch_url` to confirm the person\'s name + role.',
    '4. Use `search_existing_companies` to find/match their company.',
    '5. Call `record_person` once, with company_id OR company_draft.',
    '',
    `Budgets: max ${MAX_STEPS} tool calls total, ${MAX_WEB_SEARCHES} web_search calls, ${MAX_FETCH_URLS} fetch_url calls. Be efficient.`,
    '',
    'When done, call `record_person` (success) or `give_up` (no credible candidate). Do not produce a final text answer; you communicate only through tool calls.'
  ].join('\n')
}

type ToolDispatchContext = {
  organizationId: string
  campaignId: string
  campaignRunId: string
  used: {
    webSearches: number
    fetchUrls: number
  }
  lastWebSearchQuery: string | null
  lastSourceUrlHinted: string | null
}

type ToolDispatchResult =
  | { kind: 'continue'; content: string }
  | { kind: 'terminate_success'; personId: string; content: string }
  | { kind: 'terminate_duplicate'; personId: string; content: string; reason: string }
  | { kind: 'terminate_give_up'; reason: string }
  | { kind: 'terminate_invalid'; content: string }

async function dispatchTool(
  ctx: ToolDispatchContext,
  call: ToolCall
): Promise<ToolDispatchResult> {
  const name = call.function.name
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
  } catch (err) {
    return {
      kind: 'continue',
      content: JSON.stringify({
        error: `invalid_json_arguments`,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  try {
    switch (name) {
      case 'search_existing_people': {
        const { rows, total } = await searchPeople({
          organizationId: ctx.organizationId,
          query: typeof args.query === 'string' ? args.query : null,
          companyName: typeof args.company_name === 'string' ? args.company_name : null,
          campaignOnly: Boolean(args.campaign_only),
          campaignId: ctx.campaignId,
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
        if (!id) {
          return { kind: 'continue', content: JSON.stringify({ error: 'id required' }) }
        }
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
            linkedin_url: person.linkedinUrl,
            notes: person.notes,
            context: person.context,
            icp_keywords: person.icpKeywords,
            company: person.company
              ? {
                  id: person.company.id,
                  name: person.company.name,
                  domain: person.company.domain,
                  website: person.company.website,
                  industry: person.company.industry
                }
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
              industry: r.industry,
              notes: r.notes
            }))
          })
        }
      }
      case 'get_company': {
        const id = typeof args.id === 'string' ? args.id : null
        if (!id) {
          return { kind: 'continue', content: JSON.stringify({ error: 'id required' }) }
        }
        const company = await getCompany(id, ctx.organizationId)
        if (!company) return { kind: 'continue', content: JSON.stringify({ error: 'not_found' }) }
        return {
          kind: 'continue',
          content: JSON.stringify({
            id: company.id,
            name: company.name,
            domain: company.domain,
            website: company.website,
            industry: company.industry,
            hq_location: company.hqLocation,
            employee_range: company.employeeRange,
            notes: company.notes
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
        const numResults = Math.min(10, Math.max(1, Number(args.num_results) || 5))
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
      case 'record_person': {
        const fullName = typeof args.full_name === 'string' ? args.full_name : ''
        const context = typeof args.context === 'string' ? args.context : ''
        if (!fullName.trim() || !context.trim()) {
          return {
            kind: 'continue',
            content: JSON.stringify({ error: 'full_name and context are required' })
          }
        }

        let companyId = typeof args.company_id === 'string' ? args.company_id : null
        const companyDraftRaw = (args.company_draft as Record<string, unknown> | null) ?? null
        if (!companyId) {
          if (!companyDraftRaw || typeof companyDraftRaw.name !== 'string') {
            return {
              kind: 'continue',
              content: JSON.stringify({
                error: 'either company_id or company_draft.name must be provided'
              })
            }
          }
          companyId = await upsertCompany(
            {
              name: companyDraftRaw.name as string,
              domain: (companyDraftRaw.domain as string | null | undefined) ?? null,
              website: (companyDraftRaw.website as string | null | undefined) ?? null,
              industry: (companyDraftRaw.industry as string | null | undefined) ?? null,
              hqLocation: (companyDraftRaw.hq_location as string | null | undefined) ?? null,
              notes:
                (companyDraftRaw.notes as string | null | undefined) ??
                (args.company_notes as string | null | undefined) ??
                null
            },
            ctx.organizationId
          )
          if (!companyId) {
            return {
              kind: 'continue',
              content: JSON.stringify({
                error:
                  'could_not_create_company: provide at least name + (website or domain) in company_draft, or pick a company_id from search_existing_companies'
              })
            }
          }
        } else {
          const existing = await getCompany(companyId, ctx.organizationId)
          if (!existing) {
            return {
              kind: 'continue',
              content: JSON.stringify({ error: 'company_id not found; try search_existing_companies' })
            }
          }
          await appendCompanyNotes(
            companyId,
            ctx.organizationId,
            args.company_notes as string | null | undefined
          )
        }

        const keywords = Array.isArray(args.icp_keywords)
          ? (args.icp_keywords as unknown[]).filter((s): s is string => typeof s === 'string')
          : []

        const result = await upsertPerson(
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
            icpKeywords: keywords
          },
          ctx.organizationId,
          ctx.campaignId,
          companyId
        )

        if (!result.ok) {
          if (result.reason === 'duplicate') {
            // Attribute the slot's usage to the matched person so we can see
            // how much we spent re-discovering somebody we already had.
            const dupCompanyId = await getPersonCompanyId(result.personId, ctx.organizationId)
            await attributeUsageToPerson(result.personId, dupCompanyId)
            return {
              kind: 'terminate_duplicate',
              personId: result.personId,
              reason: 'matched existing person on email/linkedin/name+company',
              content: JSON.stringify({
                error: 'duplicate_person',
                person_id: result.personId,
                hint: 'This person is already in the DB. Pick a different person.'
              })
            }
          }
          return {
            kind: 'continue',
            content: JSON.stringify({ error: result.reason, message: result.message })
          }
        }

        await attributeUsageToPerson(result.personId, companyId)

        const sourceUrl =
          (typeof args.source_url === 'string' ? args.source_url : null) ?? ctx.lastSourceUrlHinted

        await recordDiscoveryEvent({
          organizationId: ctx.organizationId,
          campaignId: ctx.campaignId,
          campaignRunId: ctx.campaignRunId,
          personId: result.personId,
          sourceQuery: ctx.lastWebSearchQuery ?? 'agent',
          sourceUrl,
          metadata: { agent: true }
        })

        return {
          kind: 'terminate_success',
          personId: result.personId,
          content: JSON.stringify({ ok: true, person_id: result.personId })
        }
      }
      case 'give_up': {
        const reason = typeof args.reason === 'string' ? args.reason : 'no reason provided'
        return { kind: 'terminate_give_up', reason }
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
  const model = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requiredEnv('OPENROUTER_API_KEY')}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://api.flash.orinlabs.ai',
      'X-Title': 'Flash Agent'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: openRouterReasoningConfig(),
      // Ask OpenRouter to include real cost in the response. We still fall
      // back to a per-token estimate if the field is missing.
      usage: { include: true }
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

  const usage = payload.usage
  if (usage) {
    const promptTokens = usage.prompt_tokens ?? 0
    const completionTokens = usage.completion_tokens ?? 0
    const reportedCost = typeof usage.cost === 'number' ? usage.cost : null
    const costUsd =
      reportedCost ?? estimateChatCostUsd(model, promptTokens, completionTokens)
    await recordUsageEvent({
      provider: 'openrouter',
      operation: 'chat_completion',
      model,
      promptTokens,
      completionTokens,
      totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
      costUsd,
      estimated: reportedCost == null,
      metadata: { finishReason: choice?.finish_reason ?? null }
    })
  }

  return {
    toolCalls: message?.tool_calls ?? [],
    text: message?.content ?? null,
    finishReason: choice?.finish_reason ?? null
  }
}

export async function findPersonAgent(input: AgentInput): Promise<FindPersonAgentResult> {
  // Seed: list already-discovered for this campaign so the model can plan around it.
  const alreadyIds = await getCampaignDiscoveredPersonIds(input.campaignId, input.organizationId)
  const preview = await searchPeople({
    organizationId: input.organizationId,
    campaignOnly: true,
    campaignId: input.campaignId,
    limit: 20,
    offset: 0
  })
  const seedUser = [
    `Campaign currently has ${alreadyIds.length} discovered person(s).`,
    preview.rows.length === 0
      ? 'No people yet — you are likely the first agent to land.'
      : 'A sample of already-discovered people (avoid these):\n' +
        preview.rows
          .map(
            (r, i) =>
              `${i + 1}. ${r.fullName ?? 'Unknown'} — ${r.title ?? 'no title'} @ ${
                r.companyName ?? 'no company'
              }`
          )
          .join('\n'),
    '',
    'Begin researching now using the tools.'
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(input) },
    { role: 'user', content: seedUser }
  ]

  const ctx: ToolDispatchContext = {
    organizationId: input.organizationId,
    campaignId: input.campaignId,
    campaignRunId: input.campaignRunId,
    used: { webSearches: 0, fetchUrls: 0 },
    lastWebSearchQuery: null,
    lastSourceUrlHinted: null
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
        steps
      }
    }

    const { toolCalls, text, finishReason } = llmResult

    if (toolCalls.length === 0) {
      // Model produced text without a tool call. Nudge once, otherwise terminate.
      if (finishReason === 'stop') {
        return {
          status: 'no_candidate',
          reason: `model ended without tool call: ${text?.slice(0, 200) ?? '(no text)'}`,
          steps
        }
      }
      messages.push({ role: 'assistant', content: text })
      messages.push({
        role: 'user',
        content:
          'You must respond only via tool calls (record_person or give_up to terminate). Continue.'
      })
      continue
    }

    messages.push({ role: 'assistant', content: text, tool_calls: toolCalls })

    let terminated:
      | { kind: 'success'; personId: string }
      | { kind: 'duplicate'; personId: string; reason: string }
      | { kind: 'give_up'; reason: string }
      | null = null

    for (const call of toolCalls) {
      const out = await dispatchTool(ctx, call)
      switch (out.kind) {
        case 'continue':
          messages.push({ role: 'tool', tool_call_id: call.id, content: out.content })
          break
        case 'terminate_success':
          messages.push({ role: 'tool', tool_call_id: call.id, content: out.content })
          terminated = { kind: 'success', personId: out.personId }
          break
        case 'terminate_duplicate':
          messages.push({ role: 'tool', tool_call_id: call.id, content: out.content })
          // Allow the model to try again with a different person if budget remains.
          terminated = { kind: 'duplicate', personId: out.personId, reason: out.reason }
          break
        case 'terminate_give_up':
          terminated = { kind: 'give_up', reason: out.reason }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ ok: true, gave_up: true })
          })
          break
        case 'terminate_invalid':
          messages.push({ role: 'tool', tool_call_id: call.id, content: out.content })
          break
      }
      if (terminated?.kind === 'success' || terminated?.kind === 'give_up') break
    }

    if (terminated?.kind === 'success') {
      return { status: 'found', personId: terminated.personId, steps }
    }
    if (terminated?.kind === 'give_up') {
      return { status: 'no_candidate', reason: terminated.reason, steps }
    }
    // Duplicate: stash but loop so model can try a different person.
    if (terminated?.kind === 'duplicate' && steps >= MAX_STEPS - 1) {
      return {
        status: 'duplicate',
        personId: terminated.personId,
        reason: terminated.reason,
        steps
      }
    }
  }

  return {
    status: 'no_candidate',
    reason: `step budget (${MAX_STEPS}) exhausted without a record_person call`,
    steps
  }
}
