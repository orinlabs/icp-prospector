import { and, eq, sql } from 'drizzle-orm'

import { db } from '../../db/client.js'
import { mailboxes, type Mailbox } from '../../db/schema.js'
import { syncSendAsDisplayName } from './sendAs.js'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

/**
 * Send + read threads (for reply/bounce detection) + send-as display name.
 * Drafts live in our DB until the operator approves them on the Drafts page.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid'
] as const

const ACCESS_TOKEN_REFRESH_SLACK_MS = 60 * 1000

function clientId(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!v) throw new Error('GOOGLE_OAUTH_CLIENT_ID required for Gmail OAuth')
  return v
}

function clientSecret(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!v) throw new Error('GOOGLE_OAUTH_CLIENT_SECRET required for Gmail OAuth')
  return v
}

function redirectUri(): string {
  const v = process.env.GOOGLE_OAUTH_REDIRECT_URI
  if (!v) throw new Error('GOOGLE_OAUTH_REDIRECT_URI required for Gmail OAuth')
  return v
}

export function buildConsentUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state
  })
  return AUTH_URL + '?' + params.toString()
}

type TokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
  token_type?: string
  id_token?: string
}

type UserInfo = {
  email?: string
  name?: string
}

async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code'
    }).toString()
  })
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as TokenResponse
}

async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) {
    throw new Error(`Google userinfo fetch failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as UserInfo
}

export type ConnectMailboxResult = {
  mailbox: Mailbox
  alreadyExisted: boolean
}

/**
 * Exchange the OAuth callback code, fetch the user's email, and upsert
 * the mailbox row by lower(email). Returns the persisted row.
 */
export async function connectMailboxFromCode(
  code: string,
  organizationId: string
): Promise<ConnectMailboxResult> {
  const tokens = await exchangeCodeForTokens(code)
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. Revoke the app at https://myaccount.google.com/permissions and reconnect, ensuring prompt=consent.'
    )
  }
  const info = await fetchUserInfo(tokens.access_token)
  if (!info.email) {
    throw new Error('Google userinfo did not include an email; cannot upsert mailbox.')
  }
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)

  const [existing] = await db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.organizationId, organizationId),
        sql`lower(${mailboxes.email}) = ${info.email.toLowerCase()}`
      )
    )
    .limit(1)

  if (existing) {
    const [updated] = await db
      .update(mailboxes)
      .set({
        displayName: existing.displayName ?? info.name ?? null,
        oauthRefreshToken: tokens.refresh_token,
        oauthAccessToken: tokens.access_token,
        oauthExpiresAt: expiresAt,
        scopes: tokens.scope ?? GMAIL_SCOPES.join(' '),
        status: 'active',
        updatedAt: new Date()
      })
      .where(eq(mailboxes.id, existing.id))
      .returning()
    try {
      await syncSendAsDisplayName(
        tokens.access_token,
        updated.email,
        updated.displayName ?? info.name ?? null
      )
    } catch (err) {
      console.warn(
        `[gmail] sendAs displayName sync failed on connect for ${updated.email}:`,
        err instanceof Error ? err.message : err
      )
    }
    return { mailbox: updated, alreadyExisted: true }
  }

  const [created] = await db
    .insert(mailboxes)
    .values({
      email: info.email,
      organizationId,
      displayName: info.name ?? null,
      oauthRefreshToken: tokens.refresh_token,
      oauthAccessToken: tokens.access_token,
      oauthExpiresAt: expiresAt,
      scopes: tokens.scope ?? GMAIL_SCOPES.join(' '),
      status: 'active'
    })
    .returning()
  try {
    await syncSendAsDisplayName(
      tokens.access_token,
      created.email,
      created.displayName ?? info.name ?? null
    )
  } catch (err) {
    console.warn(
      `[gmail] sendAs displayName sync failed on connect for ${created.email}:`,
      err instanceof Error ? err.message : err
    )
  }
  return { mailbox: created, alreadyExisted: false }
}

async function refreshAccessToken(mailbox: Mailbox): Promise<Mailbox> {
  if (!mailbox.oauthRefreshToken) {
    throw new Error(`Mailbox ${mailbox.email} has no refresh token; reconnect required.`)
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
      refresh_token: mailbox.oauthRefreshToken
    }).toString()
  })
  if (!res.ok) {
    throw new Error(`Google refresh failed (${res.status}): ${await res.text()}`)
  }
  const payload = (await res.json()) as TokenResponse
  const expiresAt = new Date(Date.now() + payload.expires_in * 1000)
  const [updated] = await db
    .update(mailboxes)
    .set({
      oauthAccessToken: payload.access_token,
      oauthExpiresAt: expiresAt,
      updatedAt: new Date()
    })
    .where(eq(mailboxes.id, mailbox.id))
    .returning()
  return updated
}

/**
 * Returns a valid access token for the mailbox, refreshing the stored
 * one (and updating the row) if it's within the slack window.
 */
export async function getValidAccessToken(mailbox: Mailbox): Promise<{
  accessToken: string
  mailbox: Mailbox
}> {
  const now = Date.now()
  const expiresAt = mailbox.oauthExpiresAt?.getTime() ?? 0
  if (mailbox.oauthAccessToken && expiresAt - now > ACCESS_TOKEN_REFRESH_SLACK_MS) {
    return { accessToken: mailbox.oauthAccessToken, mailbox }
  }
  const refreshed = await refreshAccessToken(mailbox)
  if (!refreshed.oauthAccessToken) {
    throw new Error(`Mailbox ${mailbox.email} refresh produced no access token.`)
  }
  return { accessToken: refreshed.oauthAccessToken, mailbox: refreshed }
}

export async function getMailbox(id: string): Promise<Mailbox | null> {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1)
  return row ?? null
}
