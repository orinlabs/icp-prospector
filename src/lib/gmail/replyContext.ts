import { eq } from 'drizzle-orm'

import { db } from '../../db/client.js'
import { outreachDrafts, type OutreachDraft } from '../../db/schema.js'
import { fetchGmailReplyHeaders } from './messageHeaders.js'
import { getMailbox, getValidAccessToken } from './oauth.js'

export type ResolvedReplyContext = {
  threadId: string
  inReplyTo: string
  references: string
}

async function rfcMessageIdForDraft(
  accessToken: string,
  draft: Pick<OutreachDraft, 'gmailRfcMessageId' | 'gmailMessageId'>
): Promise<string | null> {
  if (draft.gmailRfcMessageId?.trim()) return draft.gmailRfcMessageId.trim()
  if (!draft.gmailMessageId) return null
  const headers = await fetchGmailReplyHeaders(accessToken, draft.gmailMessageId)
  return headers?.inReplyTo ?? null
}

/** Resolve Gmail thread + RFC headers for a draft that replies to a prior sent email. */
export async function resolveReplyContextForDraft(
  mailboxId: string,
  draft: Pick<OutreachDraft, 'replyToDraftId' | 'gmailThreadId'>
): Promise<ResolvedReplyContext | null> {
  if (!draft.replyToDraftId) return null

  const [parent] = await db
    .select()
    .from(outreachDrafts)
    .where(eq(outreachDrafts.id, draft.replyToDraftId))
    .limit(1)
  if (!parent || parent.status !== 'sent') {
    throw new Error('reply_to draft is missing or was not sent')
  }

  const threadId = draft.gmailThreadId ?? parent.gmailThreadId
  if (!threadId) {
    throw new Error('cannot reply: prior email has no Gmail thread id')
  }

  const mailbox = await getMailbox(mailboxId)
  if (!mailbox) throw new Error(`mailbox not found: ${mailboxId}`)
  const { accessToken } = await getValidAccessToken(mailbox)

  const inReplyTo = await rfcMessageIdForDraft(accessToken, parent)
  if (!inReplyTo) {
    throw new Error(
      'cannot reply: could not read Message-ID from the prior email (reconnect mailbox for gmail.readonly)'
    )
  }

  return {
    threadId,
    inReplyTo,
    references: inReplyTo
  }
}
