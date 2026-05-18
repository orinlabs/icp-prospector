const MESSAGE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

type GmailHeader = { name?: string; value?: string }

type GmailMessageMetadata = {
  threadId?: string
  payload?: { headers?: GmailHeader[] }
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  if (!headers) return null
  const found = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
  const value = found?.value?.trim()
  return value || null
}

/** RFC 5322 Message-ID from a sent Gmail message (requires gmail.readonly scope). */
export async function fetchGmailRfcMessageId(
  accessToken: string,
  gmailMessageId: string
): Promise<string | null> {
  const url =
    MESSAGE_URL +
    '/' +
    encodeURIComponent(gmailMessageId) +
    '?format=metadata&metadataHeaders=Message-ID'
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) {
    throw new Error(`Gmail message metadata failed (${res.status}): ${await res.text()}`)
  }
  const payload = (await res.json()) as GmailMessageMetadata
  return headerValue(payload.payload?.headers, 'Message-ID')
}

export type GmailReplyHeaders = {
  threadId: string
  inReplyTo: string
  references: string
}

/** Message-ID + References for threading a reply (requires gmail.readonly scope). */
export async function fetchGmailReplyHeaders(
  accessToken: string,
  gmailMessageId: string
): Promise<GmailReplyHeaders | null> {
  const url =
    MESSAGE_URL +
    '/' +
    encodeURIComponent(gmailMessageId) +
    '?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References'
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) {
    throw new Error(`Gmail message metadata failed (${res.status}): ${await res.text()}`)
  }
  const payload = (await res.json()) as GmailMessageMetadata
  const inReplyTo = headerValue(payload.payload?.headers, 'Message-ID')
  if (!inReplyTo || !payload.threadId) return null
  const references =
    headerValue(payload.payload?.headers, 'References') ?? inReplyTo
  return {
    threadId: payload.threadId,
    inReplyTo,
    references
  }
}
