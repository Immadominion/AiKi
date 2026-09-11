import { encodeErrorResult, parseAbi } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BSC_MAINNET } from '../config/chains.js'
import { InMemoryEvidenceStore } from '../evidence/store.js'
import { registeredObservation } from '../indexer/evidence-sink.js'
import {
  CURRENT_REGISTRATION_TIMEOUT_MS,
  type CurrentRegistrationReader,
  createCurrentRegistrationReader,
  probeCurrentCandidate,
  readCurrentRegistration,
} from './current-registration.js'
import type { probeAgent } from './probe.js'
import type { resolveRegistration } from './registration.js'
import type { ProbeCandidate } from './sweep.js'

const owner = `0x${'ab'.repeat(20)}`
const candidate: ProbeCandidate = {
  chainId: 56,
  registry: BSC_MAINNET.contracts.erc8004Identity,
  agentId: '43129',
  agentUri: 'https://old.example/registration.json',
  lastProbedAt: null,
}
const uri = 'https://new.example/registration.json'
function fixture() {
  const block = {
    number: 121000000n,
    hash: `0x${'cd'.repeat(32)}`,
    timestamp: BigInt(Math.floor(Date.now() / 1000) - 2),
  }
  const reader = {
    getChainId: vi.fn().mockResolvedValue(56),
    getBlock: vi.fn().mockImplementation(async () => ({ ...block })),
    readContract: vi
      .fn()
      .mockImplementation(async (input) => (input.functionName === 'ownerOf' ? owner : uri)),
  } satisfies CurrentRegistrationReader
  const store = new InMemoryEvidenceStore()
  const resolve = vi.fn<typeof resolveRegistration>().mockImplementation(async (value) => ({
    uri: value,
    scheme: 'https',
    status: 'resolved',
    fetchedAt: new Date().toISOString(),
    zeroCost: false,
    manifest: {
      name: 'Current agent',
      services: [{ name: 'aiki-agent', endpoint: 'https://new.example/agents/43129' }],
      registrations: [],
      supportedTrust: [],
    },
  }))
  const probe = vi.fn<typeof probeAgent>().mockImplementation(async (input) => ({
    agentId: input.agentId,
    verdict: { state: 'LIVE', rule: 'D5', detail: 'Local fixture.' },
    samples: [],
    registrationWasZeroCost: false,
    probedAt: new Date().toISOString(),
  }))
  const run = (input = candidate) => probeCurrentCandidate(input, reader, store, { resolve, probe })
  return { block, reader, store, resolve, probe, run }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('scheduled probe current finalized registration', () => {
  it('uses changed tokenURI rather than fetching the original Registered URI', async () => {
    const f = fixture()
    await f.run()
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(uri)
    expect(f.probe).toHaveBeenCalledWith(expect.objectContaining({ agentUri: uri }))
    expect(
      f.reader.readContract.mock.calls.map(([input]) => ({
        name: input.functionName,
        block: input.blockNumber,
        args: input.args,
      })),
    ).toEqual(
      expect.arrayContaining([
        { name: 'ownerOf', block: f.block.number, args: [43129n] },
        { name: 'tokenURI', block: f.block.number, args: [43129n] },
      ]),
    )
  })
  it('does not fetch any URI or persist fresh evidence when the registry RPC fails', async () => {
    const f = fixture()
    f.reader.getChainId.mockRejectedValue(new Error('private RPC credential'))
    await expect(f.run()).rejects.toThrow('Current finalized registration could not be verified')
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.store.observations).toEqual([])
  })
  it('does not probe burned/nonexistent tokens when ownerOf reverts', async () => {
    const f = fixture()
    f.reader.readContract.mockRejectedValue(new Error('ERC721NonexistentToken'))
    await expect(f.run()).rejects.toThrow('Current finalized registration could not be verified')
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.store.observations).toEqual([])
  })
  it('preserves historical Registered facts and adds exact finalized current-identity provenance', async () => {
    const f = fixture()
    await f.store.append(
      registeredObservation(
        {
          agentId: candidate.agentId,
          agentURI: candidate.agentUri,
          owner: `0x${'11'.repeat(20)}`,
          blockNumber: 120000000,
          logIndex: 0,
          txHash: `0x${'ef'.repeat(32)}`,
        },
        new Date(Date.now() - 60_000).toISOString(),
      ),
    )
    const historical = structuredClone(f.store.observations[0])
    await f.run({ ...candidate, agentUri: '' })
    expect(f.store.observations[0]).toEqual(historical)
    expect(
      f.store.observations.filter((o) => o.predicate === 'erc8004.agent_registered'),
    ).toHaveLength(1)
    expect(
      f.store.observations.find((o) => o.predicate === 'erc8004.registration_resolution')?.value,
    ).toMatchObject({
      uri,
      currentIdentity: {
        chainId: 56,
        registry: candidate.registry.toLowerCase(),
        agentId: candidate.agentId,
        owner,
        agentUri: uri,
        block: {
          number: f.block.number.toString(),
          hash: f.block.hash,
          timestamp: f.block.timestamp.toString(),
          finality: 'finalized',
        },
      },
    })
    expect(f.reader.getChainId).toHaveBeenCalledTimes(2)
    expect(f.reader.getBlock.mock.calls).toEqual([
      [{ blockTag: 'finalized' }],
      [{ blockNumber: f.block.number }],
    ])
    expect(f.reader.readContract).toHaveBeenCalledTimes(2)
    expect(
      f.reader.readContract.mock.calls.every(
        ([request]) => request.address === BSC_MAINNET.contracts.erc8004Identity,
      ),
    ).toBe(true)
  })
  it.each([
    { chainId: 97 },
    { chainId: 1 },
    { registry: `0x${'11'.repeat(20)}` },
    { agentId: '-1' },
    { agentId: '01' },
    { agentId: '1.1' },
    { agentId: '0x01' },
    { agentId: (1n << 256n).toString() },
  ])('rejects an unbound candidate before any RPC: %j', async (change) => {
    const f = fixture()
    await expect(f.run({ ...candidate, ...change })).rejects.toThrow(
      'Current finalized registration could not be verified',
    )
    expect(f.reader.getChainId).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.store.observations).toEqual([])
  })
  it.each([0n, (1n << 256n) - 1n])('preserves exact uint256 token IDs including %s', async (id) => {
    const f = fixture()
    await readCurrentRegistration({ ...candidate, agentId: id.toString() }, f.reader)
    expect(f.reader.readContract.mock.calls.every(([request]) => request.args[0] === id)).toBe(true)
  })
  it.each(['before', 'after'])('rejects actual RPC chain mismatch %s state reads', async (when) => {
    const f = fixture()
    if (when === 'before') f.reader.getChainId.mockResolvedValue(97)
    else f.reader.getChainId.mockResolvedValueOnce(56).mockResolvedValueOnce(97)
    await expect(f.run()).rejects.toThrow('Current finalized registration could not be verified')
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.store.observations).toEqual([])
  })
  it.each(['hash', 'number', 'timestamp'])('rejects canonical block %s drift', async (field) => {
    const f = fixture()
    f.reader.getBlock.mockResolvedValueOnce({ ...f.block }).mockResolvedValueOnce({
      ...f.block,
      [field]:
        field === 'hash'
          ? `0x${'11'.repeat(32)}`
          : field === 'number'
            ? f.block.number + 1n
            : f.block.timestamp + 1n,
    })
    await expect(f.run()).rejects.toThrow('Current finalized registration could not be verified')
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.store.observations).toEqual([])
  })
  it.each([
    null,
    { number: 1, hash: `0x${'cd'.repeat(32)}`, timestamp: 1n },
    { number: 1n, hash: `0x${'00'.repeat(32)}`, timestamp: 1n },
  ])('rejects malformed finalized blocks', async (block) => {
    const f = fixture()
    f.reader.getBlock.mockResolvedValue(block)
    await expect(f.run()).rejects.toThrow('Current finalized registration could not be verified')
    expect(f.reader.readContract).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.store.observations).toEqual([])
  })
  it.each([-121, 1])(
    'rejects stale/future finalized timestamp offset %s seconds',
    async (offset) => {
      const f = fixture()
      f.block.timestamp = BigInt(Math.floor(Date.now() / 1000) + offset)
      await expect(f.run()).rejects.toThrow('Current finalized registration could not be verified')
      expect(f.reader.readContract).not.toHaveBeenCalled()
      expect(f.store.observations).toEqual([])
    },
  )
  it.each([
    ['ownerOf', '0x'],
    ['ownerOf', `0x${'00'.repeat(20)}`],
    ['ownerOf', null],
    ['tokenURI', ''],
    ['tokenURI', null],
    ['tokenURI', 'x'.repeat(1024 * 1024 + 1)],
  ])('rejects malformed %s results', async (name, value) => {
    const f = fixture()
    f.reader.readContract.mockImplementation(async (input) =>
      input.functionName === name ? value : input.functionName === 'ownerOf' ? owner : uri,
    )
    await expect(f.run()).rejects.toThrow('Current finalized registration could not be verified')
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.store.observations).toEqual([])
  })
  it('expires an ignored RPC promise and suppresses all late follow-on work', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let release: (value: number) => void = () => {}
    f.reader.getChainId.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const result = f.run().then(
      () => 'unexpected success',
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(CURRENT_REGISTRATION_TIMEOUT_MS)
    expect(await result).toContain('Current finalized registration could not be verified')
    release(56)
    await vi.runAllTimersAsync()
    expect(f.reader.getBlock).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.store.observations).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('clears its deadline after successful identity verification', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const identity = await readCurrentRegistration(candidate, f.reader)
    expect(Object.isFrozen(identity)).toBe(true)
    expect(Object.isFrozen(identity.block)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('never follows CCIP-read URLs from an RPC revert', async () => {
    const errorData = encodeErrorResult({
      abi: parseAbi([
        'error OffchainLookup(address sender,string[] urls,bytes callData,bytes4 callbackFunction,bytes extraData)',
      ]),
      errorName: 'OffchainLookup',
      args: [
        BSC_MAINNET.contracts.erc8004Identity,
        ['https://unreviewed.example/{data}'],
        '0x1234',
        '0x12345678',
        '0x',
      ],
    })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: 3, message: 'revert', data: errorData },
      })
    })
    vi.stubGlobal('fetch', fetcher)
    const reader = createCurrentRegistrationReader('https://rpc.example.invalid')
    await expect(
      reader.readContract({
        address: BSC_MAINNET.contracts.erc8004Identity,
        abi: parseAbi(['function ownerOf(uint256) view returns (address)']),
        functionName: 'ownerOf',
        args: [43129n],
        blockNumber: 121000000n,
      }),
    ).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://rpc.example.invalid/')
  })
  it('retains the exact selected identity if the caller object changes while RPC is pending', async () => {
    const f = fixture()
    const input = { ...candidate }
    f.reader.getChainId.mockImplementationOnce(async () => {
      input.agentId = '999'
      input.registry = `0x${'11'.repeat(20)}`
      return 56
    })
    await f.run(input)
    expect(f.reader.readContract.mock.calls.every(([request]) => request.args[0] === 43129n)).toBe(
      true,
    )
    expect(f.probe).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: '43129',
        registry: `eip155:56:${candidate.registry.toLowerCase()}`,
      }),
    )
    expect(
      f.store.observations.every(
        (entry) =>
          entry.subject.agentId === '43129' &&
          entry.subject.registry === candidate.registry.toLowerCase(),
      ),
    ).toBe(true)
  })
})
