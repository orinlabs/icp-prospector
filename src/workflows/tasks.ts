import { task } from '@renderinc/sdk/workflows'

import { attributeUsageToCompany, withUsageContext } from '../lib/usage.js'
import { findPersonAgent, type FindPersonAgentResult } from './agent.js'
import { workAccountAgent, type WorkAccountAgentResult } from './outreachAgent.js'
import {
  getCampaignDiscoveredPersonIds,
  getCampaignRunWithCampaign,
  markRunFailed,
  requiredEnv,
  updateCampaignStatusIfRunning,
  updateRunCheckpoint
} from './repo.js'
import { listDueCompanyIds } from './repoOutreach.js'

type SlotInput = {
  organizationId: string
  campaignRunId: string
  campaignId: string
  campaignName: string
  icpDocument: string
  slotIndex: number
  totalSlots: number
}

type SlotResult = {
  slotIndex: number
  result: FindPersonAgentResult
}

/**
 * One agent run = one task run = one attempt to add one net-new person.
 * Registered as a Render task so the orchestrator can fan out N copies and
 * each one shows up as its own task run in the Render workflow dashboard.
 */
export const findOneProspect = task(
  {
    name: 'findOneProspect',
    timeoutSeconds: 600,
    retry: { maxRetries: 1, waitDurationMs: 2000, backoffScaling: 2 }
  },
  async function findOneProspect(input: SlotInput): Promise<SlotResult> {
    const result = await withUsageContext(
      {
        organizationId: input.organizationId,
        campaignId: input.campaignId,
        campaignRunId: input.campaignRunId,
        slotIndex: input.slotIndex
      },
      () =>
        findPersonAgent({
          organizationId: input.organizationId,
          campaignId: input.campaignId,
          campaignRunId: input.campaignRunId,
          campaignName: input.campaignName,
          icpDocument: input.icpDocument,
          slotIndex: input.slotIndex,
          totalSlots: input.totalSlots
        })
    )
    return { slotIndex: input.slotIndex, result }
  }
)

/**
 * Orchestrator: for each missing slot up to targetCount, spawn one findOneProspect subtask.
 * Each subtask is its own LLM agent with progressive-disclosure DB + web tools.
 */
export const prospectCampaign = task(
  {
    name: 'prospectCampaign',
    timeoutSeconds: 3600,
    retry: { maxRetries: 1, waitDurationMs: 5000, backoffScaling: 2 }
  },
  async function prospectCampaign(campaignRunId: string): Promise<{
    qualifiedCount: number
    spawned: number
    found: number
    duplicates: number
    gaveUp: number
    errors: number
  }> {
    try {
      return await runProspectCampaign(campaignRunId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await markRunFailed(campaignRunId, message)
      throw err
    }
  }
)

async function runProspectCampaign(campaignRunId: string): Promise<{
  qualifiedCount: number
  spawned: number
  found: number
  duplicates: number
  gaveUp: number
  errors: number
}> {
  requiredEnv('DATABASE_URL')
  requiredEnv('EXA_API_KEY')
  requiredEnv('OPENROUTER_API_KEY')

  const row = await getCampaignRunWithCampaign(campaignRunId)
  if (!row) {
    throw new Error(`campaign run not found: ${campaignRunId}`)
  }
  const { campaign } = row

  const targetCount = Math.max(1, campaign.targetCount)
  const alreadyIds = await getCampaignDiscoveredPersonIds(campaign.id, campaign.organizationId)
  const startingQualified = alreadyIds.length
  const slotsNeeded = Math.max(0, targetCount - startingQualified)

  await updateRunCheckpoint(campaignRunId, {
    status: 'running',
    qualifiedCount: startingQualified,
    checkpoint: {
      phase: 'orchestrating',
      targetCount,
      startingQualified,
      slotsToSpawn: slotsNeeded
    },
    lastError: null
  })

  if (slotsNeeded === 0) {
    await updateRunCheckpoint(campaignRunId, {
      status: 'succeeded',
      qualifiedCount: startingQualified,
      checkpoint: {
        phase: 'done',
        targetCount,
        qualifiedCount: startingQualified,
        message: 'Target already met before run'
      }
    })
    await updateCampaignStatusIfRunning(campaign.id, campaign.organizationId, 'completed')
    return {
      qualifiedCount: startingQualified,
      spawned: 0,
      found: 0,
      duplicates: 0,
      gaveUp: 0,
      errors: 0
    }
  }

  const slots: SlotInput[] = Array.from({ length: slotsNeeded }, (_, i) => ({
    organizationId: campaign.organizationId,
    campaignRunId,
    campaignId: campaign.id,
    campaignName: campaign.name,
    icpDocument: campaign.icpDocument,
    slotIndex: i,
    totalSlots: slotsNeeded
  }))

  // Fan out: each call to findOneProspect from a parent task is automatically
  // turned into a subtask run by the Render SDK.
  const settled = await Promise.allSettled(slots.map((s) => findOneProspect(s)))

  let found = 0
  let duplicates = 0
  let gaveUp = 0
  let errors = 0
  const foundIds = new Set<string>()
  const summaries: Array<Record<string, unknown>> = []

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'rejected') {
      errors += 1
      summaries.push({ slot: i, status: 'task_rejected', error: String(s.reason).slice(0, 200) })
      continue
    }
    const { result } = s.value
    switch (result.status) {
      case 'found':
        if (!foundIds.has(result.personId)) {
          foundIds.add(result.personId)
          found += 1
        } else {
          duplicates += 1
        }
        summaries.push({ slot: i, status: 'found', personId: result.personId, steps: result.steps })
        break
      case 'duplicate':
        duplicates += 1
        summaries.push({ slot: i, status: 'duplicate', personId: result.personId, steps: result.steps })
        break
      case 'no_candidate':
        gaveUp += 1
        summaries.push({ slot: i, status: 'no_candidate', reason: result.reason, steps: result.steps })
        break
      case 'error':
        errors += 1
        summaries.push({ slot: i, status: 'agent_error', error: result.error, steps: result.steps })
        break
    }
  }

  // Re-read for an accurate final count (slots may have caught dups via DB).
  const finalIds = await getCampaignDiscoveredPersonIds(campaign.id, campaign.organizationId)
  const qualifiedCount = finalIds.length

  const finalStatus =
    qualifiedCount >= targetCount ? 'succeeded' : qualifiedCount > startingQualified ? 'partial' : 'partial'

  await updateRunCheckpoint(campaignRunId, {
    status: finalStatus,
    qualifiedCount,
    checkpoint: {
      phase: 'done',
      targetCount,
      qualifiedCount,
      spawned: slots.length,
      found,
      duplicates,
      gaveUp,
      errors,
      slots: summaries
    },
    lastError: null
  })

  await updateCampaignStatusIfRunning(
    campaign.id,
    campaign.organizationId,
    finalStatus === 'succeeded' ? 'completed' : 'partial'
  )

  return {
    qualifiedCount,
    spawned: slots.length,
    found,
    duplicates,
    gaveUp,
    errors
  }
}

/**
 * One run of the outreach agent against a single account. Triggered:
 *   - Manually by the user ("Run now" / bulk start)
 *   - By the `sweepDueAccounts` task when `outreach_next_wake_at` is due.
 * Always idempotent against `companies.outreach_status` — the agent itself
 * decides to sleep / pause / mark_completed and writes its own next wake.
 */
export const workAccount = task(
  {
    name: 'workAccount',
    timeoutSeconds: 600,
    retry: { maxRetries: 1, waitDurationMs: 2000, backoffScaling: 2 }
  },
  async function workAccount(
    companyId: string,
    organizationId?: string
  ): Promise<{ companyId: string; result: WorkAccountAgentResult }> {
    requiredEnv('DATABASE_URL')
    requiredEnv('OPENROUTER_API_KEY')
    const result = await withUsageContext({ organizationId: organizationId ?? null }, async () => {
      await attributeUsageToCompany(companyId)
      return workAccountAgent({ companyId, organizationId })
    })
    return { companyId, result }
  }
)

/**
 * Scheduled sweeper invoked by the Render Cron Job. Finds all `working`
 * companies whose `outreach_next_wake_at <= now()` and fans out one
 * `workAccount` subtask per company.
 */
export const sweepDueAccounts = task(
  {
    name: 'sweepDueAccounts',
    timeoutSeconds: 1200,
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1 }
  },
  async function sweepDueAccounts(organizationId?: string): Promise<{
    swept: number
    succeeded: number
    failed: number
  }> {
    requiredEnv('DATABASE_URL')
    const ids = await listDueCompanyIds(organizationId ?? null, 50)
    if (ids.length === 0) {
      return { swept: 0, succeeded: 0, failed: 0 }
    }
    const settled = await Promise.allSettled(ids.map((id) => workAccount(id, organizationId)))
    let succeeded = 0
    let failed = 0
    for (const s of settled) {
      if (s.status === 'fulfilled') succeeded += 1
      else failed += 1
    }
    return { swept: ids.length, succeeded, failed }
  }
)
