import assert from 'node:assert/strict'
import test from 'node:test'

import { isOrganizationSetupApiPath } from './authPaths.js'
import { domainMatchesEmail, emailDomain, normalizeDomain, slugifyOrgName } from './orgs.js'

test('normalizes claimed organization domains before matching user emails', () => {
  assert.equal(normalizeDomain(' HTTPS://WWW.Example.COM/path '), 'example.com')
  assert.equal(emailDomain('USER@Example.COM'), 'example.com')
  assert.equal(domainMatchesEmail('user@example.com', 'https://www.example.com'), true)
  assert.equal(domainMatchesEmail('user@other.com', 'example.com'), false)
})

test('keeps org setup routes accessible before a user has an active organization', () => {
  assert.equal(isOrganizationSetupApiPath('/organizations'), true)
  assert.equal(isOrganizationSetupApiPath('/organizations/switch'), true)
  assert.equal(isOrganizationSetupApiPath('/organizations/invites/token/accept'), true)
  assert.equal(isOrganizationSetupApiPath('/companies'), false)
})

test('builds stable organization slugs from display names', () => {
  assert.equal(slugifyOrgName('Acme, Inc.'), 'acme-inc')
  assert.equal(slugifyOrgName('  '), 'organization')
})
