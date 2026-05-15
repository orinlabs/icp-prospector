import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { db } from '../db/client.js'
import {
  companies,
  people,
  prospectListCompanies,
  prospectListPeople,
  prospectLists
} from '../db/schema.js'
import type { AppVariables } from '../lib/orgs.js'

const listTypeValues = ['people', 'companies'] as const

const createListSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(listTypeValues),
  personIds: z.array(z.string().uuid()).max(500).optional().default([]),
  companyIds: z.array(z.string().uuid()).max(500).optional().default([])
})

const addMembersSchema = z.object({
  personIds: z.array(z.string().uuid()).max(500).optional().default([]),
  companyIds: z.array(z.string().uuid()).max(500).optional().default([])
})

export const listsRoutes = new Hono<{ Variables: AppVariables }>()

type ProspectListRow = typeof prospectLists.$inferSelect

async function listSummary(list: ProspectListRow) {
  const [personMembers, companyMembers] = await Promise.all([
    db.select().from(prospectListPeople).where(eq(prospectListPeople.listId, list.id)),
    db.select().from(prospectListCompanies).where(eq(prospectListCompanies.listId, list.id))
  ])
  return {
    ...list,
    personCount: personMembers.length,
    companyCount: companyMembers.length
  }
}

async function listDetail(id: string, organizationId: string) {
  const [list] = await db
    .select()
    .from(prospectLists)
    .where(and(eq(prospectLists.id, id), eq(prospectLists.organizationId, organizationId)))
    .limit(1)
  if (!list) return null

  if (list.type === 'people') {
    const members = await db
      .select({ person: people })
      .from(prospectListPeople)
      .innerJoin(people, eq(people.id, prospectListPeople.personId))
      .where(and(eq(prospectListPeople.listId, id), eq(people.organizationId, organizationId)))
    return {
      ...(await listSummary(list)),
      people: members.map((row) => row.person),
      companies: []
    }
  }

  const members = await db
    .select({ company: companies })
    .from(prospectListCompanies)
    .innerJoin(companies, eq(companies.id, prospectListCompanies.companyId))
    .where(and(eq(prospectListCompanies.listId, id), eq(companies.organizationId, organizationId)))
  return {
    ...(await listSummary(list)),
    people: [],
    companies: members.map((row) => row.company)
  }
}

async function addMembers(input: {
  list: ProspectListRow
  personIds: string[]
  companyIds: string[]
  organizationId: string
}) {
  if (input.list.type === 'people' && input.personIds.length > 0) {
    const rows = await db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.organizationId, input.organizationId), inArray(people.id, input.personIds)))
    if (rows.length === 0) return
    await db
      .insert(prospectListPeople)
      .values(rows.map((row) => ({ listId: input.list.id, personId: row.id })))
      .onConflictDoNothing()
  }
  if (input.list.type === 'companies' && input.companyIds.length > 0) {
    const rows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(eq(companies.organizationId, input.organizationId), inArray(companies.id, input.companyIds))
      )
    if (rows.length === 0) return
    await db
      .insert(prospectListCompanies)
      .values(rows.map((row) => ({ listId: input.list.id, companyId: row.id })))
      .onConflictDoNothing()
  }
}

listsRoutes.get('/', async (c) => {
  const organizationId = c.get('organization').id
  const rows = await db
    .select()
    .from(prospectLists)
    .where(eq(prospectLists.organizationId, organizationId))
    .orderBy(desc(prospectLists.createdAt))
  return c.json({ data: await Promise.all(rows.map((row) => listSummary(row))) })
})

listsRoutes.post('/', async (c) => {
  const organizationId = c.get('organization').id
  const parsed = createListSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const body = parsed.data
  const [list] = await db
    .insert(prospectLists)
    .values({ organizationId, name: body.name, type: body.type })
    .returning()
  await addMembers({ list, personIds: body.personIds, companyIds: body.companyIds, organizationId })
  return c.json(await listDetail(list.id, organizationId), 201)
})

listsRoutes.post('/:id/members', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const parsed = addMembersSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const [list] = await db
    .select()
    .from(prospectLists)
    .where(and(eq(prospectLists.id, id), eq(prospectLists.organizationId, organizationId)))
    .limit(1)
  if (!list) return c.json({ error: 'not found' }, 404)

  await addMembers({
    list,
    personIds: parsed.data.personIds,
    companyIds: parsed.data.companyIds,
    organizationId
  })
  await db
    .update(prospectLists)
    .set({ updatedAt: new Date() })
    .where(and(eq(prospectLists.id, id), eq(prospectLists.organizationId, organizationId)))
  return c.json(await listDetail(id, organizationId))
})

listsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const detail = await listDetail(id, organizationId)
  if (!detail) return c.json({ error: 'not found' }, 404)
  return c.json(detail)
})
