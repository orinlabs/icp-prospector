import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatFromHeader } from './sendAs.js'
import { buildRfc5322 } from './send.js'

describe('buildRfc5322', () => {
  it('sets quoted From when a display name is provided', () => {
    const raw = buildRfc5322({
      from: 'bryan@orinlabs.ai',
      fromDisplay: 'Bryan Houlton',
      to: 'bryan@learnwithorin.com',
      subject: 'Hello',
      body: 'Test body',
      bodyHtml: null
    })
    assert.match(raw, /^From: "Bryan Houlton" <bryan@orinlabs\.ai>/m)
    assert.match(raw, /^To: bryan@learnwithorin\.com/m)
    assert.match(raw, /Test body/)
  })

  it('uses bare email when display name is missing', () => {
    const raw = buildRfc5322({
      from: 'bryan@orinlabs.ai',
      fromDisplay: null,
      to: 'bryan@learnwithorin.com',
      subject: 'Hello',
      body: 'Test body',
      bodyHtml: null
    })
    assert.match(raw, /^From: bryan@orinlabs\.ai/m)
  })
})

describe('formatFromHeader', () => {
  it('escapes quotes in display names', () => {
    assert.equal(formatFromHeader('a@b.com', 'Bryan "BH" Houlton'), '"Bryan \\"BH\\" Houlton" <a@b.com>')
  })
})
