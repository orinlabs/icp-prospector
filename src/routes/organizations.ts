import { and, eq, gt, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { db } from '../db/client.js'
import {
  organizationInvites,
  organizationMemberships,
  organizations
} from '../db/schema.js'
import { normalizeAppEmail, randomSessionToken, sha256Hex } from '../lib/authApp.js'
import {
  domainMatchesEmail,
  emailDomain,
  hasClaimedDomain,
  normalizeDomain,
  setSessionActiveOrganization,
  slugifyOrgName,
  type AppVariables
} from '../lib/orgs.js'

export const organizationsRoutes = new Hono<{ Variables: AppVariables }>()

const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  emailDomain: z.string().trim().min(3).max(253)
})

const switchOrganizationSchema = z.object({
  organizationId: z.string().uuid()
})

const createInviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).optional().default('member')
})

async function uniqueSlug(name: string): Promise<string> {
  const base = slugifyOrgName(name)
  let slug = base
  for (let i = 2; i < 100; i += 1) {
    const [existing] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1)
    if (!existing) return slug
    slug = base + '-' + i
  }
  return base + '-' + Date.now()
}

function serializeOrgMembership(row: {
  id: string
  name: string
  slug: string
  emailDomain: string
  role: string
}) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    emailDomain: row.emailDomain,
    role: row.role
  }
}

organizationsRoutes.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      emailDomain: organizations.emailDomain,
      role: organizationMemberships.role
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(eq(organizationMemberships.userId, user.id), eq(organizationMemberships.status, 'active'))
    )
  return c.json({ data: rows.map(serializeOrgMembership) })
})

organizationsRoutes.post('/', async (c) => {
  const user = c.get('user')
  const parsed = createOrganizationSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const domain = normalizeDomain(parsed.data.emailDomain)
  if (!domainMatchesEmail(user.email, domain)) {
    return c.json({ error: 'organization domain must match your email domain' }, 400)
  }
  if (await hasClaimedDomain(domain)) {
    return c.json({ error: 'domain already has an organization' }, 409)
  }

  const slug = await uniqueSlug(parsed.data.name)
  const [org] = await db
    .insert(organizations)
    .values({
      name: parsed.data.name,
      slug,
      emailDomain: domain,
      createdByUserId: user.id
    })
    .returning()

  await db.insert(organizationMemberships).values({
    organizationId: org.id,
    userId: user.id,
    role: 'owner',
    status: 'active'
  })
  await setSessionActiveOrganization(c, org.id)

  return c.json(
    {
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        emailDomain: org.emailDomain,
        role: 'owner'
      }
    },
    201
  )
})

organizationsRoutes.post('/switch', async (c) => {
  const user = c.get('user')
  const parsed = switchOrganizationSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const [membership] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      emailDomain: organizations.emailDomain,
      role: organizationMemberships.role
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(
        eq(organizationMemberships.userId, user.id),
        eq(organizationMemberships.organizationId, parsed.data.organizationId),
        eq(organizationMemberships.status, 'active')
      )
    )
    .limit(1)
  if (!membership) return c.json({ error: 'organization not found' }, 404)

  await setSessionActiveOrganization(c, membership.id)
  return c.json({ activeOrganization: serializeOrgMembership(membership) })
})

organizationsRoutes.post('/:id/invites', async (c) => {
  const user = c.get('user')
  const activeOrg = c.get('organization')
  const id = c.req.param('id')
  if (id !== activeOrg.id) return c.json({ error: 'organization not found' }, 404)

  const [adminMembership] = await db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, id),
        eq(organizationMemberships.userId, user.id),
        eq(organizationMemberships.status, 'active')
      )
    )
    .limit(1)
  if (!adminMembership || !['owner', 'admin'].includes(adminMembership.role)) {
    return c.json({ error: 'forbidden' }, 403)
  }

  const parsed = createInviteSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const email = normalizeAppEmail(parsed.data.email)
  if (!domainMatchesEmail(email, activeOrg.emailDomain)) {
    return c.json({ error: 'invite email must match organization domain' }, 400)
  }

  const rawToken = randomSessionToken()
  const [invite] = await db
    .insert(organizationInvites)
    .values({
      organizationId: id,
      email,
      role: parsed.data.role,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      createdByUserId: user.id
    })
    .returning()

  return c.json({
    invite: {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt
    },
    token: rawToken
  })
})

organizationsRoutes.post('/invites/:token/accept', async (c) => {
  const user = c.get('user')
  const token = c.req.param('token')
  const [invite] = await db
    .select({
      id: organizationInvites.id,
      email: organizationInvites.email,
      role: organizationInvites.role,
      organizationId: organizationInvites.organizationId,
      emailDomain: organizations.emailDomain
    })
    .from(organizationInvites)
    .innerJoin(organizations, eq(organizations.id, organizationInvites.organizationId))
    .where(
      and(
        eq(organizationInvites.tokenHash, sha256Hex(token)),
        gt(organizationInvites.expiresAt, new Date()),
        sql`${organizationInvites.acceptedAt} is null`
      )
    )
    .limit(1)
  if (!invite) return c.json({ error: 'invalid or expired invite' }, 404)
  if (normalizeAppEmail(user.email) !== normalizeAppEmail(invite.email)) {
    return c.json({ error: 'invite email does not match signed-in user' }, 403)
  }
  if (emailDomain(user.email) !== normalizeDomain(invite.emailDomain)) {
    return c.json({ error: 'invite domain does not match signed-in user' }, 403)
  }

  await db
    .insert(organizationMemberships)
    .values({
      organizationId: invite.organizationId,
      userId: user.id,
      role: invite.role,
      status: 'active'
    })
    .onConflictDoUpdate({
      target: [organizationMemberships.organizationId, organizationMemberships.userId],
      set: { role: invite.role, status: 'active', updatedAt: new Date() }
    })
  await db
    .update(organizationInvites)
    .set({ acceptedAt: new Date() })
    .where(eq(organizationInvites.id, invite.id))
  await setSessionActiveOrganization(c, invite.organizationId)

  return c.json({ ok: true, organizationId: invite.organizationId })
})
