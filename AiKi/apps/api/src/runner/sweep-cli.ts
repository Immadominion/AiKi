import { AIKI_ENFORCERS_BSC_TESTNET } from '../config/enforcers.js'
import { PostgresJobStore } from '../jobs/postgres-store.js'
import { JobService } from '../jobs/service.js'
import { VenusClient } from '../reference/venus/client.js'
import { PostgresWatchStore } from './store.js'
import { type SweepChainConfig, sweep } from './sweep.js'

/**
 * One pass of every agent that is watching something.
 *
 * A separate process on its own clock, like the indexer and the prober, and for
 * the same reason: a loop that shares a process with the API takes the API down
 * with it when it wedges on a slow RPC.
 *
 * It exits non-zero only when it could not run at all. A pass where every watch
 * failed is still a pass that ran, and the failures are recorded per watch where
 * somebody can see them.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required.')

/*
 * The chain the mandates are enforced on. Venus has a deployment there too,
 * which is what makes an unattended agent coherent: the position being read and
 * the caveats refusing the repayment are on the same chain. Watching a position
 * on one chain while the limit lives on another would be theatre.
 */
const deployment = AIKI_ENFORCERS_BSC_TESTNET
const chainId = deployment.chainId
const rpcUrl =
  process.env.RUNNER_RPC_URL ??
  process.env.ENFORCER_RPC_URL ??
  'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
/*
 * The manager comes from the pinned deployment, not from the environment. The
 * caveats in every stored delegation were compiled against this exact address
 * and its enforcers, so a manager set by an environment variable is a
 * misconfiguration that would redeem a mandate through contracts nobody checked
 * it against. It is the one address that must not be a knob.
 */
const manager = deployment.manager as `0x${string}`
const relayerKey = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined

const intervalMs = Number(process.env.RUNNER_INTERVAL_MS ?? String(5 * 60_000))
const limit = Number(process.env.RUNNER_LIMIT ?? '50')

const jobStore = new PostgresJobStore(databaseUrl)
const watchStore = new PostgresWatchStore(databaseUrl)

try {
  /*
   * Missing keys are reported rather than assumed. A runner that quietly cannot
   * act still claims to be watching, which is the worst of both: the user
   * believes a guardian is on duty and nothing is.
   */
  if (!relayerKey)
    console.warn(
      'runner: AGENT_PRIVATE_KEY is unset, so no watch can act. Positions will be read and recorded only.',
    )

  const chain: SweepChainConfig | null = relayerKey
    ? { rpcUrl, chainId, delegationManager: manager, relayerKey }
    : null

  const reader = new VenusClient(rpcUrl, undefined, chainId)

  const report = await sweep({
    jobs: new JobService(jobStore),
    watches: watchStore,
    reader: (id) => (id === chainId ? reader : null),
    chain: (id) => (id === chainId ? chain : null),
    intervalMs,
    limit,
  })

  console.log(
    JSON.stringify(
      { chainId, looked: report.looked, acted: report.acted, stopped: report.stopped },
      null,
      2,
    ),
  )
  for (const pass of report.passes)
    console.log(`  ${pass.jobId} ${pass.acted ? 'ACTED' : 'quiet'}: ${pass.reason}`)
} finally {
  await watchStore.close()
  await jobStore.close?.()
}
