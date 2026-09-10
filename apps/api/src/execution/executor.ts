import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Action } from '../authority/policy.js'

/**
 * The step that turns an allowed verdict into a transaction.
 *
 * Everything upstream of here decides whether an action is permitted; this is
 * the only place that makes one happen. It deliberately does not decide
 * anything: it is handed a delegation the user signed and an action the policy
 * engine already allowed, and its job is to put that on chain and report what
 * came back.
 *
 * The executor key pays gas and is the named delegate. It may redeem the user's
 * signed delegation within its on-chain caveats, but it is not the account
 * owner. Protect it as a spending credential, not merely a gas-paying key.
 */
export interface Caveat {
  enforcer: Address
  terms: Hex
  args: Hex
}

export interface SignedDelegation {
  delegate: Address
  delegator: Address
  authority: Hex
  caveats: Caveat[]
  salt: bigint
  epoch: bigint
  signature: Hex
}

export const DELEGATION_ABI = [
  {
    type: 'function',
    name: 'redeemDelegations',
    inputs: [
      { name: 'permissionContexts', type: 'bytes[]' },
      { name: 'modes', type: 'bytes32[]' },
      { name: 'executionCallDatas', type: 'bytes[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

export const DELEGATION_TUPLE = {
  type: 'tuple[]',
  components: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    {
      name: 'caveats',
      type: 'tuple[]',
      components: [
        { name: 'enforcer', type: 'address' },
        { name: 'terms', type: 'bytes' },
        { name: 'args', type: 'bytes' },
      ],
    },
    { name: 'salt', type: 'uint256' },
    { name: 'epoch', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
} as const

/** ERC-7579 single call: target, then value, then calldata, packed. */
export function encodeSingleExecution(target: Address, value: bigint, callData: Hex): Hex {
  const targetHex = target.toLowerCase().replace('0x', '')
  const valueHex = value.toString(16).padStart(64, '0')
  return `0x${targetHex}${valueHex}${callData.replace('0x', '')}` as Hex
}

export interface ExecutionRequest {
  rpcUrl: string
  chainId: number
  delegationManager: Address
  /** Pays gas and redeems permissions as the delegation's named delegate. */
  relayerKey: Hex
  delegation: SignedDelegation
  action: Action
  callData: Hex
  /** Persist the signed transaction hash before broadcasting. Never persist the signed bytes. */
  onPrepared?: (transactionHash: Hex) => Promise<void>
}

export interface ExecutionOutcome {
  /**
   * `landed` and `reverted` have a receipt for this exact signed transaction.
   * On BNB networks the receipt must also be canonical and finalized.
   * `refused` is a known failure before broadcasting, with no transfer or gas
   * spent. `unconfirmed` means submission or its result is uncertain. Its hash
   * and reserved spending limit must survive; it must not be sent again.
   */
  status: 'landed' | 'reverted' | 'refused' | 'unconfirmed'
  /** The prepared transaction's hash, including uncertain submissions. */
  transactionHash?: Hex
  gasUsed: bigint
  /** A safe refusal or uncertainty explanation. Never includes credentials. */
  revertReason?: string
}

/**
 * Submit one redemption and report what the chain did with it.
 *
 * A reverted transaction is returned, not thrown: the chain refusing an action
 * is a result worth recording against the job, and the enforcers' revert data
 * carries the same rule and reason the off-chain engine would have given.
 */
export async function execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
  return executeRedemption({ ...request, target: request.action.target as Address })
}

/** A vault operation is not a scalar ERC-20 spend. Its economic limits live in its immutable policy. */
export type RedemptionRequest = Omit<ExecutionRequest, 'action'> & {
  target: Address
  /** Optional hard limit on the maximum prepared gas charge, not an inner-call estimate. */
  maxGasCostWei?: bigint
}

export async function executeRedemption(request: RedemptionRequest): Promise<ExecutionOutcome> {
  const chain = {
    id: request.chainId,
    name: `chain-${request.chainId}`,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [request.rpcUrl] } },
  } as const

  const transport = http(request.rpcUrl)
  const publicClient = createPublicClient({ chain, transport })
  const wallet = createWalletClient({
    account: privateKeyToAccount(request.relayerKey),
    chain,
    transport,
  })

  const context = encodeAbiParameters([DELEGATION_TUPLE], [[request.delegation]])
  const execution = encodeSingleExecution(request.target, 0n, request.callData)
  const data = encodeFunctionData({
    abi: DELEGATION_ABI,
    functionName: 'redeemDelegations',
    args: [
      [context],
      ['0x0000000000000000000000000000000000000000000000000000000000000000'],
      [execution],
    ],
  })

  let signed: Hex
  let hash: Hex
  const requiresFinality = request.chainId === 56 || request.chainId === 97
  try {
    if (requiresFinality && (await publicClient.getChainId()) !== request.chainId)
      throw new Error('Execution RPC chain mismatch.')
    const prepared = await wallet.prepareTransactionRequest({
      to: request.delegationManager,
      data,
      // BSC supports legacy transactions. Select one fee model before viem's
      // eth_fillTransaction merge; ambiguous mixed-fee responses remain refused.
      ...(requiresFinality ? { type: 'legacy' as const } : {}),
    })
    if (request.maxGasCostWei !== undefined) {
      const fee = prepared.gasPrice ?? prepared.maxFeePerGas
      const positiveUint = (value: unknown): value is bigint =>
        typeof value === 'bigint' && value > 0n && value < 1n << 256n
      if (
        !positiveUint(request.maxGasCostWei) ||
        !positiveUint(prepared.gas) ||
        !positiveUint(fee) ||
        (prepared.gasPrice !== undefined && prepared.maxFeePerGas !== undefined) ||
        prepared.gas * fee > request.maxGasCostWei
      )
        throw new Error('Prepared transaction exceeds the strategy gas budget.')
    }
    signed = await wallet.signTransaction(prepared)
    hash = keccak256(signed)
    await request.onPrepared?.(hash)
  } catch {
    return {
      status: 'refused',
      gasUsed: 0n,
      revertReason: 'The transaction could not be prepared safely. Nothing was broadcast.',
    }
  }

  try {
    // Any exception from here is ambiguous: the RPC may accept a transaction
    // before its acknowledgement is lost. The pre-recorded hash survives it.
    await publicClient.sendRawTransaction({ serializedTransaction: signed })
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: 60_000,
      ...(requiresFinality ? { confirmations: 3 } : {}),
    })
    if (receipt.transactionHash?.toLowerCase() !== hash.toLowerCase())
      return {
        status: 'unconfirmed',
        transactionHash: hash,
        gasUsed: 0n,
        revertReason:
          'A different transaction used this nonce. Review the original hash before any further action.',
      }
    if (receipt.status !== 'success' && receipt.status !== 'reverted')
      throw new Error('Execution receipt outcome is unavailable.')
    if (requiresFinality) {
      const validHash = (value: unknown): value is Hex =>
        typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value)
      if (
        !validHash(receipt.blockHash) ||
        typeof receipt.blockNumber !== 'bigint' ||
        receipt.blockNumber < 0n
      )
        throw new Error('Execution receipt block identity is unavailable.')
      // Depth is not finality. An unavailable or lagging finalized checkpoint
      // keeps the signer locked even for a mined revert; there is no resend.
      const finalized = await publicClient.getBlock({ blockTag: 'finalized' })
      if (
        !finalized ||
        typeof finalized.number !== 'bigint' ||
        finalized.number < receipt.blockNumber ||
        !validHash(finalized.hash) ||
        (finalized.number === receipt.blockNumber &&
          finalized.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
      )
        throw new Error('Execution receipt is not finalized.')
      // Read canonicality AFTER the checkpoint to catch a branch change during
      // finality lookup. Neither replacement nor orphaned receipts unlock.
      const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
      if (
        !canonical ||
        canonical.number !== receipt.blockNumber ||
        !validHash(canonical.hash) ||
        canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
        (await publicClient.getChainId()) !== request.chainId
      )
        throw new Error('Execution receipt is not canonical on the configured chain.')
    }
    return {
      status: receipt.status === 'success' ? 'landed' : 'reverted',
      transactionHash: hash,
      gasUsed: receipt.gasUsed,
    }
  } catch {
    return {
      status: 'unconfirmed',
      transactionHash: hash,
      gasUsed: 0n,
      revertReason:
        'Transaction confirmation is unavailable. Do not send it again; the spending limit remains reserved for review.',
    }
  }
}

/** Calldata for an ERC-20 transfer, the only action shape v1 executes. */
/**
 * Repaying a loan, as opposed to sending money in the direction of one.
 *
 * A transfer to a vToken is a donation to the pool: the borrow is untouched and
 * the position is no healthier than before. This is the call that actually
 * reduces the debt, and it pulls the underlying from the account through an
 * allowance the owner granted, so nothing moves that the owner did not permit
 * twice over.
 */
export function venusRepayCall(amount: bigint): Hex {
  return encodeFunctionData({
    abi: parseAbi(['function repayBorrow(uint256 repayAmount) returns (uint256)']),
    functionName: 'repayBorrow',
    args: [amount],
  })
}

export function erc20TransferCall(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
    functionName: 'transfer',
    args: [to, amount],
  })
}
