import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { injectTrackingPixel, trackingPixelUrl } from './pixel.js'

describe('injectTrackingPixel', () => {
  const prev = process.env.TRACKING_PUBLIC_BASE_URL

  before(() => {
    process.env.TRACKING_PUBLIC_BASE_URL = 'https://api.example.com'
  })

  after(() => {
    if (prev === undefined) delete process.env.TRACKING_PUBLIC_BASE_URL
    else process.env.TRACKING_PUBLIC_BASE_URL = prev
  })

  it('appends pixel to existing HTML', () => {
    const html = '<html><body><p>Hi</p></body></html>'
    const out = injectTrackingPixel(html, 'plain fallback', 'tok_abc')
    assert.match(out, /<img[^>]+src="https:\/\/api\.example\.com\/t\/pixel\/tok_abc\.gif"/)
    assert.match(out, /<\/body>/)
    const bodyIdx = out.indexOf('<img')
    const closeIdx = out.indexOf('</body>')
    assert.ok(bodyIdx > 0 && closeIdx > bodyIdx)
  })

  it('wraps plain body when html is missing', () => {
    const out = injectTrackingPixel(null, 'Line one\n\nLine two', 'tok_xyz')
    assert.match(out, /<p>Line one<\/p>/)
    assert.ok(out.includes(trackingPixelUrl('tok_xyz')))
  })
})
