import { createPublicClient, createWalletClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'
import type { PreparedApexTransaction } from './apex.js'

export type SettlementSubmission = Readonly<{
  transactionHash: Hex
  transactionNonce: string | null
}>

export interface SettlementSubmitter {
  submit(transaction: PreparedApexTransaction): Promise<SettlementSubmission>
}

export class ViemSettlementSubmitter implements SettlementSubmitter {
  private readonly account: ReturnType<typeof privateKeyToAccount>
  private readonly publicClient: ReturnType<typeof createPublicClient>
  private readonly wallet: ReturnType<typeof createWalletClient>

  constructor(input: { rpcUrl: string; privateKey: Hex }) {
    this.account = privateKeyToAccount(input.privateKey)
    const transport = http(input.rpcUrl)
    this.publicClient = createPublicClient({ chain: bsc, transport })
    this.wallet = createWalletClient({ account: this.account, chain: bsc, transport })
  }

  async submit(transaction: PreparedApexTransaction): Promise<SettlementSubmission> {
    if (transaction.chainId !== bsc.id)
      throw new Error(`Prepared transaction targets chain ${transaction.chainId}, not ${bsc.id}.`)
    const hash = await this.wallet.sendTransaction({
      account: this.account,
      chain: bsc,
      to: transaction.to,
      data: transaction.data,
      value: 0n,
    })
    return {
      transactionHash: hash,
      transactionNonce: await this.readNonce(hash),
    }
  }

  private async readNonce(hash: Hex): Promise<string | null> {
    try {
      const tx = await this.publicClient.getTransaction({ hash })
      return tx.nonce.toString()
    } catch {
      return null
    }
  }
}
