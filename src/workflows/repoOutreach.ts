import { and, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm'

import { db } from '../db/client.js'
import {
  companies,
  mailboxes,
  outreachDrafts,
  outreachEvents,
  people,
  type Company,
  type Mailbox,
  type OutreachDraft,
  type OutreachEvent
} from '../db/schema.js'
import {
  cleanNullable,
  getPerson,
  normalizeDomain,
  normalizeEmail,
  normalizeName,
  normalizeProfileUrl,
  normalizeUrl,
  upsertPerson,
  type PersonDraft
} from './repo.js'

export type CompanyWithMailbox = Company & {
  mailbox: Mailbox | null
}

export async function getCompanyForOutreach(
  companyId: string,
  organizationId?: string
): Promise<CompanyWithMailbox | null> {
  const [row] = await db
    .select({ company: companies, mailbox: mailboxes })
    .from(companies)
    .leftJoin(mailboxes, eq(mailboxes.id, companies.outreachMailboxId))
    .where(
      organizationId
        ? and(eq(companies.id, companyId), eq(companies.organizationId, organizationId))
        : eq(companies.id, companyId)
    )
    .limit(1)
  if (!row) return null
  return { ...row.company, mailbox: row.mailbox ?? null }
}

export async function listDueCompanyIds(organizationId: string | null = null, limit = 50): Promise<string[]> {
  const filters = [
    eq(companies.outreachStatus, 'working'),
    isNotNull(companies.outreachMailboxId),
    isNotNull(companies.outreachNextWakeAt),
    lte(companies.outreachNextWakeAt, new Date())
  ]
  if (organizationId) filters.unshift(eq(companies.organizationId, organizationId))
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(...filters)
    )
    .orderBy(companies.outreachNextWakeAt)
    .limit(limit)
  return rows.map((r) => r.id)
}

export type AppendEventInput = {
  organizationId: string
  companyId: string
  kind: string
  summary: string
  details?: Record<string, unknown> | null
  sourceUrl?: string | null
}

export async function appendOutreachEvent(input: AppendEventInput): Promise<OutreachEvent> {
  const [row] = await db
    .insert(outreachEvents)
    .values({
      companyId: input.companyId,
      organizationId: input.organizationId,
      kind: input.kind,
      summary: input.summary,
      details: input.details ?? undefined,
      sourceUrl: input.sourceUrl ?? undefined
    })
    .returning()
  return row
}

export async function listRecentOutreachEvents(
  companyId: string,
  organizationId: string,
  limit = 20
): Promise<OutreachEvent[]> {
  return db
    .select()
    .from(outreachEvents)
    .where(and(eq(outreachEvents.companyId, companyId), eq(outreachEvents.organizationId, organizationId)))
    .orderBy(desc(outreachEvents.createdAt))
    .limit(limit)
}

export async function writeStrategy(
  companyId: string,
  organizationId: string,
  text: string,
  reason: string | null
): Promise<void> {
  await db
    .update(companies)
    .set({
      outreachStrategy: text,
      updatedAt: new Date()
    })
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)))
  await appendOutreachEvent({
    organizationId,
    companyId,
    kind: 'strategy_revision',
    summary: reason?.trim() || 'Agent revised the outreach strategy.',
    details: { length: text.length }
  })
}

export type InsertDraftInput = {
  organizationId: string
  companyId: string
  mailboxId: string
  personId?: string | null
  toEmail: string
  subject: string
  body: string
  bodyHtml?: string | null
  agentRationale?: string | null
}

export async function findPendingDraftForEmail(
  companyId: string,
  organizationId: string,
  toEmail: string
): Promise<OutreachDraft | null> {
  const normalized = normalizeEmail(toEmail)
  if (!normalized) return null
  const [row] = await db
    .select()
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.companyId, companyId),
        eq(outreachDrafts.organizationId, organizationId),
        eq(outreachDrafts.status, 'pending_review'),
        sql`lower(${outreachDrafts.toEmail}) = ${normalized}`
      )
    )
    .orderBy(desc(outreachDrafts.createdAt))
    .limit(1)
  return row ?? null
}

export async function insertDraft(
  input: InsertDraftInput
): Promise<
  | { ok: true; draft: OutreachDraft }
  | { ok: false; error: string; existingDraftId: string; existingSubject: string }
> {
  const toEmail = normalizeEmail(input.toEmail) ?? input.toEmail.trim().toLowerCase()
  const existing = await findPendingDraftForEmail(input.companyId, input.organizationId, toEmail)
  if (existing) {
    return {
      ok: false,
      error:
        'A pending-review draft already exists for this recipient. Call delete_draft on the existing draft, then draft_email again with your revised copy.',
      existingDraftId: existing.id,
      existingSubject: existing.subject
    }
  }
  const [row] = await db
    .insert(outreachDrafts)
    .values({
      companyId: input.companyId,
      organizationId: input.organizationId,
      mailboxId: input.mailboxId,
      personId: input.personId ?? null,
      toEmail,
      subject: input.subject,
      body: input.body,
      bodyHtml: input.bodyHtml ?? null,
      agentRationale: input.agentRationale ?? null,
      status: 'pending_review'
    })
    .returning()
  return { ok: true, draft: row }
}

export async function listRecentDrafts(
  companyId: string,
  organizationId: string,
  limit = 10
): Promise<OutreachDraft[]> {
  return db
    .select()
    .from(outreachDrafts)
    .where(and(eq(outreachDrafts.companyId, companyId), eq(outreachDrafts.organizationId, organizationId)))
    .orderBy(desc(outreachDrafts.createdAt))
    .limit(limit)
}

export async function listPeopleAtCompany(companyId: string, organizationId: string, limit = 25) {
  return db
    .select({
      id: people.id,
      fullName: people.fullName,
      title: people.title,
      seniority: people.seniority,
      department: people.department,
      email: people.email,
      phone: people.phone,
      linkedinUrl: people.linkedinUrl,
      twitterUrl: people.twitterUrl,
      notes: people.notes,
      context: people.context,
      lifecycleStatus: people.lifecycleStatus
    })
    .from(people)
    .where(and(eq(people.companyId, companyId), eq(people.organizationId, organizationId)))
    .orderBy(desc(people.lastSeenAt))
    .limit(limit)
}

type CompanyDetailsPatch = {
  name?: string | null
  domain?: string | null
  website?: string | null
  industry?: string | null
  employeeRange?: string | null
  hqLocation?: string | null
  notes?: string | null
  outreachEmailInstructions?: string | null
}

type PersonAtCompanyPatch = {
  fullName?: string | null
  title?: string | null
  seniority?: string | null
  department?: string | null
  email?: string | null
  phone?: string | null
  linkedinUrl?: string | null
  twitterUrl?: string | null
  notes?: string | null
  context?: string | null
  lifecycleStatus?: string | null
}

type UpsertPersonAtCompanyDraft = PersonDraft & {
  lifecycleStatus?: string | null
}

function hasKey<T extends object>(obj: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function fieldNames(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => key !== 'updatedAt')
}

export async function updateCompanyDetails(
  companyId: string,
  organizationId: string,
  patch: CompanyDetailsPatch,
  reason: string | null
): Promise<{ ok: true; changedFields: string[] } | { ok: false; error: string }> {
  const updates: Record<string, unknown> = { updatedAt: new Date() }

  if (hasKey(patch, 'name')) {
    const name = cleanNullable(patch.name)
    if (!name) return { ok: false, error: 'name cannot be empty' }
    updates.name = name
  }
  if (hasKey(patch, 'domain')) updates.domain = normalizeDomain(patch.domain)
  if (hasKey(patch, 'website')) updates.website = normalizeUrl(patch.website)
  if (hasKey(patch, 'industry')) updates.industry = cleanNullable(patch.industry)
  if (hasKey(patch, 'employeeRange')) updates.employeeRange = cleanNullable(patch.employeeRange)
  if (hasKey(patch, 'hqLocation')) updates.hqLocation = cleanNullable(patch.hqLocation)
  if (hasKey(patch, 'notes')) updates.notes = cleanNullable(patch.notes)
  if (hasKey(patch, 'outreachEmailInstructions')) {
    const value = cleanNullable(patch.outreachEmailInstructions)
    updates.outreachEmailInstructions = value ? value.slice(0, MAX_OUTREACH_EMAIL_INSTRUCTIONS) : null
  }

  const changedFields = fieldNames(updates)
  if (changedFields.length === 0) return { ok: false, error: 'no company fields supplied' }

  const [updated] = await db
    .update(companies)
    .set(updates)
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)))
    .returning({ id: companies.id })
  if (!updated) return { ok: false, error: 'company not found' }

  await appendOutreachEvent({
    organizationId,
    companyId,
    kind: 'record_update',
    summary: reason?.trim() || `Agent updated company fields: ${changedFields.join(', ')}`,
    details: { entity: 'company', changedFields }
  })
  return { ok: true, changedFields }
}

export async function updatePersonAtCompany(
  companyId: string,
  organizationId: string,
  personId: string,
  patch: PersonAtCompanyPatch,
  reason: string | null
): Promise<{ ok: true; changedFields: string[] } | { ok: false; error: string }> {
  const updates: Record<string, unknown> = { updatedAt: new Date(), lastSeenAt: new Date() }

  if (hasKey(patch, 'fullName')) {
    const fullName = cleanNullable(patch.fullName)
    updates.fullName = fullName
    updates.nameNormalized = normalizeName(fullName)
  }
  if (hasKey(patch, 'title')) updates.title = cleanNullable(patch.title)
  if (hasKey(patch, 'seniority')) updates.seniority = cleanNullable(patch.seniority)
  if (hasKey(patch, 'department')) updates.department = cleanNullable(patch.department)
  if (hasKey(patch, 'email')) updates.email = normalizeEmail(patch.email)
  if (hasKey(patch, 'phone')) updates.phone = cleanNullable(patch.phone)
  if (hasKey(patch, 'linkedinUrl')) {
    updates.linkedinUrl = normalizeProfileUrl(patch.linkedinUrl, 'linkedin.com')
  }
  if (hasKey(patch, 'twitterUrl')) {
    updates.twitterUrl =
      normalizeProfileUrl(patch.twitterUrl, 'twitter.com') ??
      normalizeProfileUrl(patch.twitterUrl, 'x.com')
  }
  if (hasKey(patch, 'notes')) updates.notes = cleanNullable(patch.notes)
  if (hasKey(patch, 'context')) updates.context = cleanNullable(patch.context)
  if (hasKey(patch, 'lifecycleStatus')) updates.lifecycleStatus = cleanNullable(patch.lifecycleStatus) ?? 'new'

  const changedFields = fieldNames(updates).filter((key) => key !== 'lastSeenAt')
  if (changedFields.length === 0) return { ok: false, error: 'no person fields supplied' }

  const [updated] = await db
    .update(people)
    .set(updates)
    .where(
      and(
        eq(people.id, personId),
        eq(people.companyId, companyId),
        eq(people.organizationId, organizationId)
      )
    )
    .returning({ id: people.id })
  if (!updated) return { ok: false, error: 'person not found at this company' }

  await appendOutreachEvent({
    organizationId,
    companyId,
    kind: 'record_update',
    summary: reason?.trim() || `Agent updated person fields: ${changedFields.join(', ')}`,
    details: { entity: 'person', personId, changedFields }
  })
  return { ok: true, changedFields }
}

export async function upsertPersonAtCompany(
  companyId: string,
  organizationId: string,
  draft: UpsertPersonAtCompanyDraft,
  reason: string | null
): Promise<
  | { ok: true; personId: string; created: boolean; merged: boolean; changedFields: string[] }
  | { ok: false; error: string; personId?: string }
> {
  const result = await upsertPerson(draft, organizationId, companyId, companyId)
  if (result.ok) {
    const changedFields: string[] = []
    const lifecycleStatus = cleanNullable(draft.lifecycleStatus)
    if (lifecycleStatus) {
      await db
        .update(people)
        .set({ lifecycleStatus, updatedAt: new Date(), lastSeenAt: new Date() })
        .where(
          and(
            eq(people.id, result.personId),
            eq(people.companyId, companyId),
            eq(people.organizationId, organizationId)
          )
        )
      changedFields.push('lifecycleStatus')
    }
    await appendOutreachEvent({
      organizationId,
      companyId,
      kind: 'record_update',
      summary: reason?.trim() || `Agent added person: ${draft.fullName}`,
      details: { entity: 'person', personId: result.personId, created: true, changedFields }
    })
    return {
      ok: true,
      personId: result.personId,
      created: result.created,
      merged: false,
      changedFields
    }
  }

  if (result.reason !== 'duplicate') {
    return { ok: false, error: result.message }
  }

  const existing = await getPerson(result.personId, organizationId)
  if (!existing || existing.companyId !== companyId) {
    return {
      ok: false,
      error: 'matched existing person outside this company; use search_existing_people before adding',
      personId: result.personId
    }
  }

  const patch: PersonAtCompanyPatch = {}
  if (cleanNullable(draft.fullName)) patch.fullName = draft.fullName
  if (cleanNullable(draft.title)) patch.title = draft.title
  if (cleanNullable(draft.seniority)) patch.seniority = draft.seniority
  if (cleanNullable(draft.department)) patch.department = draft.department
  if (cleanNullable(draft.email)) patch.email = draft.email
  if (cleanNullable(draft.phone)) patch.phone = draft.phone
  if (cleanNullable(draft.linkedinUrl)) patch.linkedinUrl = draft.linkedinUrl
  if (cleanNullable(draft.twitterUrl)) patch.twitterUrl = draft.twitterUrl
  if (cleanNullable(draft.notes)) patch.notes = draft.notes
  if (cleanNullable(draft.context)) patch.context = draft.context
  if (cleanNullable(draft.lifecycleStatus)) patch.lifecycleStatus = draft.lifecycleStatus
  const merged = await updatePersonAtCompany(companyId, organizationId, result.personId, patch, reason)
  if (!merged.ok) return { ok: false, error: merged.error, personId: result.personId }

  return {
    ok: true,
    personId: result.personId,
    created: false,
    merged: true,
    changedFields: merged.changedFields
  }
}

export async function setNextWake(
  companyId: string,
  organizationId: string,
  wakeAt: Date | null,
  patch?: { lastWorkedAt?: Date }
): Promise<void> {
  await db
    .update(companies)
    .set({
      outreachNextWakeAt: wakeAt,
      ...(patch?.lastWorkedAt ? { outreachLastWorkedAt: patch.lastWorkedAt } : {}),
      updatedAt: new Date()
    })
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)))
}

export async function markCompanyOutreachStatus(
  companyId: string,
  status: 'dormant' | 'working' | 'paused' | 'completed' | 'dead',
  organizationId: string,
  options: { clearWake?: boolean } = {}
): Promise<void> {
  const patch: Record<string, unknown> = {
    outreachStatus: status,
    updatedAt: new Date()
  }
  if (options.clearWake) patch.outreachNextWakeAt = null
  if (status === 'completed') patch.outreachCompletedAt = new Date()
  if (status === 'working') patch.outreachStartedAt = sql`coalesce(${companies.outreachStartedAt}, now())`
  await db
    .update(companies)
    .set(patch)
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)))
}

export async function startWorkingCompanies(
  companyIds: string[],
  mailboxId: string,
  organizationId: string
): Promise<number> {
  if (companyIds.length === 0) return 0
  const result = await db
    .update(companies)
    .set({
      outreachStatus: 'working',
      outreachMailboxId: mailboxId,
      outreachStartedAt: sql`coalesce(${companies.outreachStartedAt}, now())`,
      outreachNextWakeAt: new Date(),
      updatedAt: new Date()
    })
    .where(and(eq(companies.organizationId, organizationId), inArray(companies.id, companyIds)))
    .returning({ id: companies.id })
  return result.length
}

export async function getDraft(id: string, organizationId: string): Promise<OutreachDraft | null> {
  const [row] = await db
    .select()
    .from(outreachDrafts)
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

/** Hard-delete a draft still in review. Used by the work-account agent to remove mistakes. */
export async function deleteOutreachDraft(
  companyId: string,
  organizationId: string,
  draftId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const deleted = await db
    .delete(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.id, draftId),
        eq(outreachDrafts.companyId, companyId),
        eq(outreachDrafts.organizationId, organizationId),
        eq(outreachDrafts.status, 'pending_review')
      )
    )
    .returning({
      id: outreachDrafts.id,
      subject: outreachDrafts.subject,
      toEmail: outreachDrafts.toEmail
    })
  const row = deleted[0]
  if (!row) {
    return {
      ok: false,
      error: 'draft not found, not pending_review, or does not belong to this company'
    }
  }
  return { ok: true }
}

export async function markDraftSent(
  id: string,
  organizationId: string,
  gmail: { gmailMessageId: string; gmailThreadId: string | null }
): Promise<OutreachDraft> {
  const [row] = await db
    .update(outreachDrafts)
    .set({
      status: 'sent',
      sentAt: new Date(),
      gmailMessageId: gmail.gmailMessageId,
      gmailThreadId: gmail.gmailThreadId,
      sendError: null,
      updatedAt: new Date()
    })
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))
    .returning()
  return row
}

export async function markDraftFailed(
  id: string,
  organizationId: string,
  error: string
): Promise<OutreachDraft> {
  const [row] = await db
    .update(outreachDrafts)
    .set({
      status: 'failed',
      sendError: error.slice(0, 2000),
      updatedAt: new Date()
    })
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))
    .returning()
  return row
}

export async function markDraftDiscarded(
  id: string,
  organizationId: string,
  reviewNotes?: string | null
): Promise<OutreachDraft> {
  const [row] = await db
    .update(outreachDrafts)
    .set({
      status: 'discarded',
      reviewNotes: reviewNotes ?? null,
      updatedAt: new Date()
    })
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))
    .returning()
  return row
}

export async function patchDraft(
  id: string,
  organizationId: string,
  patch: Partial<Pick<OutreachDraft, 'subject' | 'body' | 'bodyHtml' | 'toEmail' | 'reviewNotes'>>
): Promise<OutreachDraft> {
  const [row] = await db
    .update(outreachDrafts)
    .set({
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.bodyHtml !== undefined ? { bodyHtml: patch.bodyHtml } : {}),
      ...(patch.toEmail !== undefined ? { toEmail: patch.toEmail } : {}),
      ...(patch.reviewNotes !== undefined ? { reviewNotes: patch.reviewNotes } : {}),
      updatedAt: new Date()
    })
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))
    .returning()
  return row
}

export async function listDrafts(input: {
  organizationId: string
  status?: string | null
  mailboxId?: string | null
  companyId?: string | null
  limit?: number
  offset?: number
}) {
  const limit = Math.min(200, Math.max(1, input.limit ?? 100))
  const offset = Math.max(0, input.offset ?? 0)
  const filters = [eq(outreachDrafts.organizationId, input.organizationId)]
  if (input.status) filters.push(eq(outreachDrafts.status, input.status))
  if (input.mailboxId) filters.push(eq(outreachDrafts.mailboxId, input.mailboxId))
  if (input.companyId) filters.push(eq(outreachDrafts.companyId, input.companyId))
  const where = filters.length ? and(...filters) : undefined

  const rows = await db
    .select({
      draft: outreachDrafts,
      company: companies,
      mailbox: mailboxes,
      person: people
    })
    .from(outreachDrafts)
    .leftJoin(companies, eq(companies.id, outreachDrafts.companyId))
    .leftJoin(mailboxes, eq(mailboxes.id, outreachDrafts.mailboxId))
    .leftJoin(people, eq(people.id, outreachDrafts.personId))
    .where(where)
    .orderBy(desc(outreachDrafts.createdAt))
    .limit(limit)
    .offset(offset)

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(outreachDrafts)
    .where(where)

  return {
    rows: rows.map((r) => ({
      draft: r.draft,
      company: r.company,
      mailbox: r.mailbox,
      person: r.person
    })),
    total: Number(count),
    limit,
    offset
  }
}

const MAX_OUTREACH_EMAIL_INSTRUCTIONS = 24_000

function appendOutreachInstructionBlock(
  existing: string | null | undefined,
  header: string,
  lines: string[]
): string {
  if (lines.length === 0) return (existing ?? '').trim()
  const body = lines.map((l) => `- ${l}`).join('\n')
  const block = `${header}\n${body}`.trim()
  const base = existing?.trim() ? existing.trim() + '\n\n---\n\n' : ''
  const merged = (base + block).trim()
  if (merged.length <= MAX_OUTREACH_EMAIL_INSTRUCTIONS) return merged
  return merged.slice(-MAX_OUTREACH_EMAIL_INSTRUCTIONS)
}

export async function appendCompanyOutreachEmailInstructions(
  companyId: string,
  organizationId: string,
  lines: string[]
): Promise<void> {
  if (lines.length === 0) return
  const [row] = await db
    .select({ cur: companies.outreachEmailInstructions })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)))
    .limit(1)
  const header = `From draft feedback (${new Date().toISOString().slice(0, 10)}):`
  const next = appendOutreachInstructionBlock(row?.cur, header, lines)
  await db
    .update(companies)
    .set({ outreachEmailInstructions: next, updatedAt: new Date() })
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)))
}

export async function appendMailboxOutreachEmailInstructions(
  mailboxId: string,
  organizationId: string,
  lines: string[]
): Promise<void> {
  if (lines.length === 0) return
  const [row] = await db
    .select({ cur: mailboxes.outreachEmailInstructions })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.organizationId, organizationId)))
    .limit(1)
  const header = `From draft feedback (${new Date().toISOString().slice(0, 10)}):`
  const next = appendOutreachInstructionBlock(row?.cur, header, lines)
  await db
    .update(mailboxes)
    .set({ outreachEmailInstructions: next, updatedAt: new Date() })
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.organizationId, organizationId)))
}

export async function countPendingDraftsByCompany(
  organizationId: string | null = null
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      companyId: outreachDrafts.companyId,
      count: sql<number>`count(*)::int`
    })
    .from(outreachDrafts)
    .where(
      organizationId
        ? and(eq(outreachDrafts.organizationId, organizationId), eq(outreachDrafts.status, 'pending_review'))
        : eq(outreachDrafts.status, 'pending_review')
    )
    .groupBy(outreachDrafts.companyId)
  return new Map(rows.map((r) => [r.companyId, Number(r.count)]))
}
