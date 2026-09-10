import { decodeFunctionData } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { DELEGATION_ABI } from '../execution/executor.js'
import { assertStrategyEnvelope } from './envelope.js'
import { fixture, h, yieldOp } from './receipt.test-support.js'
import { isVerifiedStrategySimulation } from './simulation.js'
import { simulationFixture } from './simulation.test-support.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (importOriginal) => {
  const original = await importOriginal<{ default: { manager: string; managerCodeHash: string } }>()
  const { keccak256 } = await import('viem')
  return { default: { ...original.default, managerCodeHash: keccak256('0x60006000') } }
})
async function setup() {
  const f = fixture(structuredClone(yieldOp))
  const result = await simulationFixture(f.target.operation, f.delegation)
  for (const mock of Object.values(result.reader)) mock.mockClear()
  return result
}
describe('full strategy manager simulation', () => {
  it('simulates the exact whole permission path and gas on one canonical block', async () => {
    const f = await setup(),
      quote = await f.run()
    expect(quote.status).toBe('simulated')
    expect(isVerifiedStrategySimulation(quote)).toBe(true)
    const call = f.reader.call.mock.calls[0]?.[0]
    expect(call).toMatchObject({
      account: f.input.executor,
      to: f.snapshot.manager,
      value: 0n,
      blockNumber: f.snapshot.block.number,
    })
    if (!call) throw new Error('Missing simulated call')
    expect(decodeFunctionData({ abi: DELEGATION_ABI, data: call.data }).functionName).toBe(
      'redeemDelegations',
    )
    assertStrategyEnvelope(call.data, f.input.operation, f.input.executor)
    expect(f.reader.estimateGas).toHaveBeenCalledWith(call)
    expect(f.reader.getBlock).toHaveBeenCalledWith({ blockNumber: f.snapshot.block.number })
  })
  it('issues immutable in-process proof, never a serializable trust token', async () => {
    const f = await setup(),
      quote = await f.run()
    expect(Object.isFrozen(quote)).toBe(true)
    expect(isVerifiedStrategySimulation({ ...quote })).toBe(false)
    expect(() => Object.assign(quote, { gasUnits: 1n })).toThrow()
    f.input.snapshot = { ...f.snapshot }
    expect((await f.run()).status).toBe('blocked')
    expect(f.reader.call).toHaveBeenCalledTimes(1)
  })
  it('rejects a broad grant, wrong signed vault terms and malformed signature before RPC', async () => {
    for (const change of [
      (f: Awaited<ReturnType<typeof setup>>) => {
        f.input.delegation.caveats = []
      },
      (f: Awaited<ReturnType<typeof setup>>) => {
        const caveat = f.input.delegation.caveats[1]
        if (!caveat) throw new Error('Missing fixture caveat')
        caveat.terms = h('ab')
      },
      (f: Awaited<ReturnType<typeof setup>>) => {
        f.input.delegation.signature = '0x1234'
      },
    ]) {
      const f = await setup()
      change(f)
      expect((await f.run()).status).toBe('blocked')
      expect(f.reader.getChainId).not.toHaveBeenCalled()
    }
  })
  it('blocks mismatched nonce, binding and snapshot-relative deadline', async () => {
    for (const fields of [
      { expectedNonce: 8n },
      { deadline: yieldOp.deadline + 86400n },
      { deadline: yieldOp.deadline - 120n },
    ]) {
      const f = await setup()
      Object.assign(f.input.operation, fields)
      expect((await f.run()).status).toBe('blocked')
      expect(f.reader.call).not.toHaveBeenCalled()
    }
    const f = await setup()
    f.input.operation.binding.policyHash = h('ab')
    expect((await f.run()).status).toBe('blocked')
  })
  it('never issues a quote after a manager revert or missing full-call gas estimate', async () => {
    const f = await setup()
    f.reader.call.mockRejectedValue(new Error('reverted'))
    expect((await f.run()).status).toBe('blocked')
    expect(f.reader.estimateGas).not.toHaveBeenCalled()
    const other = await setup()
    other.reader.estimateGas.mockRejectedValue(new Error('unsupported historical estimate'))
    expect((await other.run()).status).toBe('blocked')
  })
  it('rejects zero or unbounded gas and prices', async () => {
    for (const gas of [0n, -1n, 30_000_001n]) {
      const f = await setup()
      f.reader.estimateGas.mockResolvedValue(gas)
      expect((await f.run()).status).toBe('blocked')
    }
    for (const price of [0n, -1n, 1_000_000_000_001n]) {
      const f = await setup()
      f.reader.getGasPrice.mockResolvedValue(price)
      expect((await f.run()).status).toBe('blocked')
    }
  })
  it('rejects a changed canonical hash or RPC chain after simulation', async () => {
    const f = await setup()
    f.reader.getBlock.mockResolvedValue({ ...f.snapshot.block, hash: h('ab') })
    expect((await f.run()).status).toBe('blocked')
    const other = await setup()
    other.reader.getChainId.mockResolvedValueOnce(56).mockResolvedValueOnce(97)
    expect((await other.run()).status).toBe('blocked')
  })
  it('captures permission and operation before awaits so caller mutation cannot change the call', async () => {
    const f = await setup()
    const first = f.simulation.operationDigest
    f.reader.getChainId.mockImplementation(async () => {
      f.input.operation.expectedNonce = 900n
      f.input.delegation.salt = 900n
      return 56
    })
    const quote = await f.run()
    expect(quote).toMatchObject({ status: 'simulated', operationDigest: first })
  })
})
