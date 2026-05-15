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

export type CompanyWithMailbox = Company & {
  mailbox: Mailbox | null
}

export async function getCompanyForOutreach(
  companyId: string
): Promise<CompanyWithMailbox | null> {
  const [row] = await db
    .select({ company: companies, mailbox: mailboxes })
    .from(companies)
    .leftJoin(mailboxes, eq(mailboxes.id, companies.outreachMailboxId))
    .where(eq(companies.id, companyId))
    .limit(1)
  if (!row) return null
  return { ...row.company, mailbox: row.mailbox ?? null }
}

export async function listDueCompanyIds(limit = 50): Promise<string[]> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.outreachStatus, 'working'),
        isNotNull(companies.outreachMailboxId),
        isNotNull(companies.outreachNextWakeAt),
        lte(companies.outreachNextWakeAt, new Date())
      )
    )
    .orderBy(companies.outreachNextWakeAt)
    .limit(limit)
  return rows.map((r) => r.id)
}

export type AppendEventInput = {
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
  limit = 20
): Promise<OutreachEvent[]> {
  return db
    .select()
    .from(outreachEvents)
    .where(eq(outreachEvents.companyId, companyId))
    .orderBy(desc(outreachEvents.createdAt))
    .limit(limit)
}

export async function writeStrategy(
  companyId: string,
  text: string,
  reason: string | null
): Promise<void> {
  await db
    .update(companies)
    .set({
      outreachStrategy: text,
      updatedAt: new Date()
    })
    .where(eq(companies.id, companyId))
  await appendOutreachEvent({
    companyId,
    kind: 'strategy_revision',
    summary: reason?.trim() || 'Agent revised the outreach strategy.',
    details: { length: text.length }
  })
}

export type InsertDraftInput = {
  companyId: string
  mailboxId: string
  personId?: string | null
  toEmail: string
  subject: string
  body: string
  bodyHtml?: string | null
  agentRationale?: string | null
}

export async function insertDraft(input: InsertDraftInput): Promise<OutreachDraft> {
  const [row] = await db
    .insert(outreachDrafts)
    .values({
      companyId: input.companyId,
      mailboxId: input.mailboxId,
      personId: input.personId ?? null,
      toEmail: input.toEmail,
      subject: input.subject,
      body: input.body,
      bodyHtml: input.bodyHtml ?? null,
      agentRationale: input.agentRationale ?? null,
      status: 'pending_review'
    })
    .returning()
  return row
}

export async function listRecentDrafts(
  companyId: string,
  limit = 10
): Promise<OutreachDraft[]> {
  return db
    .select()
    .from(outreachDrafts)
    .where(eq(outreachDrafts.companyId, companyId))
    .orderBy(desc(outreachDrafts.createdAt))
    .limit(limit)
}

export async function listPeopleAtCompany(companyId: string, limit = 25) {
  return db
    .select({
      id: people.id,
      fullName: people.fullName,
      title: people.title,
      seniority: people.seniority,
      department: people.department,
      email: people.email,
      linkedinUrl: people.linkedinUrl,
      twitterUrl: people.twitterUrl,
      notes: people.notes,
      context: people.context
    })
    .from(people)
    .where(eq(people.companyId, companyId))
    .orderBy(desc(people.lastSeenAt))
    .limit(limit)
}

export async function setNextWake(
  companyId: string,
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
    .where(eq(companies.id, companyId))
}

export async function markCompanyOutreachStatus(
  companyId: string,
  status: 'dormant' | 'working' | 'paused' | 'completed' | 'dead',
  options: { clearWake?: boolean } = {}
): Promise<void> {
  const patch: Record<string, unknown> = {
    outreachStatus: status,
    updatedAt: new Date()
  }
  if (options.clearWake) patch.outreachNextWakeAt = null
  if (status === 'completed') patch.outreachCompletedAt = new Date()
  if (status === 'working') patch.outreachStartedAt = sql`coalesce(${companies.outreachStartedAt}, now())`
  await db.update(companies).set(patch).where(eq(companies.id, companyId))
}

export async function startWorkingCompanies(
  companyIds: string[],
  mailboxId: string
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
    .where(inArray(companies.id, companyIds))
    .returning({ id: companies.id })
  return result.length
}

export async function getDraft(id: string): Promise<OutreachDraft | null> {
  const [row] = await db.select().from(outreachDrafts).where(eq(outreachDrafts.id, id)).limit(1)
  return row ?? null
}

/** Hard-delete a draft still in review. Used by the work-account agent to remove mistakes. */
export async function deleteOutreachDraft(
  companyId: string,
  draftId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const deleted = await db
    .delete(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.id, draftId),
        eq(outreachDrafts.companyId, companyId),
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
    .where(eq(outreachDrafts.id, id))
    .returning()
  return row
}

export async function markDraftFailed(id: string, error: string): Promise<OutreachDraft> {
  const [row] = await db
    .update(outreachDrafts)
    .set({
      status: 'failed',
      sendError: error.slice(0, 2000),
      updatedAt: new Date()
    })
    .where(eq(outreachDrafts.id, id))
    .returning()
  return row
}

export async function markDraftDiscarded(
  id: string,
  reviewNotes?: string | null
): Promise<OutreachDraft> {
  const [row] = await db
    .update(outreachDrafts)
    .set({
      status: 'discarded',
      reviewNotes: reviewNotes ?? null,
      updatedAt: new Date()
    })
    .where(eq(outreachDrafts.id, id))
    .returning()
  return row
}

export async function patchDraft(
  id: string,
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
    .where(eq(outreachDrafts.id, id))
    .returning()
  return row
}

export async function listDrafts(input: {
  status?: string | null
  mailboxId?: string | null
  companyId?: string | null
  limit?: number
  offset?: number
}) {
  const limit = Math.min(200, Math.max(1, input.limit ?? 100))
  const offset = Math.max(0, input.offset ?? 0)
  const filters = []
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
  lines: string[]
): Promise<void> {
  if (lines.length === 0) return
  const [row] = await db
    .select({ cur: companies.outreachEmailInstructions })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
  const header = `From draft feedback (${new Date().toISOString().slice(0, 10)}):`
  const next = appendOutreachInstructionBlock(row?.cur, header, lines)
  await db
    .update(companies)
    .set({ outreachEmailInstructions: next, updatedAt: new Date() })
    .where(eq(companies.id, companyId))
}

export async function appendMailboxOutreachEmailInstructions(
  mailboxId: string,
  lines: string[]
): Promise<void> {
  if (lines.length === 0) return
  const [row] = await db
    .select({ cur: mailboxes.outreachEmailInstructions })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .limit(1)
  const header = `From draft feedback (${new Date().toISOString().slice(0, 10)}):`
  const next = appendOutreachInstructionBlock(row?.cur, header, lines)
  await db
    .update(mailboxes)
    .set({ outreachEmailInstructions: next, updatedAt: new Date() })
    .where(eq(mailboxes.id, mailboxId))
}

export async function countPendingDraftsByCompany(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      companyId: outreachDrafts.companyId,
      count: sql<number>`count(*)::int`
    })
    .from(outreachDrafts)
    .where(eq(outreachDrafts.status, 'pending_review'))
    .groupBy(outreachDrafts.companyId)
  return new Map(rows.map((r) => [r.companyId, Number(r.count)]))
}
