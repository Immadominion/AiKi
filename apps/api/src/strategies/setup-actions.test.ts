import {
  GridStrategyVaultAbi,
  type StrategyWalletAction,
  YieldAllocationVaultAbi,
} from '@aiki/contracts/strategies'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  parseAbi,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { a, LP_TEST_POLICY, lpFixture } from './lp/planner.test-support.js'
import {
  prepareStrategyWalletAction,
  type StrategySetupActionReader,
  verifyStrategyWalletReceipt,
} from './setup-actions.js'
import { snapshotFixture } from './snapshot.test-support.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: object }>(),
    { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x6005') } }
})
const h = (v: string) => `0x${v.repeat(32)}` as Hex
async function setup(kind: 'yield' | 'grid' | 'lp' = 'yield') {
  const f = snapshotFixture(kind, { paused: true }),
    proof = await f.run()
  if (proof.status !== 'verified') throw new Error('Invalid fixture')
  const snapshot = proof.snapshot,
    values = { balance: 1000n, allowance: 0n, decimals: 18 },
    owner = snapshot.owner
  const reader = {
    ...f.reader,
    readContract: vi.fn(async (input: Parameters<StrategySetupActionReader['readContract']>[0]) => {
      if (input.functionName === 'balanceOf') return values.balance
      if (input.functionName === 'allowance') return values.allowance
      if (input.functionName === 'decimals') return values.decimals
      return f.reader.readContract(input)
    }),
    call: vi.fn(async () => ({ data: `0x${'0'.repeat(63)}1` as Hex })),
    getBalance: vi.fn(async () => 1000n),
    getTransaction: vi.fn(async () => ({})),
    getTransactionReceipt: vi.fn(async () => ({})),
  }
  return {
    f,
    snapshot,
    owner,
    reader,
    values,
    run: (request: Parameters<typeof prepareStrategyWalletAction>[0]['request']) =>
      prepareStrategyWalletAction({ snapshot, owner, reader, request }),
  }
}
describe('one explicit owner wallet step', () => {
  it('prepares only exact USDT approval, not funding or activation', async () => {
    const f = await setup(),
      a = await f.run({ kind: 'fund', assets: '10' })
    expect(a).toMatchObject({
      kind: 'approve',
      transaction: {
        chainId: 56,
        from: f.owner,
        to: '0x6161616161616161616161616161616161616161',
        value: '0',
      },
      review: { assets: [{ amount: '10', decimals: 18 }], recipient: f.snapshot.binding.vault },
    })
    expect(f.reader.call).toHaveBeenCalledOnce()
    expect(f.reader.getTransaction).not.toHaveBeenCalled()
  })
  it('requires a separate zero reset for an existing different allowance', async () => {
    const f = await setup()
    f.values.allowance = 11n
    expect(await f.run({ kind: 'fund', assets: '10' })).toMatchObject({
      kind: 'approve_reset',
      review: { assets: [{ amount: '0' }] },
    })
  })
  it('funds only after exact approval and encodes the exact raw-unit value', async () => {
    const f = await setup()
    f.values.allowance = 10n
    const a = await f.run({ kind: 'fund', assets: '10' })
    expect(a.kind).toBe('fund')
    expect(
      decodeFunctionData({ abi: YieldAllocationVaultAbi, data: a.transaction.data }),
    ).toMatchObject({ functionName: 'fund', args: [10n] })
    expect(a.transaction.to).toBe(f.snapshot.binding.vault)
  })
  it('uses one reviewed Grid rung and never an arbitrary destination', async () => {
    const f = await setup('grid')
    f.values.allowance = 10n
    const a = await f.run({ kind: 'fund', rungIndex: 1, amount0: '10', amount1: '0' })
    expect(
      decodeFunctionData({ abi: GridStrategyVaultAbi, data: a.transaction.data }),
    ).toMatchObject({ functionName: 'fund', args: [1, 10n, 0n] })
    expect(a.review.rungIndex).toBe(1)
  })
  it.each(['amount', 'balance', 'cap', 'decimals', 'false-approval', 'rpc', 'chain', 'reorg'])(
    'blocks %s without presenting a financial action',
    async (mode) => {
      const f = await setup()
      if (mode === 'balance') f.values.balance = 0n
      if (mode === 'decimals') f.values.decimals = 99
      if (mode === 'false-approval')
        f.reader.call.mockResolvedValue({ data: `0x${'0'.repeat(64)}` })
      if (mode === 'rpc') f.reader.call.mockRejectedValue(new Error('private RPC URL'))
      if (mode === 'chain') f.reader.getChainId.mockResolvedValue(97)
      if (mode === 'reorg') f.f.canonical.hash = h('bb')
      await expect(
        f.run({ kind: 'fund', assets: mode === 'amount' ? '1.5' : mode === 'cap' ? '1001' : '10' }),
      ).rejects.toThrow()
      expect(f.reader.getTransactionReceipt).not.toHaveBeenCalled()
    },
  )
  it('refuses owner substitution, unsupported fields, recipient overrides and cross-kind requests', async () => {
    const f = await setup()
    await expect(
      prepareStrategyWalletAction({
        snapshot: f.snapshot,
        owner: `0x${'ab'.repeat(20)}`,
        reader: f.reader,
        request: { kind: 'fund', assets: '10' },
      }),
    ).rejects.toThrow()
    for (const request of [
      { kind: 'fund', assets: '10', recipient: f.owner },
      { kind: 'fund', assets: 10 },
      { kind: 'enroll', tokenId: '1' },
      { kind: 'withdraw', token: f.owner, amount: '1' },
    ])
      await expect(f.run(request as Parameters<typeof f.run>[0])).rejects.toThrow()
    expect(f.reader.call).not.toHaveBeenCalled()
  })
  it('prepares owner resume separately and does not change snapshot state', async () => {
    const f = await setup(),
      action = await f.run({ kind: 'resume' })
    expect(
      decodeFunctionData({ abi: YieldAllocationVaultAbi, data: action.transaction.data }),
    ).toMatchObject({ functionName: 'resume' })
    expect(f.snapshot.paused).toBe(true)
    expect(action.review.summary).toContain('does not start')
  })
  it('withdraws only reviewed receipt tokens to the owner, not an arbitrary external call', async () => {
    const f = await setup()
    if (f.snapshot.state.kind !== 'yield') throw new Error('Wrong fixture')
    const action = await f.run({
      kind: 'withdraw',
      token: f.snapshot.state.protocol.venus,
      amount: '10',
    })
    expect(
      decodeFunctionData({ abi: YieldAllocationVaultAbi, data: action.transaction.data }),
    ).toMatchObject({ functionName: 'recover', args: [f.snapshot.state.protocol.venus, 10n] })
    expect(action.review.recipient).toBe(f.owner)
  })
})

describe('LP ownership and reviewed position before any NFT approval', () => {
  async function fixture() {
    const f = lpFixture({ paused: true })
    f.base.setVault('enrolled', false)
    f.base.setVault('currentTokenId', 0n)
    f.base.setVault('positionLiquidity', 0n)
    const proof = await f.base.run()
    if (proof.status !== 'verified') throw new Error('Invalid fixture')
    const snapshot = proof.snapshot,
      owner = snapshot.owner
    f.base.set(a('80'), 'ownerOf', owner, [42n])
    const reader = {
      ...f.base.reader,
      getBytecode: f.poolReader.getBytecode,
      readContract: vi.fn(
        async (input: Parameters<StrategySetupActionReader['readContract']>[0]) =>
          input.address === a('83') || input.address === a('82')
            ? f.poolReader.readContract(input)
            : f.base.reader.readContract(input),
      ),
      call: vi.fn(async () => ({ data: '0x' as Hex })),
      getBalance: vi.fn(async () => 1n),
      getTransaction: vi.fn(async () => null),
      getTransactionReceipt: vi.fn(async () => null),
    }
    const run = () =>
      prepareStrategyWalletAction({
        snapshot,
        owner,
        reader,
        poolRuntimeCodeHash: LP_TEST_POLICY.poolRuntimeCodeHash,
        request: { kind: 'enroll', tokenId: '42' },
      })
    return { ...f, snapshot, owner, reader, run }
  }
  it('reviews an eligible owner NFT and prepares only its token-specific approval', async () => {
    const f = await fixture(),
      action = await f.run()
    expect(action).toMatchObject({
      kind: 'approve_nft',
      review: { tokenId: '42', recipient: f.snapshot.binding.vault },
    })
    expect(
      decodeFunctionData({
        abi: parseAbi(['function approve(address,uint256)']),
        data: action.transaction.data,
      }),
    ).toMatchObject({ functionName: 'approve', args: [f.snapshot.binding.vault, 42n] })
    expect(f.reader.call).toHaveBeenCalledOnce()
  })
  it('requires a separate explicit enrollment after token-specific approval', async () => {
    const f = await fixture()
    f.base.set(a('80'), 'getApproved', f.snapshot.binding.vault, [42n])
    expect(await f.run()).toMatchObject({
      kind: 'enroll',
      transaction: { to: f.snapshot.binding.vault },
    })
  })
  it.each([
    'owner',
    'pair',
    'liquidity',
    'fee',
    'ticks',
    'position-cap',
    'pool-runtime',
    'history',
    'spot-deviation',
  ] as const)('blocks %s before asking for any approval', async (mode) => {
    const f = await fixture()
    if (mode === 'owner') f.base.set(a('80'), 'ownerOf', a('ab'), [42n])
    if (['pair', 'liquidity', 'fee', 'ticks', 'position-cap'].includes(mode)) {
      const position = [0n, a('00'), a('71'), a('72'), 500, -300, 300, 10n ** 18n, 0n, 0n, 0n, 0n]
      if (mode === 'pair') position[2] = a('ab')
      if (mode === 'liquidity') position[7] = 0n
      if (mode === 'fee') position[4] = 3000
      if (mode === 'ticks') position[5] = -301
      if (mode === 'position-cap') position[7] = 10n ** 30n
      f.base.set(a('80'), 'positions', position, [42n])
    }
    if (mode === 'pool-runtime') f.reader.getBytecode.mockResolvedValue('0x00')
    if (mode === 'history')
      f.poolValues.set('observations:1', [Number(f.snapshot.block.timestamp), 0n, 0n, true])
    if (mode === 'spot-deviation')
      f.poolValues.set('observe', [
        [0n, 30300n],
        [0n, (300n << 128n) / 10n ** 24n],
      ])
    await expect(f.run()).rejects.toThrow()
    expect(f.reader.call).not.toHaveBeenCalled()
  })
})

describe('exact finalized wallet action receipt', () => {
  async function receiptFixture() {
    const f = await setup()
    f.values.allowance = 10n
    const prepared = await f.run({ kind: 'fund', assets: '10' }),
      hash = h('cc')
    const action: StrategyWalletAction = {
      ...prepared,
      id: 'action',
      status: 'SUBMITTED',
      transactionHash: hash,
    }
    const receipt: Record<string, unknown> = {
      transactionHash: hash,
      blockHash: f.snapshot.block.hash,
      blockNumber: 100n,
      status: 'success',
    }
    const tx: Record<string, unknown> = {
      hash,
      blockHash: receipt.blockHash,
      blockNumber: 100n,
      from: f.owner,
      to: action.transaction.to,
      input: action.transaction.data,
      value: 0n,
      chainId: 56,
    }
    const reader = {
      ...f.reader,
      getTransactionReceipt: vi.fn(async () => receipt),
      getTransaction: vi.fn(async () => tx),
    }
    return {
      ...f,
      reader,
      receipt,
      tx,
      action,
      run: () => verifyStrategyWalletReceipt(action, reader),
    }
  }
  it.each(['success', 'reverted'])(
    'proves an exact finalized %s without a replacement lookup',
    async (status) => {
      const f = await receiptFixture()
      f.receipt.status = status
      expect(await f.run()).toEqual({
        status: status === 'success' ? 'FINALIZED' : 'REVERTED',
        block: { number: '100', hash: f.snapshot.block.hash },
      })
      expect(f.reader.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith({
        hash: f.action.transactionHash,
      })
    },
  )
  it.each([
    'missing-hash',
    'different-hash',
    'different-owner',
    'different-call',
    'native-value',
    'wrong-chain',
    'unfinalized',
    'reorg',
    'malformed-finality',
  ])('refuses %s and leaves the wallet action unresolved', async (mode) => {
    const f = await receiptFixture()
    if (mode === 'missing-hash') f.action.transactionHash = null
    if (mode === 'different-hash') f.receipt.transactionHash = h('dd')
    if (mode === 'different-owner') f.tx.from = `0x${'dd'.repeat(20)}`
    if (mode === 'different-call') f.tx.input = '0x1234'
    if (mode === 'native-value') f.tx.value = 1n
    if (mode === 'wrong-chain') f.tx.chainId = 97
    if (mode === 'unfinalized') f.f.finalized.number = 99n
    if (mode === 'reorg') f.f.canonical.hash = h('dd')
    if (mode === 'malformed-finality') f.f.finalized.hash = '0x'
    expect(await f.run()).toBeNull()
  })
  it('does not call a success receipt a completed approval without the exact allowance effect', async () => {
    const f = await receiptFixture()
    f.action.kind = 'approve'
    f.action.review.recipient = f.snapshot.binding.vault
    const asset = f.action.review.assets?.[0]
    if (!asset) throw new Error('Missing fixtureasset')
    f.action.transaction.to = asset.token
    f.tx.to = asset.token
    f.values.allowance = 0n
    expect(await f.run()).toBeNull()
  })
  it.each(['approve', 'approve_reset', 'approve_nft'] as const)(
    'proves receipt-local %s even if consumed by a later same-block transaction',
    async (kind) => {
      const f = await receiptFixture(),
        asset = f.action.review.assets?.[0]
      if (!asset) throw new Error('Missing asset')
      f.action.kind = kind
      f.action.review.recipient = f.snapshot.binding.vault
      f.action.transaction.to = asset.token
      f.tx.to = asset.token
      if (kind === 'approve_nft') f.action.review.tokenId = '42'
      if (kind === 'approve_reset') asset.amount = '0'
      const abi = parseAbi([
        kind === 'approve_nft'
          ? 'event Approval(address indexed owner,address indexed approved,uint256 indexed tokenId)'
          : 'event Approval(address indexed owner,address indexed spender,uint256 value)',
      ])
      const args =
        kind === 'approve_nft'
          ? { owner: f.owner, approved: f.snapshot.binding.vault, tokenId: 42n }
          : { owner: f.owner, spender: f.snapshot.binding.vault }
      f.receipt.logs = [
        {
          address: asset.token,
          transactionHash: f.action.transactionHash,
          blockHash: f.snapshot.block.hash,
          blockNumber: 100n,
          removed: false,
          topics: encodeEventTopics({ abi, eventName: 'Approval', args }),
          data:
            kind === 'approve_nft'
              ? '0x'
              : encodeAbiParameters([{ type: 'uint256' }], [BigInt(asset.amount)]),
        },
      ]
      f.values.allowance = 0n
      expect(await f.run()).toMatchObject({ status: 'FINALIZED' })
      expect(
        f.reader.readContract.mock.calls.some(([input]) =>
          ['allowance', 'getApproved'].includes(input.functionName),
        ),
      ).toBe(true) // Funding preparation checked allowance, receipt verification did not.
      const count = f.reader.readContract.mock.calls.length
      expect(await f.run()).toMatchObject({ status: 'FINALIZED' })
      expect(f.reader.readContract.mock.calls).toHaveLength(count)
      for (const property of ['address', 'transactionHash', 'blockHash']) {
        const logs = structuredClone(f.receipt.logs) as Array<Record<string, unknown>>,
          log = logs[0]
        if (!log) throw new Error('Missing log')
        const original = log[property]
        log[property] = property === 'address' ? a('ab') : h('ab')
        f.receipt.logs = logs
        expect(await f.run()).toBeNull()
        log[property] = original
      }
    },
  )
})
