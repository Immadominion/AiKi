/** OPT-IN LOCAL-ONLY customer journey. Never run against a public transaction endpoint.
 * STRATEGY_JOURNEY_RPC=http://127.0.0.1:18545 BSC_FORK_BLOCK=121004566
 * STRATEGY_JOURNEY_DATABASE_URL=postgres://...@127.0.0.1:.../local_test pnpm exec vitest run src/strategies/strategy-journey-fork.test.ts
 * Start Anvil separately with the same explicit mainnet fork block, --chain-id56,
 * --hardfork cancun, --gas-price 50000000 --disable-min-priority-fee
 * --block-base-fee-per-gas 50000000 and
 * --slots-in-an-epoch1 (local finalized tag trails two blocks).
 * Uses unlocked PUBLIC Anvil accounts, not environment keys or production signatures.
 */
import { randomUUID } from 'node:crypto'
import { DELEGATION_TYPES, delegationMessage } from '@aiki/contracts'
import type {
  StrategySetupInput,
  StrategySetupView,
  StrategyWalletActionRequest,
} from '@aiki/contracts/strategies'
import postgres from 'postgres'
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseAbi,
} from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import mainnet from '../config/deployments/bsc-mainnet.json' with { type: 'json' }
import { applyMigrations, readMigrations } from '../db/migrate.js'
import {
  DELEGATION_ABI,
  DELEGATION_TUPLE,
  encodeSingleExecution,
  executeRedemption,
  type RedemptionRequest,
} from '../execution/executor.js'
import { readStrategySetupSnapshot } from './deployment.js'
import { STRATEGY_DEPLOYMENT_ARTIFACTS as A } from './deployment-artifacts.js'
import {
  STRATEGY_PROTOCOL_ADDRESSES as P,
  parseStrategyDeploymentConfig,
  reviewedStrategyAccountRuntimeHash,
  type StrategyDeploymentConfig,
  strategyDeploymentConfigDigest,
} from './deployment-config.js'
import { strategyInfrastructureTransactions } from './deployment-infrastructure.js'
import { decodeStoredStrategyDelegation } from './envelope.js'
import { executeStrategyOperation, type StrategyExecutionResult } from './execution.js'
import { mulDivRoundingUp, quoteAtTick, sqrtRatioAtTick } from './grid/math.js'
import { runStrategySweep } from './runner.js'
import { planStrategyPass } from './runner-plan.js'
import { createStrategyRunnerPolicy } from './runner-policy.js'
import { PostgresStrategyRunnerStore } from './runner-store.js'
import { StrategySetupService } from './setup.js'
import { PostgresStrategySetupStore } from './setup-store.js'
import { isVerifiedStrategySimulation, quoteStrategyOperation } from './simulation.js'
import { PostgresStrategyStore } from './store.js'

const rpcUrl = process.env.STRATEGY_JOURNEY_RPC
const databaseUrl = process.env.STRATEGY_JOURNEY_DATABASE_URL
const forkBlockText = process.env.BSC_FORK_BLOCK
const requested = !!(rpcUrl || databaseUrl)
if (
  requested &&
  (!rpcUrl || !databaseUrl || !forkBlockText || !/^[1-9][0-9]*$/.test(forkBlockText))
)
  throw Error('Local journey requires loopback RPC, loopback database and explicit BSC_FORK_BLOCK.')
if (rpcUrl) {
  const url = new URL(rpcUrl)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '18545' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search
  )
    throw Error('Journey transactions are restricted to http://127.0.0.1:18545.')
}
if (databaseUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw Error('Journey database must be loopback.')
const OWNER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Hex
const EXECUTOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Hex
const DONOR = '0xf977814e90da44bfa03b6295a0616a897441acec' as Hex
// Public BSC sample on 2026-09-10: 0.05 gwei. This only configures local test fees.
const LOCAL_GAS_PRICE = 50_000_000n
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex
const TOKEN = parseAbi([
  'function approve(address,uint256) returns(bool)',
  'function transfer(address,uint256) returns(bool)',
  'function balanceOf(address) view returns(uint256)',
  'function deposit() payable',
])
const fail = (): never => {
  throw Error('Local journey safety boundary failed.')
}

describe.skipIf(!requested)('actual customer strategy setup on an isolated Anvil BSC fork', () => {
  const schema = `strategy_journey_${randomUUID().replaceAll('-', '')}`
  // Anvil 1.7.1 can deadlock parallel historical call/getCode reads on its
  // upgradeable backend lock. Serialize only this local fixture's transport;
  // preserve each exact RPC request, block, timeout and production proof check.
  let rpcQueue: Promise<unknown> = Promise.resolve()
  const localTransport = (options: Parameters<ReturnType<typeof http>>[0]) => {
    const underlying = http(rpcUrl ?? 'http://127.0.0.1:18545', {
      timeout: 20000,
      retryCount: 0,
    })(options)
    return {
      ...underlying,
      request: ((...args: Parameters<typeof underlying.request>) => {
        const next = rpcQueue.then(() => underlying.request(...args))
        rpcQueue = next.then(
          () => undefined,
          () => undefined,
        )
        return next
      }) as typeof underlying.request,
    }
  }
  const reader = createPublicClient({
    chain: bsc,
    transport: localTransport,
    cacheTime: 0,
  })
  const wallet = createWalletClient({
    account: OWNER,
    chain: bsc,
    transport: localTransport,
    cacheTime: 0,
  })
  const originalCall = reader.call.bind(reader)
  reader.call = (async (args: Parameters<typeof originalCall>[0]) => {
    try {
      return await originalCall(args)
    } catch (error) {
      const e = error as {
        shortMessage?: string
        cause?: { shortMessage?: string; data?: unknown }
      }
      console.info(
        JSON.stringify({
          component: 'local-call-diagnostic',
          to: args.to,
          selector: args.data?.slice(0, 10),
          message: e.shortMessage,
          cause: e.cause?.shortMessage,
          data: e.cause?.data,
        }),
      )
      try {
        const trace = await raw('debug_traceCall', [
          { from: args.account, to: args.to, data: args.data, value: '0x0' },
          typeof args.blockNumber === 'bigint' ? `0x${args.blockNumber.toString(16)}` : 'latest',
          { tracer: 'callTracer' },
        ])
        const compact = (v: unknown): unknown => {
          const t = v as { to?: string; error?: string; output?: string; calls?: unknown[] }
          return {
            to: t.to,
            error: t.error,
            output: t.output?.slice(0, 138),
            calls: t.calls?.map(compact),
          }
        }
        console.info(JSON.stringify({ component: 'local-revert-trace', trace: compact(trace) }))
      } catch {
        console.info('Local revert trace unavailable.')
      }
      throw error
    }
  }) as typeof reader.call
  let admin: postgres.Sql | undefined, sql: postgres.Sql | undefined, chainSnapshot: Hex | undefined
  let store: PostgresStrategySetupStore,
    strategies: PostgresStrategyStore,
    scheduler: PostgresStrategyRunnerStore,
    service: StrategySetupService,
    config: StrategyDeploymentConfig,
    controller: Hex
  let nowSeconds = 0
  async function raw(method: string, params: unknown[] = []): Promise<unknown> {
    if (!rpcUrl || new URL(rpcUrl).origin !== 'http://127.0.0.1:18545') return fail()
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {
      throw Error(`Local Anvil transport failed: ${method}`)
    })
    const result = (await response.json()) as { result?: unknown; error?: unknown }
    if (!response.ok || result.error) throw Error(`Local Anvil method failed: ${method}`)
    return result.result
  }
  async function boundary() {
    const version = await raw('web3_clientVersion')
    const node = (await raw('anvil_nodeInfo')) as {
      environment?: { chainId?: number }
      forkConfig?: { forkBlockNumber?: number }
    }
    if (
      typeof version !== 'string' ||
      !version.toLowerCase().includes('anvil') ||
      node.environment?.chainId !== 56 ||
      String(node.forkConfig?.forkBlockNumber) !== forkBlockText ||
      (await reader.getChainId()) !== 56
    )
      return fail()
    const accounts = await wallet.getAddresses()
    if (accounts[0]?.toLowerCase() !== OWNER || accounts[1]?.toLowerCase() !== EXECUTOR)
      return fail()
  }
  async function finalized() {
    // This test's Anvil uses one slot/epoch, so finalized trails two local blocks.
    // Mine empty blocks at zero interval;
    // this is local finality simulation, not a statement about real BSC consensus.
    await mineLocal(3)
    const block = await reader.getBlock({ blockTag: 'finalized' })
    nowSeconds = Number(block.timestamp)
    return block
  }
  async function mineLocal(count = 1) {
    // Cancun Anvil reports baseFee (not --gas-price) with its default tip floor
    // disabled. Set only LOCAL block fee environment, never protocol/feed storage
    // or an RPC response. Actual transactions still pay their signed fee.
    for (let index = 0; index < count; index++) {
      await raw('anvil_setNextBlockBaseFeePerGas', [`0x${LOCAL_GAS_PRICE.toString(16)}`])
      await raw('anvil_mine', ['0x1', '0x0'])
    }
    await raw('anvil_setNextBlockBaseFeePerGas', [`0x${LOCAL_GAS_PRICE.toString(16)}`])
  }
  async function send(to: Hex | undefined, data: Hex, value = 0n) {
    await boundary()
    await raw('anvil_setNextBlockBaseFeePerGas', [`0x${LOCAL_GAS_PRICE.toString(16)}`])
    const hash = await wallet.sendTransaction({
      ...(to ? { to } : {}),
      data,
      value,
      gas: 20_000_000n,
      gasPrice: LOCAL_GAS_PRICE,
    })
    // Publish explicit local confirmation heads before starting viem's watcher;
    // an automined submission can otherwise race its initial head observation.
    await finalized()
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 20_000 })
    expect(receipt.status).toBe('success')
    expect((await finalized()).number).toBeGreaterThanOrEqual(receipt.blockNumber)
    return receipt
  }
  const readAddress = async (address: Hex, name: string): Promise<Hex> => {
    const result = await reader.readContract({
      address,
      abi: parseAbi([`function ${name}() view returns(address)`]),
      functionName: name,
    })
    if (typeof result !== 'string' || !/^0x[0-9a-f]{40}$/i.test(result)) return fail()
    return result.toLowerCase() as Hex
  }
  const pin = async (address: Hex) => {
    const code = await reader.getBytecode({ address })
    if (!code || code === '0x') return fail()
    return { address: address.toLowerCase() as Hex, runtimeCodeHash: keccak256(code) }
  }
  beforeAll(async () => {
    if (!databaseUrl || !forkBlockText) return fail()
    await boundary()
    expect(await reader.getGasPrice(), 'Start Anvil with the documented 0.05 gwei fee flags.').toBe(
      LOCAL_GAS_PRICE,
    )
    const base = await reader.getBlock({ blockNumber: BigInt(forkBlockText) })
    expect(base.number).toBe(BigInt(forkBlockText))
    expect((await pin(mainnet.manager as Hex)).runtimeCodeHash).toBe(mainnet.managerCodeHash)
    chainSnapshot = (await raw('evm_snapshot')) as Hex
    // Advance LOCAL time so production freshness guards can also compare the real local DB clock.
    await raw('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)])
    const account = await send(
      undefined,
      encodeDeployData({
        abi: [
          {
            type: 'constructor',
            inputs: A.AiKiMandateAccount.constructorInputs,
            stateMutability: 'nonpayable',
          },
        ],
        bytecode: A.AiKiMandateAccount.creationCode,
        args: [OWNER, mainnet.manager as Hex],
      }),
    )
    if (!account.contractAddress) return fail()
    controller = account.contractAddress.toLowerCase() as Hex
    expect((await pin(controller)).runtimeCodeHash).toBe(reviewedStrategyAccountRuntimeHash())
    const addresses = new Map<string, Hex>()
    for (const tx of strategyInfrastructureTransactions(OWNER)) {
      const receipt = await send(undefined, tx.data)
      if (!receipt.contractAddress) return fail()
      addresses.set(tx.name, receipt.contractAddress.toLowerCase() as Hex)
    }
    const implementation = async (address: Hex) => {
      const value = await reader.getStorageAt({ address, slot: SLOT })
      if (!value || !/^0x0{24}[0-9a-f]{40}$/i.test(value)) return fail()
      return pin(`0x${value.slice(-40)}` as Hex)
    }
    config = parseStrategyDeploymentConfig({
      version: 1,
      chainId: 56,
      manager: await pin(mainnet.manager as Hex),
      accountRuntimeHash: reviewedStrategyAccountRuntimeHash(),
      bindingEnforcer: await pin(addresses.get('StrategyBindingEnforcer') ?? fail()),
      factories: {
        yield: await pin(addresses.get('YieldVaultFactory') ?? fail()),
        grid: await pin(addresses.get('GridVaultFactory') ?? fail()),
        lp: await pin(addresses.get('LPVaultFactory') ?? fail()),
      },
      protocols: Object.fromEntries(
        await Promise.all(
          Object.entries(P).map(async ([key, address]) => [
            key,
            (await pin(address)).runtimeCodeHash,
          ]),
        ),
      ),
      poolDeployer: await pin(await readAddress(P.pancakeFactory, 'poolDeployer')),
      implementations: {
        venus: await pin(await readAddress(P.venus, 'implementation')),
        comptroller: await pin(await readAddress(P.comptroller, 'comptrollerImplementation')),
        aavePool: await implementation(P.aavePool),
        aaveReceipt: await implementation(P.aaveReceipt),
      },
      multicallRuntimeHash: (await pin('0xca11bde05977b3631167028862be2a173976ca11'))
        .runtimeCodeHash,
    })
    // Local donor impersonation is never signed and never reaches the upstream fork endpoint.
    await raw('anvil_impersonateAccount', [DONOR])
    await raw('anvil_setBalance', [DONOR, '0x56bc75e2d63100000'])
    try {
      await boundary()
      const donor = createWalletClient({
        account: DONOR,
        chain: bsc,
        transport: http(rpcUrl, { timeout: 20000, retryCount: 0 }),
      })
      const hash = await donor.sendTransaction({
        to: P.usdt,
        data: encodeFunctionData({
          abi: TOKEN,
          functionName: 'transfer',
          args: [OWNER, 1000n * 10n ** 18n],
        }),
        gas: 200000n,
        gasPrice: LOCAL_GAS_PRICE,
      })
      await finalized()
      expect((await reader.waitForTransactionReceipt({ hash, timeout: 20_000 })).status).toBe(
        'success',
      )
    } finally {
      await raw('anvil_stopImpersonatingAccount', [DONOR])
    }
    await send(P.wbnb, encodeFunctionData({ abi: TOKEN, functionName: 'deposit' }), 10n ** 18n)
    admin = postgres(databaseUrl, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 5000 },
      onnotice: () => {},
    })
    await admin`CREATE SCHEMA ${admin(schema)}`
    const database = new URL(databaseUrl)
    database.searchParams.set('search_path', schema)
    sql = postgres(database.toString(), { max: 5, onnotice: () => {} })
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema)
    await applyMigrations(
      sql,
      await readMigrations(new URL('../db/migrations/', import.meta.url)),
      () => {},
    )
    store = new PostgresStrategySetupStore(sql)
    strategies = new PostgresStrategyStore(sql)
    scheduler = new PostgresStrategyRunnerStore(sql)
    service = new StrategySetupService({
      store,
      strategies,
      deployments: config,
      executor: EXECUTOR,
      reader,
      now: () => nowSeconds,
    })
    await scheduler.heartbeat({
      instanceId: randomUUID(),
      configurationHash: strategyDeploymentConfigDigest(config),
      executor: EXECUTOR,
      ready: true,
      reason: 'Local fork journey test worker.',
    })
    expect(await service.publicConfig()).toMatchObject({ available: true, chainId: 56 })
    console.info(
      JSON.stringify({
        component: 'local-strategy-journey',
        forkBlock: forkBlockText,
        baseHash: base.hash,
        manager: mainnet.manager,
        controller,
        localFactories: Object.fromEntries(addresses),
        configurationDigest: strategyDeploymentConfigDigest(config),
      }),
    )
  }, 240000)
  afterEach(async () => {
    // Only this test-owned isolated schema: failed engine tests must not leave a
    // due watch that the next engine accidentally claims. No chain call occurs.
    if (sql && strategies) {
      for (const row of await sql<
        { id: string }[]
      >`SELECT id FROM strategy_watches WHERE status='ACTIVE'`)
        expect(await strategies.pause(row.id, OWNER)).toBe(true)
    }
  }, 10000)
  afterAll(async () => {
    const errors: unknown[] = []
    const cleanup = async (work: () => Promise<unknown>) => {
      try {
        await work()
      } catch (error) {
        errors.push(error)
      }
    }
    // Independent bounded cleanup: a DB failure must not skip the chain restore,
    // and a failed DROP must not leave the administrative pool open.
    await Promise.all([
      (async () => {
        await cleanup(async () => sql?.end({ timeout: 5 }))
        const database = admin
        if (database) {
          try {
            await cleanup(async () => database`DROP SCHEMA ${database(schema)} CASCADE`)
          } finally {
            await cleanup(async () => database.end({ timeout: 5 }))
          }
        }
      })(),
      cleanup(async () => {
        if (chainSnapshot) {
          await boundary()
          expect(await raw('evm_revert', [chainSnapshot])).toBe(true)
        }
      }),
    ])
    if (errors.length) throw new AggregateError(errors, 'Local journey cleanup failed.')
  }, 30000)
  async function create(input: StrategySetupInput) {
    const key = randomUUID(),
      body = { input, gasLimitWei: '1000000000000000' }
    let view = await service.prepare(OWNER, body, key)
    const action = view.actions.find((a) => a.kind === 'deploy' && a.status === 'PREPARED')
    if (!action) return fail()
    const receipt = await send(action.transaction.to, action.transaction.data)
    await service.submitAction(OWNER, view.id, action.id, {
      transactionHash: receipt.transactionHash,
    })
    view = await service.finalizeAction(OWNER, view.id, action.id)
    expect(view.status).toBe('DEPLOYED')
    expect(view.binding?.vault).toBe(view.prepared.predictedVault)
    expect((await service.prepare(OWNER, body, key)).id).toBe(view.id)
    return view
  }
  async function action(view: StrategySetupView, request: StrategyWalletActionRequest) {
    const key = randomUUID()
    for (let step = 0; step < 5; step++) {
      view = await service.prepareAction(OWNER, view.id, request, key)
      const pending = view.actions.find((a) => a.status === 'PREPARED')
      if (!pending) return fail()
      const receipt = await send(pending.transaction.to, pending.transaction.data)
      await service.submitAction(OWNER, view.id, pending.id, {
        transactionHash: receipt.transactionHash,
      })
      view = await service.finalizeAction(OWNER, view.id, pending.id)
      expect(view.actions.find((a) => a.id === pending.id)?.status).toBe('FINALIZED')
      if (pending.kind === request.kind) return view
    }
    return fail()
  }
  async function sign(view: StrategySetupView) {
    const prepared = await service.prepareAuthorization(OWNER, view.id)
    // ERC1271 accepts a correctly signed digest without validating the manager's
    // structural caveats. Exercise the real manager's mandatory first caveat too.
    expect(prepared.unsigned.caveats).toHaveLength(2)
    expect(prepared.unsigned.caveats[0]).toEqual({
      enforcer: await readAddress(mainnet.manager as Hex, 'EXPIRY_ENFORCER'),
      terms: encodeAbiParameters([{ type: 'uint256' }], [BigInt(view.input.common.expiresAt)]),
      args: '0x',
    })
    await boundary()
    const signature = await wallet.signTypedData({
      domain: prepared.domain,
      types: DELEGATION_TYPES,
      primaryType: 'Delegation',
      message: delegationMessage(prepared.unsigned),
    })
    view = await service.fileAuthorization(OWNER, view.id, { signature })
    expect(view.authorization?.id).toBeTruthy()
    expect(view.status).toBe('PAUSED')
    expect((await service.fileAuthorization(OWNER, view.id, { signature })).authorization?.id).toBe(
      view.authorization?.id,
    )
    return { view, delegation: decodeStoredStrategyDelegation({ ...prepared.unsigned, signature }) }
  }
  async function snapshot(view: StrategySetupView) {
    const result = await readStrategySetupSnapshot({
      config,
      prepared: view.prepared,
      owner: OWNER,
      reader,
      nowSeconds: BigInt(nowSeconds),
    })
    if (result.status !== 'verified') throw Error(result.reason)
    return result.snapshot
  }
  async function crossGridSellTick(expectedTick: number) {
    const poolAbi = parseAbi([
      'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)',
      'function liquidity() view returns(uint128)',
      'function tickSpacing() view returns(int24)',
      'function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)',
    ])
    const block = await reader.getBlock({ blockTag: 'latest' })
    const base = { address: P.pancakePool, abi: poolAbi, blockNumber: block.number } as const
    const slot = await reader.readContract({ ...base, functionName: 'slot0' })
    let liquidity = await reader.readContract({ ...base, functionName: 'liquidity' })
    const spacing = await reader.readContract({ ...base, functionName: 'tickSpacing' })
    expect(slot[1]).toBe(expectedTick)
    expect(spacing).toBe(10)
    expect(liquidity).toBeGreaterThan(0n)
    const targetTick = expectedTick + 2,
      targetPrice = sqrtRatioAtTick(targetTick)
    let startPrice = slot[0],
      netInput = 0n,
      grossInput = 0n
    const segment = (endPrice: bigint) => {
      const net = mulDivRoundingUp(liquidity, endPrice - startPrice, 1n << 96n)
      netInput += net
      grossInput += net + mulDivRoundingUp(net, 500n, 999_500n)
      startPrice = endPrice
    }
    // Upward token1 input can cross one initialized tick boundary in two ticks.
    // Respect the real signed liquidityNet; never assume constant liquidity across it.
    const boundaryTick = (Math.floor(expectedTick / spacing) + 1) * spacing
    if (boundaryTick < targetTick) {
      segment(sqrtRatioAtTick(boundaryTick))
      const boundaryState = await reader.readContract({
        ...base,
        functionName: 'ticks',
        args: [boundaryTick],
      })
      if (boundaryState[7]) liquidity += boundaryState[1]
      expect(liquidity).toBeGreaterThan(0n)
    }
    segment(targetPrice)
    const cap = mulDivRoundingUp(grossInput, 101n, 100n) + 2n
    expect(cap).toBeGreaterThan(0n)
    expect(cap).toBeLessThanOrEqual(100n * 10n ** 18n) // Finite PUBLIC local fixture ceiling.
    const minOutput = (quoteAtTick(targetTick, netInput, P.wbnb, P.usdt) * 99n) / 100n
    expect(minOutput).toBeGreaterThan(0n)
    expect((await reader.getBlock({ blockNumber: block.number })).hash).toBe(block.hash)
    let beforeIn = await reader.readContract({
      address: P.wbnb,
      abi: TOKEN,
      functionName: 'balanceOf',
      args: [OWNER],
    })
    // Keep one local WBNB for the later LP fixture; only public Anvil native funds are wrapped.
    if (beforeIn < cap + 10n ** 18n) {
      await send(
        P.wbnb,
        encodeFunctionData({ abi: TOKEN, functionName: 'deposit' }),
        cap + 10n ** 18n - beforeIn,
      )
      beforeIn = await reader.readContract({
        address: P.wbnb,
        abi: TOKEN,
        functionName: 'balanceOf',
        args: [OWNER],
      })
    }
    const beforeOut = await reader.readContract({
      address: P.usdt,
      abi: TOKEN,
      functionName: 'balanceOf',
      args: [OWNER],
    })
    await send(
      P.wbnb,
      encodeFunctionData({ abi: TOKEN, functionName: 'approve', args: [P.pancakeRouter, cap] }),
    )
    try {
      await send(
        P.pancakeRouter,
        encodeFunctionData({
          abi: parseAbi([
            'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)',
          ]),
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: P.wbnb,
              tokenOut: P.usdt,
              fee: 500,
              recipient: OWNER,
              deadline: BigInt(nowSeconds + 90),
              amountIn: cap,
              amountOutMinimum: minOutput,
              sqrtPriceLimitX96: targetPrice,
            },
          ],
        }),
      )
    } finally {
      await send(
        P.wbnb,
        encodeFunctionData({ abi: TOKEN, functionName: 'approve', args: [P.pancakeRouter, 0n] }),
      )
    }
    const afterIn = await reader.readContract({
      address: P.wbnb,
      abi: TOKEN,
      functionName: 'balanceOf',
      args: [OWNER],
    })
    const afterOut = await reader.readContract({
      address: P.usdt,
      abi: TOKEN,
      functionName: 'balanceOf',
      args: [OWNER],
    })
    expect(beforeIn - afterIn).toBeGreaterThan(0n)
    expect(beforeIn - afterIn).toBeLessThanOrEqual(cap)
    expect(afterOut - beforeOut).toBeGreaterThanOrEqual(minOutput)
    expect(
      (
        await reader.readContract({ address: P.pancakePool, abi: poolAbi, functionName: 'slot0' })
      )[0],
    ).toBe(targetPrice)
    expect(
      await reader.readContract({
        address: P.wbnb,
        abi: parseAbi(['function allowance(address,address) view returns(uint256)']),
        functionName: 'allowance',
        args: [OWNER, P.pancakeRouter],
      }),
    ).toBe(0n)
  }
  async function executorFixtureKey() {
    await boundary()
    // Public, universally known Anvil fixture, derived only after the loopback guard.
    // NEVER read a key/mnemonic from the environment or use this outside this local test.
    const fixture = mnemonicToAccount(
      'test test test test test test test test test test test junk',
      {
        addressIndex: 1,
      },
    )
    expect(fixture.address.toLowerCase()).toBe(EXECUTOR)
    const key = fixture.getHdKey().privateKey
    if (!key) return fail()
    return bytesToHex(key)
  }
  async function localRedemption(request: RedemptionRequest) {
    await boundary()
    expect(request.rpcUrl).toBe('http://127.0.0.1:18545')
    expect(request.chainId).toBe(56)
    // Mine local confirmation blocks while the unmodified executor waits for finality.
    let mining = true
    const confirmations = (async () => {
      while (mining) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (mining) await mineLocal()
      }
    })()
    try {
      const result = await executeRedemption({
        ...request,
        onPrepared: async (hash) => {
          await request.onPrepared?.(hash)
          if (!sql) return fail()
          const [attempt] =
            await sql`SELECT state FROM execution_attempts WHERE transaction_hash=${hash}`
          expect(attempt?.state).toBe('SUBMITTED')
          // The exact hash is durably protected before any broadcast, not after an ack.
          await expect(reader.getTransaction({ hash })).rejects.toThrow()
        },
      })
      if (result.status === 'refused') {
        // Read-only preparation diagnostic using the same PUBLIC local fixture.
        // Never log the request, signature, signed bytes or spending credential.
        try {
          const diagnostic = createWalletClient({
            account: privateKeyToAccount(request.relayerKey),
            chain: {
              id: 56,
              name: 'chain-56',
              nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
              rpcUrls: { default: { http: [request.rpcUrl] } },
            },
            transport: localTransport,
          })
          const prepared = await diagnostic.prepareTransactionRequest({
            to: request.delegationManager,
            data: encodeFunctionData({
              abi: DELEGATION_ABI,
              functionName: 'redeemDelegations',
              args: [
                [encodeAbiParameters([DELEGATION_TUPLE], [[request.delegation]])],
                [`0x${'0'.repeat(64)}`],
                [encodeSingleExecution(request.target, 0n, request.callData)],
              ],
            }),
          })
          console.info(
            JSON.stringify({
              component: 'local-preparation-diagnostic',
              gas: prepared.gas?.toString(),
              gasPrice: prepared.gasPrice?.toString(),
              maxFeePerGas: prepared.maxFeePerGas?.toString(),
              cap: request.maxGasCostWei?.toString(),
            }),
          )
        } catch (error) {
          console.info(
            JSON.stringify({
              component: 'local-preparation-diagnostic',
              message: (error as { shortMessage?: string }).shortMessage,
            }),
          )
        }
      }
      return result
    } finally {
      mining = false
      await confirmations
    }
  }
  async function executePlan(
    input: Parameters<NonNullable<Parameters<typeof runStrategySweep>[0]['execute']>>[0],
  ) {
    const key = await executorFixtureKey()
    const reportedFee = await reader.getGasPrice()
    expect(reportedFee).toBeGreaterThan(0n)
    expect(reportedFee).toBeLessThanOrEqual(LOCAL_GAS_PRICE)
    const result = await executeStrategyOperation({
      store: strategies,
      watchId: input.claim.watchId,
      expectedRevision: input.expectedRevision,
      operation: input.plan.operation,
      simulation: input.plan.quote,
      gasBudgetWei: input.plan.gasBudgetWei,
      reader,
      request: {
        rpcUrl: rpcUrl ?? fail(),
        chainId: 56,
        delegationManager: mainnet.manager as Hex,
        relayerKey: key,
        delegation: decodeStoredStrategyDelegation(input.claim.delegation),
      },
      send: localRedemption,
    })
    await finalized()
    return result
  }
  async function assertSettled(
    view: StrategySetupView,
    result: StrategyExecutionResult,
    previousNonce: bigint,
  ) {
    if (!sql || !view.authorization) return fail()
    expect(result.status, JSON.stringify(result)).toBe('landed')
    if (result.status !== 'landed') return fail()
    const [operation] =
      await sql`SELECT o.state, e.state AS attempt_state, e.transaction_hash, o.verified_receipt
      FROM strategy_operations o JOIN execution_attempts e ON e.id=o.attempt_id WHERE o.attempt_id=${result.attemptId}`
    expect(operation?.state).toBe('LANDED')
    expect(operation?.attempt_state).toBe('LANDED')
    expect(operation?.transaction_hash).toBe(result.transactionHash)
    const transaction = await reader.getTransaction({ hash: result.transactionHash })
    const receipt = await reader.getTransactionReceipt({ hash: result.transactionHash })
    expect(transaction.type).toBe('legacy')
    if (typeof transaction.gasPrice !== 'bigint') return fail()
    expect(transaction.gasPrice).toBeGreaterThan(0n)
    expect(transaction.gas * transaction.gasPrice).toBeLessThanOrEqual(BigInt(view.gasLimitWei))
    expect(receipt.gasUsed * receipt.effectiveGasPrice).toBeLessThanOrEqual(
      BigInt(view.gasLimitWei),
    )
    expect(operation?.verified_receipt).toMatchObject({
      status: 'landed',
      nextNonce: String(previousNonce + 1n),
    })
    const watch = await scheduler.getWatchForOwner(view.authorization.watchId, OWNER)
    expect(watch?.nonce).toBe(String(previousNonce + 1n))
    expect(watch?.snapshot).toBeNull() // Receipt is not a fresh complete chain snapshot.
    expect(await strategies.getPendingAttempt(result.attemptId)).toBeNull()
    const fresh = await snapshot(view)
    expect(fresh.nonce).toBe(previousNonce + 1n)
    return { result, receipt, fresh, watch: watch ?? fail() }
  }
  const common = () => ({
    expiresAt: String(nowSeconds + 86400),
    minInterval: 60,
    maxDeadlineDelay: 300,
  })
  it('yield: real customer setup, DB claim, signed manager execution and finalized atomic settlement', async () => {
    let view = await create({
      version: 1,
      chainId: 56,
      kind: 'yield',
      controller,
      common: common(),
      policy: {
        maxPrincipal: String(1000n * 10n ** 18n),
        maxMove: String(100n * 10n ** 18n),
        maxTurnover: String(2000n * 10n ** 18n),
        minIdle: String(10n * 10n ** 18n),
        maxVenusExposure: String(900n * 10n ** 18n),
        maxAaveExposure: String(900n * 10n ** 18n),
        maxLossPerMove: String(10n ** 15n),
        maxCumulativeLoss: String(10n ** 16n),
        maxLossBps: 10,
      },
    })
    view = await action(view, { kind: 'fund', assets: String(100n * 10n ** 18n) })
    const signed = await sign(view)
    view = await action(signed.view, { kind: 'resume' })
    view = await service.start(OWNER, view.id)
    expect(view.status).toBe('ACTIVE')
    const proof = await snapshot(view)
    expect(proof.state.kind).toBe('yield')
    if (proof.state.kind !== 'yield') return fail()
    expect(proof.state.managedIdle).toBe(100n * 10n ** 18n)
    const operation = {
      kind: 'yield',
      binding: proof.binding,
      expectedNonce: proof.nonce,
      deadline: proof.block.timestamp + 90n,
      source: 0,
      destination: 1,
      assets: 10n * 10n ** 18n,
      minReceived: 10n * 10n ** 18n,
    } as const
    const quote = await quoteStrategyOperation({
      snapshot: proof,
      reader,
      executor: EXECUTOR,
      delegation: signed.delegation,
      operation,
    })
    expect(
      isVerifiedStrategySimulation(quote),
      JSON.stringify(quote, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).toBe(true)
    expect((await snapshot(view)).nonce).toBe(proof.nonce)
    if (!isVerifiedStrategySimulation(quote) || !view.authorization || !sql) return fail()
    // Historical feeds are intentionally not rewritten. This covers the real durable
    // execution path for an exact simulated move, not automatic economic selection.
    const [claim] = await scheduler.claimDue(1, 90)
    expect(claim?.watchId).toBe(view.authorization.watchId)
    if (!claim) return fail()
    const synced = await strategies.syncSnapshot({
      watchId: claim.watchId,
      expectedRevision: claim.revision,
      snapshot: proof,
    })
    if (synced.status !== 'applied') return fail()
    const revision = await scheduler.savePlannerState({
      watchId: claim.watchId,
      leaseId: claim.leaseId,
      expectedRevision: synced.revision,
      state: {},
    })
    if (revision === null) return fail()
    const result = await executePlan({
      claim,
      expectedRevision: revision,
      plan: { act: true, operation, quote, gasBudgetWei: 10n ** 15n },
    })
    const settled = await assertSettled(view, result, proof.nonce)
    if (settled.fresh.state.kind !== 'yield') return fail()
    expect(settled.fresh.state.managedIdle).toBe(90n * 10n ** 18n)
    expect(settled.fresh.state.managedVenusShares).toBeGreaterThan(0n)
    expect(settled.fresh.state.turnover).toBe(10n * 10n ** 18n)
    expect(
      await reader.readContract({
        address: P.usdt,
        abi: TOKEN,
        functionName: 'balanceOf',
        args: [proof.binding.vault],
      }),
    ).toBe(90n * 10n ** 18n)
    expect(
      (await sql`SELECT spent FROM authorizations WHERE id=${view.authorization.id}`)[0]?.spent,
    ).toBe('0')
    expect(
      await strategies.syncSnapshot({
        watchId: claim.watchId,
        expectedRevision: settled.watch.revision,
        snapshot: proof,
      }),
    ).toEqual({ status: 'not_ready' })
    expect(
      await strategies.syncSnapshot({
        watchId: claim.watchId,
        expectedRevision: settled.watch.revision,
        snapshot: settled.fresh,
      }),
    ).toMatchObject({ status: 'applied', active: true })
    await scheduler.finishPass({
      watchId: claim.watchId,
      leaseId: claim.leaseId,
      code: 'LANDED',
      reason: 'Local actual manager operation settled.',
      intervalSeconds: 60,
    })
    await service.pause(OWNER, view.id)
    console.info(
      JSON.stringify({
        component: 'local-yield-journey',
        vault: view.binding?.vault,
        authorization: view.authorization?.id,
        quote: quote.status,
        localStrategyTransaction: settled.result.transactionHash,
        automaticEconomicSelection: false,
        gas: isVerifiedStrategySimulation(quote) ? quote.gasUnits.toString() : null,
        liveTransactions: 0,
      }),
    )
  }, 180000)
  it('grid: full runner sweeps settle a baseline and a real bounded crossing fill without replay', async () => {
    const slot = await reader.readContract({
      address: P.pancakePool,
      abi: parseAbi([
        'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)',
      ]),
      functionName: 'slot0',
    })
    const center = Math.floor(slot[1] / 10) * 10
    let view = await create({
      version: 1,
      chainId: 56,
      kind: 'grid',
      controller,
      common: { ...common(), minInterval: 1 }, // Explicit immutable local fixture owner choice.
      policy: {
        tickLower: center - 2000,
        tickUpper: center + 2000,
        maxInput0: String(10n ** 18n),
        maxInput1: String(10n ** 15n),
        fundingCap0: String(100n * 10n ** 18n),
        fundingCap1: String(10n ** 18n),
        turnoverCap0: String(1000n * 10n ** 18n),
        turnoverCap1: String(10n ** 18n),
        twapWindow: 60,
        maxDeviationTicks: 100,
        minLiquidity: '1',
        maxSlippageBps: 50,
        minFillBps: 9000,
        minCycleGainBps: 10,
        hysteresisTicks: 1,
      },
      rungs: [
        {
          buyTick: slot[1] - 300,
          sellTick: slot[1] + 1,
          lot0: String(10n ** 18n),
          lot1: String(10n ** 15n),
          initialSell: true,
        },
      ],
    })
    view = await action(view, {
      kind: 'fund',
      rungIndex: 0,
      amount0: String(10n * 10n ** 18n),
      amount1: '0',
    })
    const signed = await sign(view)
    view = await action(signed.view, { kind: 'resume' })
    view = await service.start(OWNER, view.id)
    expect(view.status).toBe('ACTIVE')
    const proof = await snapshot(view),
      policy = createStrategyRunnerPolicy(proof, 10n ** 15n)
    const plan = await planStrategyPass({
      snapshot: proof,
      policy,
      reader,
      executor: EXECUTOR,
      delegation: signed.delegation,
      plannerState: {},
      gasLimitWei: 10n ** 15n,
      now: () => nowSeconds,
    })
    expect(
      plan.act,
      JSON.stringify(plan, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    ).toBe(true)
    if (!plan.act) return fail()
    expect(plan.operation).toMatchObject({ kind: 'grid', baseline: true, rungIndex: 0 })
    expect(isVerifiedStrategySimulation(plan.quote)).toBe(true)
    expect((await snapshot(view)).nonce).toBe(proof.nonce)
    let executed: StrategyExecutionResult | undefined
    const report = await runStrategySweep({
      scheduler,
      store: strategies,
      reader,
      config,
      executor: EXECUTOR,
      limit: 1,
      now: () => Math.floor(Date.now() / 1000),
      execute: async (input) => {
        expect(input.claim.watchId).toBe(view.authorization?.watchId)
        expect(input.plan.operation).toMatchObject({ kind: 'grid', baseline: true })
        executed = await executePlan(input)
        return executed
      },
    })
    expect(
      report,
      JSON.stringify({
        report,
        result: executed,
        watch: view.authorization
          ? await scheduler.getWatchForOwner(view.authorization.watchId, OWNER)
          : null,
      }),
    ).toMatchObject({ ready: true, looked: 1, acted: 1 })
    if (!executed || !view.authorization || !sql) return fail()
    const settled = await assertSettled(view, executed, proof.nonce)
    expect(settled.result.outcome).toMatchObject({ kind: 'grid', filled: false, baseline: true })
    if (settled.fresh.state.kind !== 'grid') return fail()
    expect(settled.fresh.state.initialized).toBe(true)
    expect(settled.fresh.state.allocated0).toBe(10n * 10n ** 18n)
    expect(settled.fresh.state.allocated1).toBe(0n)
    expect(settled.fresh.state.rungs[0]?.state.armed).toBe(true)
    await sql`UPDATE strategy_watches SET next_run_at=now() WHERE id=${view.authorization.watchId}`
    const next = await runStrategySweep({
      scheduler,
      store: strategies,
      reader,
      config,
      executor: EXECUTOR,
      limit: 1,
      now: () => Math.floor(Date.now() / 1000),
      execute: async () => {
        throw Error('An unchanged baseline must never be broadcast twice.')
      },
    })
    expect(next).toMatchObject({ ready: true, looked: 1, acted: 0, waiting: 1 })
    const refreshed = await scheduler.getWatchForOwner(view.authorization.watchId, OWNER)
    expect(refreshed?.snapshot).not.toBeNull()
    expect(refreshed?.nonce).toBe(String(proof.nonce + 1n))
    expect(
      (
        await sql`SELECT count(*)::int AS count FROM strategy_operations WHERE watch_id=${view.authorization.watchId}`
      )[0]?.count,
    ).toBe(1)
    // A real, bounded owner router trade moves the actual pool two ticks. It does
    // not alter observations/storage, and the executor still needs a fresh proof.
    await crossGridSellTick(slot[1])
    const earliest = Number(settled.fresh.lastExecutionAt + settled.fresh.minInterval) * 1000
    if (Date.now() < earliest)
      await new Promise((resolve) => setTimeout(resolve, earliest - Date.now()))
    await raw('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)])
    await finalized()
    await sql`UPDATE strategy_watches SET next_run_at=now() WHERE id=${view.authorization.watchId}`
    let filled: StrategyExecutionResult | undefined
    const fillReport = await runStrategySweep({
      scheduler,
      store: strategies,
      reader,
      config,
      executor: EXECUTOR,
      limit: 1,
      now: () => Math.floor(Date.now() / 1000),
      execute: async (input) => {
        expect(input.claim.watchId).toBe(view.authorization?.watchId)
        expect(input.plan.operation).toMatchObject({ kind: 'grid', baseline: false, rungIndex: 0 })
        filled = await executePlan(input)
        return filled
      },
    })
    const fillWatch = await scheduler.getWatchForOwner(view.authorization.watchId, OWNER)
    expect(
      fillReport,
      JSON.stringify({
        fillReport,
        result: filled,
        code: fillWatch?.code,
        reason: fillWatch?.reason,
      }),
    ).toMatchObject({ ready: true, looked: 1, acted: 1 })
    if (!filled) return fail()
    const fillSettlement = await assertSettled(view, filled, settled.fresh.nonce)
    const outcome = fillSettlement.result.outcome,
      state = fillSettlement.fresh.state
    if (outcome?.kind !== 'grid' || !outcome.filled || state.kind !== 'grid') return fail()
    expect(outcome).toMatchObject({ baseline: false, rung: 0, cycleBefore: '0', soldToken0: true })
    const input = BigInt(outcome.actualInput),
      output = BigInt(outcome.actualOutput)
    expect(input).toBe(10n ** 18n)
    expect(output).toBeGreaterThan(0n)
    expect(state.allocated0).toBe(10n * 10n ** 18n - input)
    expect(state.allocated1).toBe(output)
    expect(state.actual0).toBe(state.allocated0)
    expect(state.actual1).toBe(state.allocated1)
    expect(state.turnover0).toBe(input)
    expect(state.turnover1).toBe(0n)
    expect(state.rungs[0]?.state).toMatchObject({ nextSell: false, armed: true, cycle: 0n })
    for (const token of [P.usdt, P.wbnb]) {
      expect(
        await reader.readContract({
          address: token,
          abi: parseAbi(['function allowance(address,address) view returns(uint256)']),
          functionName: 'allowance',
          args: [fillSettlement.fresh.binding.vault, P.pancakeRouter],
        }),
      ).toBe(0n)
    }
    await sql`UPDATE strategy_watches SET next_run_at=now() WHERE id=${view.authorization.watchId}`
    const noReplay = await runStrategySweep({
      scheduler,
      store: strategies,
      reader,
      config,
      executor: EXECUTOR,
      limit: 1,
      now: () => Math.floor(Date.now() / 1000),
      execute: async () => {
        throw Error('The completed Grid sell must not be replayed.')
      },
    })
    expect(noReplay).toMatchObject({ ready: true, looked: 1, acted: 0, waiting: 1 })
    expect(
      (
        await sql`SELECT count(*)::int AS count FROM strategy_operations WHERE watch_id=${view.authorization.watchId}`
      )[0]?.count,
    ).toBe(2)
    await service.pause(OWNER, view.id)
    console.info(
      JSON.stringify({
        component: 'local-grid-journey',
        vault: view.binding?.vault,
        baseline: true,
        localStrategyTransaction: settled.result.transactionHash,
        fillTransaction: fillSettlement.result.transactionHash,
        actualInput: outcome.actualInput,
        actualOutput: outcome.actualOutput,
        gas: plan.quote.gasUnits.toString(),
        liveTransactions: 0,
      }),
    )
  }, 180000)
  it('LP: full runner sweep replaces the enrolled NFT and atomically settles finalized custody', async () => {
    const slot = await reader.readContract({
      address: P.pancakePool,
      abi: parseAbi([
        'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)',
      ]),
      functionName: 'slot0',
    })
    const center = Math.floor(slot[1] / 10) * 10
    const mint = parseAbi([
      'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns(uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
      'function balanceOf(address) view returns(uint256)',
      'function tokenOfOwnerByIndex(address,uint256) view returns(uint256)',
    ])
    await send(
      P.usdt,
      encodeFunctionData({
        abi: TOKEN,
        functionName: 'approve',
        args: [P.positionManager, 100n * 10n ** 18n],
      }),
    )
    await send(
      P.wbnb,
      encodeFunctionData({
        abi: TOKEN,
        functionName: 'approve',
        args: [P.positionManager, 10n ** 17n],
      }),
    )
    await send(
      P.positionManager,
      encodeFunctionData({
        abi: mint,
        functionName: 'mint',
        args: [
          {
            token0: P.usdt,
            token1: P.wbnb,
            fee: 500,
            tickLower: center - 1000,
            tickUpper: center + 1000,
            amount0Desired: 100n * 10n ** 18n,
            amount1Desired: 10n ** 17n,
            amount0Min: 0n,
            amount1Min: 0n,
            recipient: OWNER,
            deadline: BigInt(nowSeconds + 300),
          },
        ],
      }),
    )
    const count = await reader.readContract({
      address: P.positionManager,
      abi: mint,
      functionName: 'balanceOf',
      args: [OWNER],
    })
    const tokenId = await reader.readContract({
      address: P.positionManager,
      abi: mint,
      functionName: 'tokenOfOwnerByIndex',
      args: [OWNER, count - 1n],
    })
    let view = await create({
      version: 1,
      chainId: 56,
      kind: 'lp',
      controller,
      common: common(),
      policy: {
        twapWindow: 60,
        maxDeviationTicks: 100,
        minPoolLiquidity: '1',
        // A real wider NFT was minted above. This explicit immutable owner choice
        // makes a narrower replacement necessary without manipulating pool prices.
        rangeWidth: 1000,
        maxCenterOffsetTicks: 50,
        maxSwapSlippageBps: 50,
        maxLiquiditySlippageBps: 50,
        minSwapFillBps: 9000,
        minDeployedBps: 9000,
        maxLossBps: 100,
        maxSwap0: String(100n * 10n ** 18n),
        maxSwap1: String(10n ** 17n),
        maxPositionValueQuote: String(1000n * 10n ** 18n),
        maxLossQuote: String(10n ** 18n),
        maxCumulativeLossQuote: String(10n * 10n ** 18n),
      },
    })
    view = await action(view, { kind: 'enroll', tokenId: tokenId.toString() })
    const signed = await sign(view),
      proof = await snapshot(signed.view)
    expect(proof.state.kind).toBe('lp')
    if (proof.state.kind !== 'lp') return fail()
    expect(proof.state.currentTokenId).toBe(tokenId)
    expect(proof.state.position?.owner).toBe(view.binding?.vault)
    expect(proof.paused).toBe(true)
    view = await action(signed.view, { kind: 'resume' })
    view = await service.start(OWNER, view.id)
    expect(view.status).toBe('ACTIVE')
    const active = await snapshot(view)
    const lowBudget = await planStrategyPass({
      snapshot: active,
      policy: createStrategyRunnerPolicy(active, 10n ** 12n, {
        poolRuntimeCodeHash: config.protocols.pancakePool,
      }),
      reader,
      executor: EXECUTOR,
      delegation: signed.delegation,
      plannerState: {},
      gasLimitWei: 10n ** 12n,
      now: () => Math.floor(Date.now() / 1000),
    })
    expect(lowBudget).toMatchObject({ act: false, code: 'GAS_BUDGET' })
    // Negative candidate search consumed wall time. Mine a real local block at
    // that same wall clock, so the next sweep obtains a fresh finalized snapshot.
    await raw('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)])
    await finalized()
    let executed: StrategyExecutionResult | undefined
    const report = await runStrategySweep({
      scheduler,
      store: strategies,
      reader,
      config,
      executor: EXECUTOR,
      limit: 1,
      now: () => Math.floor(Date.now() / 1000),
      execute: async (input) => {
        expect(input.claim.watchId).toBe(view.authorization?.watchId)
        expect(input.plan.operation.kind).toBe('lp')
        expect(isVerifiedStrategySimulation(input.plan.quote)).toBe(true)
        executed = await executePlan(input)
        return executed
      },
    })
    const watch = view.authorization
      ? await scheduler.getWatchForOwner(view.authorization.watchId, OWNER)
      : null
    expect(
      report,
      JSON.stringify({ report, result: executed, code: watch?.code, reason: watch?.reason }),
    ).toMatchObject({ ready: true, looked: 1, acted: 1 })
    if (!executed || !view.authorization || !sql) return fail()
    const settled = await assertSettled(view, executed, active.nonce)
    if (settled.fresh.state.kind !== 'lp') return fail()
    expect(settled.result.outcome).toMatchObject({ kind: 'lp', oldTokenId: tokenId.toString() })
    expect(settled.fresh.state.currentTokenId).not.toBe(tokenId)
    expect(settled.fresh.state.currentTokenId).toBeGreaterThan(0n)
    expect(settled.fresh.state.position?.owner).toBe(view.binding?.vault)
    expect(settled.fresh.state.positionLiquidity).toBeGreaterThan(0n)
    const replacement = settled.fresh.state.position
    if (!replacement) return fail()
    expect(replacement.tickUpper - replacement.tickLower).toBe(1000)
    expect(settled.fresh.state.cumulativeLossQuote).toBeLessThanOrEqual(10n * 10n ** 18n)
    const burnTopics = encodeEventTopics({
      abi: parseAbi([
        'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
      ]),
      eventName: 'Transfer',
      args: {
        from: active.binding.vault,
        to: '0x0000000000000000000000000000000000000000',
        tokenId,
      },
    })
    // Exact finalized canonical NFPM burn evidence; a transport error is not proof.
    expect(
      settled.receipt.logs.some(
        (log) =>
          log.address.toLowerCase() === P.positionManager.toLowerCase() &&
          log.data === '0x' &&
          log.topics.length === burnTopics.length &&
          log.topics.every((topic, index) => topic === burnTopics[index]),
      ),
    ).toBe(true)
    for (const token of [P.usdt, P.wbnb]) {
      for (const spender of [P.positionManager, P.pancakeRouter]) {
        expect(
          await reader.readContract({
            address: token,
            abi: parseAbi(['function allowance(address,address) view returns(uint256)']),
            functionName: 'allowance',
            args: [active.binding.vault, spender],
          }),
        ).toBe(0n)
      }
    }
    await sql`UPDATE strategy_watches SET next_run_at=now() WHERE id=${view.authorization.watchId}`
    const next = await runStrategySweep({
      scheduler,
      store: strategies,
      reader,
      config,
      executor: EXECUTOR,
      limit: 1,
      now: () => Math.floor(Date.now() / 1000),
      execute: async () => {
        throw Error('The fresh replacement must not be immediately replayed.')
      },
    })
    expect(next).toMatchObject({ ready: true, looked: 1, acted: 0, waiting: 1 })
    const refreshed = await scheduler.getWatchForOwner(view.authorization.watchId, OWNER)
    expect(refreshed?.snapshot).not.toBeNull()
    expect(refreshed?.nonce).toBe(String(active.nonce + 1n))
    expect(['COOLDOWN', 'POSITION_HEALTHY']).toContain(refreshed?.code)
    expect(
      (
        await sql`SELECT count(*)::int AS count FROM strategy_operations WHERE watch_id=${view.authorization.watchId}`
      )[0]?.count,
    ).toBe(1)
    await service.pause(OWNER, view.id)
    console.info(
      JSON.stringify({
        component: 'local-lp-journey',
        vault: view.binding?.vault,
        tokenId: tokenId.toString(),
        enrolled: true,
        newTokenId: settled.fresh.state.currentTokenId.toString(),
        localStrategyTransaction: settled.result.transactionHash,
        settled: true,
        liveTransactions: 0,
      }),
    )
  }, 180000)
})
