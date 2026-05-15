import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { db } from '../db/client.js'
import {
  campaignRuns,
  campaigns,
  companies,
  people,
  usageEvents
} from '../db/schema.js'
import type { AppVariables } from '../lib/orgs.js'

export const usageRoutes = new Hono<{ Variables: AppVariables }>()

const totalsSelect = {
  events: sql<number>`count(*)::int`.as('events'),
  costUsd: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`.as('cost_usd'),
  promptTokens: sql<string>`coalesce(sum(${usageEvents.promptTokens}), 0)`.as(
    'prompt_tokens'
  ),
  completionTokens: sql<string>`coalesce(sum(${usageEvents.completionTokens}), 0)`.as(
    'completion_tokens'
  ),
  totalTokens: sql<string>`coalesce(sum(${usageEvents.totalTokens}), 0)`.as(
    'total_tokens'
  ),
  units: sql<string>`coalesce(sum(${usageEvents.units}), 0)`.as('units')
}

function parseDays(value: string | undefined): number | null {
  if (!value) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(365, Math.max(1, Math.floor(n)))
}

function buildSinceFilter(days: number | null): SQL | undefined {
  if (!days) return undefined
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return gte(usageEvents.createdAt, since)
}

usageRoutes.get('/summary', async (c) => {
  const organizationId = c.get('organization').id
  const days = parseDays(c.req.query('days') ?? undefined)
  const sinceFilter = buildSinceFilter(days)
  const orgFilter = eq(usageEvents.organizationId, organizationId)

  const [overall] = await db
    .select(totalsSelect)
    .from(usageEvents)
    .where(and(orgFilter, sinceFilter))

  const byProvider = await db
    .select({
      provider: usageEvents.provider,
      operation: usageEvents.operation,
      ...totalsSelect
    })
    .from(usageEvents)
    .where(and(orgFilter, sinceFilter))
    .groupBy(usageEvents.provider, usageEvents.operation)
    .orderBy(desc(sql`coalesce(sum(${usageEvents.costUsd}), 0)`))

  const byModel = await db
    .select({
      model: usageEvents.model,
      ...totalsSelect
    })
    .from(usageEvents)
    .where(and(orgFilter, sinceFilter, eq(usageEvents.provider, 'openrouter')))
    .groupBy(usageEvents.model)
    .orderBy(desc(sql`coalesce(sum(${usageEvents.costUsd}), 0)`))

  return c.json({
    days,
    overall,
    byProvider,
    byModel
  })
})

usageRoutes.get('/by-campaign', async (c) => {
  const organizationId = c.get('organization').id
  const days = parseDays(c.req.query('days') ?? undefined)
  const sinceFilter = buildSinceFilter(days)

  const rows = await db
    .select({
      campaignId: usageEvents.campaignId,
      campaignName: campaigns.name,
      campaignStatus: campaigns.status,
      ...totalsSelect
    })
    .from(usageEvents)
    .leftJoin(campaigns, eq(campaigns.id, usageEvents.campaignId))
    .where(and(eq(usageEvents.organizationId, organizationId), sinceFilter))
    .groupBy(usageEvents.campaignId, campaigns.name, campaigns.status)
    .orderBy(desc(sql`coalesce(sum(${usageEvents.costUsd}), 0)`))

  return c.json({ data: rows })
})

usageRoutes.get('/by-run', async (c) => {
  const organizationId = c.get('organization').id
  const days = parseDays(c.req.query('days') ?? undefined)
  const sinceFilter = buildSinceFilter(days)
  const campaignId = c.req.query('campaign_id')

  const filters: SQL[] = [eq(usageEvents.organizationId, organizationId)]
  if (sinceFilter) filters.push(sinceFilter)
  if (campaignId) filters.push(eq(usageEvents.campaignId, campaignId))
  const where = filters.length > 0 ? and(...filters) : undefined

  const rows = await db
    .select({
      campaignRunId: usageEvents.campaignRunId,
      campaignId: usageEvents.campaignId,
      campaignName: campaigns.name,
      runStatus: campaignRuns.status,
      runCreatedAt: campaignRuns.createdAt,
      qualifiedCount: campaignRuns.qualifiedCount,
      ...totalsSelect
    })
    .from(usageEvents)
    .leftJoin(campaignRuns, eq(campaignRuns.id, usageEvents.campaignRunId))
    .leftJoin(campaigns, eq(campaigns.id, usageEvents.campaignId))
    .where(where)
    .groupBy(
      usageEvents.campaignRunId,
      usageEvents.campaignId,
      campaigns.name,
      campaignRuns.status,
      campaignRuns.createdAt,
      campaignRuns.qualifiedCount
    )
    .orderBy(desc(campaignRuns.createdAt))

  return c.json({ data: rows })
})

usageRoutes.get('/by-company', async (c) => {
  const organizationId = c.get('organization').id
  const days = parseDays(c.req.query('days') ?? undefined)
  const sinceFilter = buildSinceFilter(days)

  const rows = await db
    .select({
      companyId: usageEvents.companyId,
      companyName: companies.name,
      companyDomain: companies.domain,
      ...totalsSelect
    })
    .from(usageEvents)
    .leftJoin(companies, eq(companies.id, usageEvents.companyId))
    .where(and(eq(usageEvents.organizationId, organizationId), sinceFilter))
    .groupBy(usageEvents.companyId, companies.name, companies.domain)
    .orderBy(desc(sql`coalesce(sum(${usageEvents.costUsd}), 0)`))

  return c.json({ data: rows })
})

usageRoutes.get('/by-person', async (c) => {
  const organizationId = c.get('organization').id
  const days = parseDays(c.req.query('days') ?? undefined)
  const sinceFilter = buildSinceFilter(days)

  const rows = await db
    .select({
      personId: usageEvents.personId,
      personName: people.fullName,
      personTitle: people.title,
      companyId: people.companyId,
      companyName: companies.name,
      ...totalsSelect
    })
    .from(usageEvents)
    .leftJoin(people, eq(people.id, usageEvents.personId))
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(and(eq(usageEvents.organizationId, organizationId), sinceFilter))
    .groupBy(
      usageEvents.personId,
      people.fullName,
      people.title,
      people.companyId,
      companies.name
    )
    .orderBy(desc(sql`coalesce(sum(${usageEvents.costUsd}), 0)`))

  return c.json({ data: rows })
})

const recentSchema = z.object({
  campaign_id: z.string().uuid().optional(),
  campaign_run_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  person_id: z.string().uuid().optional(),
  provider: z.string().optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100)
})

usageRoutes.get('/recent', async (c) => {
  const organizationId = c.get('organization').id
  const parsed = recentSchema.safeParse({
    campaign_id: c.req.query('campaign_id') ?? undefined,
    campaign_run_id: c.req.query('campaign_run_id') ?? undefined,
    company_id: c.req.query('company_id') ?? undefined,
    person_id: c.req.query('person_id') ?? undefined,
    provider: c.req.query('provider') ?? undefined,
    days: c.req.query('days') ?? undefined,
    limit: c.req.query('limit') ?? undefined
  })
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const { campaign_id, campaign_run_id, company_id, person_id, provider, days, limit } =
    parsed.data

  const filters: SQL[] = [eq(usageEvents.organizationId, organizationId)]
  const sinceFilter = buildSinceFilter(days ?? null)
  if (sinceFilter) filters.push(sinceFilter)
  if (campaign_id) filters.push(eq(usageEvents.campaignId, campaign_id))
  if (campaign_run_id) filters.push(eq(usageEvents.campaignRunId, campaign_run_id))
  if (company_id) filters.push(eq(usageEvents.companyId, company_id))
  if (person_id) filters.push(eq(usageEvents.personId, person_id))
  if (provider) filters.push(eq(usageEvents.provider, provider))
  const where = filters.length > 0 ? and(...filters) : undefined

  const rows = await db
    .select({
      id: usageEvents.id,
      provider: usageEvents.provider,
      operation: usageEvents.operation,
      model: usageEvents.model,
      promptTokens: usageEvents.promptTokens,
      completionTokens: usageEvents.completionTokens,
      totalTokens: usageEvents.totalTokens,
      units: usageEvents.units,
      costUsd: usageEvents.costUsd,
      estimated: usageEvents.estimated,
      campaignId: usageEvents.campaignId,
      campaignRunId: usageEvents.campaignRunId,
      companyId: usageEvents.companyId,
      personId: usageEvents.personId,
      slotIndex: usageEvents.slotIndex,
      metadata: usageEvents.metadata,
      createdAt: usageEvents.createdAt,
      campaignName: campaigns.name,
      personName: people.fullName,
      companyName: companies.name
    })
    .from(usageEvents)
    .leftJoin(campaigns, eq(campaigns.id, usageEvents.campaignId))
    .leftJoin(people, eq(people.id, usageEvents.personId))
    .leftJoin(companies, eq(companies.id, usageEvents.companyId))
    .where(where)
    .orderBy(desc(usageEvents.createdAt))
    .limit(limit)

  return c.json({ data: rows })
})
