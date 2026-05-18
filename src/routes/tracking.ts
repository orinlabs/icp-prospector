import { Hono } from 'hono'

import { TRANSPARENT_GIF } from '../lib/emailTracking/pixel.js'
import { recordEmailOpen } from '../lib/emailTracking/recordOpen.js'

export const trackingRoutes = new Hono()

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return c.req.header('x-real-ip') ?? c.req.header('cf-connecting-ip') ?? null
}

trackingRoutes.get('/pixel/:token', async (c) => {
  const raw = c.req.param('token')
  const token = decodeURIComponent(raw).replace(/\.gif$/i, '')

  try {
    await recordEmailOpen({
      token,
      userAgent: c.req.header('user-agent') ?? null,
      clientIp: clientIp(c)
    })
  } catch (err) {
    console.error('[tracking] record open failed:', err instanceof Error ? err.message : err)
  }

  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0',
      'Content-Length': String(TRANSPARENT_GIF.length)
    }
  })
})
