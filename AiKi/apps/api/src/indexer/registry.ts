/**
 * ERC-8004 IdentityRegistry indexer — reads the chain directly.
 *
 * 8004scan is a convenience, not a dependency. This is the authoritative path:
 * the registry contract is the source of truth and we index it ourselves.
 *
 * Facts this is built around, all measured rather than assumed:
 *
 *  - `totalSupply()` REVERTS. The registry is not ERC721Enumerable, so you cannot
 *    walk 1..totalSupply(). You must index `Registered` events.
 *
 *  - `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`
 *    — agentId is topics[1], owner is topics[2], agentURI is the ABI-encoded string
 *    in data. Both key fields ARE indexed, so per-agent log filters work.
 *
 *  - `eth_getLogs` is DISABLED on the official BSC dataseeds and capped elsewhere:
 *    25 blocks (blockrazor), 50 (1rpc), 5,000 (publicnode), 50,000 (NodeReal).
 *    At 0.45s/block a 5,000-block window is only ~37 minutes of chain.
 *
 *  - `finalized` trails `latest` by 2 blocks; worst-case honest reorg is 8 blocks
 *    (one validator turn). Index against `finalized` and treat anything newer as
 *    provisional.
 */

import { BSC_MAINNET } from '../config/chains.js'

const REGISTRY = BSC_MAINNET.contracts.erc8004Identity
const TOPIC_REGISTERED = '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a'

/** Worst-case honest reorg depth: one validator turn (turnLength = 8). */
export const REORG_DEPTH = 8

export interface RegisteredEvent {
  agentId: string
  owner: string
  agentURI: string
  blockNumber: number
  logIndex: number
  txHash: string
}

export interface RpcConfig {
  url: string
  /** Max block span per eth_getLogs call. Probed at startup if omitted. */
  maxSpan?: number
  /** Optional inclusive ceiling for safe bounded historical verification. */
  stopAtBlock?: number
}

/** Thrown when the provider serves the tip but gates historical state. */
export class ArchiveRequiredError extends Error {
  constructor(
    readonly provider: string,
    readonly fromBlock: number,
  ) {
    super(
      `Block ${fromBlock.toLocaleString()} is behind ${provider}'s archive boundary. ` +
        'Free BSC endpoints serve roughly the last 10,000 blocks (~75 minutes at ' +
        '0.45s/block); anything older needs a paid archive node. Set BSC_RPC_URL to ' +
        'an archive provider (NodeReal MegaNode includes archive on every tier).',
    )
    this.name = 'ArchiveRequiredError'
  }
}

const ARCHIVE_HINTS = ['archive', 'personal token', 'missing trie node', 'header not found']

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = (await res.json()) as { result?: T; error?: { message: string } }
  if (json.error) {
    const msg = json.error.message
    if (ARCHIVE_HINTS.some((h) => msg.toLowerCase().includes(h))) {
      const from = (params[0] as { fromBlock?: string })?.fromBlock
      throw new ArchiveRequiredError(new URL(url).host, from ? Number(from) : 0)
    }
    throw new Error(`${method}: ${msg}`)
  }
  return json.result as T
}

export async function blockNumber(url: string, tag = 'latest'): Promise<number> {
  if (tag === 'latest') return Number(await rpc<string>(url, 'eth_blockNumber', []))
  const b = await rpc<{ number: string }>(url, 'eth_getBlockByNumber', [tag, false])
  return Number(b.number)
}

/**
 * Discover the provider's eth_getLogs span cap by bisection.
 *
 * Caps vary by two orders of magnitude between providers and the error strings are
 * not standardised, so probing beats parsing messages or hard-coding a number.
 */
export async function probeMaxSpan(url: string, ceiling = 50_000): Promise<number> {
  const head = await blockNumber(url)
  let lo = 1
  let hi = ceiling
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    try {
      await rpc(url, 'eth_getLogs', [
        {
          address: REGISTRY,
          topics: [TOPIC_REGISTERED],
          fromBlock: `0x${(head - mid + 1).toString(16)}`,
          toBlock: `0x${head.toString(16)}`,
        },
      ])
      lo = mid
    } catch {
      hi = mid - 1
    }
  }
  return lo
}

/** Strip ABI padding from an indexed address topic. */
const topicToAddress = (t: string) => `0x${t.slice(26)}`

/**
 * Decode the ABI-encoded `string agentURI` from a log's data field.
 * Layout: [32B offset][32B length][content, right-padded to 32B].
 */
function decodeStringData(data: string): string {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const offset = Number.parseInt(hex.slice(0, 64), 16) * 2
  const length = Number.parseInt(hex.slice(offset, offset + 64), 16)
  const bytes = hex.slice(offset + 64, offset + 64 + length * 2)
  return Buffer.from(bytes, 'hex').toString('utf8')
}

export function decodeRegistered(log: {
  topics: string[]
  data: string
  blockNumber: string
  logIndex: string
  transactionHash: string
}): RegisteredEvent {
  const agentIdTopic = log.topics[1]
  const ownerTopic = log.topics[2]
  if (!agentIdTopic || !ownerTopic) throw new Error('Registered log missing indexed topics')
  return {
    agentId: BigInt(agentIdTopic).toString(),
    owner: topicToAddress(ownerTopic),
    agentURI: decodeStringData(log.data),
    blockNumber: Number(log.blockNumber),
    logIndex: Number(log.logIndex),
    txHash: log.transactionHash,
  }
}

/** Fetch one window of Registered events. */
export async function fetchWindow(
  url: string,
  fromBlock: number,
  toBlock: number,
): Promise<RegisteredEvent[]> {
  const logs = await rpc<
    { topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string }[]
  >(url, 'eth_getLogs', [
    {
      address: REGISTRY,
      topics: [TOPIC_REGISTERED],
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
    },
  ])
  return logs.map(decodeRegistered)
}

export interface Checkpoint {
  lastIndexedBlock: number
  agentsSeen: number
}

/**
 * Walk the registry from `fromBlock` to the finalized head, yielding batches.
 *
 * Stops at `finalized` rather than `latest` so nothing provisional enters the
 * evidence store unflagged — a reorg would otherwise silently corrupt scores.
 */
export async function* indexRegistry(
  cfg: RpcConfig,
  fromBlock: number,
  onProgress?: (c: Checkpoint) => void,
): AsyncGenerator<RegisteredEvent[]> {
  const span = cfg.maxSpan ?? (await probeMaxSpan(cfg.url))
  const finalizedHead = await blockNumber(cfg.url, 'finalized')
  const finalized = cfg.stopAtBlock === undefined ? finalizedHead : Math.min(cfg.stopAtBlock, finalizedHead)

  let cursor = fromBlock
  let seen = 0

  while (cursor <= finalized) {
    const to = Math.min(cursor + span - 1, finalized)
    let batch: RegisteredEvent[] = []
    try {
      batch = await fetchWindow(cfg.url, cursor, to)
    } catch (err) {
      if (err instanceof ArchiveRequiredError) throw err
      // Narrow and retry once — providers sometimes cap by response size, not span.
      const half = Math.max(1, Math.floor((to - cursor) / 2))
      batch = await fetchWindow(cfg.url, cursor, cursor + half)
      cursor = cursor + half + 1
      seen += batch.length
      onProgress?.({ lastIndexedBlock: cursor - 1, agentsSeen: seen })
      yield batch
      continue
    }
    seen += batch.length
    cursor = to + 1
    onProgress?.({ lastIndexedBlock: to, agentsSeen: seen })
    if (batch.length) yield batch
  }
}

export { REGISTRY, TOPIC_REGISTERED }
