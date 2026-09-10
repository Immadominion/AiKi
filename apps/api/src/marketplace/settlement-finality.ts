import { createPublicClient, type Hex, http } from 'viem'
import { bsc } from 'viem/chains'
import type { ApexReceiptLog } from './apex.js'

export type FinalizedTransactionReceipt = Readonly<{
  status: 'success' | 'reverted'
  transactionHash: Hex
  blockNumber: bigint
  blockHash: Hex
  logs: ApexReceiptLog[]
}>

export interface SettlementFinalityReader {
  finalizedReceipt(hash: Hex): Promise<FinalizedTransactionReceipt | null>
}

const HASH = /^0x[0-9a-f]{64}$/i
const isHash = (value: unknown): value is Hex =>
  typeof value === 'string' && HASH.test(value) && !/^0x0+$/i.test(value)
const sameHash = (a: unknown, b: Hex): boolean => isHash(a) && a.toLowerCase() === b.toLowerCase()
const blockIdentity = (value: { number: bigint | null; hash: Hex | null }) =>
  typeof value.number === 'bigint' && value.number >= 0n && isHash(value.hash)
    ? { number: value.number, hash: value.hash }
    : null

export class ViemSettlementFinalityReader implements SettlementFinalityReader {
  private readonly client: ReturnType<typeof createPublicClient>

  constructor(rpcUrl: string) {
    this.client = createPublicClient({ chain: bsc, transport: http(rpcUrl) })
  }

  async finalizedReceipt(hash: Hex): Promise<FinalizedTransactionReceipt | null> {
    try {
      if (!isHash(hash) || (await this.client.getChainId()) !== bsc.id) return null
      const receipt = await this.client.getTransactionReceipt({ hash })
      if (
        !sameHash(receipt.transactionHash, hash) ||
        !isHash(receipt.blockHash) ||
        typeof receipt.blockNumber !== 'bigint' ||
        receipt.blockNumber < 0n ||
        !['success', 'reverted'].includes(receipt.status) ||
        !Array.isArray(receipt.logs)
      )
        return null

      // Copy the checked evidence before further asynchronous reads. Never mix
      // foreign/removed logs into an otherwise matching settlement receipt.
      const result: FinalizedTransactionReceipt = {
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        logs: [],
      }
      const indices = new Set<number>()
      for (const log of receipt.logs) {
        if (
          !sameHash(log.transactionHash, result.transactionHash) ||
          !sameHash(log.blockHash, result.blockHash) ||
          log.blockNumber !== result.blockNumber ||
          (log.removed !== undefined && log.removed !== false) ||
          !Number.isSafeInteger(log.logIndex) ||
          log.logIndex < 0 ||
          indices.has(log.logIndex) ||
          !/^0x[0-9a-f]{40}$/i.test(log.address) ||
          !/^0x(?:[0-9a-f]{2})*$/i.test(log.data) ||
          !Array.isArray(log.topics) ||
          log.topics.some((topic) => typeof topic !== 'string' || !HASH.test(topic))
        )
          return null
        indices.add(log.logIndex)
        result.logs.push({
          address: log.address.toLowerCase() as Hex,
          topics: [...log.topics],
          data: log.data,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
        })
      }

      const finalized = blockIdentity(await this.client.getBlock({ blockTag: 'finalized' }))
      if (!finalized || result.blockNumber > finalized.number) return null
      const canonical = blockIdentity(
        await this.client.getBlock({ blockNumber: result.blockNumber }),
      )
      if (
        !canonical ||
        canonical.number !== result.blockNumber ||
        !sameHash(canonical.hash, result.blockHash)
      )
        return null

      // Height alone is not finality: the receipt and finalized anchor must
      // still be the same canonical blocks when this read completes.
      const [receiptBlock, finalizedBlock, chainId] = await Promise.all([
        this.client.getBlock({ blockNumber: result.blockNumber }).then(blockIdentity),
        this.client.getBlock({ blockNumber: finalized.number }).then(blockIdentity),
        this.client.getChainId(),
      ])
      if (
        chainId !== bsc.id ||
        !receiptBlock ||
        receiptBlock.number !== result.blockNumber ||
        !sameHash(receiptBlock.hash, result.blockHash) ||
        !finalizedBlock ||
        finalizedBlock.number !== finalized.number ||
        !sameHash(finalizedBlock.hash, finalized.hash)
      )
        return null
      return result
    } catch {
      // Missing receipts, unavailable finality and inconsistent RPC responses
      // are unverified, not a revert and never permission to move money again.
      return null
    }
  }
}
