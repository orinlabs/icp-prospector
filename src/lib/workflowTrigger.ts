import { Render } from '@renderinc/sdk'

function renderClient(): { render: Render; workflowService: string } | null {
  const token = process.env.RENDER_API_KEY
  const workflowService = process.env.RENDER_WORKFLOW_SLUG
  if (!token || !workflowService) return null
  return { render: new Render({ token }), workflowService }
}

/**
 * Dispatches `prospectCampaign` on the Render Workflow service.
 * `RENDER_WORKFLOW_SLUG` is the **workflow service name** from the dashboard (not the repo name).
 * Task full slug: `${RENDER_WORKFLOW_SLUG}/prospectCampaign`
 */
export async function startProspectWorkflow(campaignRunId: string): Promise<boolean> {
  const client = renderClient()
  if (!client) return false
  await client.render.workflows.startTask(`${client.workflowService}/prospectCampaign`, [
    campaignRunId
  ])
  return true
}

/**
 * Triggers `workAccount(companyId)` directly. Used by single-account "Run now"
 * and the bulk-start endpoint (which fans out one call per company).
 */
export async function startWorkAccount(companyId: string, organizationId: string): Promise<boolean> {
  const client = renderClient()
  if (!client) return false
  await client.render.workflows.startTask(`${client.workflowService}/workAccount`, [
    companyId,
    organizationId
  ])
  return true
}

/**
 * Triggers the scheduled sweeper task. Used by the Render Cron Job.
 */
export async function startSweepDueAccounts(organizationId?: string): Promise<boolean> {
  const client = renderClient()
  if (!client) return false
  await client.render.workflows.startTask(
    `${client.workflowService}/sweepDueAccounts`,
    organizationId ? [organizationId] : []
  )
  return true
}
