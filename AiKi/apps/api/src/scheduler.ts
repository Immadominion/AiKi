/**
 * The evidence engine, running on its own.
 *
 * Indexing and probing are separate loops on separate clocks: the registry
 * grows on chain continuously, while probing is a courtesy call to someone
 * else's server and belongs on a slower one. Neither loop lets a failed pass
 * end the process, because a prober that dies on one bad endpoint stops being
 * a prober; it logs the failure and waits for its next turn.
 */
import { spawn } from 'node:child_process'

const INDEX_INTERVAL_MS = Number(process.env.INDEX_INTERVAL_MS ?? String(5 * 60_000))
const PROBE_INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS ?? String(30 * 60_000))

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
  `evidence scheduler: index every ${INDEX_INTERVAL_MS / 60_000}m, probe every ${PROBE_INTERVAL_MS / 60_000}m`,
)
await Promise.all([
  loop('index', `${here}indexer/persist-cli.ts`, INDEX_INTERVAL_MS),
  loop('probe', `${here}prober/sweep-cli.ts`, PROBE_INTERVAL_MS),
])
