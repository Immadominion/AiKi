/**
 * Grade AiKi's own agents with AiKi's own prober.
 *
 * The product's whole claim is that it tests agents instead of listing them. The
 * first agents that claim has to survive are ours, and the only honest way to
 * check is to read the identity from the chain — not from our config — resolve
 * whatever the registry actually points at, and run the same rules we run on
 * strangers. Anything less is marking our own homework.
 *
 * A first-party agent should reach LIVE by rule D5 with a verified D8 reciprocal
 * proof. Anything else is a defect worth knowing about before a judge finds it.
 *
 *   BSC_RPC_URL=… pnpm --filter @aiki/api reference:verify 315943 315944 …
 */

import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'
import { BSC_MAINNET } from '../config/chains.js'
import { probeAgent } from '../prober/probe.js'
import { resolveRegistration } from '../prober/registration.js'
import { REFERENCE_REGISTRY } from './manifest.js'

const REGISTRY_ABI = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)'])

const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
if (!ids.length) throw new Error('Pass one or more ERC-8004 token ids.')

const client = createPublicClient({
  chain: bsc,
  transport: http(process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org'),
})

let failures = 0

for (const agentId of ids) {
  const uri = await client.readContract({
    address: BSC_MAINNET.contracts.erc8004Identity,
    abi: REGISTRY_ABI,
    functionName: 'tokenURI',
    args: [BigInt(agentId)],
  })
  const registration = await resolveRegistration(uri)
  const services = registration.manifest?.services ?? []

  const result = await probeAgent({
    agentId,
    registry: REFERENCE_REGISTRY,
    services,
    agentUri: uri,
  })

  const claimed = registration.manifest?.registrations?.[0]
  const identityMatches =
    claimed?.agentId === agentId && claimed?.agentRegistry === REFERENCE_REGISTRY

  const ok = result.verdict.state === 'LIVE' && result.reciprocal?.verified && identityMatches
  if (!ok) failures += 1

  console.log(`\n${ok ? 'PASS' : 'FAIL'}  agent ${agentId} — ${registration.manifest?.name ?? '?'}`)
  console.log(`  registration   ${registration.status} (${registration.scheme})  ${uri}`)
  console.log(`  endpoint       ${services[0]?.endpoint ?? 'none declared'}`)
  console.log(`  verdict        ${result.verdict.state} via ${result.verdict.rule}`)
  console.log(`                 ${result.verdict.detail}`)
  console.log(
    `  D8 reciprocal  ${result.reciprocal?.verified ? 'verified' : 'NOT verified'} — ${result.reciprocal?.detail ?? 'not checked'}`,
  )
  console.log(`  D1 probes      ${result.samples.map((s) => `${s.label}:${s.status}`).join('  ')}`)
  // The bytes must differ across ids, or the endpoint is not reading the question
  // and D1 would call it an impostor — correctly.
  const hashes = new Set(result.samples.map((s) => s.bodyHash))
  console.log(`  distinct bodies ${hashes.size} of ${result.samples.length}`)
  if (!identityMatches)
    console.log(`  identity       manifest claims ${claimed?.agentId} at ${claimed?.agentRegistry}`)
}

console.log(`\n${ids.length - failures}/${ids.length} passed`)
if (failures) process.exit(1)
