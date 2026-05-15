import { randomBytes } from 'node:crypto'

import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { db } from '../db/client.js'
import { mailboxes } from '../db/schema.js'
import { buildConsentUrl, connectMailboxFromCode } from '../lib/gmail/oauth.js'
import type { AppVariables } from '../lib/orgs.js'

export const mailboxesRoutes = new Hono<{ Variables: AppVariables }>()
const oauthStates = new Map<string, { userId: string; organizationId: string; expiresAt: number }>()

const patchSchema = z
  .object({
    displayName: z.union([z.string().min(1).max(120), z.null()]).optional(),
    signature: z.string().max(4000).optional(),
    senderBio: z.string().max(4000).optional(),
    outreachEmailInstructions: z.string().max(24_000).nullable().optional()
  })
  .superRefine((data, ctx) => {
    if (data.senderBio !== undefined) {
      const t = data.senderBio.trim()
      if (t.length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'senderBio must be at least 20 non-whitespace characters',
          path: ['senderBio']
        })
      }
    }
  })

function redact<T extends { oauthRefreshToken?: string | null; oauthAccessToken?: string | null }>(
  m: T
): Omit<T, 'oauthRefreshToken' | 'oauthAccessToken'> & {
  hasRefreshToken: boolean
  hasAccessToken: boolean
} {
  const { oauthRefreshToken, oauthAccessToken, ...rest } = m
  return {
    ...rest,
    hasRefreshToken: Boolean(oauthRefreshToken),
    hasAccessToken: Boolean(oauthAccessToken)
  }
}

mailboxesRoutes.get('/', async (c) => {
  const organizationId = c.get('organization').id
  const rows = await db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.organizationId, organizationId))
    .orderBy(desc(mailboxes.createdAt))
  return c.json(rows.map(redact))
})

mailboxesRoutes.post('/oauth/start', (c) => {
  const user = c.get('user')
  const organizationId = c.get('organization').id
  let consentUrl: string
  try {
    const state = randomBytes(16).toString('hex')
    oauthStates.set(state, { userId: user.id, organizationId, expiresAt: Date.now() + 10 * 60 * 1000 })
    consentUrl = buildConsentUrl(state)
    return c.json({ consentUrl, state })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to build consent URL' },
      500
    )
  }
})

mailboxesRoutes.get('/oauth/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')
  if (error) {
    return c.html(callbackHtml({ ok: false, message: `Google OAuth error: ${error}` }), 400)
  }
  if (!code) {
    return c.html(callbackHtml({ ok: false, message: 'Missing ?code in callback URL.' }), 400)
  }
  const oauthState = state ? oauthStates.get(state) : undefined
  if (!state || !oauthState || oauthState.expiresAt < Date.now()) {
    return c.html(callbackHtml({ ok: false, message: 'Missing or expired OAuth state.' }), 400)
  }
  oauthStates.delete(state)
  try {
    const result = await connectMailboxFromCode(code, oauthState.organizationId)
    return c.html(
      callbackHtml({
        ok: true,
        mailboxId: result.mailbox.id,
        message: `Connected ${result.mailbox.email}${
          result.alreadyExisted ? ' (refreshed existing connection)' : ''
        }.`
      })
    )
  } catch (err) {
    return c.html(
      callbackHtml({
        ok: false,
        message: err instanceof Error ? err.message : 'OAuth exchange failed'
      }),
      500
    )
  }
})

mailboxesRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const parsed = patchSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const senderBioPatch =
    parsed.data.senderBio !== undefined ? { senderBio: parsed.data.senderBio.trim() } : {}
  const [updated] = await db
    .update(mailboxes)
    .set({
      ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
      ...(parsed.data.signature !== undefined ? { signature: parsed.data.signature } : {}),
      ...senderBioPatch,
      ...(parsed.data.outreachEmailInstructions !== undefined
        ? { outreachEmailInstructions: parsed.data.outreachEmailInstructions }
        : {}),
      updatedAt: new Date()
    })
    .where(and(eq(mailboxes.id, id), eq(mailboxes.organizationId, organizationId)))
    .returning()
  if (!updated) return c.json({ error: 'not found' }, 404)
  return c.json(redact(updated))
})

mailboxesRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const organizationId = c.get('organization').id
  const [updated] = await db
    .update(mailboxes)
    .set({
      status: 'revoked',
      oauthAccessToken: null,
      oauthRefreshToken: null,
      updatedAt: new Date()
    })
    .where(and(eq(mailboxes.id, id), eq(mailboxes.organizationId, organizationId)))
    .returning()
  if (!updated) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true, mailbox: redact(updated) })
})

function callbackHtml(opts: { ok: boolean; message: string; mailboxId?: string }): string {
  const heading = opts.ok ? 'Mailbox connected' : 'Connection failed'
  const subheading = opts.ok
    ? 'You can close this window and return to the app.'
    : 'You can close this window and try again from the Mailboxes page.'
  const tone = opts.ok ? '#16a34a' : '#dc2626'
  const postMessagePayload = JSON.stringify(
    opts.ok && opts.mailboxId
      ? { type: 'mailbox-oauth', ok: true as const, mailboxId: opts.mailboxId }
      : { type: 'mailbox-oauth', ok: opts.ok as boolean }
  )
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${heading}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system; background:#0b0b0c; color:#f8fafc; margin:0; min-height:100vh; display:grid; place-items:center; }
  .card { max-width:480px; padding:32px; border-radius:14px; background:#111114; border:1px solid #1f1f24; box-shadow:0 8px 32px rgba(0,0,0,.4); }
  h1 { margin:0 0 8px; font-size:18px; color:${tone}; }
  p { margin:0 0 6px; color:#cbd5e1; font-size:14px; line-height:1.6; }
  pre { margin-top:14px; padding:12px; border-radius:8px; background:#0b0b0c; border:1px solid #1f1f24; white-space:pre-wrap; word-break:break-word; font-size:12px; color:#e2e8f0; }
  button { margin-top:18px; padding:8px 14px; border-radius:8px; border:1px solid #2d2d33; background:#1f1f24; color:#f8fafc; font-size:13px; cursor:pointer; }
  button:hover { background:#2d2d33; }
</style></head>
<body><div class="card">
  <h1>${heading}</h1>
  <p>${subheading}</p>
  <pre>${escapeHtml(opts.message)}</pre>
  <button onclick="window.close()">Close window</button>
</div>
<script>
  try { if (window.opener) { window.opener.postMessage(${postMessagePayload}, '*'); } } catch (_) {}
</script>
</body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
