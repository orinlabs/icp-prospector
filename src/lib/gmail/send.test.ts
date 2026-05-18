import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildRfc5322 } from './send.js'

describe('buildRfc5322', () => {
  it('omits From so Gmail applies send-as display name', () => {
    const raw = buildRfc5322({
      to: 'bryan@learnwithorin.com',
      subject: 'Hello',
      body: 'Test body',
      bodyHtml: null
    })
    assert.ok(!/^From:/im.test(raw), 'raw MIME must not set From header')
    assert.match(raw, /^To: bryan@learnwithorin\.com/m)
    assert.match(raw, /^Subject: Hello/m)
    assert.match(raw, /Test body/)
  })
})
