import { createHash } from 'node:crypto'
import { decodeFunctionData, encodeFunctionData, parseAbi } from 'viem'

/**
 * Deliberately not connected to routes, a wallet, or the settlement worker.
 * Provider identity must be refreshed from finalized ownerOf/tokenURI before
 * a future checkout. Pins are an integration policy, not a perpetual attestation.
 *
 * Public contract: https://agent.brainonbnb.com/.well-known/agent-card.json
 * Price dialect: POST /a2a message/send, data.skill=negotiate. The observed
 * flat result has NO signature, task/buyer binding, or quote expiry.
 * ABI: https://github.com/bnb-chain/apex-contracts/tree/main/abis
 * Historical sample: job 56657, submit tx 0x80c290345614577371b9268f872cf0a457dedbd45114f12f60a5342d98edffd6.
 * Its complete JSON is in submit.optParams; SHA-256, not keccak256, is the
 * deliverable. Byte equality and the hash were independently checked on BSC.
 */
export const BRAIN_HEALTH_PROVIDER = Object.freeze({
  agentId: '302257',
  chainId: 56,
  registry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  provider: '0x73809f69916fcf7ddc5bb1315fbdf96a569a5963',
  endpoint: 'https://agent.brainonbnb.com/a2a',
  commerce: '0xea4daa3100a767e86fded867729ae7446476eba6',
  evaluatorRouter: '0x51895229e12f9876011789b04f8698af06ccd6da',
  policy: '0x9c01845705b3078aa2e8cff7520a6376fd766de5',
  paymentToken: '0xce24439f2d9c6a2289f741120fe202248b666666',
  decimals: 18,
  priceAtomic: '100000000000000000',
  service: 'health_factor',
} as const)

const MAX_DOCUMENT_BYTES = 512 * 1024
const MAX_FINALITY_AGE_SECONDS = 120n
const TASK_PREFIX = 'health factor and liquidation distance for the Venus position of '
const SUBMIT_ABI = parseAbi([
  'function submit(uint256 jobId, bytes32 deliverable, bytes optParams)',
])
const fail = (): never => {
  throw new Error('Brain provider evidence could not be verified.')
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
const address = (value: unknown): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value))
    return fail()
  return value.toLowerCase()
}
const hash = (value: unknown): `0x${string}` => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value) || /^0x0{64}$/i.test(value))
    return fail()
  return value.toLowerCase() as `0x${string}`
}
const uint = (value: unknown): bigint => {
  if (
    typeof value !== 'bigint' &&
    (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value))
  )
    return fail()
  const result = BigInt(value)
  if (result < 0n || result >= 1n << 256n) return fail()
  return result
}
const requestId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return fail()
  return value
}
const block = (value: unknown) => {
  const item = record(value)
  return { number: uint(item.number), hash: hash(item.hash), timestamp: uint(item.timestamp) }
}

/** Price discovery only; never notify_funded or any stateful service skill. */
export function buildBrainHealthNegotiation(input: { account: string; requestId: string }) {
  const id = requestId(input.requestId)
  const account = address(input.account)
  return {
    jsonrpc: '2.0',
    id,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        kind: 'message',
        messageId: id,
        parts: [
          {
            kind: 'data',
            data: { skill: 'negotiate', task_description: `${TASK_PREFIX}${account}` },
          },
        ],
      },
    },
  } as const
}

/**
 * This establishes a matching unsigned price response, not an enforceable
 * provider commitment. Additional instructions, URLs, calls, claimed signatures
 * and claimed expiries are deliberately neither interpreted nor returned.
 */
export function parseBrainHealthPriceResponse(raw: unknown, expectedRequestId: string) {
  const response = record(raw)
  if (
    response.jsonrpc !== '2.0' ||
    response.id !== requestId(expectedRequestId) ||
    'error' in response
  )
    return fail()
  const result = record(response.result)
  const pin = BRAIN_HEALTH_PROVIDER
  if (
    result.accepted !== true ||
    address(result.provider) !== pin.provider ||
    result.chain_id !== pin.chainId ||
    address(result.verifying_contract) !== pin.commerce ||
    address(result.payment_token) !== pin.paymentToken ||
    result.service !== pin.service ||
    result.price !== pin.priceAtomic
  )
    return fail()
  const estimate = result.estimated_completion_seconds
  if (
    typeof estimate !== 'number' ||
    !Number.isSafeInteger(estimate) ||
    estimate < 1 ||
    estimate > 86_400
  )
    return fail()
  return Object.freeze({
    kind: 'unsigned_price_discovery' as const,
    agentId: pin.agentId,
    chainId: pin.chainId,
    provider: pin.provider,
    service: pin.service,
    priceAtomic: pin.priceAtomic,
    paymentToken: pin.paymentToken,
    decimals: pin.decimals,
    estimatedCompletionSeconds: estimate,
    providerCommitment: 'not_verified' as const,
    providerQuoteExpiry: null,
  })
}

export interface BrainDeliveryEvidence {
  expected: { client: string; account: string; jobId: string }
  nowSeconds: bigint
  /** Trusted RPC chain id and a fresh, canonical, finalized block. */
  finalizedBlock: unknown
  /** Trusted getJob read: { chainId, contract, blockNumber, blockHash, value }. */
  job: unknown
  /** Trusted RPC transaction/receipt and canonical getBlock(receipt.blockNumber). */
  transaction: unknown
  receipt: unknown
  receiptBlock: unknown
  documentBytes: Uint8Array
}

/**
 * Pure consistency verification, NOT an RPC/finality oracle. A caller must
 * obtain chain evidence from its own guarded public reader, never from the
 * provider or client, and recheck the finalized block before invoking this.
 * The result verifies delivery identity/bytes, not the report's financial truth.
 * No provider-controlled prose, URL, report values or calldata leave this helper.
 */
export function verifyBrainHealthDelivery(input: BrainDeliveryEvidence) {
  try {
    const pin = BRAIN_HEALTH_PROVIDER
    const client = address(input.expected.client)
    const account = address(input.expected.account)
    const jobId = uint(input.expected.jobId)
    if (jobId === 0n) return fail()
    const finality = block(input.finalizedBlock)
    const now = uint(input.nowSeconds)
    if (
      record(input.finalizedBlock).chainId !== pin.chainId ||
      finality.timestamp > now ||
      now - finality.timestamp > MAX_FINALITY_AGE_SECONDS
    )
      return fail()
    const snapshot = record(input.job)
    if (
      snapshot.chainId !== pin.chainId ||
      address(snapshot.contract) !== pin.commerce ||
      uint(snapshot.blockNumber) !== finality.number ||
      hash(snapshot.blockHash) !== finality.hash
    )
      return fail()
    const job = record(snapshot.value)
    if (
      uint(job.id) !== jobId ||
      address(job.client) !== client ||
      address(job.provider) !== pin.provider ||
      address(job.evaluator) !== pin.evaluatorRouter ||
      address(job.hook) !== pin.evaluatorRouter ||
      uint(job.budget).toString() !== pin.priceAtomic ||
      (job.status !== 2 && job.status !== 3) ||
      uint(job.submittedAt) === 0n ||
      uint(job.expiredAt) <= uint(job.submittedAt) ||
      typeof job.description !== 'string' ||
      Buffer.byteLength(job.description) > 4096
    )
      return fail()
    const description = record(JSON.parse(job.description))
    if (
      description.service !== pin.service ||
      typeof description.task !== 'string' ||
      !description.task.startsWith(TASK_PREFIX) ||
      address(description.task.slice(TASK_PREFIX.length)) !== account
    )
      return fail()
    const transaction = record(input.transaction)
    const receipt = record(input.receipt)
    const canonicalReceiptBlock = block(input.receiptBlock)
    const txHash = hash(transaction.hash)
    if (
      transaction.chainId !== pin.chainId ||
      address(transaction.from) !== pin.provider ||
      address(transaction.to) !== pin.commerce ||
      receipt.status !== 'success' ||
      hash(receipt.transactionHash) !== txHash ||
      address(receipt.from) !== pin.provider ||
      address(receipt.to) !== pin.commerce ||
      uint(transaction.blockNumber) !== canonicalReceiptBlock.number ||
      uint(receipt.blockNumber) !== canonicalReceiptBlock.number ||
      hash(transaction.blockHash) !== canonicalReceiptBlock.hash ||
      hash(receipt.blockHash) !== canonicalReceiptBlock.hash ||
      canonicalReceiptBlock.number > finality.number ||
      canonicalReceiptBlock.timestamp > finality.timestamp ||
      (canonicalReceiptBlock.number === finality.number &&
        (canonicalReceiptBlock.hash !== finality.hash ||
          canonicalReceiptBlock.timestamp !== finality.timestamp)) ||
      uint(job.submittedAt) !== canonicalReceiptBlock.timestamp
    )
      return fail()
    const bytes = input.documentBytes
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_DOCUMENT_BYTES
    )
      return fail()
    const documentSha256 = `0x${createHash('sha256').update(bytes).digest('hex')}` as const
    if (documentSha256 !== hash(job.deliverable)) return fail()
    if (
      typeof transaction.input !== 'string' ||
      transaction.input.length > MAX_DOCUMENT_BYTES * 2 + 1024 ||
      !/^0x(?:[0-9a-f]{2})+$/i.test(transaction.input)
    )
      return fail()
    const data = transaction.input.toLowerCase() as `0x${string}`
    const decoded = decodeFunctionData({ abi: SUBMIT_ABI, data })
    if (
      decoded.functionName !== 'submit' ||
      decoded.args[0] !== jobId ||
      decoded.args[1] !== documentSha256 ||
      !Buffer.from(decoded.args[2].slice(2), 'hex').equals(Buffer.from(bytes)) ||
      encodeFunctionData({ abi: SUBMIT_ABI, functionName: 'submit', args: decoded.args }) !== data
    )
      return fail()
    const document = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    const result = record(document.result)
    const position = record(result.position)
    if (
      uint(document.job_id) !== jobId ||
      document.service !== pin.service ||
      address(document.client) !== client ||
      address(document.provider) !== pin.provider ||
      result.service !== pin.service ||
      address(position.account) !== account ||
      position.chain !== 'eip155:56'
    )
      return fail()
    return Object.freeze({
      kind: 'verified_delivery_binding' as const,
      agentId: pin.agentId,
      chainId: pin.chainId,
      service: pin.service,
      provider: pin.provider,
      client,
      account,
      jobId: jobId.toString(),
      documentSha256,
      transactionHash: txHash,
      receiptBlockNumber: canonicalReceiptBlock.number.toString(),
      finalizedBlockNumber: finality.number.toString(),
      finalizedBlockHash: finality.hash,
      settlementState: job.status === 3 ? ('COMPLETED' as const) : ('SUBMITTED' as const),
      reportAccuracy: 'not_independently_verified' as const,
    })
  } catch {
    return fail()
  }
}
