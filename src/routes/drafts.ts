import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { db } from '../db/client.js'
import { companies, mailboxes, outreachDrafts, people } from '../db/schema.js'
import { createTrackingToken, injectTrackingPixel } from '../lib/emailTracking/pixel.js'
import { sendMessage } from '../lib/gmail/send.js'
import { appendMailboxSignature, appendMailboxSignatureHtml } from '../lib/mailboxSignature.js'
import type { AppVariables } from '../lib/orgs.js'
import { startWorkAccount } from '../lib/workflowTrigger.js'
import {
  appendCompanyOutreachEmailInstructions,
  appendMailboxOutreachEmailInstructions,
  appendOutreachEvent,
  listDrafts,
  markDraftDiscarded,
  markDraftFailed,
  markDraftSent,
  patchDraft
} from '../workflows/repoOutreach.js'
import { extractDraftFeedbackInstructionLines } from '../lib/extractDraftFeedbackInstructions.js'

export const draftsRoutes = new Hono<{ Variables: AppVariables }>()

const listQuerySchema = z.object({
  status: z.string().optional(),
  mailboxId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0)
})

const patchSchema = z.object({
  subject: z.string().min(1).max(998).optional(),
  body: z.string().min(1).max(50_000).optional(),
  bodyHtml: z.string().max(200_000).nullable().optional(),
  toEmail: z.string().email().optional(),
  reviewNotes: z.string().max(8000).nullable().optional()
})

const regenerateSchema = z.object({
  reviewNotes: z.string().min(1).max(8000),
  saveInstructionsToAccount: z.boolean().optional(),
  saveInstructionsToMailbox: z.boolean().optional()
})

const discardBodySchema = z.object({
  reviewNotes: z.string().max(8000).optional(),
  saveInstructionsToAccount: z.boolean().optional(),
  saveInstructionsToMailbox: z.boolean().optional()
})

async function maybeAppendEmailInstructionsFromFeedback(input: {
  reviewNotes: string
  organizationId: string
  companyId: string
  mailboxId: string
  saveToAccount: boolean
  saveToMailbox: boolean
}): Promise<{ lines: string[]; error?: string }> {
  if (!input.saveToAccount && !input.saveToMailbox) {
    return { lines: [] }
  }
  try {
    const lines = await extractDraftFeedbackInstructionLines(input.reviewNotes)
    if (input.saveToAccount) {
      await appendCompanyOutreachEmailInstructions(input.companyId, input.organizationId, lines)
    }
    if (input.saveToMailbox) {
      await appendMailboxOutreachEmailInstructions(input.mailboxId, input.organizationId, lines)
    }
    return { lines }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { lines: [], error: message }
  }
}

draftsRoutes.get('/', async (c) => {
  const organizationId = c.get('organization').id
  const parsed = listQuerySchema.safeParse({
    status: c.req.query('status') ?? 'pending_review',
    mailboxId: c.req.query('mailboxId') ?? undefined,
    companyId: c.req.query('companyId') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    offset: c.req.query('offset') ?? undefined
  })
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const { status, mailboxId, companyId, limit, offset } = parsed.data
  const result = await listDrafts({
    organizationId,
    status: status || null,
    mailboxId: mailboxId ?? null,
    companyId: companyId ?? null,
    limit,
    offset
  })
  return c.json({
    data: result.rows.map((r) => ({
      draft: r.draft,
      company: r.company
        ? { id: r.company.id, name: r.company.name, domain: r.company.domain }
        : null,
      mailbox: r.mailbox
        ? {
            id: r.mailbox.id,
            email: r.mailbox.email,
            displayName: r.mailbox.displayName,
            signature: r.mailbox.signature
          }
        : null,
      person: r.person
        ? { id: r.person.id, fullName: r.person.fullName, title: r.person.title }
        : null
    })),
    total: result.total,
    limit: result.limit,
    offset: result.offset
  })
})

draftsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const [row] = await db
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
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))
    .limit(1)
  if (!row) return c.json({ error: 'not found' }, 404)

  const sentEmails = row.company
    ? await db
        .select({
          id: outreachDrafts.id,
          toEmail: outreachDrafts.toEmail,
          subject: outreachDrafts.subject,
          sentAt: outreachDrafts.sentAt,
          gmailMessageId: outreachDrafts.gmailMessageId,
          person: {
            id: people.id,
            fullName: people.fullName,
            title: people.title
          }
        })
        .from(outreachDrafts)
        .leftJoin(people, eq(people.id, outreachDrafts.personId))
        .where(
          and(
            eq(outreachDrafts.companyId, row.company.id),
            eq(outreachDrafts.organizationId, organizationId),
            eq(outreachDrafts.status, 'sent')
          )
        )
        .orderBy(desc(outreachDrafts.sentAt))
        .limit(50)
    : []

  return c.json({
    draft: row.draft,
    company: row.company,
    mailbox: row.mailbox
      ? {
          id: row.mailbox.id,
          email: row.mailbox.email,
          displayName: row.mailbox.displayName,
          signature: row.mailbox.signature
        }
      : null,
    person: row.person,
    strategy: row.company?.outreachStrategy ?? null,
    sentEmails
  })
})

draftsRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const parsed = patchSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const [existing] = await db
    .select()
    .from(outreachDrafts)
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))
    .limit(1)
  if (!existing) return c.json({ error: 'not found' }, 404)
  if (existing.status !== 'pending_review') {
    return c.json({ error: `cannot edit draft in status ${existing.status}` }, 409)
  }
  const updated = await patchDraft(id, organizationId, parsed.data)
  return c.json(updated)
})

draftsRoutes.post('/:id/approve', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const [existing] = await db
    .select()
    .from(outreachDrafts)
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))
    .limit(1)
  if (!existing) return c.json({ error: 'not found' }, 404)
  if (existing.status !== 'pending_review' && existing.status !== 'failed') {
    return c.json({ error: `cannot approve draft in status ${existing.status}` }, 409)
  }

  // Flip to approved first so a concurrent request doesn't double-send.
  await db
    .update(outreachDrafts)
    .set({ status: 'approved', sendError: null, updatedAt: new Date() })
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))

  try {
    const [mailbox] = await db
      .select({ signature: mailboxes.signature })
      .from(mailboxes)
      .where(and(eq(mailboxes.id, existing.mailboxId), eq(mailboxes.organizationId, organizationId)))
      .limit(1)
    const signature = mailbox?.signature ?? null
    const outgoingBody = appendMailboxSignature(existing.body, signature)
    const baseHtml =
      existing.bodyHtml?.trim() && signature
        ? appendMailboxSignatureHtml(existing.bodyHtml, signature)
        : existing.bodyHtml
    const trackingToken = createTrackingToken()
    const outgoingBodyHtml = injectTrackingPixel(baseHtml, outgoingBody, trackingToken)

    const sent = await sendMessage({
      mailboxId: existing.mailboxId,
      to: existing.toEmail,
      subject: existing.subject,
      body: outgoingBody,
      bodyHtml: outgoingBodyHtml,
      threadId: existing.gmailThreadId
    })
    const updated = await markDraftSent(id, organizationId, sent, trackingToken)
    await appendOutreachEvent({
      organizationId,
      companyId: existing.companyId,
      kind: 'email_sent',
      summary: `Email sent to ${existing.toEmail}: ${existing.subject}`,
      details: {
        draftId: id,
        toEmail: existing.toEmail,
        subject: existing.subject,
        gmailMessageId: sent.gmailMessageId,
        gmailThreadId: sent.gmailThreadId
      }
    })
    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failed = await markDraftFailed(id, organizationId, message)
    await appendOutreachEvent({
      organizationId,
      companyId: existing.companyId,
      kind: 'error',
      summary: `Send failed: ${message.slice(0, 200)}`,
      details: { draftId: id }
    })
    return c.json({ error: message, draft: failed }, 502)
  }
})

draftsRoutes.post('/:id/discard', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const parsed = discardBodySchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const body = parsed.data
  const [existing] = await db
    .select()
    .from(outreachDrafts)
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))
    .limit(1)
  if (!existing) return c.json({ error: 'not found' }, 404)
  const notes = body.reviewNotes?.trim() ?? ''
  const saveAccount = Boolean(body.saveInstructionsToAccount)
  const saveMailbox = Boolean(body.saveInstructionsToMailbox)
  let instructionAppend: { lines: string[]; error?: string } = { lines: [] }
  if (notes && (saveAccount || saveMailbox)) {
    instructionAppend = await maybeAppendEmailInstructionsFromFeedback({
      reviewNotes: notes,
      organizationId,
      companyId: existing.companyId,
      mailboxId: existing.mailboxId,
      saveToAccount: saveAccount,
      saveToMailbox: saveMailbox
    })
  }
  const updated = await markDraftDiscarded(id, organizationId, notes || null)
  await appendOutreachEvent({
    organizationId,
    companyId: existing.companyId,
    kind: 'note',
    summary: `Operator discarded draft: ${existing.subject}`,
    details: { draftId: id, reviewNotes: notes || null }
  })
  return c.json({ ...updated, instructionAppend })
})

draftsRoutes.post('/:id/regenerate', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const parsed = regenerateSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const [existing] = await db
    .select()
    .from(outreachDrafts)
    .where(and(eq(outreachDrafts.id, id), eq(outreachDrafts.organizationId, organizationId)))
    .limit(1)
  if (!existing) return c.json({ error: 'not found' }, 404)
  const saveAccount = Boolean(parsed.data.saveInstructionsToAccount)
  const saveMailbox = Boolean(parsed.data.saveInstructionsToMailbox)
  let instructionAppend: { lines: string[]; error?: string } = { lines: [] }
  if (saveAccount || saveMailbox) {
    instructionAppend = await maybeAppendEmailInstructionsFromFeedback({
      reviewNotes: parsed.data.reviewNotes,
      organizationId,
      companyId: existing.companyId,
      mailboxId: existing.mailboxId,
      saveToAccount: saveAccount,
      saveToMailbox: saveMailbox
    })
  }
  const discarded = await markDraftDiscarded(id, organizationId, parsed.data.reviewNotes)
  await appendOutreachEvent({
    organizationId,
    companyId: existing.companyId,
    kind: 'decision',
    summary: `Operator asked for a rewrite. Notes: ${parsed.data.reviewNotes.slice(0, 200)}`,
    details: { draftId: id, reviewNotes: parsed.data.reviewNotes }
  })
  await db
    .update(companies)
    .set({ outreachNextWakeAt: new Date(), updatedAt: new Date() })
    .where(and(eq(companies.id, existing.companyId), eq(companies.organizationId, organizationId)))

  let workflowTriggered = false
  let workflowError: string | undefined
  try {
    workflowTriggered = await startWorkAccount(existing.companyId, organizationId)
  } catch (e) {
    workflowError = e instanceof Error ? e.message : String(e)
  }
  return c.json({
    ok: true,
    discardedDraft: discarded,
    instructionAppend,
    workflowTriggered,
    error: workflowError,
    hint: workflowTriggered
      ? undefined
      : 'No Render workflow dispatched; the sweep cron will pick this up.'
  })
})
