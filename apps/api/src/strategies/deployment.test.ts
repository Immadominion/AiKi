import {
  encodeStrategyBindingTerms as browserTerms,
  type StrategyBinding,
  type StrategyKind,
} from '@aiki/contracts/strategies'
import { keccak256 } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  finalizeStrategyDeployment,
  prepareStrategyDeployment,
  readStrategySetupSnapshot,
  validatePreparedStrategyDeployment,
} from './deployment.js'
import { da, deploymentFixture, dh, localArtifact, setupInput } from './deployment.test-support.js'
import { STRATEGY_DEPLOYMENT_ARTIFACTS as A } from './deployment-artifacts.js'
import { runStrategyDeploymentCli } from './deployment-cli.js'
import {
  loadStrategyDeploymentConfig,
  parseStrategyDeploymentConfig,
  strategyDeploymentConfigDigest,
} from './deployment-config.js'
import {
  prepareStrategyInfrastructure,
  strategyInfrastructureTransactions,
} from './deployment-infrastructure.js'
import {
  canonicalizeStrategySetupInput,
  DEPLOYMENT_ABIS,
  deriveStrategyDeployment,
} from './deployment-policy.js'
import { assertStrategyArtifactRuntime } from './deployment-verification.js'
import { encodeStrategyBindingTerms } from './grant.js'

vi.mock('../config/deployments/bsc-mainnet.json', async (original) => {
  const module = await original<{ default: Record<string, unknown> }>()
  const { keccak256 } = await import('viem')
  return { default: { ...module.default, managerCodeHash: keccak256('0x60006000') } }
})

describe('reviewed unsigned strategy deployment', () => {
  it.each(['yield', 'grid', 'lp'] as const)(
    'prepares exact %s calldata and stable deterministic retry identity',
    async (kind) => {
      const f = deploymentFixture(kind),
        p = await f.prepared()
      expect(p).toMatchObject({
        owner: f.owner,
        chainId: 56,
        kind,
        alreadyDeployed: false,
        predictedVault: f.derived.predictedVault,
        policyHash: f.derived.policyHash,
        unsignedTransaction: {
          to: f.config.factories[kind].address,
          from: f.owner,
          data: f.derived.data,
          value: '0',
        },
      })
      f.deploy(true)
      expect(await f.prepare()).toMatchObject({
        status: 'prepared',
        prepared: { requestDigest: p.requestDigest, alreadyDeployed: true },
      })
      expect(f.reader.call).toHaveBeenCalledWith({
        account: f.owner,
        to: f.config.factories[kind].address,
        data: f.derived.data,
        value: 0n,
        blockNumber: 100n,
      })
      expect(Object.keys(f.reader)).not.toContain('sendTransaction')
    },
  )
  it('blocks missing configuration and bad policy before RPC', async () => {
    const f = deploymentFixture()
    expect(loadStrategyDeploymentConfig(undefined)).toBeNull()
    expect(loadStrategyDeploymentConfig('{}')).toBeNull()
    expect(
      await prepareStrategyDeployment({
        config: null,
        owner: f.owner,
        input: f.input,
        reader: f.reader,
      }),
    ).toMatchObject({ status: 'blocked' })
    f.input.common.expiresAt = '001'
    expect((await f.prepare()).status).toBe('blocked')
    expect(f.reader.getChainId).not.toHaveBeenCalled()
  })
  it.each(['different owner', 'different policy', 'different expiry'] as const)(
    '%s changes prediction instead of resetting existing vault',
    (caseName) => {
      const f = deploymentFixture(),
        other = structuredClone(f.input)
      const owner = caseName === 'different owner' ? da('98') : f.owner
      if (caseName === 'different policy' && other.kind === 'yield')
        other.policy.maxTurnover = '2001'
      if (caseName === 'different expiry') other.common.expiresAt = '1900086401'
      expect(
        deriveStrategyDeployment(owner, f.config.factories.yield.address, other).predictedVault,
      ).not.toBe(f.derived.predictedVault)
    },
  )
  it.each([
    'manager',
    'controller',
    'factory',
    'enforcer',
    'pool',
    'implementation',
    'storage',
    'owner',
    'prediction',
    'policy',
    'simulation',
    'canonical',
    'chain',
    'stale',
  ] as const)('fails closed on %s drift', async (which) => {
    const f = deploymentFixture()
    if (which === 'manager') f.codes.set(f.config.manager.address, '0x6002')
    if (which === 'controller') f.codes.set(f.input.controller, '0x6002')
    if (which === 'factory') f.codes.set(f.config.factories.yield.address, '0x6002')
    if (which === 'enforcer') f.codes.set(f.config.bindingEnforcer.address, '0x6002')
    if (which === 'pool') f.set('0x36696169c63e42cd08ce11f5deebbcebae652050', 'token0', da('88'))
    if (which === 'implementation') f.codes.set(f.config.implementations.aavePool.address, '0x6002')
    if (which === 'storage') vi.mocked(f.reader.getStorageAt).mockResolvedValue(dh('ff'))
    if (which === 'owner') f.set(f.input.controller, 'owner', da('98'))
    if (which === 'prediction')
      f.set(f.config.factories.yield.address, 'predictForController', da('98'))
    if (which === 'policy') f.set(f.config.factories.yield.address, 'expectedPolicyHash', dh('98'))
    if (which === 'simulation')
      vi.mocked(f.reader.call).mockRejectedValue(Error('rpc secret-token-url'))
    if (which === 'canonical')
      vi.mocked(f.reader.getBlock).mockImplementation(async (args) =>
        'blockTag' in args ? f.block : { ...f.block, hash: dh('ff') },
      )
    if (which === 'chain') vi.mocked(f.reader.getChainId).mockResolvedValue(97)
    if (which === 'stale') f.block.timestamp -= 1000n
    const result = await prepareStrategyDeployment({
      config: f.config,
      owner: f.owner,
      input: f.input,
      reader: f.reader,
      nowSeconds: 1900000000n,
    })
    expect(result.status).toBe('blocked')
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })
  it('requires actual registered runtime, not merely occupied predicted code', async () => {
    const f = deploymentFixture()
    f.deploy()
    const original = vi.mocked(f.reader.readContract).getMockImplementation()
    if (!original) throw new Error('Missing mock implementation')
    vi.mocked(f.reader.readContract).mockImplementation(async (args) =>
      args.functionName === 'registeredRuntimeHash' ? dh('ff') : original(args),
    )
    expect((await f.prepare()).status).toBe('blocked')
  })
  it('expires new creation but permits unchanged registered historical retry', async () => {
    const f = deploymentFixture()
    f.block.timestamp = BigInt(f.input.common.expiresAt) + 1n
    expect((await f.prepare()).status).toBe('blocked')
    f.deploy(true)
    expect(await f.prepare()).toMatchObject({
      status: 'prepared',
      prepared: { alreadyDeployed: true },
    })
  })
  it.each(['yield', 'grid', 'lp'] as const)(
    'requires exact finalized %s factory event and confirms real registry',
    async (kind) => {
      const f = deploymentFixture(kind),
        prepared = await f.prepared()
      f.deploy()
      expect(
        await finalizeStrategyDeployment({
          config: f.config,
          prepared,
          transactionHash: f.transactionHash,
          reader: f.reader,
          nowSeconds: f.block.timestamp,
        }),
      ).toMatchObject({
        status: 'verified',
        retry: false,
        requestDigest: prepared.requestDigest,
        binding: { kind, vault: prepared.predictedVault, policyHash: prepared.policyHash },
      })
    },
  )
  it.each(['yield', 'grid', 'lp'] as const)(
    'admits an exact %s eventless retry created earlier in the same block',
    async (kind) => {
      const f = deploymentFixture(kind),
        prepared = await f.prepared()
      f.deploy()
      f.receipt.logs = []
      const run = () =>
        finalizeStrategyDeployment({
          config: f.config,
          prepared,
          transactionHash: f.transactionHash,
          reader: f.reader,
          nowSeconds: f.block.timestamp,
        })
      expect(await run()).toMatchObject({ status: 'verified', retry: true })
      f.deploy(true)
      expect(await run()).toMatchObject({ status: 'verified', retry: true })
    },
  )
  it.each([
    'sender',
    'target',
    'calldata',
    'value',
    'chain',
    'receipt hash',
    'revert',
    'wrong log',
    'removed',
    'duplicate',
    'transaction block',
    'current owner',
    'registry runtime',
    'stored policy',
    'stored transaction',
  ] as const)('never confirms %s mismatch', async (which) => {
    const f = deploymentFixture(),
      prepared = await f.prepared()
    f.deploy()
    if (which === 'sender') f.tx.from = da('98')
    if (which === 'target') f.tx.to = da('98')
    if (which === 'calldata') f.tx.input = `${f.derived.data}00`
    if (which === 'value') f.tx.value = 1n
    if (which === 'chain') f.tx.chainId = 97
    if (which === 'receipt hash') f.receipt.blockHash = dh('98')
    if (which === 'revert') f.receipt.status = 'reverted'
    if (which === 'wrong log') f.log.data = `0x${da('98').slice(2).padStart(64, '0')}`
    if (which === 'removed') f.log.removed = true
    if (which === 'duplicate') f.receipt.logs = [f.log, f.log]
    if (which === 'transaction block') f.tx.blockNumber = 99n
    if (which === 'current owner') f.set(f.input.controller, 'owner', da('98'))
    if (which === 'registry runtime') {
      const original = vi.mocked(f.reader.readContract).getMockImplementation()
      if (!original) throw new Error('Missing mock implementation')
      vi.mocked(f.reader.readContract).mockImplementation(async (a) =>
        a.functionName === 'registeredRuntimeHash' ? dh('ff') : original(a),
      )
    }
    if (which === 'stored policy') prepared.policyHash = dh('98')
    if (which === 'stored transaction') prepared.unsignedTransaction.to = da('98')
    expect(
      (
        await finalizeStrategyDeployment({
          config: f.config,
          prepared,
          transactionHash: f.transactionHash,
          reader: f.reader,
          nowSeconds: f.block.timestamp,
        })
      ).status,
    ).toBe('blocked')
  })
  it('returns pending until mined and canonical finality, without a binding', async () => {
    const f = deploymentFixture(),
      prepared = await f.prepared()
    const run = () =>
      finalizeStrategyDeployment({
        config: f.config,
        prepared,
        transactionHash: f.transactionHash,
        reader: f.reader,
        nowSeconds: f.block.timestamp,
      })
    vi.mocked(f.reader.getTransactionReceipt).mockResolvedValue(null)
    expect(await run()).toMatchObject({ status: 'pending' })
    vi.mocked(f.reader.getTransactionReceipt).mockResolvedValue({ ...f.receipt, blockNumber: 101n })
    expect(await run()).toMatchObject({ status: 'pending' })
  })
  it('snapshot next step rejects wrong owner before RPC', async () => {
    const f = deploymentFixture(),
      prepared = await f.prepared()
    vi.mocked(f.reader.getChainId).mockClear()
    expect(
      (
        await readStrategySetupSnapshot({
          config: f.config,
          prepared,
          owner: da('98'),
          reader: f.reader,
        })
      ).status,
    ).toBe('blocked')
    expect(f.reader.getChainId).not.toHaveBeenCalled()
  })
  it('survives durable JSONB key order changes without relaxing values', async () => {
    const f = deploymentFixture(),
      prepared = await f.prepared()
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, value]) => [k, reverse(value)]),
            )
          : v
    expect(
      validatePreparedStrategyDeployment(f.config, reverse(prepared) as typeof prepared)
        .requestDigest,
    ).toBe(prepared.requestDigest)
  })
})

describe('canonical policies and artifact drift', () => {
  it.each([
    ['yield', '0xb57a3deb8aa36c2fbfeb51c8ee0bed4f3976bd2b19e7912126cc030118366ff0'],
    ['grid', '0x4acefe16c0dbe45cddc33c66f0af9849ce7e7cb30cc30bd6bf1b4e2aec042e5d'],
    ['lp', '0x7aab8ac8eff3c1e5c8fa918f16f51bc49664b6c4c4f73b94c879c59b278b0f0c'],
  ] as const)('matches independently encoded Foundry cast policy vector %s', (kind, expected) => {
    expect(deriveStrategyDeployment(da('99'), da('31'), setupInput(kind)).policyHash).toBe(expected)
  })
  it.each(['yield', 'grid', 'lp'] as const)(
    'round trips exact %s wire types and browser caveat',
    (kind) => {
      const input = setupInput(kind)
      expect(canonicalizeStrategySetupInput(input)).toEqual(input)
      const binding: StrategyBinding = {
        version: 1,
        chainId: 56,
        kind,
        controller: da('22'),
        vault: da('11'),
        policyHash: dh('44'),
        runtimeCodeHash: dh('55'),
      }
      expect(browserTerms(binding)).toBe(encodeStrategyBindingTerms(binding))
    },
  )
  it.each([
    'negative',
    'leading zero',
    'exponent',
    'fraction',
    'overflow',
    'number',
    'unknown',
    'wrongchain',
    'wrongbool',
    'unsorted',
    'thin gain',
    'wrongspacing',
  ] as const)('rejects %s policy inputs', (which) => {
    const input = setupInput(
      which === 'wrongbool' || which === 'unsorted' || which === 'thin gain'
        ? 'grid'
        : which === 'wrongspacing'
          ? 'lp'
          : 'yield',
    )
    if (input.kind === 'yield') {
      if (which === 'negative') input.policy.maxPrincipal = '-1'
      if (which === 'leading zero') input.policy.maxPrincipal = '01000'
      if (which === 'exponent') input.policy.maxPrincipal = '1e3'
      if (which === 'fraction') input.policy.maxPrincipal = '1.0'
      if (which === 'overflow') input.policy.maxPrincipal = (1n << 256n).toString()
      if (which === 'number') Object.assign(input.policy, { maxPrincipal: 1000 })
    }
    if (which === 'unknown') Object.assign(input, { salt: dh('66') })
    if (which === 'wrongchain') Object.assign(input, { chainId: 97 })
    if (input.kind === 'grid') {
      const rung = input.rungs[0]
      if (!rung) throw new Error('Missing fixture rung')
      if (which === 'wrongbool') Object.assign(input.rungs[0] as object, { initialSell: 1 })
      if (which === 'unsorted') input.rungs.push({ ...rung })
      if (which === 'thin gain') rung.sellTick = -150
    }
    if (input.kind === 'lp') input.policy.rangeWidth = 201
    expect(() => canonicalizeStrategySetupInput(input)).toThrow()
  })
  it('pins exact reviewed artifacts and factory ABI, independent of filesystem at runtime', () => {
    for (const [name, a] of Object.entries(A)) {
      const artifact = localArtifact(name)
      expect(a.creationCode).toBe(artifact.bytecode.object)
      expect(a.constructorInputs).toEqual(
        artifact.abi.find((e: { type: string }) => e.type === 'constructor')?.inputs ?? [],
      )
      expect(a.template.maskedCodeHash).toBe(keccak256(artifact.deployedBytecode.object))
      assertStrategyArtifactRuntime(name as keyof typeof A, artifact.deployedBytecode.object)
    }
    for (const kind of ['yield', 'grid', 'lp'] as StrategyKind[])
      expect(DEPLOYMENT_ABIS[kind]).toEqual(
        localArtifact(
          { yield: 'YieldVaultFactory', grid: 'GridVaultFactory', lp: 'LPVaultFactory' }[kind],
        ).abi,
      )
    expect(keccak256(A.GridStrategyVault.creationCode)).toBe(
      '0x732e4c7e16c8696808c2d4206011d7d80e634d4a7731672827aa2810022f936f',
    )
    expect(keccak256(A.PancakeLPVault.creationCode)).toBe(
      '0xc07b021eab142a2e9f31fd976b537a5f007ef2765c192dcdeec50a95b52a070c',
    )
  })
  it('rejects immutable duplication tampering and wrong template', () => {
    const code = localArtifact('AiKiMandateAccount').deployedBytecode.object as string
    const slot = A.AiKiMandateAccount.template.immutableReferences[0]
    if (!slot) throw new Error('Missing immutable fixture')
    const corrupt = `${code.slice(0, 2 + slot.start * 2)}${'1'.repeat(slot.length * 2)}${code.slice(2 + (slot.start + slot.length) * 2)}`
    expect(() => assertStrategyArtifactRuntime('AiKiMandateAccount', corrupt)).toThrow()
    expect(() => assertStrategyArtifactRuntime('AiKiMandateAccount', '0x6001')).toThrow()
  })
  it('canonical config digest is field-order invariant and rejects invented account template', () => {
    const f = deploymentFixture(),
      reverse = Object.fromEntries(Object.entries(f.config).reverse())
    expect(strategyDeploymentConfigDigest(parseStrategyDeploymentConfig(reverse))).toBe(
      strategyDeploymentConfigDigest(f.config),
    )
    expect(() =>
      parseStrategyDeploymentConfig({ ...f.config, accountRuntimeHash: dh('77') }),
    ).toThrow()
  })
})

describe('unsigned infrastructure tool', () => {
  it('produces four exact public CREATE artifacts, no guessed to/nonce/signature/key', async () => {
    const f = deploymentFixture(),
      result = await prepareStrategyInfrastructure({
        owner: f.owner,
        reader: f.reader,
        nowSeconds: f.block.timestamp,
      })
    expect(result.status).toBe('prepared')
    const txs = strategyInfrastructureTransactions(f.owner)
    expect(txs).toHaveLength(4)
    for (const tx of txs) {
      expect(tx.data.startsWith(A[tx.name].creationCode)).toBe(true)
      expect(tx).not.toHaveProperty('to')
      expect(tx).not.toHaveProperty('nonce')
      expect(tx).not.toHaveProperty('signature')
      expect(tx.value).toBe('0')
    }
    expect(f.reader.call).not.toHaveBeenCalled()
  })
  it('blocks infrastructure when reviewed manager code changes', async () => {
    const f = deploymentFixture()
    f.codes.set(f.config.manager.address, '0x6002')
    expect(
      await prepareStrategyInfrastructure({
        owner: f.owner,
        reader: f.reader,
        nowSeconds: f.block.timestamp,
      }),
    ).toMatchObject({ status: 'blocked' })
  })
  it.each(
    [
      [],
      ['send'],
      ['infrastructure', '--private-key', 'secret'],
      [
        'prepare',
        '--owner',
        da('99'),
        '--input',
        'x',
        '--config',
        'y',
        '--rpc',
        'http://unsafe.example',
      ],
    ].map((args) => ({ args })),
  )('rejects CLI authority expansion without RPC: $args', async ({ args }) => {
    expect(await runStrategyDeploymentCli(args)).toMatchObject({ status: 'blocked' })
  })
})
