/**
 * Rough USD pricing used as a fallback when a provider does not return cost in
 * its response. These are intentionally a single source of truth so the user
 * can adjust them in one place.
 *
 * OpenRouter pricing is per 1M tokens. Exa pricing is per single API call /
 * per result, depending on the operation. Numbers are best-effort estimates
 * and should be treated as approximate.
 */

export type ModelPricing = {
  inputPerMillion: number
  outputPerMillion: number
}

const DEFAULT_MODEL_PRICING: ModelPricing = {
  inputPerMillion: 0.5,
  outputPerMillion: 2.0
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'openai/gpt-5-mini': { inputPerMillion: 0.25, outputPerMillion: 2.0 },
  'openai/gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10.0 },
  'openai/gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'openai/gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  'anthropic/claude-3.5-sonnet': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'anthropic/claude-3.5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4.0 }
}

export function getModelPricing(model: string | null | undefined): ModelPricing {
  if (!model) return DEFAULT_MODEL_PRICING
  return MODEL_PRICING[model] ?? DEFAULT_MODEL_PRICING
}

export function estimateChatCostUsd(
  model: string | null | undefined,
  promptTokens: number,
  completionTokens: number
): number {
  const p = getModelPricing(model)
  const inputCost = (promptTokens / 1_000_000) * p.inputPerMillion
  const outputCost = (completionTokens / 1_000_000) * p.outputPerMillion
  return inputCost + outputCost
}

/**
 * Exa API pricing as of 2026-05:
 *  - Search: $7 per 1k requests, including up to 10 results with text/highlights.
 *  - Additional search results above 10: $1 per 1k results.
 *  - AI page summaries: $1 per 1k pages, billed separately.
 *  - Contents: $1 per 1k pages per requested content type.
 *
 * These are fallback estimates for visibility when Exa does not return cost.
 */
export const EXA_SEARCH_REQUEST_COST_USD = 0.007
export const EXA_ADDITIONAL_SEARCH_RESULT_COST_USD = 0.001
export const EXA_AI_SUMMARY_COST_USD = 0.001
export const EXA_CONTENTS_PAGE_CONTENT_TYPE_COST_USD = 0.001

export function estimateExaSearchCostUsd(input: {
  requestedResults: number
  returnedResults: number
  includesSummary: boolean
}): number {
  const requestedResults = Math.max(0, Math.floor(input.requestedResults))
  const returnedResults = Math.max(0, Math.floor(input.returnedResults))
  const additionalResults = Math.max(0, requestedResults - 10)
  const summaryPages = input.includesSummary ? returnedResults : 0

  return (
    EXA_SEARCH_REQUEST_COST_USD +
    additionalResults * EXA_ADDITIONAL_SEARCH_RESULT_COST_USD +
    summaryPages * EXA_AI_SUMMARY_COST_USD
  )
}

export function estimateExaContentsCostUsd(input: {
  pages: number
  contentTypes: number
  summaries?: number
}): number {
  const pages = Math.max(0, Math.floor(input.pages))
  const contentTypes = Math.max(0, Math.floor(input.contentTypes))
  const summaries = Math.max(0, Math.floor(input.summaries ?? 0))

  return (
    pages * contentTypes * EXA_CONTENTS_PAGE_CONTENT_TYPE_COST_USD +
    summaries * EXA_AI_SUMMARY_COST_USD
  )
}
