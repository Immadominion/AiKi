import postgres from 'postgres'
import { checkLedger } from './reconcile.js'

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
const findings = await checkLedger(sql)
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
