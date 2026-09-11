import { type Abi, createPublicClient, type Hex, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'
import { BSC_MAINNET } from '../config/chains.js'
import type { EvidenceStore } from '../evidence/types.js'
import { type CurrentRegistrationIdentity, persistVerification } from './evidence-sink.js'
import { probeAgent } from './probe.js'
import { resolveRegistration } from './registration.js'
import type { ProbeCandidate } from './sweep.js'

export interface CurrentRegistrationReader {
  getChainId(): Promise<number>
  getBlock(input: { blockTag: 'finalized' } | { blockNumber: bigint }): Promise<unknown>
  readContract(input: {
    address: Hex
    abi: Abi
    functionName: 'ownerOf' | 'tokenURI'
    args: readonly [bigint]
    blockNumber: bigint
  }): Promise<unknown>
}

const abi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
])
const failure = () =>
  new Error(
    'Current finalized registration could not be verified; no fresh probe evidence was recorded.',
  )
export const CURRENT_REGISTRATION_TIMEOUT_MS = 12_000
const MAX_URI_BYTES = 1024 * 1024
const MAX_FINALIZED_AGE_SECONDS = 120n

/** Public reads only. No wallet client, keys, transaction methods or retries. */
export function createCurrentRegistrationReader(rpcUrl: string): CurrentRegistrationReader {
  try {
    const client = createPublicClient({
      chain: bsc,
      ccipRead: false,
      batch: { multicall: false },
      cacheTime: 0,
      transport: http(rpcUrl, { timeout: 5_000, retryCount: 0 }),
    })
    return {
      getChainId: () => client.getChainId(),
      getBlock: (input) => client.getBlock(input),
      readContract: (input) => client.readContract(input),
    }
  } catch {
    throw failure()
  }
}

function blockIdentity(value: unknown) {
  if (!value || typeof value !== 'object') throw failure()
  const { number, hash, timestamp } = value as Record<string, unknown>
  if (
    typeof number !== 'bigint' ||
    number < 0n ||
    number >= 1n << 256n ||
    typeof timestamp !== 'bigint' ||
    timestamp < 0n ||
    typeof hash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(hash) ||
    /^0x0{64}$/.test(hash)
  )
    throw failure()
  return { number, hash: hash.toLowerCase() as Hex, timestamp }
}

/** Six bounded RPC reads; all identity state is read at one canonical finalized block. */
export async function readCurrentRegistration(
  candidate: ProbeCandidate,
  reader: CurrentRegistrationReader,
): Promise<CurrentRegistrationIdentity> {
  let expired = false
  const active = () => {
    if (expired) throw failure()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { chainId: candidateChain, registry, agentId } = candidate
    if (
      candidateChain !== 56 ||
      registry.toLowerCase() !== BSC_MAINNET.contracts.erc8004Identity.toLowerCase() ||
      !/^(0|[1-9][0-9]{0,77})$/.test(agentId) ||
      BigInt(agentId) >= 1n << 256n
    )
      throw failure()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true
        reject(failure())
      }, CURRENT_REGISTRATION_TIMEOUT_MS)
      timer.unref?.()
    })
    return await Promise.race([
      (async () => {
        if ((await reader.getChainId()) !== 56) throw failure()
        active()
        const block = blockIdentity(await reader.getBlock({ blockTag: 'finalized' }))
        active()
        const now = BigInt(Math.floor(Date.now() / 1000))
        if (block.timestamp > now || now - block.timestamp > MAX_FINALIZED_AGE_SECONDS)
          throw failure()
        const args = [BigInt(agentId)] as const
        const request = {
          address: BSC_MAINNET.contracts.erc8004Identity,
          abi,
          args,
          blockNumber: block.number,
        }
        const [owner, agentUri] = await Promise.all([
          reader.readContract({ ...request, functionName: 'ownerOf' }),
          reader.readContract({ ...request, functionName: 'tokenURI' }),
        ])
        active()
        if (
          typeof owner !== 'string' ||
          !/^0x[0-9a-fA-F]{40}$/.test(owner) ||
          /^0x0{40}$/.test(owner) ||
          typeof agentUri !== 'string' ||
          !agentUri ||
          agentUri.length > MAX_URI_BYTES ||
          Buffer.byteLength(agentUri, 'utf8') > MAX_URI_BYTES
        )
          throw failure()
        const [canonicalValue, chainId] = await Promise.all([
          reader.getBlock({ blockNumber: block.number }),
          reader.getChainId(),
        ])
        active()
        const canonical = blockIdentity(canonicalValue)
        if (
          chainId !== 56 ||
          canonical.number !== block.number ||
          canonical.hash !== block.hash ||
          canonical.timestamp !== block.timestamp
        )
          throw failure()
        return Object.freeze({
          chainId: 56 as const,
          registry: BSC_MAINNET.contracts.erc8004Identity.toLowerCase() as Hex,
          agentId,
          owner: owner.toLowerCase() as Hex,
          agentUri,
          block: Object.freeze({
            number: block.number.toString(),
            hash: block.hash,
            timestamp: block.timestamp.toString(),
            finality: 'finalized' as const,
          }),
        })
      })(),
      timeout,
    ])
  } catch {
    // Never emit provider URLs, RPC payloads, credentials, or revert diagnostics.
    throw failure()
  } finally {
    expired = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** No manifest fetch, agent request, or fresh evidence append precedes identity verification. */
export async function probeCurrentCandidate(
  candidate: ProbeCandidate,
  reader: CurrentRegistrationReader,
  store: EvidenceStore,
  dependencies: {
    resolve?: typeof resolveRegistration
    probe?: typeof probeAgent
  } = {},
): Promise<number> {
  const currentIdentity = await readCurrentRegistration(candidate, reader)
  const registration = await (dependencies.resolve ?? resolveRegistration)(currentIdentity.agentUri)
  const probe = await (dependencies.probe ?? probeAgent)({
    agentId: currentIdentity.agentId,
    registry: `eip155:${currentIdentity.chainId}:${currentIdentity.registry}`,
    services: registration.manifest?.services ?? [],
    agentUri: currentIdentity.agentUri,
  })
  return (
    await persistVerification(store, {
      chainId: currentIdentity.chainId,
      registry: currentIdentity.registry,
      agentId: currentIdentity.agentId,
      registration,
      probe,
      identityVerified: true,
      currentIdentity,
    })
  ).observationsInserted
}
