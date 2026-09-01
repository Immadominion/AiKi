import postgres from 'postgres'
import { checkLedger } from './reconcile.js'
import { treasuryBackingPoints } from './treasury.js'

/**
 * Ask the live database whether the money adds up, and exit non-zero if not.
 *
 * Non-zero on purpose: this is meant to be runnable from a deploy step or a
 * cron and to fail loudly, because a books-do-not-balance finding that arrives
 * as a line in a log nobody reads is the same as no finding at all.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required to reconcile the ledger.')

const sql = postgres(databaseUrl, { max: 1 })
/*
 * Read from the same places the running server reads them, so an operator and
 * the health route cannot disagree about whether AiKi is solvent.
 */
const treasury = process.env.CREDITS_TREASURY_ADDRESS as `0x${string}` | undefined
const findings = await checkLedger(
  sql,
  await treasuryBackingPoints(
    treasury
      ? {
          rpcUrl: process.env.ENFORCER_RPC_URL ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
          chainId: 97,
          token: (process.env.CREDITS_TOKEN_ADDRESS ??
            '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c') as `0x${string}`,
          treasury,
        }
      : undefined,
  ),
)
await sql.end()

for (const finding of findings) {
  console.log(`${finding.ok ? 'ok  ' : 'FAIL'}  ${finding.check}`)
  console.log(`      ${finding.detail}`)
}

const failed = findings.filter((f) => !f.ok)
console.log(
  failed.length
    ? `\n${failed.length} of ${findings.length} checks failed. The ledger does not balance.`
    : `\nAll ${findings.length} checks passed. Every point is accounted for.`,
)
process.exit(failed.length ? 1 : 0)
