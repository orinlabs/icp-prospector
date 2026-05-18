const SEND_AS_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs'

/** RFC 5322 From with quoted display name (required for Gmail API to show sender name). */
export function formatFromHeader(email: string, displayName: string): string {
  const name = displayName.trim()
  if (!name) return email
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}" <${email}>`
}

export async function syncSendAsDisplayName(
  accessToken: string,
  sendAsEmail: string,
  displayName: string | null | undefined
): Promise<void> {
  const name = displayName?.trim()
  if (!name) return

  const res = await fetch(`${SEND_AS_BASE}/${encodeURIComponent(sendAsEmail)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ displayName: name })
  })
  if (!res.ok) {
    throw new Error(`Gmail sendAs update failed (${res.status}): ${await res.text()}`)
  }
}

export async function getSendAsDisplayName(
  accessToken: string,
  sendAsEmail: string
): Promise<string | null> {
  const res = await fetch(`${SEND_AS_BASE}/${encodeURIComponent(sendAsEmail)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) return null
  const payload = (await res.json()) as { displayName?: string }
  return payload.displayName?.trim() || null
}

/** Prefer Gmail send-as name after sync; fall back to the mailbox row. */
export async function resolveSenderDisplayName(
  accessToken: string,
  sendAsEmail: string,
  mailboxDisplayName: string | null | undefined
): Promise<string | null> {
  await syncSendAsDisplayName(accessToken, sendAsEmail, mailboxDisplayName)
  return (await getSendAsDisplayName(accessToken, sendAsEmail)) ?? mailboxDisplayName?.trim() ?? null
}
