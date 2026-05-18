const SEND_AS_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs'

/** Gmail applies the send-as display name to outbound API mail; MIME From names are ignored. */
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
