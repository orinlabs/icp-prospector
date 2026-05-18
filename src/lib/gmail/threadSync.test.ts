import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyInboundMessage, normalizeEmailAddress } from './threadSync.js'

describe('normalizeEmailAddress', () => {
  it('extracts address from display name form', () => {
    assert.equal(normalizeEmailAddress('Jane Doe <jane@acme.com>'), 'jane@acme.com')
  })
})

describe('classifyInboundMessage', () => {
  it('detects mailer-daemon bounces', () => {
    assert.equal(
      classifyInboundMessage({
        fromEmail: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Failure)',
        recipientEmail: 'ceo@acme.com'
      }),
      'bounce'
    )
  })

  it('detects replies from the prospect address', () => {
    assert.equal(
      classifyInboundMessage({
        fromEmail: 'ceo@acme.com',
        subject: 'Re: Quick question',
        recipientEmail: 'ceo@acme.com'
      }),
      'reply'
    )
  })

  it('ignores unrelated participants', () => {
    assert.equal(
      classifyInboundMessage({
        fromEmail: 'assistant@acme.com',
        subject: 'Re: Quick question',
        recipientEmail: 'ceo@acme.com'
      }),
      'other'
    )
  })
})
