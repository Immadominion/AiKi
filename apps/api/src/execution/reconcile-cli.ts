import postgres from 'postgres'
import { createPublicClient, http } from 'viem'
import { parseRecoveryArguments, reconcileExecution } from './reconcile.js'
import { PostgresExecutionRecoveryStore } from './reconcile-store.js'

const usage = `Usage: pnpm exec tsx src/execution/reconcile-cli.ts --attempt UUID --chain 56|97 --hash HASH [--apply]

Requires DATABASE_URL and EXECUTION_RECONCILE_RPC_URL. No private key is used.
Default is read-only. --apply can only record an exact canonical finalized
success as LANDED, keeping counted spend unchanged. Missing receipts, unproven
finality, and reverts remain locked. No broadcast, refund, replacement, automatic
watch restart, or nonce change is possible. Inspect the dry run before applying.

Recovering the attempt permits later authorized requests to proceed. Pause or
stop the watch first if it must not resume through its existing schedule.`

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    console.log(usage)
    return
  }
  const options = parseRecoveryArguments(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  const rpcUrl = process.env.EXECUTION_RECONCILE_RPC_URL
  if (!databaseUrl || !rpcUrl)
    throw new Error('DATABASE_URL and EXECUTION_RECONCILE_RPC_URL are required.')
  let parsed: URL
  try {
    parsed = new URL(rpcUrl)
  } catch {
    throw new Error('Choose a valid HTTP(S) execution reconciliation RPC.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('Choose a valid HTTP(S) execution reconciliation RPC.')
  const sql = postgres(databaseUrl, { max: 1 })
  try {
    const result = await reconcileExecution({
      target: options,
      apply: options.apply,
      store: new PostgresExecutionRecoveryStore(sql),
      reader: createPublicClient({ transport: http(rpcUrl, { timeout: 5_000, retryCount: 0 }) }),
    })
    console.log(JSON.stringify(result, null, 2))
    if (result.status === 'blocked' || result.status === 'changed') process.exitCode = 2
  } catch {
    // Connection strings, RPC credentials and raw driver errors stay out of
    // operator logs. A lost COMMIT response requires inspection, never refund.
    console.error(
      'Reconciliation could not be confirmed. Inspect this exact attempt again before retrying; no transaction was sent.',
    )
    process.exitCode = 1
  } finally {
    await sql.end()
  }
}

try {
  await main()
} catch {
  console.error(
    `Reconciliation could not be confirmed. Inspect the exact attempt before retrying; no transaction was sent. Check the command and required configuration.\n${usage}`,
  )
  process.exitCode = 1
}
