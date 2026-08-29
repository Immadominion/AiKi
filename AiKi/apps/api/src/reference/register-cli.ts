/**
 * Mint the four first-party ERC-8004 identities and report the token ids.
 *
 * Run once per environment, deliberately. It is in the repository rather than
 * being a shell one-liner because the registration of AiKi's own agents is the
 * one claim about AiKi that a judge can check against the chain, and it should be
 * reproducible and reviewable rather than remembered.
 *
 * ORDER MATTERS, and it is circular by design. The registration file must name the
 * token id, and the token id does not exist until the file's URL has been written
 * on chain. So: register with the stable manifest URL, read the minted id out of
 * the `Registered` event, then set that id in the environment so the manifest can
 * finally name it. `setAgentURI` is owner-gated and available if the URL ever moves.
 *
 * Usage:
 *   REGISTRAR_PRIVATE_KEY=0x… REFERENCE_AGENT_BASE_URL=https://… \
 *     pnpm --filter @aiki/api reference:register [--dry-run]
 */

import { createPublicClient, createWalletClient, formatEther, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'
import { BSC_MAINNET } from '../config/chains.js'

const REGISTRY_ABI = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
])

/** Each agent's manifest path, and the environment variable its id belongs in. */
const AGENTS = [
  {
    label: 'Venus Health Factor Guardian',
    path: '/v1/reference/venus/manifest.json',
    env: 'VENUS_GUARDIAN_AGENT_ID',
  },
  {
    label: 'PancakeSwap LP Rebalancer',
    path: '/v1/reference/pancake/rebalancer/manifest.json',
    env: 'PANCAKE_REBALANCER_AGENT_ID',
  },
  {
    label: 'PancakeSwap Grid Trader',
    path: '/v1/reference/pancake/grid/manifest.json',
    env: 'PANCAKE_GRID_AGENT_ID',
  },
  {
    label: 'Venus Yield Optimiser',
    path: '/v1/reference/yield/manifest.json',
    env: 'YIELD_OPTIMIZER_AGENT_ID',
  },
] as const

const dryRun = process.argv.includes('--dry-run')
const rpcUrl = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org'
const rawBase = process.env.REFERENCE_AGENT_BASE_URL
if (!rawBase)
  throw new Error('REFERENCE_AGENT_BASE_URL is required: it is what gets written on chain.')
const base = new URL(rawBase).toString().replace(/\/$/, '')
if (!base.startsWith('https://'))
  throw new Error(
    'REFERENCE_AGENT_BASE_URL must be HTTPS. The prober refuses to fetch anything else.',
  )

const key = process.env.REGISTRAR_PRIVATE_KEY
if (!key) throw new Error('REGISTRAR_PRIVATE_KEY is required.')
const account = privateKeyToAccount(key as `0x${string}`)

const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) })
const wallet = createWalletClient({ account, chain: bsc, transport: http(rpcUrl) })

/**
 * Refuse to write a URL the host does not serve.
 *
 * The manifest cannot return 200 yet — it has no id to name — but it must return
 * the 503 that says "this route exists and is waiting for an identity". A 404 here
 * means a path typo, and a typo written on chain is a dead agent in the registry:
 * exactly the failure this product was built to measure in other people's agents.
 */
async function assertRouteExists(url: string) {
  const response = await fetch(url, { redirect: 'error' })
  if (response.status === 200) return 'already serving a manifest'
  if (response.status !== 503)
    throw new Error(
      `${url} returned HTTP ${response.status}. Expected 503 REFERENCE_NOT_REGISTERED (route present, ` +
        'identity not yet minted) or 200. Registering a URL that does not resolve would publish a dead agent.',
    )
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
  if (body.error?.code !== 'REFERENCE_NOT_REGISTERED')
    throw new Error(`${url} returned 503 but not REFERENCE_NOT_REGISTERED. Refusing to guess.`)
  return 'route present, awaiting identity'
}

const balance = await publicClient.getBalance({ address: account.address })
console.log(`registrar   ${account.address}`)
console.log(`balance     ${formatEther(balance)} BNB`)
console.log(`registry    ${BSC_MAINNET.contracts.erc8004Identity}`)
console.log(`base        ${base}`)
console.log(dryRun ? 'mode        DRY RUN — nothing will be sent\n' : 'mode        LIVE\n')

const results: { label: string; env: string; agentId: string; txHash: string }[] = []

for (const agent of AGENTS) {
  const uri = `${base}${agent.path}`
  const state = await assertRouteExists(uri)
  console.log(`${agent.label}\n  uri   ${uri}\n  route ${state}`)

  const { request, result } = await publicClient.simulateContract({
    address: BSC_MAINNET.contracts.erc8004Identity,
    abi: REGISTRY_ABI,
    functionName: 'register',
    args: [uri],
    account,
  })
  if (dryRun) {
    console.log(`  would mint agent id ${result} (simulated; the real id may differ)\n`)
    continue
  }

  const hash = await wallet.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Registration reverted: ${hash}`)

  // Read the id from the event rather than the simulation: between simulating and
  // mining, anyone else's registration moves the counter.
  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === BSC_MAINNET.contracts.erc8004Identity.toLowerCase() &&
      l.topics[0] === '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a',
  )
  const topic = log?.topics[1]
  if (!topic) throw new Error(`No Registered event in ${hash}. Refusing to guess the agent id.`)
  const agentId = BigInt(topic).toString()

  // Prove it from the chain's own state, not from the receipt we just parsed.
  const [onChainUri, owner] = await Promise.all([
    publicClient.readContract({
      address: BSC_MAINNET.contracts.erc8004Identity,
      abi: REGISTRY_ABI,
      functionName: 'tokenURI',
      args: [BigInt(agentId)],
    }),
    publicClient.readContract({
      address: BSC_MAINNET.contracts.erc8004Identity,
      abi: REGISTRY_ABI,
      functionName: 'ownerOf',
      args: [BigInt(agentId)],
    }),
  ])
  if (onChainUri !== uri) throw new Error(`tokenURI(${agentId}) is ${onChainUri}, not ${uri}.`)
  if (owner.toLowerCase() !== account.address.toLowerCase())
    throw new Error(`Agent ${agentId} is owned by ${owner}, not the registrar.`)

  console.log(`  agent ${agentId}  tx ${hash}\n`)
  results.push({ label: agent.label, env: agent.env, agentId, txHash: hash })
}

if (results.length) {
  console.log('Set these, then redeploy so the manifests can name their own ids:\n')
  for (const r of results) console.log(`  ${r.env}=${r.agentId}`)
  console.log(`\nTransactions:\n${results.map((r) => `  ${r.label}: ${r.txHash}`).join('\n')}`)
}
