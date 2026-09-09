import { parseArgs } from 'node:util'
import postgres from 'postgres'
import { ClientError } from '../http/errors.js'
import { recoveryInput, reviewHistoricalDeposit } from './recovery.js'

// Read-only by construction. Credentials stay in environment variables, never
// CLI arguments or output. No --apply flag or persistent credit writer exists.
const { values } = parseArgs({
  options: {
    'chain-id': { type: 'string' },
    token: { type: 'string' },
    treasury: { type: 'string' },
    owner: { type: 'string' },
    'transaction-hash': { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
})
const input = recoveryInput(values, process.env.CREDITS_RECOVERY_RPC_URL)
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is required for a read-only ledger review.')
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 })
try {
  const result = await reviewHistoricalDeposit({ sql, ...input })
  console.log(JSON.stringify(result, null, 2))
  if (result.status === 'conflict') process.exitCode = 2
} catch (error) {
  console.error(
    JSON.stringify({
      applied: false,
      error: error instanceof ClientError ? error.code : 'RECOVERY_VERIFICATION_UNAVAILABLE',
      message: 'Historical payment review failed. No persistent points or balances were changed.',
    }),
  )
  process.exitCode = 1
} finally {
  await sql.end()
}
