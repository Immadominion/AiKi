import { decodeEventLog, encodeFunctionData, type Hex, parseAbi } from 'viem'
import { BSC_MAINNET } from '../config/chains.js'
import type { SettlementRail } from './settlement-rails.js'

export const APEX_COMMERCE_ABI = parseAbi([
  'function createJob(address provider, address evaluator, uint256 expiredAt, string metadata, address hook) returns (uint256)',
  'function fund(uint256 jobId, uint256 amount, bytes optParams)',
  'function submit(uint256 jobId, bytes32 deliverable, bytes optParams)',
  'function complete(uint256 jobId, bytes32 reason, bytes optParams)',
  'function reject(uint256 jobId, bytes32 reason, bytes optParams)',
  'function claimRefund(uint256 jobId)',
  'function paymentToken() view returns (address)',
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)',
  'event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)',
  'event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)',
  'event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)',
  'event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)',
])

export type PreparedApexCreateEscrowTransaction = Readonly<{
  chainId: number
  to: `0x${string}`
  data: Hex
  value: '0'
  functionName: 'createJob'
  args: {
    provider: `0x${string}`
    evaluator: `0x${string}`
    expiredAt: string
    metadata: string
    hook: `0x${string}`
  }
}>

export type PreparedApexFundTransaction = Readonly<{
  chainId: number
  to: `0x${string}`
  data: Hex
  value: '0'
  functionName: 'fund'
  args: {
    externalJobId: string
    amount: string
    optParams: Hex
  }
}>

export type PreparedApexSubmitTransaction = Readonly<{
  chainId: number
  to: `0x${string}`
  data: Hex
  value: '0'
  functionName: 'submit'
  args: {
    externalJobId: string
    deliverable: Hex
    optParams: Hex
  }
}>

export type PreparedApexCompleteTransaction = Readonly<{
  chainId: number
  to: `0x${string}`
  data: Hex
  value: '0'
  functionName: 'complete'
  args: {
    externalJobId: string
    reason: Hex
    optParams: Hex
  }
}>

export type PreparedApexTransaction =
  | PreparedApexCreateEscrowTransaction
  | PreparedApexFundTransaction
  | PreparedApexSubmitTransaction
  | PreparedApexCompleteTransaction

export type ApexReceiptLog = Readonly<{
  address: `0x${string}`
  topics: readonly Hex[]
  data: Hex
  transactionHash: Hex
  logIndex: number
  blockNumber: bigint
  blockHash: Hex
}>

export type ApexJobCreated = Readonly<{
  externalJobId: string
  client: `0x${string}`
  provider: `0x${string}`
  evaluator: `0x${string}`
  expiredAt: string
  hook: `0x${string}`
  log: ApexReceiptLog
}>

export type ApexJobFunded = Readonly<{
  externalJobId: string
  client: `0x${string}`
  amount: string
  log: ApexReceiptLog
}>

export type ApexJobSubmitted = Readonly<{
  externalJobId: string
  provider: `0x${string}`
  deliverable: Hex
  log: ApexReceiptLog
}>

export type ApexJobCompleted = Readonly<{
  externalJobId: string
  evaluator: `0x${string}`
  reason: Hex
  log: ApexReceiptLog
}>

export type ApexPaymentReleased = Readonly<{
  externalJobId: string
  provider: `0x${string}`
  amount: string
  log: ApexReceiptLog
}>

const lowerAddress = (value: `0x${string}`): `0x${string}` => value.toLowerCase() as `0x${string}`

export function agreementMetadata(input: {
  jobId: string
  agreementId: string
  termsHash: string
}): string {
  return `aiki://marketplace/jobs/${input.jobId}/agreements/${input.agreementId}?termsHash=${input.termsHash}`
}

export function prepareApexCreateEscrow(input: {
  rail: SettlementRail
  jobId: string
  agreementId: string
  provider: `0x${string}`
  hardExpiry: string
  termsHash: string
}): PreparedApexCreateEscrowTransaction {
  const expiredAt = BigInt(Math.floor(new Date(input.hardExpiry).getTime() / 1000))
  const evaluator = lowerAddress(BSC_MAINNET.contracts.erc8183EvaluatorRouter)
  const hook = evaluator
  const metadata = agreementMetadata({
    jobId: input.jobId,
    agreementId: input.agreementId,
    termsHash: input.termsHash,
  })
  return {
    chainId: input.rail.chainId,
    to: input.rail.contract,
    data: encodeFunctionData({
      abi: APEX_COMMERCE_ABI,
      functionName: 'createJob',
      args: [lowerAddress(input.provider), evaluator, expiredAt, metadata, hook],
    }),
    value: '0',
    functionName: 'createJob',
    args: {
      provider: lowerAddress(input.provider),
      evaluator,
      expiredAt: expiredAt.toString(),
      metadata,
      hook,
    },
  }
}

export function prepareApexFund(input: {
  rail: SettlementRail
  externalJobId: string
  amount: string
}): PreparedApexFundTransaction {
  const externalJobId = BigInt(input.externalJobId)
  const amount = BigInt(input.amount)
  const optParams = '0x'
  return {
    chainId: input.rail.chainId,
    to: input.rail.contract,
    data: encodeFunctionData({
      abi: APEX_COMMERCE_ABI,
      functionName: 'fund',
      args: [externalJobId, amount, optParams],
    }),
    value: '0',
    functionName: 'fund',
    args: {
      externalJobId: externalJobId.toString(),
      amount: amount.toString(),
      optParams,
    },
  }
}

export function prepareApexSubmit(input: {
  rail: SettlementRail
  externalJobId: string
  deliverable: string
}): PreparedApexSubmitTransaction {
  const externalJobId = BigInt(input.externalJobId)
  const deliverable = `0x${input.deliverable}` as Hex
  if (!/^0x[0-9a-f]{64}$/.test(deliverable))
    throw new Error('APEX submit deliverable must be bytes32.')
  const optParams = '0x'
  return {
    chainId: input.rail.chainId,
    to: input.rail.contract,
    data: encodeFunctionData({
      abi: APEX_COMMERCE_ABI,
      functionName: 'submit',
      args: [externalJobId, deliverable, optParams],
    }),
    value: '0',
    functionName: 'submit',
    args: {
      externalJobId: externalJobId.toString(),
      deliverable,
      optParams,
    },
  }
}

export function prepareApexComplete(input: {
  rail: SettlementRail
  externalJobId: string
  reason: string
}): PreparedApexCompleteTransaction {
  const externalJobId = BigInt(input.externalJobId)
  const reason = `0x${input.reason}` as Hex
  if (!/^0x[0-9a-f]{64}$/.test(reason)) throw new Error('APEX complete reason must be bytes32.')
  const optParams = '0x'
  return {
    chainId: input.rail.chainId,
    to: input.rail.contract,
    data: encodeFunctionData({
      abi: APEX_COMMERCE_ABI,
      functionName: 'complete',
      args: [externalJobId, reason, optParams],
    }),
    value: '0',
    functionName: 'complete',
    args: {
      externalJobId: externalJobId.toString(),
      reason,
      optParams,
    },
  }
}

export function parseApexJobCreated(input: {
  contract: `0x${string}`
  transactionHash: Hex
  logs: readonly ApexReceiptLog[]
}): ApexJobCreated {
  const contract = lowerAddress(input.contract)
  for (const log of input.logs) {
    if (lowerAddress(log.address) !== contract) continue
    let decoded: ReturnType<typeof decodeEventLog>
    try {
      const topics = log.topics as [`0x${string}`, ...`0x${string}`[]]
      decoded = decodeEventLog({
        abi: APEX_COMMERCE_ABI,
        data: log.data,
        topics,
      })
    } catch {
      continue
    }
    if (decoded.eventName !== 'JobCreated') continue
    const args = decoded.args as {
      jobId: bigint
      client: `0x${string}`
      provider: `0x${string}`
      evaluator: `0x${string}`
      expiredAt: bigint
      hook: `0x${string}`
    }
    if (lowerAddress(log.transactionHash) !== lowerAddress(input.transactionHash)) {
      throw new Error('JobCreated log transaction hash does not match the settlement operation.')
    }
    return {
      externalJobId: args.jobId.toString(),
      client: lowerAddress(args.client),
      provider: lowerAddress(args.provider),
      evaluator: lowerAddress(args.evaluator),
      expiredAt: args.expiredAt.toString(),
      hook: lowerAddress(args.hook),
      log,
    }
  }
  throw new Error('No APEX JobCreated event found in the finalized transaction receipt.')
}

export function parseApexJobFunded(input: {
  contract: `0x${string}`
  transactionHash: Hex
  logs: readonly ApexReceiptLog[]
}): ApexJobFunded {
  const contract = lowerAddress(input.contract)
  for (const log of input.logs) {
    if (lowerAddress(log.address) !== contract) continue
    let decoded: ReturnType<typeof decodeEventLog>
    try {
      const topics = log.topics as [`0x${string}`, ...`0x${string}`[]]
      decoded = decodeEventLog({
        abi: APEX_COMMERCE_ABI,
        data: log.data,
        topics,
      })
    } catch {
      continue
    }
    if (decoded.eventName !== 'JobFunded') continue
    const args = decoded.args as {
      jobId: bigint
      client: `0x${string}`
      amount: bigint
    }
    if (lowerAddress(log.transactionHash) !== lowerAddress(input.transactionHash)) {
      throw new Error('JobFunded log transaction hash does not match the settlement operation.')
    }
    return {
      externalJobId: args.jobId.toString(),
      client: lowerAddress(args.client),
      amount: args.amount.toString(),
      log,
    }
  }
  throw new Error('No APEX JobFunded event found in the finalized transaction receipt.')
}

export function parseApexJobSubmitted(input: {
  contract: `0x${string}`
  transactionHash: Hex
  logs: readonly ApexReceiptLog[]
}): ApexJobSubmitted {
  const contract = lowerAddress(input.contract)
  for (const log of input.logs) {
    if (lowerAddress(log.address) !== contract) continue
    let decoded: ReturnType<typeof decodeEventLog>
    try {
      const topics = log.topics as [`0x${string}`, ...`0x${string}`[]]
      decoded = decodeEventLog({
        abi: APEX_COMMERCE_ABI,
        data: log.data,
        topics,
      })
    } catch {
      continue
    }
    if (decoded.eventName !== 'JobSubmitted') continue
    const args = decoded.args as {
      jobId: bigint
      provider: `0x${string}`
      deliverable: Hex
    }
    if (lowerAddress(log.transactionHash) !== lowerAddress(input.transactionHash)) {
      throw new Error('JobSubmitted log transaction hash does not match the settlement operation.')
    }
    return {
      externalJobId: args.jobId.toString(),
      provider: lowerAddress(args.provider),
      deliverable: args.deliverable.toLowerCase() as Hex,
      log,
    }
  }
  throw new Error('No APEX JobSubmitted event found in the finalized transaction receipt.')
}

export function parseApexJobCompleted(input: {
  contract: `0x${string}`
  transactionHash: Hex
  logs: readonly ApexReceiptLog[]
}): ApexJobCompleted {
  const contract = lowerAddress(input.contract)
  for (const log of input.logs) {
    if (lowerAddress(log.address) !== contract) continue
    let decoded: ReturnType<typeof decodeEventLog>
    try {
      const topics = log.topics as [`0x${string}`, ...`0x${string}`[]]
      decoded = decodeEventLog({
        abi: APEX_COMMERCE_ABI,
        data: log.data,
        topics,
      })
    } catch {
      continue
    }
    if (decoded.eventName !== 'JobCompleted') continue
    const args = decoded.args as {
      jobId: bigint
      evaluator: `0x${string}`
      reason: Hex
    }
    if (lowerAddress(log.transactionHash) !== lowerAddress(input.transactionHash)) {
      throw new Error('JobCompleted log transaction hash does not match the settlement operation.')
    }
    return {
      externalJobId: args.jobId.toString(),
      evaluator: lowerAddress(args.evaluator),
      reason: args.reason.toLowerCase() as Hex,
      log,
    }
  }
  throw new Error('No APEX JobCompleted event found in the finalized transaction receipt.')
}

export function parseApexPaymentReleased(input: {
  contract: `0x${string}`
  transactionHash: Hex
  logs: readonly ApexReceiptLog[]
}): ApexPaymentReleased {
  const contract = lowerAddress(input.contract)
  for (const log of input.logs) {
    if (lowerAddress(log.address) !== contract) continue
    let decoded: ReturnType<typeof decodeEventLog>
    try {
      const topics = log.topics as [`0x${string}`, ...`0x${string}`[]]
      decoded = decodeEventLog({
        abi: APEX_COMMERCE_ABI,
        data: log.data,
        topics,
      })
    } catch {
      continue
    }
    if (decoded.eventName !== 'PaymentReleased') continue
    const args = decoded.args as {
      jobId: bigint
      provider: `0x${string}`
      amount: bigint
    }
    if (lowerAddress(log.transactionHash) !== lowerAddress(input.transactionHash)) {
      throw new Error(
        'PaymentReleased log transaction hash does not match the settlement operation.',
      )
    }
    return {
      externalJobId: args.jobId.toString(),
      provider: lowerAddress(args.provider),
      amount: args.amount.toString(),
      log,
    }
  }
  throw new Error('No APEX PaymentReleased event found in the finalized transaction receipt.')
}
