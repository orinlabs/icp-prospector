import 'dotenv/config'

import { syncAllDueDraftThreads } from '../../lib/gmail/threadSync.js'

async function main(): Promise<void> {
  const result = await syncAllDueDraftThreads()
  console.log(
    `[cron:sync-threads] attempted=${result.attempted} with_new=${result.withNew} errors=${result.errors}`
  )
  if (result.errors > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[cron:sync-threads] failed:', err)
  process.exit(1)
})
