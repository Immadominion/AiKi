import postgres from 'postgres'
import { createPublicClient, type Hex, http } from 'viem'
import { bsc } from 'viem/chains'
import { executionNetwork, verifyExecutionNetwork } from '../config/execution-network.js'
import { executorIdentity } from '../config/executor-identity.js'
import { loadStrategyDeploymentConfig } from './deployment-config.js'
import { decodeStoredStrategyDelegation } from './envelope.js'
import { executeStrategyOperation } from './execution.js'
import { runStrategySweep } from './runner.js'
import { PostgresStrategyRunnerStore } from './runner-store.js'
import { PostgresStrategyStore } from './store.js'

/** Isolated worker process. Never starts from an HTTP request or a wallet-connect event. */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required.')
const network = await executionNetwork(process.env)
if (network.deployment.chainId !== 56)
  throw new Error('Strategy automation requires the reviewed BSC mainnet deployment.')
await verifyExecutionNetwork(network)
const config = loadStrategyDeploymentConfig(process.env.STRATEGY_DEPLOYMENT_CONFIG)
const { agentKey: relayerKey, agentSessionKey: executor } = executorIdentity(process.env)
const reader = createPublicClient({
  chain: bsc,
  transport: http(network.rpcUrl, { timeout: 8000, retryCount: 1 }),
})
const sql = postgres(databaseUrl, { max: 5, onnotice: () => {} })
const store = new PostgresStrategyStore(sql),
  scheduler = new PostgresStrategyRunnerStore(sql)
try {
  const report = await runStrategySweep({
    store,
    scheduler,
    reader,
    config,
    ...(executor ? { executor } : {}),
    limit: Number(process.env.STRATEGY_RUNNER_LIMIT ?? '5'),
    ...(relayerKey
      ? {
          execute: async ({
            claim,
            expectedRevision,
            plan,
          }: Parameters<NonNullable<Parameters<typeof runStrategySweep>[0]['execute']>>[0]) =>
            executeStrategyOperation({
              store,
              watchId: claim.watchId,
              expectedRevision,
              operation: plan.operation,
              simulation: plan.quote,
              gasBudgetWei: plan.gasBudgetWei,
              reader,
              request: {
                rpcUrl: network.rpcUrl,
                chainId: 56,
                delegationManager: network.deployment.manager as Hex,
                relayerKey,
                delegation: decodeStoredStrategyDelegation(claim.delegation),
              },
            }),
        }
      : {}),
  })
  console.log(JSON.stringify({ component: 'strategy-runner', chainId: 56, ...report }))
} finally {
  await sql.end()
}
