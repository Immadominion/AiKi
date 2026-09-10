/**
 * The engine, running on its own.
 *
 * Independent loops on separate clocks. Indexing and probing build the evidence: the
 * registry grows on chain continuously, while probing is a courtesy call to
 * someone else's server and belongs on a slower clock. The runner is the third
 * and it is a different kind of thing - it is the one that spends money, on
 * behalf of people who are not watching.
 *
 * No loop lets a failed pass end the process. A prober that dies on one bad
 * endpoint stops being a prober; a runner that dies on one unreachable RPC
 * stops being a guardian, which is worse, because the user was told it was on
 * duty. Each logs the failure and waits for its next turn.
 */
import { spawn } from 'node:child_process'

const INDEX_INTERVAL_MS = Number(process.env.INDEX_INTERVAL_MS ?? String(5 * 60_000))
const PROBE_INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS ?? String(30 * 60_000))
/*
 * The fastest of the three. A position can go from healthy to liquidatable in
 * the time between two blocks, and every minute of this interval is a minute
 * the user is unprotected. It is bounded below by the trigger's own cooldown,
 * which is what stops a fast clock repaying the same shortfall twice.
 */
const RUN_INTERVAL_MS = Number(process.env.RUN_INTERVAL_MS ?? String(60_000))
const STRATEGY_RUN_INTERVAL_MS = Number(process.env.STRATEGY_RUN_INTERVAL_MS ?? String(15_000))
if (
  !Number.isSafeInteger(STRATEGY_RUN_INTERVAL_MS) ||
  STRATEGY_RUN_INTERVAL_MS < 5_000 ||
  STRATEGY_RUN_INTERVAL_MS > 60_000
)
  throw new Error('Strategy runner interval must be between five and sixty seconds.')

function runOnce(label: string, script: string) {
  return new Promise<void>((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    })
    child.on('exit', (code) => {
      console.log(`[${label}] exited ${code} after ${Math.round((Date.now() - started) / 1000)}s`)
      resolve()
    })
    child.on('error', (error) => {
      console.error(`[${label}] failed to start:`, error.message)
      resolve()
    })
  })
}

async function loop(label: string, script: string, intervalMs: number) {
  while (true) {
    await runOnce(label, script)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

const here = new URL('.', import.meta.url).pathname
console.log(
  `scheduler: index every ${INDEX_INTERVAL_MS / 60_000}m, ` +
    `probe every ${PROBE_INTERVAL_MS / 60_000}m, ` +
    `run every ${RUN_INTERVAL_MS / 60_000}m, ` +
    `strategies every ${STRATEGY_RUN_INTERVAL_MS / 1000}s`,
)
await Promise.all([
  loop('index', `${here}indexer/persist-cli.ts`, INDEX_INTERVAL_MS),
  loop('probe', `${here}prober/sweep-cli.ts`, PROBE_INTERVAL_MS),
  loop('run', `${here}runner/sweep-cli.ts`, RUN_INTERVAL_MS),
  loop('strategies', `${here}strategies/runner-cli.ts`, STRATEGY_RUN_INTERVAL_MS),
])
