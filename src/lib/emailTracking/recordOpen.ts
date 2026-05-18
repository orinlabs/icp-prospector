import { and, eq, sql } from 'drizzle-orm'

import { db } from '../../db/client.js'
import { outreachDrafts, outreachEmailOpens } from '../../db/schema.js'
import { appendOutreachEvent } from '../../workflows/repoOutreach.js'
import { hashClientIp } from './pixel.js'

const OPEN_DEBOUNCE_MS = 60_000

export type RecordOpenInput = {
  token: string
  userAgent: string | null
  clientIp: string | null
}

export type RecordOpenResult =
  | { recorded: true; draftId: string; openCount: number; isFirstOpen: boolean }
  | { recorded: false; reason: 'unknown_token' | 'debounced' }

export async function recordEmailOpen(input: RecordOpenInput): Promise<RecordOpenResult> {
  const token = input.token.trim()
  if (!token) return { recorded: false, reason: 'unknown_token' }

  const [draft] = await db
    .select()
    .from(outreachDrafts)
    .where(eq(outreachDrafts.trackingToken, token))
    .limit(1)
  if (!draft || draft.status !== 'sent') {
    return { recorded: false, reason: 'unknown_token' }
  }

  const ipHash = hashClientIp(input.clientIp)
  const ua = input.userAgent?.trim().slice(0, 2000) ?? null

  if (draft.lastOpenedAt && Date.now() - draft.lastOpenedAt.getTime() < OPEN_DEBOUNCE_MS) {
    const filters = [
      eq(outreachEmailOpens.draftId, draft.id),
      sql`${outreachEmailOpens.openedAt} > now() - interval '60 seconds'`
    ]
    if (ipHash) filters.push(eq(outreachEmailOpens.ipHash, ipHash))
    const [recent] = await db
      .select({ id: outreachEmailOpens.id })
      .from(outreachEmailOpens)
      .where(and(...filters))
      .limit(1)
    if (recent) return { recorded: false, reason: 'debounced' }
  }

  const now = new Date()
  const isFirstOpen = !draft.firstOpenedAt

  await db.insert(outreachEmailOpens).values({
    organizationId: draft.organizationId,
    draftId: draft.id,
    openedAt: now,
    userAgent: ua,
    ipHash
  })

  const [updated] = await db
    .update(outreachDrafts)
    .set({
      openCount: sql`${outreachDrafts.openCount} + 1`,
      firstOpenedAt: draft.firstOpenedAt ?? now,
      lastOpenedAt: now,
      updatedAt: now
    })
    .where(eq(outreachDrafts.id, draft.id))
    .returning({ openCount: outreachDrafts.openCount })

  if (isFirstOpen) {
    await appendOutreachEvent({
      organizationId: draft.organizationId,
      companyId: draft.companyId,
      kind: 'email_opened',
      summary: `Prospect opened email to ${draft.toEmail}: ${draft.subject}`,
      details: {
        draftId: draft.id,
        toEmail: draft.toEmail,
        subject: draft.subject,
        openCount: updated?.openCount ?? 1
      }
    })
  }

  return {
    recorded: true,
    draftId: draft.id,
    openCount: updated?.openCount ?? draft.openCount + 1,
    isFirstOpen
  }
}
