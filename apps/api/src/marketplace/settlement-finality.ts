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

export class ViemSettlementFinalityReader implements SettlementFinalityReader {
  private readonly client: ReturnType<typeof createPublicClient>

  constructor(rpcUrl: string) {
    this.client = createPublicClient({ chain: bsc, transport: http(rpcUrl) })
  }

  async finalizedReceipt(hash: Hex): Promise<FinalizedTransactionReceipt | null> {
    const receipt = await this.client.getTransactionReceipt({ hash }).catch(() => null)
    if (!receipt) return null

    const finalized = await this.client.getBlock({ blockTag: 'finalized' }).catch(() => null)
    if (!finalized || receipt.blockNumber > finalized.number) return null

    return {
      status: receipt.status === 'success' ? 'success' : 'reverted',
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      logs: receipt.logs.map((log) => ({
        address: log.address.toLowerCase() as `0x${string}`,
        topics: log.topics,
        data: log.data,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
      })),
    }
  }
}
