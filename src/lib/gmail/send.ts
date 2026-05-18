import { fetchGmailRfcMessageId } from './messageHeaders.js'
import { getMailbox, getValidAccessToken } from './oauth.js'
import { formatFromHeader, resolveSenderDisplayName } from './sendAs.js'

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

export type SendMessageInput = {
  mailboxId: string
  to: string
  subject: string
  body: string
  bodyHtml?: string | null
  threadId?: string | null
  inReplyTo?: string | null
  references?: string | null
}

export type SendMessageResult = {
  gmailMessageId: string
  gmailThreadId: string | null
  gmailRfcMessageId: string | null
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word if non-ASCII; otherwise use as-is.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(value)) {
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
  }
  return value
}

/** Exported for tests. Gmail API needs an explicit quoted From to show the sender name. */
export function buildRfc5322(input: {
  from: string
  fromDisplay: string | null
  to: string
  subject: string
  body: string
  bodyHtml: string | null
  inReplyTo?: string | null
  references?: string | null
}): string {
  const fromHeader = input.fromDisplay
    ? formatFromHeader(input.from, input.fromDisplay)
    : input.from

  const headers: string[] = [
    `From: ${fromHeader}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0'
  ]
  if (input.inReplyTo?.trim()) {
    headers.push(`In-Reply-To: ${input.inReplyTo.trim()}`)
  }
  if (input.references?.trim()) {
    headers.push(`References: ${input.references.trim()}`)
  }

  if (input.bodyHtml && input.bodyHtml.trim()) {
    const boundary = '====slate_boundary_' + Math.random().toString(36).slice(2)
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    return [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      input.body,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      input.bodyHtml,
      '',
      `--${boundary}--`,
      ''
    ].join('\r\n')
  }

  headers.push('Content-Type: text/plain; charset="UTF-8"')
  headers.push('Content-Transfer-Encoding: 7bit')
  return [headers.join('\r\n'), '', input.body, ''].join('\r\n')
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const mailbox = await getMailbox(input.mailboxId)
  if (!mailbox) throw new Error(`mailbox not found: ${input.mailboxId}`)
  if (mailbox.status !== 'active') {
    throw new Error(`mailbox ${mailbox.email} is not active (status: ${mailbox.status})`)
  }
  const { accessToken } = await getValidAccessToken(mailbox)

  let fromDisplay: string | null = mailbox.displayName?.trim() ?? null
  try {
    fromDisplay = await resolveSenderDisplayName(accessToken, mailbox.email, mailbox.displayName)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const needsReconnect = message.includes('403') || message.includes('insufficient')
    console.warn(
      `[gmail] sendAs displayName resolve failed for ${mailbox.email}` +
        (needsReconnect ? ' (reconnect mailbox for gmail.settings.basic scope)' : '') +
        `: ${message}`
    )
  }

  const raw = buildRfc5322({
    from: mailbox.email,
    fromDisplay,
    to: input.to,
    subject: input.subject,
    body: input.body,
    bodyHtml: input.bodyHtml ?? null,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null
  })
  const encoded = base64UrlEncode(raw)

  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      raw: encoded,
      ...(input.threadId ? { threadId: input.threadId } : {})
    })
  })

  if (!res.ok) {
    throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`)
  }
  const payload = (await res.json()) as { id?: string; threadId?: string }
  if (!payload.id) {
    throw new Error('Gmail send succeeded but returned no message id.')
  }

  let gmailRfcMessageId: string | null = null
  try {
    gmailRfcMessageId = await fetchGmailRfcMessageId(accessToken, payload.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[gmail] could not fetch Message-ID for sent message ${payload.id}: ${message}`)
  }

  return {
    gmailMessageId: payload.id,
    gmailThreadId: payload.threadId ?? null,
    gmailRfcMessageId
  }
}
