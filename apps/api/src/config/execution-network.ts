import { readFile } from 'node:fs/promises'
import {
  AIKI_ENFORCERS_BSC_TESTNET,
  assertEnforcerDeployment,
  type EnforcerDeployment,
} from './enforcers.js'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const ZERO = /^0x0+$/

/** A reviewed deployment file, never a request body or a publisher manifest. */
export function parseMainnetDeployment(input: unknown): EnforcerDeployment {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('A reviewed BSC mainnet deployment is required.')
  const data = input as Record<string, unknown>
  const address = (value: unknown): value is string =>
    typeof value === 'string' && ADDRESS.test(value) && !ZERO.test(value)
  const hash = (value: unknown): value is string =>
    typeof value === 'string' && HASH.test(value) && !ZERO.test(value)
  if (
    data.chainId !== 56 ||
    data.network !== 'mainnet' ||
    typeof data.audited !== 'boolean' ||
    !address(data.manager) ||
    !address(data.registry) ||
    !hash(data.managerCodeHash) ||
    !hash(data.registryCodeHash) ||
    !Array.isArray(data.enforcers) ||
    data.enforcers.length !== AIKI_ENFORCERS_BSC_TESTNET.enforcers.length
  )
    throw new Error('The mainnet deployment must pin chain56 and every contract code hash.')
  const names = new Set(AIKI_ENFORCERS_BSC_TESTNET.enforcers.map((item) => item.name))
  const addresses = new Set([data.manager.toLowerCase(), data.registry.toLowerCase()])
  if (addresses.size !== 2) throw new Error('Deployment contracts must have distinct addresses.')
  const enforcers = data.enforcers.map((raw: unknown) => {
    const entry = raw as Record<string, unknown> | null
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      !names.delete(entry.name) ||
      !address(entry.address) ||
      !hash(entry.codeHash) ||
      addresses.has(entry.address.toLowerCase())
    )
      throw new Error('The mainnet deployment has missing, repeated or invalid enforcers.')
    addresses.add(entry.address.toLowerCase())
    return { name: entry.name, address: entry.address.toLowerCase(), codeHash: entry.codeHash }
  })
  return {
    chainId: 56,
    network: 'mainnet',
    audited: data.audited,
    manager: data.manager.toLowerCase(),
    registry: data.registry.toLowerCase(),
    managerCodeHash: data.managerCodeHash,
    registryCodeHash: data.registryCodeHash,
    enforcers,
  }
}

export async function executionNetwork(
  env: Record<string, string | undefined>,
  load: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
) {
  // Preserve existing deployments during migration. Mainnet is explicit and
  // never substitutes a testnet suite when its deployment file is missing.
  const chain = env.AIKI_EXECUTION_CHAIN_ID ?? '97'
  if (chain !== '56' && chain !== '97') throw new Error('Choose execution chain56 or97.')
  let deployment: EnforcerDeployment
  if (chain === '56') {
    if (!env.AIKI_ENFORCER_DEPLOYMENT_FILE)
      throw new Error('Mainnet execution requires AIKI_ENFORCER_DEPLOYMENT_FILE.')
    const content = await load(env.AIKI_ENFORCER_DEPLOYMENT_FILE)
    if (content.length > 32_768) throw new Error('The deployment file is too large.')
    deployment = parseMainnetDeployment(JSON.parse(content))
  } else {
    deployment = AIKI_ENFORCERS_BSC_TESTNET
  }
  const rpcUrl =
    env.RUNNER_RPC_URL ??
    env.ENFORCER_RPC_URL ??
    (chain === '56' ? env.BSC_RPC_URL : 'https://data-seed-prebsc-1-s1.bnbchain.org:8545')
  if (!rpcUrl) throw new Error('Configure the execution RPC for the selected network.')
  return { deployment, rpcUrl }
}

/** Read-only preflight. Call before exposing signing/deployment or running jobs. */
export async function verifyExecutionNetwork(input: Awaited<ReturnType<typeof executionNetwork>>) {
  let id = 0
  await assertEnforcerDeployment(
    {
      async request<T>(method: string, params: unknown[]): Promise<T> {
        const response = await fetch(input.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) throw new Error('Execution network verification could not reach its RPC.')
        const result = (await response.json()) as { result?: T; error?: unknown }
        if (result.error || result.result === undefined)
          throw new Error('Execution network verification failed.')
        return result.result
      },
    },
    input.deployment,
  )
}
