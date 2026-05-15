import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  SQL
} from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { db } from '../db/client.js'
import { companies, discoveryEvents, people } from '../db/schema.js'
import { openRouterReasoningConfig } from '../lib/openrouter.js'
import { requiredEnv } from '../workflows/repo.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const AGENTIC_PEOPLE_SEARCH_MODEL = 'openai/gpt-5-nano'
const AGENTIC_PEOPLE_SEARCH_CONCURRENCY = 50

const discoveryCampaignIdsCol = sql<
  string[]
>`coalesce((select array_agg(distinct ${discoveryEvents.campaignId}) from ${discoveryEvents} where ${discoveryEvents.personId} = ${people.id}), '{}')`.as(
  'discovery_campaign_ids'
)

const peopleColumns = {
  ...getTableColumns(people),
  discoveryCampaignIds: discoveryCampaignIdsCol
}

const querySchema = z.object({
  has_email: z.enum(['true', 'false']).optional(),
  has_linkedin: z.enum(['true', 'false']).optional(),
  company_id: z.string().uuid().optional(),
  company_scope: z.enum(['assigned', 'unassigned']).optional(),
  lifecycle: z
    .string()
    .optional()
    .transform((s) => {
      const t = (s ?? '').trim()
      return t.length === 0 ? undefined : t.slice(0, 80)
    }),
  campaign_id: z.string().uuid().optional(),
  campaign_run_id: z.string().uuid().optional(),
  q: z
    .string()
    .optional()
    .transform((s) => {
      const t = (s ?? '').trim()
      return t.length === 0 ? undefined : t.slice(0, 200)
    }),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0)
})

const createPerson = z.object({
  companyId: z.string().uuid(),
  fullName: z.string().optional(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  twitterUrl: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  seniority: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  context: z.string().optional().nullable(),
  firstSeenCampaignId: z.string().uuid().optional().nullable(),
  lifecycleStatus: z.string().optional()
})

const agenticSearchSchema = z.object({
  criteria: z.string().trim().min(1).max(4000),
  personIds: z.array(z.string().uuid()).min(1).max(200)
})

const agenticSearchDecisionSchema = z.object({
  fits: z.boolean(),
  confidence: z.number().min(0).max(1).optional().default(0),
  rationale: z.string().max(1000).optional().default('')
})

type AgenticPersonDecision = z.infer<typeof agenticSearchDecisionSchema>

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
      refusal?: string
    }
  }>
  error?: { message?: string }
}

type AgenticPersonSearchResult = {
  personId: string
  fits: boolean
  confidence: number
  rationale: string
  error?: string
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('model did not return a JSON object')
  }
  return JSON.parse(text.slice(start, end + 1)) as unknown
}

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U>
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await fn(items[currentIndex])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }).map(() => worker())
  )
  return results
}

function personClassifierPrompt(input: {
  criteria: string
  person: typeof people.$inferSelect
  company: typeof companies.$inferSelect | null
}): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You are a strict B2B prospect fit classifier.',
        'Decide whether the person fits the user criteria using only the provided person and company details.',
        'Be conservative: select fits only when the details provide positive evidence.',
        'Return only a JSON object with this exact shape:',
        '{"fits": boolean, "confidence": number, "rationale": string}'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          criteria: input.criteria,
          person: input.person,
          company: input.company
        },
        null,
        2
      )
    }
  ]
}

async function classifyPersonFit(input: {
  apiKey: string
  criteria: string
  person: typeof people.$inferSelect
  company: typeof companies.$inferSelect | null
}): Promise<AgenticPersonDecision> {
  const model = process.env.OPENROUTER_AGENTIC_PEOPLE_SEARCH_MODEL ?? AGENTIC_PEOPLE_SEARCH_MODEL
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + input.apiKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://api.flash.orinlabs.ai',
      'X-Title': 'Flash People Search'
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: personClassifierPrompt(input),
      reasoning: openRouterReasoningConfig()
    })
  })

  if (!res.ok) {
    throw new Error('OpenRouter call failed (' + res.status + '): ' + (await res.text()))
  }

  const payload = (await res.json()) as OpenRouterResponse
  if (payload.error?.message) {
    throw new Error('OpenRouter error: ' + payload.error.message)
  }

  const message = payload.choices?.[0]?.message
  if (message?.refusal) {
    throw new Error('Model refused: ' + message.refusal)
  }

  const text = message?.content
  if (!text) {
    throw new Error('model returned no content')
  }

  return agenticSearchDecisionSchema.parse(extractJsonObject(text))
}

function agenticSearchError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function agenticPeopleSearchErrors(results: AgenticPersonSearchResult[]) {
  return results
    .filter((result) => result.error)
    .map((result) => ({ personId: result.personId, error: result.error }))
}

function agenticSearchStreamHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no'
  }
}

export const peopleRoutes = new Hono()

peopleRoutes.get('/', async (c) => {
  const parsed = querySchema.safeParse({
    has_email: c.req.query('has_email') ?? undefined,
    has_linkedin: c.req.query('has_linkedin') ?? undefined,
    company_id: c.req.query('company_id') ?? undefined,
    company_scope: c.req.query('company_scope') ?? undefined,
    lifecycle: c.req.query('lifecycle') ?? undefined,
    campaign_id: c.req.query('campaign_id') ?? undefined,
    campaign_run_id: c.req.query('campaign_run_id') ?? undefined,
    q: c.req.query('q') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    offset: c.req.query('offset') ?? undefined
  })
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const {
    has_email,
    has_linkedin,
    company_id,
    company_scope,
    lifecycle,
    campaign_id,
    campaign_run_id,
    q,
    limit,
    offset
  } = parsed.data

  const filters: SQL[] = []
  if (has_email === 'true') {
    filters.push(isNotNull(people.email))
  }
  if (has_email === 'false') {
    filters.push(isNull(people.email))
  }
  if (has_linkedin === 'true') {
    filters.push(isNotNull(people.linkedinUrl))
  }
  if (has_linkedin === 'false') {
    filters.push(isNull(people.linkedinUrl))
  }
  if (company_id) {
    filters.push(eq(people.companyId, company_id))
  } else if (company_scope === 'assigned') {
    filters.push(isNotNull(people.companyId))
  } else if (company_scope === 'unassigned') {
    filters.push(isNull(people.companyId))
  }
  if (lifecycle) {
    filters.push(eq(people.lifecycleStatus, lifecycle))
  }
  if (campaign_id) {
    filters.push(
      sql`exists (select 1 from ${discoveryEvents} where ${discoveryEvents.personId} = ${people.id} and ${discoveryEvents.campaignId} = ${campaign_id})`
    )
  }
  if (campaign_run_id) {
    filters.push(
      sql`exists (select 1 from ${discoveryEvents} where ${discoveryEvents.personId} = ${people.id} and ${discoveryEvents.metadata}->>'campaignRunId' = ${campaign_run_id})`
    )
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined

  const term = q?.toLowerCase()
  const searchClause = term
    ? or(
        sql`position(${term} in lower(coalesce(${people.fullName}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${people.email}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${people.phone}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${people.title}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${people.seniority}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${people.department}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${people.linkedinUrl}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${people.twitterUrl}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${people.notes}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${people.context}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${companies.name}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${companies.domain}, ''))) > 0`,
        sql`position(${term} in lower(coalesce(${companies.website}, ''))) > 0`
      )
    : undefined
  const combinedWhere =
    whereClause && searchClause
      ? and(whereClause, searchClause)
      : (whereClause ?? searchClause)

  const rows = searchClause
    ? await db
        .select(peopleColumns)
        .from(people)
        .leftJoin(companies, eq(people.companyId, companies.id))
        .where(combinedWhere)
        .orderBy(desc(people.createdAt))
        .limit(limit)
        .offset(offset)
    : await db
        .select(peopleColumns)
        .from(people)
        .where(whereClause)
        .orderBy(desc(people.createdAt))
        .limit(limit)
        .offset(offset)

  return c.json({ data: rows, limit, offset })
})

peopleRoutes.post('/', async (c) => {
  const parsed = createPerson.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const b = parsed.data

  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, b.companyId))
    .limit(1)
  if (!company) {
    return c.json({ error: 'company not found' }, 400)
  }

  const nameNorm =
    b.fullName?.trim().length ? b.fullName.trim().toLowerCase() : null
  const [row] = await db
    .insert(people)
    .values({
      companyId: b.companyId,
      fullName: b.fullName,
      nameNormalized: nameNorm ?? undefined,
      email: b.email ?? undefined,
      phone: b.phone ?? undefined,
      linkedinUrl: b.linkedinUrl ?? undefined,
      twitterUrl: b.twitterUrl ?? undefined,
      title: b.title ?? undefined,
      seniority: b.seniority ?? undefined,
      department: b.department ?? undefined,
      notes: b.notes ?? undefined,
      context: b.context ?? undefined,
      firstSeenCampaignId: b.firstSeenCampaignId ?? undefined,
      lifecycleStatus: b.lifecycleStatus ?? 'new',
      lastSeenAt: new Date()
    })
    .returning()
  return c.json(row, 201)
})

peopleRoutes.post('/agentic-search', async (c) => {
  const parsed = agenticSearchSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const apiKey = requiredEnv('OPENROUTER_API_KEY')
  const { criteria, personIds } = parsed.data

  const personRows = await db
    .select()
    .from(people)
    .where(inArray(people.id, personIds))

  const personById = new Map(personRows.map((person) => [person.id, person]))
  const orderedPeople = personIds
    .map((id) => personById.get(id))
    .filter((person): person is typeof people.$inferSelect => Boolean(person))

  const companyIds = orderedPeople
    .map((person) => person.companyId)
    .filter((id): id is string => Boolean(id))
  const companyRows =
    companyIds.length > 0
      ? await db.select().from(companies).where(inArray(companies.id, companyIds))
      : []
  const companyById = new Map(companyRows.map((company) => [company.id, company]))

  const results: AgenticPersonSearchResult[] = await mapWithConcurrency(
    orderedPeople,
    AGENTIC_PEOPLE_SEARCH_CONCURRENCY,
    async (person) => {
      try {
        const decision = await classifyPersonFit({
          apiKey,
          criteria,
          person,
          company: person.companyId ? (companyById.get(person.companyId) ?? null) : null
        })
        return {
          personId: person.id,
          fits: decision.fits,
          confidence: decision.confidence,
          rationale: decision.rationale
        }
      } catch (err) {
        return {
          personId: person.id,
          fits: false,
          confidence: 0,
          rationale: '',
          error: agenticSearchError(err)
        }
      }
    }
  )

  return c.json({
    selectedPersonIds: results.filter((result) => result.fits).map((result) => result.personId),
    results,
    errors: agenticPeopleSearchErrors(results)
  })
})

peopleRoutes.post('/agentic-search/stream', async (c) => {
  const parsed = agenticSearchSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const apiKey = requiredEnv('OPENROUTER_API_KEY')
  const { criteria, personIds } = parsed.data

  const personRows = await db
    .select()
    .from(people)
    .where(inArray(people.id, personIds))

  const personById = new Map(personRows.map((person) => [person.id, person]))
  const orderedPeople = personIds
    .map((id) => personById.get(id))
    .filter((person): person is typeof people.$inferSelect => Boolean(person))

  const companyIds = orderedPeople
    .map((person) => person.companyId)
    .filter((id): id is string => Boolean(id))
  const companyRows =
    companyIds.length > 0
      ? await db.select().from(companies).where(inArray(companies.id, companyIds))
      : []
  const companyById = new Map(companyRows.map((company) => [company.id, company]))

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const write = (event: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
      }

      write({ type: 'start', total: orderedPeople.length })
      const results: AgenticPersonSearchResult[] = await mapWithConcurrency(
        orderedPeople,
        AGENTIC_PEOPLE_SEARCH_CONCURRENCY,
        async (person) => {
          let result: AgenticPersonSearchResult
          try {
            const decision = await classifyPersonFit({
              apiKey,
              criteria,
              person,
              company: person.companyId ? (companyById.get(person.companyId) ?? null) : null
            })
            result = {
              personId: person.id,
              fits: decision.fits,
              confidence: decision.confidence,
              rationale: decision.rationale
            }
          } catch (err) {
            result = {
              personId: person.id,
              fits: false,
              confidence: 0,
              rationale: '',
              error: agenticSearchError(err)
            }
          }
          write({ type: 'result', result })
          return result
        }
      )
      write({
        type: 'done',
        selectedPersonIds: results.filter((result) => result.fits).map((result) => result.personId),
        results,
        errors: agenticPeopleSearchErrors(results)
      })
      controller.close()
    }
  })

  return new Response(stream, { headers: agenticSearchStreamHeaders() })
})

peopleRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = await db
    .select(peopleColumns)
    .from(people)
    .where(eq(people.id, id))
  if (!row) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json(row)
})
