import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateExaContentsCostUsd, estimateExaSearchCostUsd } from './pricing.js'

test('estimates Exa search with separately billed AI summaries', () => {
  assert.equal(
    estimateExaSearchCostUsd({
      requestedResults: 10,
      returnedResults: 10,
      includesSummary: true
    }),
    0.017
  )
})

test('estimates Exa search extra result charges above the included first ten', () => {
  assert.equal(
    estimateExaSearchCostUsd({
      requestedResults: 12,
      returnedResults: 12,
      includesSummary: false
    }),
    0.009000000000000001
  )
})

test('estimates Exa contents per page and requested content type', () => {
  assert.equal(estimateExaContentsCostUsd({ pages: 2, contentTypes: 2, summaries: 1 }), 0.005)
})
