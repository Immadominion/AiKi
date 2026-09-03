import { decodeFunctionData, encodeAbiParameters, encodeEventTopics } from 'viem'
import { describe, expect, it } from 'vitest'
import { BSC_MAINNET } from '../config/chains.js'
import {
  APEX_COMMERCE_ABI,
  parseApexJobCreated,
  parseApexJobFunded,
  prepareApexCreateEscrow,
  prepareApexFund,
} from './apex.js'
import { settlementRailFor } from './settlement-rails.js'

describe('APEX settlement adapter', () => {
  it('prepares deployed createJob calldata from an immutable agreement', () => {
    const rail = settlementRailFor({
      chainId: 56,
      token: BSC_MAINNET.contracts.settlementToken.toLowerCase() as `0x${string}`,
      decimals: 18,
    })
    const prepared = prepareApexCreateEscrow({
      rail,
      jobId: '725661cb-7541-45b9-9365-18249e6bdfe6',
      agreementId: '94e80e45-22fa-49db-8b95-a8e1697ce477',
      provider: `0x${'ab'.repeat(20)}`,
      hardExpiry: '2026-09-04T00:00:00.000Z',
      termsHash: '4'.repeat(64),
    })

    expect(prepared.to).toBe(BSC_MAINNET.contracts.erc8183Commerce.toLowerCase())
    expect(prepared.data.startsWith('0x41528812')).toBe(true)
    const decoded = decodeFunctionData({ abi: APEX_COMMERCE_ABI, data: prepared.data })
    expect(decoded.functionName).toBe('createJob')
    const [provider, , expiredAt, metadata, hook] = decoded.args
    expect(String(provider).toLowerCase()).toBe(`0x${'ab'.repeat(20)}`)
    expect(expiredAt).toBe(1_788_480_000n)
    expect(String(metadata)).toContain('termsHash=4444')
    expect(String(hook).toLowerCase()).toBe(
      BSC_MAINNET.contracts.erc8183EvaluatorRouter.toLowerCase(),
    )
  })

  it('prepares deployed fund calldata after the external APEX job id is known', () => {
    const rail = settlementRailFor({
      chainId: 56,
      token: BSC_MAINNET.contracts.settlementToken.toLowerCase() as `0x${string}`,
      decimals: 18,
    })
    const prepared = prepareApexFund({
      rail,
      externalJobId: '123',
      amount: '1000000000000000001',
    })

    expect(prepared.to).toBe(BSC_MAINNET.contracts.erc8183Commerce.toLowerCase())
    expect(prepared.data.startsWith('0xd2e13f50')).toBe(true)
    const decoded = decodeFunctionData({ abi: APEX_COMMERCE_ABI, data: prepared.data })
    expect(decoded.functionName).toBe('fund')
    expect(decoded.args).toEqual([123n, 1_000_000_000_000_000_001n, '0x'])
    expect(prepared.args).toEqual({
      externalJobId: '123',
      amount: '1000000000000000001',
      optParams: '0x',
    })
  })

  it('parses a finalized JobCreated log from the deployed event shape', () => {
    const transactionHash = `0x${'11'.repeat(32)}` as const
    const provider = `0x${'ab'.repeat(20)}` as const
    const evaluator = BSC_MAINNET.contracts.erc8183EvaluatorRouter.toLowerCase() as `0x${string}`
    const topics = encodeEventTopics({
      abi: APEX_COMMERCE_ABI,
      eventName: 'JobCreated',
      args: {
        jobId: 123n,
        client: `0x${'cd'.repeat(20)}`,
        provider,
      },
    }) as `0x${string}`[]
    const parsed = parseApexJobCreated({
      contract: BSC_MAINNET.contracts.erc8183Commerce.toLowerCase() as `0x${string}`,
      transactionHash,
      logs: [
        {
          address: BSC_MAINNET.contracts.erc8183Commerce.toLowerCase() as `0x${string}`,
          topics,
          data: encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }],
            [evaluator, 456n, evaluator],
          ),
          transactionHash,
          logIndex: 7,
          blockNumber: 99n,
          blockHash: `0x${'22'.repeat(32)}`,
        },
      ],
    })
    expect(parsed.externalJobId).toBe('123')
    expect(parsed.provider).toBe(provider)
    expect(parsed.expiredAt).toBe('456')
    expect(parsed.log.logIndex).toBe(7)
  })

  it('parses a finalized JobFunded log from the deployed event shape', () => {
    const transactionHash = `0x${'33'.repeat(32)}` as const
    const client = `0x${'cd'.repeat(20)}` as const
    const topics = encodeEventTopics({
      abi: APEX_COMMERCE_ABI,
      eventName: 'JobFunded',
      args: {
        jobId: 123n,
        client,
      },
    }) as `0x${string}`[]
    const parsed = parseApexJobFunded({
      contract: BSC_MAINNET.contracts.erc8183Commerce.toLowerCase() as `0x${string}`,
      transactionHash,
      logs: [
        {
          address: BSC_MAINNET.contracts.erc8183Commerce.toLowerCase() as `0x${string}`,
          topics,
          data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000_000_000_000_001n]),
          transactionHash,
          logIndex: 8,
          blockNumber: 100n,
          blockHash: `0x${'44'.repeat(32)}`,
        },
      ],
    })
    expect(parsed.externalJobId).toBe('123')
    expect(parsed.client).toBe(client)
    expect(parsed.amount).toBe('1000000000000000001')
    expect(parsed.log.logIndex).toBe(8)
  })
})
