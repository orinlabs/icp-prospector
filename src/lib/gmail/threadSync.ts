import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm'

import { db } from '../../db/client.js'
import { outreachDrafts, outreachThreadMessages } from '../../db/schema.js'
import { appendOutreachEvent } from '../../workflows/repoOutreach.js'
import { getMailbox, getValidAccessToken } from './oauth.js'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MAX_BODY_CHARS = 12_000
const SYNC_STALE_MS = 15 * 60 * 1000
const BATCH_LIMIT = 40

type GmailHeader = { name?: string; value?: string }
type GmailMessagePart = {
  mimeType?: string
  body?: { data?: string; size?: number }
  parts?: GmailMessagePart[]
}
type GmailMessage = {
  id?: string
  internalDate?: string
  snippet?: string
  payload?: {
    headers?: GmailHeader[]
    mimeType?: string
    body?: { data?: string }
    parts?: GmailMessagePart[]
  }
}

const BOUNCE_FROM_PATTERNS = [
  /mailer-daemon/i,
  /postmaster@/i,
  /mail-daemon/i,
  /noreply.*bounce/i
]

const BOUNCE_SUBJECT_PATTERNS = [
  /undelivered/i,
  /delivery status notification/i,
  /delivery failure/i,
  /mail delivery failed/i,
  /returned mail/i,
  /failure notice/i
]

export function normalizeEmailAddress(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  const angle = trimmed.match(/<([^>]+)>/)
  const email = (angle ? angle[1] : trimmed).trim().toLowerCase()
  return email.includes('@') ? email : null
}

export function classifyInboundMessage(input: {
  fromEmail: string | null
  subject: string | null
  recipientEmail: string
}): 'bounce' | 'reply' | 'other' {
  const from = input.fromEmail ?? ''
  const subject = input.subject ?? ''
  if (BOUNCE_FROM_PATTERNS.some((re) => re.test(from))) return 'bounce'
  if (BOUNCE_SUBJECT_PATTERNS.some((re) => re.test(subject))) return 'bounce'
  const recipient = normalizeEmailAddress(input.recipientEmail)
  const sender = normalizeEmailAddress(from)
  if (recipient && sender && sender === recipient) return 'reply'
  return 'other'
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  const lower = name.toLowerCase()
  const hit = headers?.find((h) => h.name?.toLowerCase() === lower)
  return hit?.value?.trim() ?? null
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64').toString('utf8')
}

function extractPlainText(part: GmailMessagePart | undefined): string {
  if (!part) return ''
  const chunks: string[] = []
  if (part.mimeType === 'text/plain' && part.body?.data) {
    chunks.push(decodeBase64Url(part.body.data))
  }
  for (const child of part.parts ?? []) {
    chunks.push(extractPlainText(child))
  }
  return chunks.join('\n').trim()
}

function messagePlainBody(message: GmailMessage): string {
  const payload = message.payload
  if (!payload) return message.snippet?.trim() ?? ''
  const fromPayload = extractPlainText(payload as GmailMessagePart)
  if (fromPayload) return fromPayload.slice(0, MAX_BODY_CHARS)
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data).slice(0, MAX_BODY_CHARS)
  }
  return (message.snippet ?? '').slice(0, MAX_BODY_CHARS)
}

async function fetchThread(accessToken: string, threadId: string): Promise<GmailMessage[]> {
  const url = `${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}?format=full`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) {
    throw new Error(`Gmail thread fetch failed (${res.status}): ${await res.text()}`)
  }
  const payload = (await res.json()) as { messages?: GmailMessage[] }
  return payload.messages ?? []
}

export type SyncDraftThreadResult = {
  draftId: string
  newMessages: number
  kinds: string[]
}

export async function syncDraftThread(draftId: string): Promise<SyncDraftThreadResult | null> {
  const [draft] = await db.select().from(outreachDrafts).where(eq(outreachDrafts.id, draftId)).limit(1)
  if (!draft || draft.status !== 'sent' || !draft.gmailThreadId || !draft.gmailMessageId) {
    return null
  }

  const mailbox = await getMailbox(draft.mailboxId)
  if (!mailbox || mailbox.status !== 'active') return null

  const { accessToken } = await getValidAccessToken(mailbox)
  const messages = await fetchThread(accessToken, draft.gmailThreadId)

  const sentIdx = messages.findIndex((m) => m.id === draft.gmailMessageId)
  const afterSent = sentIdx >= 0 ? messages.slice(sentIdx + 1) : messages.slice(1)

  const kinds: string[] = []
  let newMessages = 0

  for (const message of afterSent) {
    if (!message.id) continue
    const fromEmail = normalizeEmailAddress(headerValue(message.payload?.headers, 'From'))
    const toEmail = normalizeEmailAddress(headerValue(message.payload?.headers, 'To'))
    const subject = headerValue(message.payload?.headers, 'Subject')
    const kind = classifyInboundMessage({
      fromEmail,
      subject,
      recipientEmail: draft.toEmail
    })
    if (kind === 'other') continue

    const receivedAt = message.internalDate
      ? new Date(Number(message.internalDate))
      : new Date()
    const bodyText = messagePlainBody(message)

    const inserted = await db
      .insert(outreachThreadMessages)
      .values({
        organizationId: draft.organizationId,
        companyId: draft.companyId,
        draftId: draft.id,
        gmailMessageId: message.id,
        kind,
        fromEmail,
        toEmail,
        subject,
        bodyText,
        receivedAt
      })
      .onConflictDoNothing({ target: outreachThreadMessages.gmailMessageId })
      .returning({ id: outreachThreadMessages.id })

    if (inserted.length === 0) continue
    newMessages += 1
    kinds.push(kind)

    if (kind === 'reply') {
      await appendOutreachEvent({
        organizationId: draft.organizationId,
        companyId: draft.companyId,
        kind: 'email_reply',
        summary: `Reply from ${fromEmail ?? 'unknown'} re: ${draft.subject}`,
        details: {
          draftId: draft.id,
          gmailMessageId: message.id,
          fromEmail,
          subject,
          body_preview: bodyText.slice(0, 500)
        }
      })
    } else if (kind === 'bounce') {
      await appendOutreachEvent({
        organizationId: draft.organizationId,
        companyId: draft.companyId,
        kind: 'email_bounced',
        summary: `Bounce for ${draft.toEmail}: ${draft.subject}`,
        details: {
          draftId: draft.id,
          gmailMessageId: message.id,
          fromEmail,
          subject,
          body_preview: bodyText.slice(0, 500)
        }
      })
    }
  }

  await db
    .update(outreachDrafts)
    .set({ threadSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(outreachDrafts.id, draft.id))

  return { draftId: draft.id, newMessages, kinds }
}

export async function listDraftsNeedingThreadSync(limit = BATCH_LIMIT): Promise<string[]> {
  const staleBefore = new Date(Date.now() - SYNC_STALE_MS)
  const rows = await db
    .select({ id: outreachDrafts.id })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.status, 'sent'),
        isNotNull(outreachDrafts.gmailThreadId),
        isNotNull(outreachDrafts.gmailMessageId),
        or(
          sql`${outreachDrafts.threadSyncedAt} is null`,
          lt(outreachDrafts.threadSyncedAt, staleBefore)
        )
      )
    )
    .orderBy(sql`coalesce(${outreachDrafts.threadSyncedAt}, ${outreachDrafts.sentAt}) asc nulls first`)
    .limit(limit)
  return rows.map((r) => r.id)
}

export async function syncAllDueDraftThreads(): Promise<{
  attempted: number
  withNew: number
  errors: number
}> {
  const ids = await listDraftsNeedingThreadSync()
  let withNew = 0
  let errors = 0
  for (const id of ids) {
    try {
      const result = await syncDraftThread(id)
      if (result && result.newMessages > 0) withNew += 1
    } catch (err) {
      errors += 1
      console.error(
        `[gmail:sync] draft ${id} failed:`,
        err instanceof Error ? err.message : err
      )
    }
  }
  return { attempted: ids.length, withNew, errors }
}

export async function syncCompanyDraftThreads(
  companyId: string,
  organizationId: string
): Promise<number> {
  const rows = await db
    .select({ id: outreachDrafts.id })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.companyId, companyId),
        eq(outreachDrafts.organizationId, organizationId),
        eq(outreachDrafts.status, 'sent'),
        isNotNull(outreachDrafts.gmailThreadId)
      )
    )
  let newCount = 0
  for (const row of rows) {
    const result = await syncDraftThread(row.id)
    if (result?.newMessages) newCount += result.newMessages
  }
  return newCount
}
