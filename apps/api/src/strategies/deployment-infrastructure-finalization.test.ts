import { readFile } from 'node:fs/promises'
import { createPublicClient, getContractAddress, type Hex } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { da, deploymentFixture, dh } from './deployment.test-support.js'
import { runStrategyDeploymentCli } from './deployment-cli.js'
import {
  STRATEGY_PROTOCOL_ADDRESSES as P,
  parseStrategyDeploymentConfig,
  strategyDeploymentConfigDigest,
} from './deployment-config.js'
import { strategyInfrastructureTransactions } from './deployment-infrastructure.js'
import {
  finalizeStrategyInfrastructure,
  parseStrategyInfrastructureReceipts,
  parseStrategyInfrastructureReceiptsJSON,
} from './deployment-infrastructure-finalization.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (original) => {
  const module = await original<{ default: Record<string, unknown> }>()
  const { keccak256 } = await import('viem')
  return { default: { ...module.default, managerCodeHash: keccak256('0x60006000') } }
})
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(),
}))
afterEach(() => vi.useRealTimers())

function fixture(firstNonce = 42) {
  const f = deploymentFixture(),
    hashes: Record<string, Hex> = {},
    transactions = new Map<Hex, Record<string, unknown>>(),
    receipts = new Map<Hex, Record<string, unknown>>()
  for (const [index, expected] of strategyInfrastructureTransactions(f.owner).entries()) {
    const hash = dh(String(index + 1).padStart(2, '0')),
      nonce = firstNonce + index,
      address = getContractAddress({ from: f.owner, nonce: BigInt(nonce) }).toLowerCase() as Hex,
      existing = [
        f.config.bindingEnforcer,
        f.config.factories.yield,
        f.config.factories.grid,
        f.config.factories.lp,
      ][index]
    if (!existing) throw Error('Missing fixture')
    const code = f.codes.get(existing.address)
    if (!code) throw Error('Missing fixture code')
    f.codes.set(address, code)
    f.set(address, 'manager', f.config.manager.address)
    f.set(address, 'accountRuntimeHash', f.config.accountRuntimeHash)
    hashes[expected.name] = hash
    transactions.set(hash, {
      hash,
      from: f.owner,
      to: null,
      input: expected.data,
      value: 0n,
      chainId: 56,
      nonce,
      blockNumber: 99n,
      blockHash: dh('bb'),
      transactionIndex: index,
    })
    receipts.set(hash, {
      transactionHash: hash,
      status: 'success',
      from: f.owner,
      to: null,
      contractAddress: address,
      blockNumber: 99n,
      blockHash: dh('bb'),
      transactionIndex: index,
    })
  }
  vi.mocked(f.reader.getTransaction).mockImplementation(async ({ hash }) => transactions.get(hash))
  vi.mocked(f.reader.getTransactionReceipt).mockImplementation(async ({ hash }) =>
    receipts.get(hash),
  )
  const tx = (index = 0) =>
    [...transactions.values()][index] ??
    (() => {
      throw Error('Missing tx')
    })()
  const receipt = (index = 0) =>
    [...receipts.values()][index] ??
    (() => {
      throw Error('Missing receipt')
    })()
  const run = () =>
    finalizeStrategyInfrastructure({
      owner: f.owner,
      receipts: hashes,
      reader: f.reader,
      nowSeconds: f.block.timestamp,
    })
  return { ...f, hashes, transactions, receipts, tx, receipt, run }
}

describe('read-only infrastructure receipt-to-config recovery', () => {
  it('accepts a genuine nonce-zero CREATE without using constructor log addresses', async () => {
    const f = fixture(0)
    for (const receipt of f.receipts.values()) receipt.logs = [{ address: da('ee'), data: '0x' }]
    const result = await f.run()
    expect(result).toMatchObject({ status: 'needs_operator_review' })
    if (result.status !== 'needs_operator_review') throw Error('Expected candidate')
    expect(result.receipts[0]?.nonce).toBe('0')
    expect(result.receipts.every((r) => r.address !== da('ee'))).toBe(true)
  })
  it('builds a deterministic review-only configuration from four exact CREATE receipts', async () => {
    const f = fixture(),
      result = await f.run()
    expect(result.status).toBe('needs_operator_review')
    if (result.status !== 'needs_operator_review') throw Error('Expected candidate')
    expect(parseStrategyDeploymentConfig(result.configuration)).toEqual(result.configuration)
    expect(result.configurationDigest).toBe(strategyDeploymentConfigDigest(result.configuration))
    expect(result.receipts).toHaveLength(4)
    expect(result.configuration.bindingEnforcer.address).toBe(f.receipt().contractAddress)
    expect(result.configuration.factories.lp.address).toBe(f.receipt(3).contractAddress)
    expect(result).not.toHaveProperty('audited')
    expect(await f.run()).toEqual(result)
    expect(f.reader.call).not.toHaveBeenCalled()
    expect(Object.keys(f.reader)).not.toContain('sendTransaction')
    expect(
      vi.mocked(f.reader.getStorageAt).mock.calls.every(([args]) => args.blockNumber === 100n),
    ).toBe(true)
    expect(
      vi
        .mocked(f.reader.getBytecode)
        .mock.calls.filter(([args]) => Object.values(P).includes(args.address as typeof P.usdt))
        .every(([args]) => args.blockNumber === 100n),
    ).toBe(true)
  })

  it.each([
    ['wrong owner', 'from', da('10')],
    ['wrong chain', 'chainId', 97],
    ['non-CREATE', 'to', da('10')],
    ['missing CREATE target', 'to', undefined],
    ['nonzero value', 'value', 1n],
    ['wrong initcode', 'input', '0x6001'],
    ['wrong hash', 'hash', dh('ee')],
    ['wrong block', 'blockNumber', 98n],
    ['wrong block hash', 'blockHash', dh('ee')],
    ['negative nonce', 'nonce', -1],
    ['fractional nonce', 'nonce', 1.2],
    ['unsafe nonce', 'nonce', Number.MAX_SAFE_INTEGER + 1],
    ['string nonce', 'nonce', '42'],
    ['wrong nonce/address', 'nonce', 100],
    ['wrong index', 'transactionIndex', 9],
  ])('blocks transaction %s', async (_label, field, value) => {
    const f = fixture()
    f.tx()[field as string] = value
    expect(await f.run()).toMatchObject({ status: 'blocked' })
  })

  it.each([
    ['wrong owner', 'from', da('10')],
    ['wrong hash', 'transactionHash', dh('ee')],
    ['reverted', 'status', 'reverted'],
    ['non-CREATE', 'to', da('10')],
    ['missing target', 'to', undefined],
    ['missing address', 'contractAddress', null],
    ['wrong CREATE address', 'contractAddress', da('10')],
    ['unfinalized', 'blockNumber', 101n],
    ['wrong block hash', 'blockHash', dh('ee')],
    ['malformed block', 'blockNumber', '99'],
    ['zero block', 'blockNumber', 0n],
    ['missing index', 'transactionIndex', undefined],
    ['negative index', 'transactionIndex', -1],
  ])('blocks receipt %s', async (_label, field, value) => {
    const f = fixture()
    f.receipt()[field as string] = value
    expect(await f.run()).toMatchObject({ status: 'blocked' })
  })

  it('rejects missing receipts and replayed nonce without assuming replacement or resending', async () => {
    const f = fixture()
    f.tx(1).nonce = f.tx().nonce
    expect(await f.run()).toMatchObject({ status: 'blocked' })
    f.receipts.clear()
    expect(await f.run()).toMatchObject({ status: 'blocked' })
  })

  it('rejects two distinct transactions claiming the same canonical block position', async () => {
    const f = fixture()
    f.tx(1).transactionIndex = f.tx().transactionIndex
    f.receipt(1).transactionIndex = f.receipt().transactionIndex
    expect(await f.run()).toMatchObject({ status: 'blocked' })
  })

  it.each(['receipt', 'head'] as const)(
    'rejects a mismatched number on the final %s canonical reread',
    async (where) => {
      const f = fixture(),
        old = vi.mocked(f.reader.getBlock).getMockImplementation()
      let reads = 0
      vi.mocked(f.reader.getBlock).mockImplementation(async (args) => {
        const result = await old?.(args)
        if (
          'blockNumber' in args &&
          args.blockNumber === (where === 'receipt' ? 99n : 100n) &&
          ++reads > (where === 'receipt' ? 4 : 1)
        )
          return { ...(result as object), number: 101n }
        return result
      })
      expect(await f.run()).toMatchObject({ status: 'blocked' })
    },
  )

  it('rejects a checkpoint that becomes stale while gathering pins', async () => {
    const f = fixture(),
      old = vi.mocked(f.reader.getStorageAt).getMockImplementation()
    vi.useFakeTimers()
    vi.setSystemTime(Number(f.block.timestamp) * 1000)
    vi.mocked(f.reader.getStorageAt).mockImplementation(async (args) => {
      vi.setSystemTime(Number(f.block.timestamp + 121n) * 1000)
      return old?.(args)
    })
    expect(
      await finalizeStrategyInfrastructure({
        owner: f.owner,
        receipts: f.hashes,
        reader: f.reader,
      }),
    ).toMatchObject({ status: 'blocked' })
  })

  it.each(['receipt', 'head'] as const)(
    'rejects a %s checkpoint reorg after reading state',
    async (where) => {
      const f = fixture(),
        getBlock = f.reader.getBlock
      let reads = 0
      vi.mocked(f.reader.getBlock).mockImplementation(async (args) => {
        const block =
          'blockTag' in args
            ? f.block
            : {
                ...f.block,
                number: args.blockNumber,
                hash: args.blockNumber === 100n ? f.block.hash : dh('bb'),
                timestamp: args.blockNumber === 100n ? f.block.timestamp : f.block.timestamp - 3n,
              }
        if (
          'blockNumber' in args &&
          args.blockNumber === (where === 'receipt' ? 99n : 100n) &&
          ++reads > (where === 'receipt' ? 4 : 0)
        )
          return { ...block, hash: dh('ee') }
        return block
      })
      expect(getBlock).toBe(f.reader.getBlock)
      expect(await f.run()).toMatchObject({ status: 'blocked' })
    },
  )

  it.each([
    'wrong chain',
    'missing finalized',
    'stale finalized',
    'future finalized',
    'wrong numbered block',
  ] as const)('rejects %s', async (which) => {
    const f = fixture()
    if (which === 'wrong chain') vi.mocked(f.reader.getChainId).mockResolvedValue(97)
    else {
      const old = vi.mocked(f.reader.getBlock).getMockImplementation()
      vi.mocked(f.reader.getBlock).mockImplementation(async (args) => {
        if (which === 'wrong numbered block' && 'blockNumber' in args) return f.block
        if ('blockTag' in args)
          return which === 'missing finalized'
            ? null
            : {
                ...f.block,
                timestamp: f.block.timestamp + (which === 'future finalized' ? 6n : -121n),
              }
        return old?.(args)
      })
    }
    expect(await f.run()).toMatchObject({ status: 'blocked' })
  })

  it.each([
    'runtime',
    'receipt runtime',
    'factory manager',
    'factory account',
    'protocol code',
    'protocol identity',
    'implementation slot',
    'implementation code',
    'manager code',
    'expiry identity',
  ] as const)('blocks inconsistent %s', async (which) => {
    const f = fixture(),
      address = f.receipt(1).contractAddress as Hex
    if (which === 'runtime') f.codes.set(address, '0x6001')
    if (which === 'receipt runtime') {
      const old = vi.mocked(f.reader.getBytecode).getMockImplementation()
      vi.mocked(f.reader.getBytecode).mockImplementation(async (args) =>
        args.address === address && args.blockNumber === 99n ? '0x6001' : old?.(args),
      )
    }
    if (which === 'factory manager') f.set(address, 'manager', da('10'))
    if (which === 'factory account') f.set(address, 'accountRuntimeHash', dh('10'))
    if (which === 'protocol code') f.codes.delete(P.usdt)
    if (which === 'protocol identity') f.set(P.aaveReceipt, 'POOL', da('10'))
    if (which === 'implementation slot')
      vi.mocked(f.reader.getStorageAt).mockResolvedValue(dh('ff'))
    if (which === 'implementation code') f.codes.delete(f.config.implementations.venus.address)
    if (which === 'manager code') f.codes.set(f.config.manager.address, '0x6001')
    if (which === 'expiry identity') f.set(f.config.manager.address, 'EXPIRY_ENFORCER', da('10'))
    expect(await f.run()).toMatchObject({ status: 'blocked' })
  })

  it('rejects a protocol pin change between gathering and full verification', async () => {
    const f = fixture(),
      old = vi.mocked(f.reader.getBytecode).getMockImplementation()
    let reads = 0
    vi.mocked(f.reader.getBytecode).mockImplementation(async (args) =>
      args.address === P.usdt && ++reads > 1 ? '0x6002' : old?.(args),
    )
    expect(await f.run()).toMatchObject({ status: 'blocked' })
  })

  it('sanitizes unavailable upstream errors', async () => {
    const f = fixture()
    vi.mocked(f.reader.getTransactionReceipt).mockRejectedValue(
      Error('https://private.example/key=secret'),
    )
    const result = await f.run()
    expect(result.status).toBe('blocked')
    expect(JSON.stringify(result)).not.toMatch(/private|secret/)
  })
})

describe('strict infrastructure receipt document and unsigned CLI', () => {
  it('accepts only four exact distinct literal named hashes', () => {
    const f = fixture(),
      text = JSON.stringify(f.hashes)
    expect(parseStrategyInfrastructureReceiptsJSON(text)).toEqual(f.hashes)
    for (const value of [
      null,
      [],
      {},
      { ...f.hashes, extra: dh('ee') },
      { ...f.hashes, YieldVaultFactory: f.hashes.StrategyBindingEnforcer },
      { ...f.hashes, LPVaultFactory: '0x00' },
    ])
      expect(() => parseStrategyInfrastructureReceipts(value)).toThrow()
    for (const value of [
      text.replace('YieldVaultFactory', 'StrategyBindingEnforcer'),
      `${text.slice(0, -1)},"StrategyBindingEnforcer":"${dh('ff')}"}`,
      text.replace('YieldVaultFactory', '\\u0059ieldVaultFactory'),
      `${text}garbage`,
      ' '.repeat(4097),
    ])
      expect(() => parseStrategyInfrastructureReceiptsJSON(value)).toThrow()
  })

  it('only reads the supplied receipts file and outputs an unapproved candidate', async () => {
    const f = fixture()
    vi.useFakeTimers()
    vi.setSystemTime(Number(f.block.timestamp) * 1000)
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(f.hashes))
    vi.mocked(createPublicClient).mockReturnValue(f.reader as ReturnType<typeof createPublicClient>)
    const result = await runStrategyDeploymentCli([
      'finalize-infrastructure',
      '--owner',
      f.owner,
      '--receipts',
      'public-receipts.json',
      '--rpc',
      'https://public.example',
    ])
    expect(result).toMatchObject({ status: 'needs_operator_review' })
    expect(readFile).toHaveBeenLastCalledWith('public-receipts.json', 'utf8')
    expect(f.reader.call).not.toHaveBeenCalled()
  })

  it.each(['--private-key', '--config', '--send', '--owner'])(
    'rejects additional or duplicate %s option without chain reads',
    async (extra) => {
      const f = fixture()
      vi.mocked(createPublicClient).mockClear()
      expect(
        await runStrategyDeploymentCli([
          'finalize-infrastructure',
          '--owner',
          f.owner,
          '--receipts',
          'public.json',
          '--rpc',
          'https://public.example',
          extra,
          'anything',
        ]),
      ).toMatchObject({ status: 'blocked' })
      expect(createPublicClient).not.toHaveBeenCalled()
    },
  )
})
