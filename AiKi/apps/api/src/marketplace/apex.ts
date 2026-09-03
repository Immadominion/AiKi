import { encodeFunctionData, type Hex, parseAbi } from 'viem'
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
])

export type PreparedApexTransaction = Readonly<{
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
}): PreparedApexTransaction {
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
