import { beforeEach, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({
  chain: vi.fn(),
  balance: vi.fn(),
  prepare: vi.fn(),
  sign: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
  lookup: vi.fn(),
  block: vi.fn(),
  code: vi.fn(),
  read: vi.fn(),
  legacy: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: () => ({
    getChainId: rpc.chain,
    getBalance: rpc.balance,
    sendRawTransaction: rpc.send,
    waitForTransactionReceipt: rpc.receipt,
    getTransactionReceipt: rpc.lookup,
    getBlock: rpc.block,
    getCode: rpc.code,
    readContract: rpc.read,
  }),
  createWalletClient: () => ({
    prepareTransactionRequest: rpc.prepare,
    signTransaction: rpc.sign,
    deployContract: rpc.legacy,
  }),
}))

const { getContractAddress, keccak256 } = await import('viem')
const { privateKeyToAccount } = await import('viem/accounts')
const { viemAccountDeployer } = await import('./deploy.js')
const { InMemoryAccountStore } = await import('./store.js')
const { expectedAccountRuntime } = await import('./runtime.js')
const owner = `0x${'11'.repeat(20)}` as const
const otherOwner = `0x${'22'.repeat(20)}` as const
const manager = `0x${'33'.repeat(20)}` as const
const funderKey = `0x${'00'.repeat(31)}01` as const
const funder = privateKeyToAccount(funderKey).address
const signed = '0x010203' as const
const hash = keccak256(signed)
const address = getContractAddress({ from: funder, nonce: 0n }).toLowerCase()
const blockHash = `0x${'ab'.repeat(32)}` as const
const goodReceipt = {
  status: 'success',
  transactionHash: hash,
  contractAddress: address,
  blockNumber: 80n,
  blockHash,
}
const config = { rpcUrl: 'http://127.0.0.1:1', chainId: 56, manager, funderKey }

beforeEach(() => {
  vi.resetAllMocks()
  rpc.chain.mockResolvedValue(56)
  rpc.balance.mockResolvedValue(1_000_000_000_000_000_000n)
  rpc.prepare.mockResolvedValue({ nonce: 0, data: '0x', chainId: 56 })
  rpc.sign.mockResolvedValue(signed)
  rpc.send.mockResolvedValue(hash)
  rpc.legacy.mockResolvedValue(hash)
  rpc.receipt.mockResolvedValue(goodReceipt)
  rpc.lookup.mockResolvedValue(goodReceipt)
  rpc.block.mockImplementation(async (input) => ({
    number: 'blockTag' in input ? 100n : 80n,
    hash: blockHash,
  }))
  rpc.code.mockResolvedValue(expectedAccountRuntime(manager))
  rpc.read.mockImplementation(async (input) => (input.functionName === 'owner' ? owner : manager))
})

it('never associates a replacement deployment receipt with the requested owner', async () => {
  const store = new InMemoryAccountStore()
  rpc.receipt.mockResolvedValue({
    ...goodReceipt,
    transactionHash: `0x${'ff'.repeat(32)}`,
    contractAddress: otherOwner,
  })
  await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
    code: 'ACCOUNT_DEPLOY_PENDING',
  })
  expect(await store.find(owner, 56)).toBeNull()
  expect((await store.pendingDeployment(owner, 56))?.transactionHash).toBe(hash)
})

it('refuses the wrong RPC chain before signing or spending gas', async () => {
  const store = new InMemoryAccountStore()
  rpc.chain.mockResolvedValue(97)
  await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
    code: 'ACCOUNT_DEPLOY_FAILED',
  })
  expect(rpc.prepare).not.toHaveBeenCalled()
  expect(rpc.send).not.toHaveBeenCalled()
  expect(await store.pendingDeployment(owner, 56)).toBeNull()
})

it.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  'does not sign an unverifiable deployment nonce %#',
  async (nonce) => {
    const store = new InMemoryAccountStore()
    rpc.prepare.mockResolvedValue({ nonce })
    await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
      code: 'ACCOUNT_DEPLOY_FAILED',
    })
    expect(rpc.sign).not.toHaveBeenCalled()
    expect(rpc.send).not.toHaveBeenCalled()
  },
)

it('keeps repeated unknown-hash checks read-only and refuses changed deployment configuration', async () => {
  const store = new InMemoryAccountStore()
  rpc.send.mockRejectedValue(new Error('private-rpc-fixture'))
  rpc.lookup.mockRejectedValue(new Error('private-rpc-fixture'))
  const deployer = viemAccountDeployer({ ...config, store })
  for (let i = 0; i < 3; i++) {
    try {
      await deployer.deploy(owner)
    } catch (error) {
      expect(error).toMatchObject({ code: 'ACCOUNT_DEPLOY_PENDING' })
      expect(String(error)).not.toContain('private-rpc-fixture')
      expect(String(error)).toContain(hash)
    }
  }
  expect(rpc.send).toHaveBeenCalledOnce()
  expect(rpc.sign).toHaveBeenCalledOnce()
  expect(rpc.lookup).toHaveBeenCalledTimes(2)
  await expect(
    viemAccountDeployer({ ...config, store, manager: otherOwner }).deploy(owner),
  ).rejects.toMatchObject({ code: 'ACCOUNT_DEPLOY_PENDING' })
  await expect(
    viemAccountDeployer({ ...config, store, funderKey: `0x${'00'.repeat(31)}02` }).deploy(owner),
  ).rejects.toMatchObject({ code: 'ACCOUNT_DEPLOY_PENDING' })
  expect(rpc.lookup).toHaveBeenCalledTimes(2)
  expect(rpc.send).toHaveBeenCalledOnce()
})

it.each([56, 97])(
  'persists exact hash and CREATE address before broadcast, then verifies account identity on chain %s',
  async (chainId) => {
    const store = new InMemoryAccountStore()
    rpc.chain.mockResolvedValue(chainId)
    rpc.send.mockImplementation(async () => {
      expect(await store.pendingDeployment(owner, chainId)).toMatchObject({
        transactionHash: hash,
        expectedAddress: address,
        state: 'SUBMITTED',
      })
      expect(await store.find(owner, chainId)).toBeNull()
      return hash
    })
    expect(await viemAccountDeployer({ ...config, chainId, store }).deploy(owner)).toMatchObject({
      address,
      transactionHash: hash,
    })
    expect(await store.pendingDeployment(owner, chainId)).toBeNull()
    expect(await store.find(owner, chainId)).toMatchObject({ address, owner, deployedTx: hash })
    expect(rpc.receipt).toHaveBeenCalledWith({
      hash,
      confirmations: 3,
      checkReplacement: false,
      timeout: 60_000,
    })
    expect(rpc.legacy).not.toHaveBeenCalled()
  },
)

it('blocks a different owner before either can prepare the same funder nonce', async () => {
  const store = new InMemoryAccountStore()
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  rpc.prepare.mockImplementation(async () => {
    started()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { nonce: 0, chainId: 56 }
  })
  const first = viemAccountDeployer({ ...config, store }).deploy(owner)
  await ready
  await expect(viemAccountDeployer({ ...config, store }).deploy(otherOwner)).rejects.toMatchObject({
    code: 'ACCOUNT_DEPLOY_PENDING',
  })
  expect(rpc.prepare).toHaveBeenCalledOnce()
  expect(rpc.send).not.toHaveBeenCalled()
  release()
  await first
  expect(rpc.send).toHaveBeenCalledOnce()
})

it.each(['send', 'receipt'] as const)(
  'retains uncertainty after lost %s response; restart checks the same hash without another broadcast',
  async (stage) => {
    const store = new InMemoryAccountStore()
    rpc[stage].mockRejectedValue(new Error('private-rpc-fixture'))
    await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
      code: 'ACCOUNT_DEPLOY_PENDING',
    })
    const pending = await store.pendingDeployment(owner, 56)
    expect(pending).toMatchObject({ state: 'UNCONFIRMED', transactionHash: hash })
    expect(await store.find(owner, 56)).toBeNull()
    // A fresh deployer represents process restart. Recovery uses receipt lookup,
    // not the signing/send path, even after a lost send acknowledgement.
    expect(await viemAccountDeployer({ ...config, store }).deploy(owner)).toMatchObject({
      address,
      transactionHash: hash,
    })
    expect(rpc.lookup).toHaveBeenCalledWith({ hash })
    expect(rpc.prepare).toHaveBeenCalledOnce()
    expect(rpc.send).toHaveBeenCalledOnce()
  },
)

it('does not leak another owner hash while its deployment is uncertain', async () => {
  const store = new InMemoryAccountStore()
  rpc.send.mockRejectedValue(new Error('lost acknowledgement'))
  await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
    code: 'ACCOUNT_DEPLOY_PENDING',
  })
  try {
    await viemAccountDeployer({ ...config, store }).deploy(otherOwner)
  } catch (error) {
    expect(String(error)).not.toContain(hash)
    expect(String(error)).not.toContain(owner)
  }
  expect(rpc.send).toHaveBeenCalledOnce()
})

it('reports an empty funder before signing or broadcasting and permits a later funded retry', async () => {
  const store = new InMemoryAccountStore()
  rpc.balance.mockResolvedValueOnce(0n)
  await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
    code: 'ACCOUNT_FUNDER_EMPTY',
  })
  expect(rpc.sign).not.toHaveBeenCalled()
  expect(rpc.send).not.toHaveBeenCalled()
  expect(await store.pendingDeployment(owner, 56)).toBeNull()
  expect(await viemAccountDeployer({ ...config, store }).deploy(owner)).toMatchObject({ address })
})

it.each(['prepare', 'sign'] as const)(
  'only releases a known pre-broadcast %s failure',
  async (stage) => {
    const store = new InMemoryAccountStore()
    rpc[stage].mockRejectedValue(new Error('private-key-fixture'))
    await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
      code: 'ACCOUNT_DEPLOY_FAILED',
    })
    expect(await store.pendingDeployment(owner, 56)).toBeNull()
    expect(rpc.send).not.toHaveBeenCalled()
  },
)

it('never broadcasts when durable hash persistence loses its acknowledgement', async () => {
  const store = new InMemoryAccountStore()
  const save = store.recordDeploymentHash.bind(store)
  vi.spyOn(store, 'recordDeploymentHash').mockImplementation(async (...args) => {
    await save(...args)
    throw new Error('lost database acknowledgement')
  })
  await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
    code: 'ACCOUNT_DEPLOY_FAILED',
  })
  expect(rpc.send).not.toHaveBeenCalled()
  expect(await store.pendingDeployment(owner, 56)).toBeNull()
})

it('keeps PREPARING claims without hashes locked after a crash', async () => {
  const store = new InMemoryAccountStore()
  await store.beginDeployment({
    id: crypto.randomUUID(),
    owner,
    funder: funder.toLowerCase() as `0x${string}`,
    manager,
    chainId: 56,
    state: 'PREPARING',
    createdAt: new Date().toISOString(),
  })
  await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
    code: 'ACCOUNT_DEPLOY_PENDING',
  })
  expect(rpc.prepare).not.toHaveBeenCalled()
  expect(rpc.send).not.toHaveBeenCalled()
})

it('recovers a database-finalization failure by verifying the original hash, not deploying again', async () => {
  const store = new InMemoryAccountStore()
  vi.spyOn(store, 'finalizeDeployment').mockRejectedValueOnce(new Error('database unavailable'))
  await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
    code: 'ACCOUNT_DEPLOY_PENDING',
  })
  expect(await store.find(owner, 56)).toBeNull()
  expect(await viemAccountDeployer({ ...config, store }).deploy(owner)).toMatchObject({ address })
  expect(rpc.send).toHaveBeenCalledOnce()
})

it('returns the existing account after a lost finalization COMMIT response', async () => {
  const store = new InMemoryAccountStore()
  const finalize = store.finalizeDeployment.bind(store)
  vi.spyOn(store, 'finalizeDeployment').mockImplementationOnce(async (attempt) => {
    await finalize(attempt)
    throw new Error('lost COMMIT acknowledgement')
  })
  await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
    code: 'ACCOUNT_DEPLOY_PENDING',
  })
  expect(await viemAccountDeployer({ ...config, store }).deploy(owner)).toMatchObject({
    address,
    created: false,
  })
  expect(rpc.send).toHaveBeenCalledOnce()
})

it.each([
  { transactionHash: undefined },
  { contractAddress: otherOwner },
  { blockHash: undefined },
  { blockNumber: 80 },
  { blockNumber: -1n },
  { status: 'unknown' },
])(
  'keeps malformed or mismatched receipt %# locked without publishing an account',
  async (patch) => {
    const store = new InMemoryAccountStore()
    rpc.receipt.mockResolvedValue({ ...goodReceipt, ...patch })
    await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
      code: 'ACCOUNT_DEPLOY_PENDING',
    })
    expect(await store.find(owner, 56)).toBeNull()
    expect((await store.pendingDeployment(owner, 56))?.state).toBe('UNCONFIRMED')
  },
)

it.each([
  null,
  {},
  { number: 79n, hash: blockHash },
  { number: 100n, hash: null },
  { number: 80n, hash: `0x${'ff'.repeat(32)}` },
])('requires valid finalized checkpoint %#', async (block) => {
  const store = new InMemoryAccountStore()
  rpc.block.mockResolvedValue(block)
  await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
    code: 'ACCOUNT_DEPLOY_PENDING',
  })
  expect(await store.find(owner, 56)).toBeNull()
})

it.each(['runtime', 'owner', 'manager', 'canonical', 'chain'] as const)(
  'refuses a mismatched deployed %s independently',
  async (field) => {
    const store = new InMemoryAccountStore()
    if (field === 'runtime') rpc.code.mockResolvedValue('0x1234')
    if (field === 'owner' || field === 'manager')
      rpc.read.mockImplementation(async (input) =>
        input.functionName === (field === 'owner' ? 'owner' : 'DELEGATION_MANAGER')
          ? otherOwner
          : input.functionName === 'owner'
            ? owner
            : manager,
      )
    if (field === 'canonical')
      rpc.block
        .mockResolvedValueOnce({ number: 100n, hash: blockHash })
        .mockResolvedValueOnce({ number: 80n, hash: `0x${'ff'.repeat(32)}` })
    if (field === 'chain')
      rpc.chain.mockResolvedValueOnce(56).mockResolvedValueOnce(56).mockResolvedValueOnce(97)
    await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
      code: 'ACCOUNT_DEPLOY_PENDING',
    })
    expect(await store.find(owner, 56)).toBeNull()
  },
)

it.each([false, true])(
  'releases a mined revert only when finality is proven (%s)',
  async (finalized) => {
    const store = new InMemoryAccountStore()
    rpc.receipt.mockResolvedValue({ ...goodReceipt, status: 'reverted', contractAddress: null })
    if (!finalized) rpc.block.mockResolvedValue({ number: 79n, hash: blockHash })
    await expect(viemAccountDeployer({ ...config, store }).deploy(owner)).rejects.toMatchObject({
      code: finalized ? 'ACCOUNT_DEPLOY_REVERTED' : 'ACCOUNT_DEPLOY_PENDING',
    })
    expect(Boolean(await store.pendingDeployment(owner, 56))).toBe(!finalized)
    expect(await store.find(owner, 56)).toBeNull()
  },
)
