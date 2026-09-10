import { ROOT_AUTHORITY } from '@aiki/contracts/delegation'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { DELEGATION_ABI, DELEGATION_TUPLE, type SignedDelegation } from '../execution/executor.js'
import { assertStrategyEnvelope, encodeStrategyEnvelope } from './envelope.js'
import { a, gridOp, lpOp, yieldOp } from './receipt.test-support.js'

const delegation: SignedDelegation = {
  delegate: a('66'),
  delegator: yieldOp.binding.controller,
  authority: ROOT_AUTHORITY,
  caveats: [],
  salt: 1n,
  epoch: 0n,
  signature: '0x1234',
}
describe('exact strategy transaction envelope', () => {
  it.each([yieldOp, gridOp, lpOp])('accepts the one canonical $kind operation', (operation) => {
    expect(() =>
      assertStrategyEnvelope(
        encodeStrategyEnvelope(operation, delegation),
        operation,
        delegation.delegate,
      ),
    ).not.toThrow()
  })
  it('rejects arbitrary selectors and extra trailing bytes', () => {
    const valid = encodeStrategyEnvelope(yieldOp, delegation)
    for (const input of ['0x12345678', `${valid}00`] as Hex[])
      expect(() => assertStrategyEnvelope(input, yieldOp, delegation.delegate)).toThrow()
  })
  it('rejects a foreign inner call even when it is a valid strategy call', () => {
    expect(() =>
      assertStrategyEnvelope(
        encodeStrategyEnvelope({ ...yieldOp, assets: 200n }, delegation),
        yieldOp,
        delegation.delegate,
      ),
    ).toThrow()
    expect(() =>
      assertStrategyEnvelope(
        encodeStrategyEnvelope(
          { ...yieldOp, binding: { ...yieldOp.binding, vault: a('ab') } },
          delegation,
        ),
        yieldOp,
        delegation.delegate,
      ),
    ).toThrow()
  })
  it.each(['delegator', 'delegate', 'authority'] as const)(
    'rejects a foreign delegation %s',
    (key) => {
      const value = key === 'authority' ? (`0x${'ab'.repeat(32)}` as Hex) : a('ab')
      expect(() =>
        assertStrategyEnvelope(
          encodeStrategyEnvelope(yieldOp, { ...delegation, [key]: value }),
          yieldOp,
          delegation.delegate,
        ),
      ).toThrow()
    },
  )
  it('rejects multiple calls, a different mode, native value and chained delegations', () => {
    const decoded = decodeFunctionData({
      abi: DELEGATION_ABI,
      data: encodeStrategyEnvelope(yieldOp, delegation),
    })
    const [contexts, modes, calls] = decoded.args
    const call = calls[0],
      context = contexts[0]
    if (!call || !context) throw new Error('Missing fixture envelope')
    const changed: (typeof decoded.args)[] = [
      [
        [...contexts, ...contexts],
        [...modes, ...modes],
        [...calls, ...calls],
      ],
      [contexts, [`0x01${'00'.repeat(31)}`], calls],
      [contexts, modes, [`${call.slice(0, 42)}${'0'.repeat(63)}1${call.slice(106)}` as Hex]],
    ]
    const [chain] = decodeAbiParameters([DELEGATION_TUPLE], context)
    changed.push([[encodeAbiParameters([DELEGATION_TUPLE], [[...chain, ...chain]])], modes, calls])
    for (const args of changed)
      expect(() =>
        assertStrategyEnvelope(
          encodeFunctionData({ abi: DELEGATION_ABI, functionName: 'redeemDelegations', args }),
          yieldOp,
          delegation.delegate,
        ),
      ).toThrow()
  })
  it('rejects unsigned caveat args instead of silently carrying them into an operation', () => {
    const withArgs = {
      ...delegation,
      caveats: [{ enforcer: a('ab'), terms: '0x' as Hex, args: '0x01' as Hex }],
    }
    expect(() =>
      assertStrategyEnvelope(
        encodeStrategyEnvelope(yieldOp, withArgs),
        yieldOp,
        delegation.delegate,
      ),
    ).toThrow()
  })
})
