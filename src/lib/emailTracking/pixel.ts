import { createHash, randomBytes } from 'node:crypto'

/** 1×1 transparent GIF (43 bytes). */
export const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
)

export function createTrackingToken(): string {
  return randomBytes(24).toString('base64url')
}

export function trackingPublicBaseUrl(): string {
  const raw = process.env.TRACKING_PUBLIC_BASE_URL?.trim()
  if (!raw) {
    throw new Error(
      'TRACKING_PUBLIC_BASE_URL is required for email open tracking (e.g. https://api.example.com)'
    )
  }
  return raw.replace(/\/+$/, '')
}

export function trackingPixelUrl(token: string): string {
  return `${trackingPublicBaseUrl()}/t/pixel/${encodeURIComponent(token)}.gif`
}

export function hashClientIp(ip: string | null | undefined): string | null {
  const trimmed = ip?.trim()
  if (!trimmed) return null
  const salt = process.env.TRACKING_IP_HASH_SALT?.trim() ?? 'flash-tracking'
  return createHash('sha256').update(`${salt}:${trimmed}`).digest('hex').slice(0, 32)
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Appends a tracking pixel to HTML. If body is plain text only, wraps it in minimal HTML first.
 */
export function injectTrackingPixel(html: string | null, plainBody: string, token: string): string {
  const pixelUrl = trackingPixelUrl(token)
  const pixelTag =
    `<img src="${escapeHtmlAttr(pixelUrl)}" width="1" height="1" alt="" ` +
    'style="display:block;width:1px;height:1px;border:0;margin:0;padding:0" ' +
    'role="presentation" />'

  const baseHtml =
    html?.trim() ||
    `<div style="font-family:sans-serif;font-size:14px;line-height:1.5">${plainBody
      .split('\n')
      .map((line) => (line.trim() ? `<p>${escapeHtmlAttr(line)}</p>` : '<br />'))
      .join('')}</div>`

  // Insert before closing body if present, else append.
  const lower = baseHtml.toLowerCase()
  const bodyClose = lower.lastIndexOf('</body>')
  if (bodyClose >= 0) {
    return baseHtml.slice(0, bodyClose) + pixelTag + baseHtml.slice(bodyClose)
  }
  return baseHtml + pixelTag
}
