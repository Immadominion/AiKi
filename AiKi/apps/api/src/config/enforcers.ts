import { keccak256 } from 'viem'
import type { JsonRpcClient } from './assertions.js'

/**
 * AiKi's own deployed mandate suite, pinned by address AND by code hash.
 *
 * This is the object a T0 claim must resolve against. Everything else in the
 * product describes enforcement that somebody else's contract performs; this is
 * the one set we wrote, and it is therefore the one that has to be checked
 * hardest.
 *
 * Address alone is not enough. `AiKiEnforcerRegistry` already answers
 * enforcer-address squatting for a user reading a delegation, but the API is a
 * second reader and it must not inherit the registry's word for it: pinning the
 * code hash means a redeployment, a different compiler run, or an address that
 * merely happens to answer `DELEGATION_MANAGER()` cannot pass as ours.
 *
 * `network` is load-bearing and is not decoration. These are on BNB testnet,
 * chain 97, and they are UNAUDITED. Nothing may render an unqualified "the chain
 * refuses this" for a mandate whose enforcement lives on a test network, because
 * a reader will assume that sentence is about their real money.
 */
export interface EnforcerDeployment {
  chainId: number
  network: 'mainnet' | 'testnet'
  audited: boolean
  registry: string
  manager: string
  /** Name as registered on chain, exactly as `addressOf(string)` expects it. */
  enforcers: { name: string; address: string; codeHash: string }[]
}

/**
 * Deployed 29 Aug 2026 from 0x3A637bc6…9Fb9b4, 7,627,729 gas at 0.1 gwei.
 *
 * The order these were deployed in is a property of the set, not a detail: the
 * stateless enforcers pin nothing, the manager pins ExpiryEnforcer as an
 * immutable so no delegation can be signed without an expiry, and the stateful
 * enforcers pin the manager so nobody else can reach their counters. Verified on
 * chain after deployment, not assumed from the script's exit code.
 */
export const AIKI_ENFORCERS_BSC_TESTNET: EnforcerDeployment = {
  chainId: 97,
  network: 'testnet',
  audited: false,
  registry: '0x0bf91dc7e4125a04ec50bcee4b7e2ae513749fee',
  manager: '0x15d7a002e420f66c08ff0f0446f47668c6099121',
  enforcers: [
    {
      name: 'ExpiryEnforcer',
      address: '0xb71341e1270364c2c7adb413d7782175d9987ce2',
      codeHash: '0x0c719e178625d2a54f75dd3a0b5c91454b8e5763745770f0e298abe1fa1f71c8',
    },
    {
      name: 'AllowedTargetsEnforcer',
      address: '0xac44cb148db11f7846cb97431e6303c53b3f03dc',
      codeHash: '0x2f24256f96430115d58f3b46c613bc1071bb954c50901719148d8b2a16fbb24b',
    },
    {
      name: 'AllowedSelectorsEnforcer',
      address: '0x2841a75424394b1c42e1e0a3dda09687230af93f',
      codeHash: '0xedd59dbf2294a86cd458ac59ae899e800839f512f066a9e432127a5279b3c87b',
    },
    {
      name: 'AssetScopeEnforcer',
      address: '0xfdbfce42f85fd75319ab2fc4c864d3e0bd52853f',
      codeHash: '0x94e235d51c1377986681030238d14c2a11003ea2c0694d7c911d7daeda5acae9',
    },
    {
      name: 'PerActionCapEnforcer',
      address: '0x664a7b4f0dcace0c56e21116908d3825dd845f76',
      codeHash: '0x195e6dba91ab3fe96c7fe0d94ed592baaa7a5406cd6d8a7986996a9ac6f250de',
    },
    {
      name: 'SessionTotalCapEnforcer',
      address: '0x933fc376cce6ae05721b685c432e3c9354ed3775',
      codeHash: '0x6bd6e2870321535054727f21854456a01e7c3ba00ad14c1256e10488d081e87c',
    },
  ],
}

export interface EnforcerAssertion {
  name: string
  address: string
  codeHash: string
}

/** ABI-encode `addressOf(string)`, by hand, so this file adds no dependency. */
function encodeAddressOf(name: string): string {
  const selector = keccak256(new TextEncoder().encode('addressOf(string)')).slice(2, 10)
  const bytes = new TextEncoder().encode(name)
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
  const offset = (32).toString(16).padStart(64, '0')
  const length = bytes.length.toString(16).padStart(64, '0')
  return `0x${selector}${offset}${length}${padded}`
}

const addressFromWord = (word: string): string => `0x${word.slice(-40)}`.toLowerCase()

/**
 * Refuse to start against a mandate suite that is not the one we deployed.
 *
 * Fails closed on three separate things, because they fail in different ways: a
 * missing contract means the wrong network or a wiped testnet; a changed code
 * hash means the address is no longer running the code these claims were made
 * about; and a registry that resolves a name elsewhere means the object the UI
 * checks T0 against disagrees with the object the API believes in. Any of the
 * three makes every downstream enforcement claim unfounded.
 */
export async function assertEnforcerDeployment(
  client: JsonRpcClient,
  deployment: EnforcerDeployment,
): Promise<EnforcerAssertion[]> {
  const chainId = await client.request<string>('eth_chainId', [])
  if (Number(chainId) !== deployment.chainId)
    throw new Error(
      `Enforcer deployment is pinned to chain ${deployment.chainId}, but the RPC answers for ${Number(chainId)}.`,
    )

  const checked: EnforcerAssertion[] = []
  for (const enforcer of deployment.enforcers) {
    const code = await client.request<string>('eth_getCode', [enforcer.address, 'latest'])
    if (!code || code.length <= 2)
      throw new Error(`${enforcer.name} at ${enforcer.address} has no deployed bytecode.`)
    const hash = keccak256(code as `0x${string}`)
    if (hash.toLowerCase() !== enforcer.codeHash.toLowerCase())
      throw new Error(
        `${enforcer.name} at ${enforcer.address} runs code we did not pin: expected ${enforcer.codeHash}, got ${hash}. Refuse every T0 claim until this is reviewed.`,
      )

    const answer = await client.request<string>('eth_call', [
      { to: deployment.registry, data: encodeAddressOf(enforcer.name) },
      'latest',
    ])
    const resolved = addressFromWord(answer)
    if (resolved !== enforcer.address.toLowerCase())
      throw new Error(
        `Registry resolves ${enforcer.name} to ${resolved}, not ${enforcer.address}. The object the UI checks T0 against disagrees with this config.`,
      )

    checked.push({ name: enforcer.name, address: enforcer.address, codeHash: hash })
  }
  return checked
}

/**
 * What a mandate enforced by this deployment may honestly say it is.
 *
 * T0 means the chain refuses the transaction. That is only a claim worth making
 * where the chain in question is the one holding the value, so an unaudited
 * testnet deployment yields T0 with the network named, never T0 unqualified.
 */
export function enforcementClaim(deployment: EnforcerDeployment): {
  tier: 'T0' | 'T2'
  qualifier: string | null
} {
  if (deployment.network !== 'mainnet')
    return { tier: 'T0', qualifier: 'on BNB testnet, against contracts nobody has audited' }
  if (!deployment.audited) return { tier: 'T0', qualifier: 'against contracts nobody has audited' }
  return { tier: 'T0', qualifier: null }
}
