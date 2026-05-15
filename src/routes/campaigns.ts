import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { db } from '../db/client.js'
import { campaignRuns, campaigns } from '../db/schema.js'
import type { AppVariables } from '../lib/orgs.js'
import { startProspectWorkflow } from '../lib/workflowTrigger.js'

const createCampaign = z.object({
  name: z.string().min(1),
  icpDocument: z.string().min(1),
  targetCount: z.number().int().positive()
})

export const campaignsRoutes = new Hono<{ Variables: AppVariables }>()

campaignsRoutes.get('/', async (c) => {
  const organizationId = c.get('organization').id
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.organizationId, organizationId))
    .orderBy(desc(campaigns.createdAt))
  return c.json(rows)
})

campaignsRoutes.post('/', async (c) => {
  const parsed = createCampaign.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const { name, icpDocument, targetCount } = parsed.data
  const organizationId = c.get('organization').id
  const [row] = await db
    .insert(campaigns)
    .values({ organizationId, name, icpDocument, targetCount, status: 'draft' })
    .returning()
  return c.json(row, 201)
})

campaignsRoutes.get('/:id/runs', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, organizationId)))
  if (!campaign) {
    return c.json({ error: 'not found' }, 404)
  }
  const runs = await db
    .select()
    .from(campaignRuns)
    .where(and(eq(campaignRuns.campaignId, id), eq(campaignRuns.organizationId, organizationId)))
    .orderBy(desc(campaignRuns.createdAt))
  return c.json(runs)
})

campaignsRoutes.post('/:id/runs', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, organizationId)))
  if (!campaign) {
    return c.json({ error: 'not found' }, 404)
  }

  const [run] = await db
    .insert(campaignRuns)
    .values({
      organizationId,
      campaignId: id,
      status: 'queued',
      qualifiedCount: 0,
      checkpoint: { step: 'queued' }
    })
    .returning()

  let workflowTriggered = false
  let workflowError: string | undefined

  try {
    workflowTriggered = await startProspectWorkflow(run.id)
  } catch (e) {
    workflowError = e instanceof Error ? e.message : String(e)
    await db
      .update(campaignRuns)
      .set({
        status: 'failed',
        lastError: workflowError,
        updatedAt: new Date()
      })
      .where(eq(campaignRuns.id, run.id))
    return c.json(
      {
        run: { ...run, status: 'failed' },
        workflowTriggered: false,
        error: workflowError
      },
      502
    )
  }

  if (workflowTriggered) {
    await db
      .update(campaigns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, organizationId)))
    await db
      .update(campaignRuns)
      .set({ status: 'running', checkpoint: { step: 'workflow_started' }, updatedAt: new Date() })
      .where(eq(campaignRuns.id, run.id))
  }

  return c.json({
    run: {
      ...run,
      status: workflowTriggered ? 'running' : 'queued'
    },
    workflowTriggered,
    hint: workflowTriggered
      ? undefined
      : 'Set RENDER_API_KEY and RENDER_WORKFLOW_SLUG (workflow service name from Render) to dispatch tasks. Run remains queued.'
  })
})

campaignsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const [row] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, organizationId)))
  if (!row) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json(row)
})
