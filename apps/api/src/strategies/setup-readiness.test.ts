import { DELEGATION_TYPES, delegationDomain, delegationMessage } from '@aiki/contracts'
import { type Hex, hashStruct, hashTypedData } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  STRATEGY_EXPIRY_ENFORCER,
  strategyUnsignedDelegation,
  verifyStrategyMandate,
} from './setup-readiness.js'
import type { StrategySnapshotReader } from './snapshot.js'
import { snapshotFixture } from './snapshot.test-support.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{
      default: { enforcers: Array<{ name: string; address: string; codeHash: string }> }
    }>(),
    { keccak256 } = await import('viem')
  return {
    default: {
      ...original.default,
      managerCodeHash: keccak256('0x6005'),
      enforcers: original.default.enforcers.map((pin) =>
        pin.name === 'ExpiryEnforcer' ? { ...pin, codeHash: keccak256('0x6006') } : pin,
      ),
    },
  }
})
const executor = `0x${'66'.repeat(20)}` as Hex
async function setup() {
  const f = snapshotFixture('yield'),
    result = await f.run()
  if (result.status !== 'verified') throw new Error('Invalid snapshot fixture')
  const snapshot = result.snapshot
  const unsigned = strategyUnsignedDelegation({ snapshot, executor, salt: '1', epoch: '0' })
  const delegation = { ...unsigned, signature: `0x${'0'.repeat(63)}1${'0'.repeat(63)}11b` as Hex }
  const digest = hashTypedData({
    domain: delegationDomain(56, snapshot.manager),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: delegationMessage(delegation),
  })
  const hash = hashStruct({
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    data: delegationMessage(delegation),
  })
  const values: Record<string, unknown> = {
    owner: snapshot.owner,
    DELEGATION_MANAGER: snapshot.manager,
    EXPIRY_ENFORCER: STRATEGY_EXPIRY_ENFORCER.address,
    epochOf: 0n,
    isDisabled: false,
    getDelegationDigest: digest,
    getDelegationHash: hash,
    isValidSignature: '0x1626ba7e',
  }
  const reader = {
    ...f.reader,
    getBytecode: vi.fn(async () => '0x6006' as Hex),
    readContract: vi.fn(
      async (input: Parameters<StrategySnapshotReader['readContract']>[0]) =>
        values[input.functionName],
    ),
  }
  const input = {
    snapshot,
    delegation,
    executor,
    owner: snapshot.owner,
    reader,
    nowSeconds: Number(snapshot.block.timestamp),
  }
  return {
    f,
    snapshot,
    delegation,
    digest,
    values,
    reader,
    input,
    run: () => verifyStrategyMandate(input),
  }
}
describe('fresh exact strategy mandate readiness', () => {
  it('checks the owner, canonical manager digest, epoch, revocation and ERC1271 at one verified block', async () => {
    const f = await setup()
    expect(await f.run()).toEqual({ ready: true, digest: f.digest })
    expect(f.reader.readContract.mock.calls.map(([input]) => input.functionName).sort()).toEqual(
      [
        'DELEGATION_MANAGER',
        'EXPIRY_ENFORCER',
        'epochOf',
        'getDelegationDigest',
        'getDelegationHash',
        'isDisabled',
        'isValidSignature',
        'owner',
      ].sort(),
    )
    for (const [input] of f.reader.readContract.mock.calls)
      expect(input.blockNumber).toBe(f.snapshot.block.number)
  })
  it.each([
    'owner',
    'DELEGATION_MANAGER',
    'EXPIRY_ENFORCER',
    'epochOf',
    'isDisabled',
    'getDelegationDigest',
    'getDelegationHash',
    'isValidSignature',
  ])('refuses changed %s', async (key) => {
    const f = await setup()
    f.values[key] = key === 'epochOf' ? 1n : key === 'isDisabled' ? true : '0x'
    expect(await f.run()).toMatchObject({ ready: false, retryable: false })
  })
  it('rejects broad or extra caller caveats before any RPC', async () => {
    const f = await setup()
    f.delegation.caveats = []
    expect((await f.run()).ready).toBe(false)
    expect(f.reader.readContract).not.toHaveBeenCalled()
  })
  it('requires exact ordered immutable expiry before the binding and pinned expiry runtime', async () => {
    const f = await setup()
    expect(f.delegation.caveats).toHaveLength(2)
    expect(f.delegation.caveats[0]).toMatchObject({
      enforcer: STRATEGY_EXPIRY_ENFORCER.address,
      terms: `0x${f.snapshot.expiresAt.toString(16).padStart(64, '0')}`,
      args: '0x',
    })
    f.reader.getBytecode.mockResolvedValue('0x6007')
    expect(await f.run()).toMatchObject({ ready: false, retryable: false })
    for (const mode of ['missing', 'order', 'expiry'] as const) {
      const bad = await setup()
      if (mode === 'missing') bad.delegation.caveats.shift()
      if (mode === 'order') bad.delegation.caveats.reverse()
      if (mode === 'expiry') {
        const caveat = bad.delegation.caveats[0]
        if (!caveat) throw new Error('Missing expiry')
        caveat.terms = `0x${(bad.snapshot.expiresAt + 1n).toString(16).padStart(64, '0')}`
      }
      expect((await bad.run()).ready).toBe(false)
      expect(bad.reader.readContract).not.toHaveBeenCalled()
    }
  })
  it.each(['salt', 'epoch'] as const)('does not coerce malformed stored %s', async (key) => {
    for (const invalid of ['01', '-1', '1e1', '9'.repeat(79), 1n, 1]) {
      const f = await setup()
      Object.assign(f.delegation, { [key]: invalid })
      expect((await f.run()).ready).toBe(false)
      expect(f.reader.readContract).not.toHaveBeenCalled()
    }
  })
  it('rejects owner/executor equality and altered signed limits', async () => {
    const f = await setup()
    expect((await verifyStrategyMandate({ ...f.input, executor: f.snapshot.owner })).ready).toBe(
      false,
    )
    const caveat = f.delegation.caveats[0]
    if (!caveat) throw new Error('Missing fixture caveat')
    caveat.terms = '0x'
    expect((await f.run()).ready).toBe(false)
  })
  it('fails closed on stale snapshot, future clock, reorg and provider exceptions', async () => {
    for (const mode of ['stale', 'future', 'reorg', 'error']) {
      const f = await setup()
      if (mode === 'stale') f.input.nowSeconds += 31
      if (mode === 'future') f.input.nowSeconds--
      if (mode === 'reorg') f.f.canonical.hash = `0x${'bb'.repeat(32)}`
      if (mode === 'error') f.reader.readContract.mockRejectedValue(new Error('private RPC URL'))
      const result = await f.run()
      expect(result.ready).toBe(false)
      expect(result).toMatchObject({ retryable: true })
      expect(JSON.stringify(result)).not.toContain('private')
    }
  })
})
