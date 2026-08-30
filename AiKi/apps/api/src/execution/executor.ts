import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
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
 * The relayer key pays gas and nothing else. It is not an owner, not a delegate,
 * and holds no authority over the account: if it were compromised the worst it
 * could do is submit a redemption the user had already signed and the caveats
 * already permit. That is the whole reason the signing and the sending are
 * separate keys.
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

const DELEGATION_ABI = [
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

const DELEGATION_TUPLE = {
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
  /** Pays gas. Holds no authority over the account. */
  relayerKey: Hex
  delegation: SignedDelegation
  action: Action
  callData: Hex
}

export interface ExecutionOutcome {
  /**
   * Three outcomes, not two.
   *
   * `landed` and `reverted` both describe a transaction that exists: it is in a
   * block, it cost gas, and it can be linked to. `refused` is the node declining
   * to accept it in the first place, usually because simulation showed it would
   * revert. Nothing was submitted and nothing was spent.
   *
   * Collapsing the last two into `reverted` meant reporting a transaction hash
   * of `0x` for something that never happened, which is a receipt citing
   * evidence that does not exist.
   */
  status: 'landed' | 'reverted' | 'refused'
  /** Absent when nothing was ever submitted. */
  transactionHash?: Hex
  gasUsed: bigint
  /** Present when the chain refused, carrying whatever it said. */
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
  const execution = encodeSingleExecution(request.action.target as Address, 0n, request.callData)
  const data = encodeFunctionData({
    abi: DELEGATION_ABI,
    functionName: 'redeemDelegations',
    args: [
      [context],
      ['0x0000000000000000000000000000000000000000000000000000000000000000'],
      [execution],
    ],
  })

  try {
    const hash = await wallet.sendTransaction({ to: request.delegationManager, data })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    return {
      status: receipt.status === 'success' ? 'landed' : 'reverted',
      transactionHash: hash,
      gasUsed: receipt.gasUsed,
    }
  } catch (error) {
    // The node would not take it, so there is no transaction and no hash to
    // give. Saying `reverted` with an empty hash would invite a caller to link
    // to something that was never on chain.
    return {
      status: 'refused',
      gasUsed: 0n,
      revertReason:
        error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error),
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
