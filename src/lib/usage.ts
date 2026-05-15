import { AsyncLocalStorage } from 'node:async_hooks'

import { inArray } from 'drizzle-orm'

import { db } from '../db/client.js'
import { usageEvents } from '../db/schema.js'

/**
 * Per-slot context for usage tracking. Lives in an AsyncLocalStorage so any
 * code path executed inside `withUsageContext(...)` (LLM calls, search calls,
 * etc.) can record events without manually threading IDs through.
 *
 * `attribution` is mutated when the slot ends up creating a person — at that
 * point we backfill all of this slot's events so the user can see "X dollars
 * spent on Person Y at Company Z."
 */
type UsageContextData = {
  organizationId: string | null
  campaignId: string | null
  campaignRunId: string | null
  slotIndex: number | null
  attribution: { personId: string | null; companyId: string | null }
  collectedIds: string[]
}

const storage = new AsyncLocalStorage<UsageContextData>()

export function withUsageContext<T>(
  ctx: {
    organizationId?: string | null
    campaignId?: string | null
    campaignRunId?: string | null
    slotIndex?: number | null
  },
  fn: () => Promise<T>
): Promise<T> {
  const data: UsageContextData = {
    organizationId: ctx.organizationId ?? null,
    campaignId: ctx.campaignId ?? null,
    campaignRunId: ctx.campaignRunId ?? null,
    slotIndex: ctx.slotIndex ?? null,
    attribution: { personId: null, companyId: null },
    collectedIds: []
  }
  return storage.run(data, fn)
}

export type RecordUsageInput = {
  provider: string
  operation: string
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
  units?: number | null
  costUsd?: number | null
  estimated?: boolean
  metadata?: Record<string, unknown>
}

export async function recordUsageEvent(input: RecordUsageInput): Promise<void> {
  const ctx = storage.getStore()
  if (!ctx?.organizationId) return
  try {
    const [row] = await db
      .insert(usageEvents)
      .values({
        provider: input.provider,
        operation: input.operation,
        model: input.model ?? undefined,
        promptTokens: input.promptTokens ?? undefined,
        completionTokens: input.completionTokens ?? undefined,
        totalTokens: input.totalTokens ?? undefined,
        units: input.units ?? undefined,
        costUsd:
          input.costUsd != null && Number.isFinite(input.costUsd)
            ? input.costUsd.toFixed(6)
            : undefined,
        estimated: input.estimated ?? false,
        organizationId: ctx?.organizationId ?? undefined,
        campaignId: ctx?.campaignId ?? undefined,
        campaignRunId: ctx?.campaignRunId ?? undefined,
        slotIndex: ctx?.slotIndex ?? undefined,
        personId: ctx?.attribution.personId ?? undefined,
        companyId: ctx?.attribution.companyId ?? undefined,
        metadata: input.metadata ?? undefined
      })
      .returning({ id: usageEvents.id })
    if (ctx && row) ctx.collectedIds.push(row.id)
  } catch (err) {
    // Usage tracking should never break the agent path.
    console.error('[usage] failed to record event:', err)
  }
}

export async function attributeUsageToPerson(
  personId: string,
  companyId: string | null
): Promise<void> {
  const ctx = storage.getStore()
  if (!ctx) return
  ctx.attribution.personId = personId
  ctx.attribution.companyId = companyId
  if (ctx.collectedIds.length === 0) return
  try {
    await db
      .update(usageEvents)
      .set({ personId, companyId: companyId ?? null })
      .where(inArray(usageEvents.id, ctx.collectedIds))
  } catch (err) {
    console.error('[usage] failed to backfill attribution:', err)
  }
}

/**
 * Outreach work isn't tied to a campaign/run, so we attribute by company.
 * Sets the context's companyId and backfills any already-recorded events.
 */
export async function attributeUsageToCompany(companyId: string): Promise<void> {
  const ctx = storage.getStore()
  if (!ctx) return
  ctx.attribution.companyId = companyId
  if (ctx.collectedIds.length === 0) return
  try {
    await db
      .update(usageEvents)
      .set({ companyId })
      .where(inArray(usageEvents.id, ctx.collectedIds))
  } catch (err) {
    console.error('[usage] failed to backfill company attribution:', err)
  }
}
