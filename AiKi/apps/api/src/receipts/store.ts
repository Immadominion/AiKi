import type { ExecutionReceipt } from './service.js'

/**
 * Where signed receipts live.
 *
 * A receipt is returned exactly as it was signed. Rebuilding one from typed
 * columns would reformat its timestamps and invalidate the signature, so
 * implementations must round-trip the body verbatim.
 */
export interface ReceiptStore {
  put(receipt: ExecutionReceipt): Promise<void>
  get(id: string): Promise<ExecutionReceipt | null>
}

export class InMemoryReceiptStore implements ReceiptStore {
  private readonly receipts = new Map<string, string>()

  async put(receipt: ExecutionReceipt) {
    this.receipts.set(receipt.receiptId, JSON.stringify(receipt))
  }

  async get(id: string) {
    const body = this.receipts.get(id)
    return body ? (JSON.parse(body) as ExecutionReceipt) : null
  }
}
