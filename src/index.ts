import 'dotenv/config'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'node:path'

import { db, pool } from './db/client.js'
import { isAuthPublicApiPath, isOrganizationSetupApiPath } from './lib/authPaths.js'
import {
  chooseActiveOrganization,
  listActiveMemberships,
  setSessionActiveOrganization,
  type AppVariables
} from './lib/orgs.js'
import { authRoutes, sessionUserFromRequest } from './routes/auth.js'
import { campaignsRoutes } from './routes/campaigns.js'
import { companiesRoutes } from './routes/companies.js'
import { draftsRoutes } from './routes/drafts.js'
import { listsRoutes } from './routes/lists.js'
import { mailboxesRoutes } from './routes/mailboxes.js'
import { organizationsRoutes } from './routes/organizations.js'
import { peopleRoutes } from './routes/people.js'
import { usageRoutes } from './routes/usage.js'
import { trackingRoutes } from './routes/tracking.js'

const app = new Hono<{ Variables: AppVariables }>()

const allowedOrigins = (
  process.env.AUTH_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

app.route('/t', trackingRoutes)

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) {
        return allowedOrigins[0] ?? true
      }
      return allowedOrigins.includes(origin) ? origin : null
    },
    credentials: true
  })
)

app.use('*', async (c, next) => {
  if (isAuthPublicApiPath(c.req.path)) {
    await next()
    return
  }
  const row = await sessionUserFromRequest(c)
  if (!row) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  c.set('user', { id: row.userId, email: row.email })
  const memberships = await listActiveMemberships(row.userId)
  c.set('memberships', memberships)
  const activeOrganization = chooseActiveOrganization(memberships, row.activeOrganizationId)
  if (activeOrganization?.id !== row.activeOrganizationId) {
    await setSessionActiveOrganization(c, activeOrganization?.id ?? null)
  }
  if (!activeOrganization) {
    if (isOrganizationSetupApiPath(c.req.path)) {
      await next()
      return
    }
    return c.json({ error: 'organization_required' }, 403)
  }
  c.set('organization', activeOrganization)
  await next()
})

app.get('/health', (c) => c.json({ ok: true, service: 'flash-api' }))

app.get('/ready', async (c) => {
  if (!process.env.DATABASE_URL) {
    return c.json({ ok: false, reason: 'DATABASE_URL not set' }, 503)
  }
  try {
    await db.execute(sql`select 1`)
    return c.json({ ok: true, database: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error'
    return c.json({ ok: false, database: false, message }, 503)
  }
})

app.route('/auth', authRoutes)
app.route('/campaigns', campaignsRoutes)
app.route('/companies', companiesRoutes)
app.route('/drafts', draftsRoutes)
app.route('/lists', listsRoutes)
app.route('/mailboxes', mailboxesRoutes)
app.route('/organizations', organizationsRoutes)
app.route('/people', peopleRoutes)
app.route('/usage', usageRoutes)

async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn('Skipping migrations: DATABASE_URL not set')
    return
  }
  const folder = path.join(process.cwd(), 'drizzle')
  await migrate(db, { migrationsFolder: folder })
  console.log('Migrations applied from', folder)
}

const port = Number(process.env.PORT) || 3000

runMigrations()
  .then(() => {
    serve({ fetch: app.fetch, port })
    console.log(`API listening on ${port}`)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

const shutdown = async () => {
  await pool.end()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
