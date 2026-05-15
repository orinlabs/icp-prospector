import { and, desc, eq, gt, lt } from 'drizzle-orm'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'

import { db } from '../db/client.js'
import { appSessions, appUsers, emailLoginChallenges } from '../db/schema.js'
import {
  assertValidAppEmail,
  normalizeAppEmail,
  randomLoginCode,
  randomSessionToken,
  secureCompareHex,
  sha256Hex
} from '../lib/authApp.js'
import {
  chooseActiveOrganization,
  emailDomain,
  hasClaimedDomain,
  listActiveMemberships,
  setSessionActiveOrganization
} from '../lib/orgs.js'
import { sendOrinlabsLoginCode } from '../lib/sendLoginCodeEmail.js'

export const SESSION_COOKIE_NAME = 'flash_session'

const requestCodeSchema = z.object({
  email: z.string().min(3).max(320)
})

const verifyCodeSchema = z.object({
  email: z.string().min(3).max(320),
  code: z.string().regex(/^\d{6}$/)
})

const CODE_TTL_MS = 15 * 60 * 1000
const MIN_RESEND_MS = 5 * 1000

const lastCodeRequestAt = new Map<string, number>()

function sessionTtlMs(): number {
  const days = Number(process.env.AUTH_SESSION_DAYS ?? '30')
  const safe = Number.isFinite(days) && days > 0 && days <= 365 ? days : 30
  return safe * 24 * 60 * 60 * 1000
}

/**
 * Session cookie SameSite policy:
 * - **Development** (`NODE_ENV !== 'production'`): `Lax` + no Secure flag so http://localhost
 *   (e.g. Vite → API proxy) still receives the cookie on same-site `/api/*` fetches.
 * - **Production**: `None` + `Secure` so the cookie is sent on credentialed fetches from a
 *   separate SPA origin (static site → API). `Lax` would omit the cookie on those requests,
 *   causing 401 on `/campaigns` etc. and immediate logout after a successful verify-code.
 */
function cookieBaseOptions(): {
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'Lax' | 'None'
  maxAge: number
} {
  const maxAge = Math.floor(sessionTtlMs() / 1000)
  const prod = process.env.NODE_ENV === 'production'
  if (prod) {
    return {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge
    }
  }
  return {
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
    maxAge
  }
}

function sessionCookieClearOptions(): { path: string; secure: boolean; sameSite: 'Lax' | 'None' } {
  const o = cookieBaseOptions()
  return { path: o.path, secure: o.secure, sameSite: o.sameSite }
}

export const authRoutes = new Hono()

authRoutes.get('/me', async (c) => {
  const row = await sessionUserFromRequest(c)
  if (!row) {
    return c.json({ user: null })
  }
  const memberships = await listActiveMemberships(row.userId)
  const activeOrganization = chooseActiveOrganization(memberships, row.activeOrganizationId)
  const domain = emailDomain(row.email)
  const domainClaimed = domain ? await hasClaimedDomain(domain) : false
  if (activeOrganization?.id !== row.activeOrganizationId) {
    await setSessionActiveOrganization(c, activeOrganization?.id ?? null)
  }
  return c.json({
    user: { id: row.userId, email: row.email },
    organizations: memberships.map((membership) => ({
      ...membership.organization,
      role: membership.role
    })),
    activeOrganization,
    domainClaimed,
    needsOrganizationSetup: memberships.length === 0 && !domainClaimed
  })
})

authRoutes.post('/request-code', async (c) => {
  const parsed = requestCodeSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  let email: string
  try {
    assertValidAppEmail(parsed.data.email)
    email = normalizeAppEmail(parsed.data.email)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid email'
    return c.json({ error: message }, 400)
  }

  const now = Date.now()
  const last = lastCodeRequestAt.get(email) ?? 0
  if (now - last < MIN_RESEND_MS) {
    return c.json({ error: 'Please wait before requesting another code.' }, 429)
  }
  lastCodeRequestAt.set(email, now)

  await db.delete(emailLoginChallenges).where(eq(emailLoginChallenges.email, email))
  await db.delete(emailLoginChallenges).where(lt(emailLoginChallenges.expiresAt, new Date()))

  const code = randomLoginCode()
  const codeHash = sha256Hex(code)
  const expiresAt = new Date(now + CODE_TTL_MS)

  await db.insert(emailLoginChallenges).values({
    email,
    codeHash,
    expiresAt
  })

  try {
    await sendOrinlabsLoginCode(email, code)
  } catch (err) {
    await db.delete(emailLoginChallenges).where(eq(emailLoginChallenges.email, email))
    const message = err instanceof Error ? err.message : 'Failed to send email'
    console.error('[auth] send code failed:', message)
    return c.json({ error: message }, 500)
  }

  return c.json({ ok: true })
})

authRoutes.post('/verify-code', async (c) => {
  const parsed = verifyCodeSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  let email: string
  try {
    assertValidAppEmail(parsed.data.email)
    email = normalizeAppEmail(parsed.data.email)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid email'
    return c.json({ error: message }, 400)
  }

  const submittedHash = sha256Hex(parsed.data.code)

  const [challenge] = await db
    .select()
    .from(emailLoginChallenges)
    .where(
      and(eq(emailLoginChallenges.email, email), gt(emailLoginChallenges.expiresAt, new Date()))
    )
    .orderBy(desc(emailLoginChallenges.createdAt))
    .limit(1)

  if (!challenge || !secureCompareHex(challenge.codeHash, submittedHash)) {
    return c.json({ error: 'Invalid or expired code' }, 400)
  }

  await db.delete(emailLoginChallenges).where(eq(emailLoginChallenges.email, email))

  let [user] = await db.select().from(appUsers).where(eq(appUsers.email, email))
  if (!user) {
    ;[user] = await db.insert(appUsers).values({ email }).returning()
  }

  const loginAt = new Date()
  await db.update(appUsers).set({ lastLoginAt: loginAt }).where(eq(appUsers.id, user.id))

  const rawToken = randomSessionToken()
  const tokenHash = sha256Hex(rawToken)
  const sessionExpires = new Date(Date.now() + sessionTtlMs())

  const memberships = await listActiveMemberships(user.id)
  const activeOrganization = chooseActiveOrganization(memberships)
  const domain = emailDomain(user.email)
  const domainClaimed = domain ? await hasClaimedDomain(domain) : false

  await db.insert(appSessions).values({
    userId: user.id,
    tokenHash,
    activeOrganizationId: activeOrganization?.id,
    expiresAt: sessionExpires
  })

  setCookie(c, SESSION_COOKIE_NAME, rawToken, cookieBaseOptions())

  return c.json({
    user: { id: user.id, email: user.email },
    organizations: memberships.map((membership) => ({
      ...membership.organization,
      role: membership.role
    })),
    activeOrganization,
    domainClaimed,
    needsOrganizationSetup: memberships.length === 0 && !domainClaimed
  })
})

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE_NAME)
  if (token) {
    await db.delete(appSessions).where(eq(appSessions.tokenHash, sha256Hex(token)))
  }
  deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieClearOptions())
  return c.json({ ok: true })
})

export async function sessionUserFromRequest(
  c: Context
): Promise<{ userId: string; email: string; activeOrganizationId: string | null } | null> {
  const token = getCookie(c, SESSION_COOKIE_NAME)
  if (!token) return null
  const tokenHash = sha256Hex(token)
  const now = new Date()
  const [row] = await db
    .select({
      userId: appUsers.id,
      email: appUsers.email,
      activeOrganizationId: appSessions.activeOrganizationId,
      expiresAt: appSessions.expiresAt
    })
    .from(appSessions)
    .innerJoin(appUsers, eq(appSessions.userId, appUsers.id))
    .where(eq(appSessions.tokenHash, tokenHash))
    .limit(1)
  if (!row || row.expiresAt.getTime() <= now.getTime()) {
    return null
  }
  return { userId: row.userId, email: row.email, activeOrganizationId: row.activeOrganizationId }
}
