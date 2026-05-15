import { and, eq, sql } from 'drizzle-orm'
import type { Context } from 'hono'

import { db } from '../db/client.js'
import {
  appSessions,
  organizationMemberships,
  organizations,
  type Organization,
  type OrganizationMembership
} from '../db/schema.js'
import { getCookie } from 'hono/cookie'
import { normalizeAppEmail, sha256Hex } from './authApp.js'

const SESSION_COOKIE_NAME = 'flash_session'

export type AuthUser = { id: string; email: string }
export type AuthOrganization = Pick<Organization, 'id' | 'name' | 'slug' | 'emailDomain'>
export type AuthMembership = Pick<OrganizationMembership, 'role' | 'status'> & {
  organization: AuthOrganization
}
export type AppVariables = {
  user: AuthUser
  organization: AuthOrganization
  memberships: AuthMembership[]
}

export function emailDomain(email: string): string | null {
  const normalized = normalizeAppEmail(email)
  const parts = normalized.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return parts[1]
}

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
}

export function domainMatchesEmail(email: string, domain: string): boolean {
  return emailDomain(email) === normalizeDomain(domain)
}

export function slugifyOrgName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'organization'
}

export async function listActiveMemberships(userId: string): Promise<AuthMembership[]> {
  const rows = await db
    .select({
      role: organizationMemberships.role,
      status: organizationMemberships.status,
      organization: {
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        emailDomain: organizations.emailDomain
      }
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, 'active'))
    )
    .orderBy(organizations.createdAt)

  return rows
}

export function chooseActiveOrganization(
  memberships: AuthMembership[],
  requestedOrganizationId?: string | null
): AuthOrganization | null {
  if (memberships.length === 0) return null
  if (requestedOrganizationId) {
    const match = memberships.find((membership) => membership.organization.id === requestedOrganizationId)
    if (match) return match.organization
  }
  return memberships[0].organization
}

export async function setSessionActiveOrganization(c: Context, organizationId: string | null): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE_NAME)
  if (!token) return
  await db
    .update(appSessions)
    .set({ activeOrganizationId: organizationId })
    .where(eq(appSessions.tokenHash, sha256Hex(token)))
}

export async function hasClaimedDomain(domain: string): Promise<boolean> {
  const normalized = normalizeDomain(domain)
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(sql`lower(${organizations.emailDomain}) = ${normalized}`)
    .limit(1)
  return Boolean(row)
}
