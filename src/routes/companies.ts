import { desc, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { db } from '../db/client.js'
import { companies, mailboxes, people } from '../db/schema.js'
import { openRouterReasoningConfig } from '../lib/openrouter.js'
import { startSweepDueAccounts, startWorkAccount } from '../lib/workflowTrigger.js'
import {
  listRecentDrafts,
  listRecentOutreachEvents,
  markCompanyOutreachStatus,
  startWorkingCompanies
} from '../workflows/repoOutreach.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const AGENTIC_COMPANY_SEARCH_MODEL = 'openai/gpt-5-nano'
const AGENTIC_COMPANY_SEARCH_CONCURRENCY = 12

const createCompany = z.object({
  name: z.string().min(1),
  website: z.string().url(),
  domain: z.string().optional(),
  industry: z.string().optional(),
  employeeRange: z.string().optional(),
  hqLocation: z.string().optional(),
  notes: z.string().optional()
})

function deriveDomain(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase()
}

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0)
})

export const companiesRoutes = new Hono()

companiesRoutes.get('/', async (c) => {
  const parsed = querySchema.safeParse({
    limit: c.req.query('limit') ?? undefined,
    offset: c.req.query('offset') ?? undefined
  })
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { limit, offset } = parsed.data
  const rows = await db
    .select()
    .from(companies)
    .orderBy(desc(companies.createdAt))
    .limit(limit)
    .offset(offset)
  return c.json({ data: rows, limit, offset })
})

companiesRoutes.post('/', async (c) => {
  const parsed = createCompany.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const body = parsed.data
  const domain = body.domain?.trim() || deriveDomain(body.website)

  if (domain) {
    const [existing] = await db
      .select()
      .from(companies)
      .where(sql`lower(trim(${companies.domain})) = ${domain.toLowerCase()}`)
      .limit(1)
    if (existing) {
      return c.json(
        { error: 'company already exists', companyId: existing.id },
        409
      )
    }
  }

  const [row] = await db
    .insert(companies)
    .values({
      name: body.name,
      domain: domain ?? undefined,
      website: body.website,
      industry: body.industry,
      employeeRange: body.employeeRange,
      hqLocation: body.hqLocation,
      notes: body.notes
    })
    .returning()
  return c.json(row, 201)
})

const outreachStatusValues = ['dormant', 'working', 'paused', 'completed', 'dead'] as const

const patchOutreachSchema = z.object({
  outreachStatus: z.enum(outreachStatusValues).optional(),
  outreachMailboxId: z.string().uuid().nullable().optional(),
  outreachStrategy: z.string().max(40_000).nullable().optional(),
  outreachEmailInstructions: z.string().max(24_000).nullable().optional(),
  outreachNextWakeAt: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional()
})

const bulkStartSchema = z.object({
  companyIds: z.array(z.string().uuid()).min(1).max(200),
  mailboxId: z.string().uuid()
})

const agenticSearchSchema = z.object({
  criteria: z.string().trim().min(1).max(4000),
  companyIds: z.array(z.string().uuid()).min(1).max(200)
})

const agenticSearchDecisionSchema = z.object({
  fits: z.boolean(),
  confidence: z.number().min(0).max(1).optional().default(0),
  rationale: z.string().max(1000).optional().default('')
})

type AgenticCompanyDecision = z.infer<typeof agenticSearchDecisionSchema>

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
      refusal?: string
    }
  }>
  error?: { message?: string }
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('model did not return a JSON object')
  }
  return JSON.parse(text.slice(start, end + 1)) as unknown
}

function requiredOpenRouterApiKey(): string {
  const value = process.env.OPENROUTER_API_KEY
  if (!value) {
    throw new Error('OPENROUTER_API_KEY is required for agentic search')
  }
  return value
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

function companyClassifierPrompt(input: {
  criteria: string
  company: typeof companies.$inferSelect
  people: Array<typeof people.$inferSelect>
}): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You are a strict B2B account fit classifier.',
        'Decide whether the company fits the user criteria using only the provided company and people details.',
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
          company: input.company,
          people: input.people
        },
        null,
        2
      )
    }
  ]
}

async function classifyCompanyFit(input: {
  apiKey: string
  criteria: string
  company: typeof companies.$inferSelect
  people: Array<typeof people.$inferSelect>
}): Promise<AgenticCompanyDecision> {
  const model = process.env.OPENROUTER_AGENTIC_COMPANY_SEARCH_MODEL ?? AGENTIC_COMPANY_SEARCH_MODEL
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + input.apiKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://api.flash.orinlabs.ai',
      'X-Title': 'Flash Company Search'
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: companyClassifierPrompt(input),
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

companiesRoutes.post('/agentic-search', async (c) => {
  const parsed = agenticSearchSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const apiKey = requiredOpenRouterApiKey()
  const { criteria, companyIds } = parsed.data

  const companyRows = await db
    .select()
    .from(companies)
    .where(inArray(companies.id, companyIds))

  const companyById = new Map(companyRows.map((company) => [company.id, company]))
  const orderedCompanies = companyIds
    .map((id) => companyById.get(id))
    .filter((company): company is typeof companies.$inferSelect => Boolean(company))

  const peopleRows =
    orderedCompanies.length > 0
      ? await db
          .select()
          .from(people)
          .where(inArray(people.companyId, orderedCompanies.map((company) => company.id)))
      : []

  const peopleByCompany = new Map<string, Array<typeof people.$inferSelect>>()
  for (const person of peopleRows) {
    if (!person.companyId) continue
    const current = peopleByCompany.get(person.companyId) ?? []
    current.push(person)
    peopleByCompany.set(person.companyId, current)
  }

  const results = await mapWithConcurrency(
    orderedCompanies,
    AGENTIC_COMPANY_SEARCH_CONCURRENCY,
    async (company) => {
      try {
        const decision = await classifyCompanyFit({
          apiKey,
          criteria,
          company,
          people: peopleByCompany.get(company.id) ?? []
        })
        return {
          companyId: company.id,
          fits: decision.fits,
          confidence: decision.confidence,
          rationale: decision.rationale
        }
      } catch (err) {
        return {
          companyId: company.id,
          fits: false,
          confidence: 0,
          rationale: '',
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  return c.json({
    selectedCompanyIds: results.filter((result) => result.fits).map((result) => result.companyId),
    results,
    errors: results
      .filter((result) => result.error)
      .map((result) => ({ companyId: result.companyId, error: result.error }))
  })
})

companiesRoutes.patch('/:id/outreach', async (c) => {
  const id = c.req.param('id')
  const parsed = patchOutreachSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const patch = parsed.data
  const [existing] = await db.select().from(companies).where(eq(companies.id, id)).limit(1)
  if (!existing) return c.json({ error: 'not found' }, 404)

  if (patch.outreachMailboxId) {
    const [mbox] = await db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.id, patch.outreachMailboxId))
      .limit(1)
    if (!mbox) return c.json({ error: 'mailbox not found' }, 400)
    if (mbox.status !== 'active') {
      return c.json({ error: 'mailbox is not active' }, 400)
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.outreachStatus !== undefined) {
    updates.outreachStatus = patch.outreachStatus
    if (patch.outreachStatus === 'completed') updates.outreachCompletedAt = new Date()
    if (patch.outreachStatus === 'working' && !existing.outreachStartedAt) {
      updates.outreachStartedAt = new Date()
    }
    if (patch.outreachStatus !== 'working') {
      updates.outreachNextWakeAt = null
    }
  }
  if (patch.outreachMailboxId !== undefined) {
    updates.outreachMailboxId = patch.outreachMailboxId
  }
  if (patch.outreachStrategy !== undefined) {
    updates.outreachStrategy = patch.outreachStrategy
    // Editing the strategy nudges the agent to wake immediately on the next sweep.
    if (
      (patch.outreachStatus ?? existing.outreachStatus) === 'working' &&
      patch.outreachNextWakeAt === undefined
    ) {
      updates.outreachNextWakeAt = new Date()
    }
  }
  if (patch.outreachEmailInstructions !== undefined) {
    updates.outreachEmailInstructions = patch.outreachEmailInstructions
    if (
      (patch.outreachStatus ?? existing.outreachStatus) === 'working' &&
      patch.outreachNextWakeAt === undefined
    ) {
      updates.outreachNextWakeAt = new Date()
    }
  }
  if (patch.outreachNextWakeAt !== undefined) {
    updates.outreachNextWakeAt = patch.outreachNextWakeAt
      ? new Date(patch.outreachNextWakeAt)
      : null
  }

  const [updated] = await db
    .update(companies)
    .set(updates)
    .where(eq(companies.id, id))
    .returning()
  return c.json(updated)
})

companiesRoutes.post('/:id/outreach/run', async (c) => {
  const id = c.req.param('id')
  const [existing] = await db.select().from(companies).where(eq(companies.id, id)).limit(1)
  if (!existing) return c.json({ error: 'not found' }, 404)
  if (!existing.outreachMailboxId) {
    return c.json({ error: 'no mailbox assigned to this account' }, 400)
  }
  if (existing.outreachStatus !== 'working') {
    await db
      .update(companies)
      .set({
        outreachStatus: 'working',
        outreachStartedAt: existing.outreachStartedAt ?? new Date(),
        outreachNextWakeAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(companies.id, id))
  } else {
    await db
      .update(companies)
      .set({ outreachNextWakeAt: new Date(), updatedAt: new Date() })
      .where(eq(companies.id, id))
  }
  let workflowTriggered = false
  let workflowError: string | undefined
  try {
    workflowTriggered = await startWorkAccount(id)
  } catch (e) {
    workflowError = e instanceof Error ? e.message : String(e)
  }
  return c.json({
    workflowTriggered,
    error: workflowError,
    hint: workflowTriggered
      ? undefined
      : 'Set RENDER_API_KEY and RENDER_WORKFLOW_SLUG to dispatch tasks. The sweep cron will pick this up on its next run.'
  })
})

companiesRoutes.post('/outreach/start', async (c) => {
  const parsed = bulkStartSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const { companyIds, mailboxId } = parsed.data
  const [mbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1)
  if (!mbox) return c.json({ error: 'mailbox not found' }, 400)
  if (mbox.status !== 'active') return c.json({ error: 'mailbox is not active' }, 400)

  const updated = await startWorkingCompanies(companyIds, mailboxId)

  let dispatched = 0
  const dispatchErrors: Array<{ companyId: string; error: string }> = []
  for (const id of companyIds) {
    try {
      const ok = await startWorkAccount(id)
      if (ok) dispatched += 1
    } catch (e) {
      dispatchErrors.push({ companyId: id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  // Also kick the sweeper as a fallback so anything we couldn't dispatch
  // (e.g. RENDER_API_KEY missing locally) still gets picked up cleanly.
  try {
    await startSweepDueAccounts()
  } catch {
    /* ignore */
  }

  return c.json({
    updated,
    dispatched,
    dispatchErrors,
    hint:
      dispatched === 0
        ? 'No Render workflow was triggered. The sweep cron (or manual Run now) will pick these up.'
        : undefined
  })
})

companiesRoutes.patch('/:id/outreach/status', async (c) => {
  const id = c.req.param('id')
  const parsed = z
    .object({ status: z.enum(outreachStatusValues) })
    .safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  await markCompanyOutreachStatus(id, parsed.data.status, {
    clearWake: parsed.data.status !== 'working'
  })
  const [row] = await db.select().from(companies).where(eq(companies.id, id)).limit(1)
  return c.json(row ?? { error: 'not found' }, row ? 200 : 404)
})

companiesRoutes.get('/:id/outreach/events', async (c) => {
  const id = c.req.param('id')
  const limit = Number(c.req.query('limit') ?? '50')
  const events = await listRecentOutreachEvents(id, Number.isFinite(limit) ? limit : 50)
  return c.json({ data: events })
})

companiesRoutes.get('/:id/outreach/drafts', async (c) => {
  const id = c.req.param('id')
  const limit = Number(c.req.query('limit') ?? '50')
  const drafts = await listRecentDrafts(id, Number.isFinite(limit) ? limit : 50)
  return c.json({ data: drafts })
})

companiesRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(companies).where(eq(companies.id, id))
  if (!row) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json(row)
})
