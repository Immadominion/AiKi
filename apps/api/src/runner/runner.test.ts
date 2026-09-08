import { readFileSync } from 'node:fs'
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { beforeAll, describe, expect, it } from 'vitest'
import type { SignedDelegation } from '../execution/executor.js'
import { JobService } from '../jobs/service.js'
import { WAD } from '../reference/venus/types.js'
import { tick } from './runner.js'
import type { Assessment } from './trigger.js'

/**
 * The whole loop, with a real chain at the end of it.
 *
 * An agent notices a position is at risk, the mandate rules on the repayment,
 * and the money moves. The position here is stated rather than read from Venus,
 * because what is under test is the loop and not the oracle: reading Venus is
 * covered by reference/venus/client.test.ts, and mixing the two would leave a
 * failure ambiguous between "the agent read wrong" and "the loop is broken".
 * Everything downstream of the assessment is real, including the refusals.
 */
const RPC = 'http://127.0.0.1:8545'
const CHAIN_ID = 31337
// anvil accounts 4 and 5. Each chain test file gets its own deployer, or their
// nonces race under vitest's parallelism and one silently skips.
const OWNER_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex
const RELAYER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as Hex

const artifact = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../onchain/out/${name}.sol/${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as { abi: unknown[]; bytecode: { object: Hex } }

const chain = {
  id: CHAIN_ID,
  name: 'anvil',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const

const owner = privateKeyToAccount(OWNER_KEY)
const publicClient = createPublicClient({ chain, transport: http(RPC) })
const wallet = createWalletClient({ account: owner, chain, transport: http(RPC) })
const reachable = await publicClient.getBlockNumber().then(
  () => true,
  () => false,
)

async function deploy(name: string, args: unknown[] = []): Promise<Address> {
  const { abi, bytecode } = artifact(name)
  const hash = await wallet.deployContract({
    abi: abi as never,
    bytecode: bytecode.object,
    args: args as never,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error(`${name} did not deploy`)
  return receipt.contractAddress
}

const atRisk = (over: Partial<Assessment> = {}): Assessment => ({
  status: 'AT_RISK',
  healthFactor: '1.10',
  minimumHealthFactor: '1.25',
  adjustedCollateral: { amount: (1_100n * WAD).toString() },
  borrowed: { amount: (1_000n * WAD).toString() },
  consistency: { verified: true, detail: 'ok' },
  observedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe.skipIf(!reachable)('tick (against a real chain)', () => {
  let manager: Address
  let account: Address
  let token: Address
  let market: Address
  let sessionEnforcer: Address
  let expiryEnforcer: Address

  beforeAll(async () => {
    expiryEnforcer = await deploy('ExpiryEnforcer')
    manager = await deploy('AiKiDelegationManager', [expiryEnforcer])
    account = await deploy('AiKiMandateAccount', [owner.address, manager])
    sessionEnforcer = await deploy('SessionTotalCapEnforcer', [manager])
    token = await deploy('MockERC20')
    market = await deploy('MockVToken', [token])
    const hash = await wallet.writeContract({
      address: token,
      abi: parseAbi(['function mint(address to, uint256 amount)']),
      functionName: 'mint',
      args: [account, 100_000n * WAD],
    })
    await publicClient.waitForTransactionReceipt({ hash })

    // A debt to repay.
    const borrowed = await wallet.writeContract({
      address: market,
      abi: parseAbi(['function setBorrow(address who, uint256 amount)']),
      functionName: 'setBorrow',
      args: [account, 100_000n * WAD],
    })
    await publicClient.waitForTransactionReceipt({ hash: borrowed })

    /*
     * The owner approves the market from their own account, once, exactly as a
     * person approves a lending market they already use. This is deliberately
     * not something the agent can do: the agent's standing authority is the
     * repayment alone, so an allowance can only ever exist because the owner
     * created it.
     */
    const approved = await wallet.writeContract({
      address: account,
      abi: parseAbi(['function execute(address target, uint256 value, bytes callData)']),
      functionName: 'execute',
      args: [
        token,
        0n,
        encodeFunctionData({
          abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
          functionName: 'approve',
          args: [market, 1_000_000n * WAD],
        }),
      ],
    })
    await publicClient.waitForTransactionReceipt({ hash: approved })
  }, 120_000)

  const debtOf = (who: Address) =>
    publicClient.readContract({
      address: market,
      abi: parseAbi(['function borrowBalance(address) view returns (uint256)']),
      functionName: 'borrowBalance',
      args: [who],
    }) as Promise<bigint>

  async function mandate(sessionCap: bigint): Promise<SignedDelegation> {
    const selector = keccak256(new TextEncoder().encode('repayBorrow(uint256)')).slice(0, 10) as Hex
    const siteType = {
      type: 'tuple[]',
      components: [
        { name: 'target', type: 'address' },
        { name: 'selector', type: 'bytes4' },
        { name: 'asset', type: 'address' },
        { name: 'argIndex', type: 'uint8' },
      ],
    } as const
    const delegation: SignedDelegation = {
      delegate: privateKeyToAccount(RELAYER_KEY).address,
      delegator: account,
      authority: `0x${'ff'.repeat(32)}` as Hex,
      caveats: [
        {
          enforcer: expiryEnforcer,
          terms: encodeAbiParameters(
            [{ type: 'uint256' }],
            [BigInt(Math.floor(Date.now() / 1000) + 86_400)],
          ),
          args: '0x',
        },
        {
          enforcer: sessionEnforcer,
          terms: encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }, siteType],
            [token, sessionCap, [{ target: market, selector, asset: token, argIndex: 0 }]],
          ),
          args: '0x',
        },
      ],
      salt: BigInt(Math.floor(Math.random() * 1e12)),
      epoch: 0n,
      signature: '0x' as Hex,
    }
    const digest = (await publicClient.readContract({
      address: manager,
      abi: parseAbi([
        'function getDelegationDigest((address,address,bytes32,(address,bytes,bytes)[],uint256,uint256,bytes) d) view returns (bytes32)',
      ]),
      functionName: 'getDelegationDigest',
      args: [
        [
          delegation.delegate,
          delegation.delegator,
          delegation.authority,
          delegation.caveats.map((c) => [c.enforcer, c.terms, c.args] as const),
          delegation.salt,
          delegation.epoch,
          delegation.signature,
        ] as never,
      ],
    })) as Hex
    delegation.signature = await owner.sign({ hash: digest })
    return delegation
  }

  async function harness(cap: bigint, mandateCap = cap) {
    const jobs = new JobService()
    const authorization = await jobs.authorize(
      [{ kind: 'session_total_cap', label: 'total', value: cap.toString(), tier: 'T0' }],
      owner.address,
    )
    const job = await jobs.createJob(authorization.id, `runner-${Math.random()}`)
    return {
      jobs,
      jobId: job.id,
      delegation: await mandate(mandateCap),
      asset: token,
      market,
      chain: {
        rpcUrl: RPC,
        chainId: CHAIN_ID,
        delegationManager: manager,
        relayerKey: RELAYER_KEY,
      },
    }
  }

  it('notices a position at risk and repays it on chain', async () => {
    const h = await harness(10_000n * WAD)
    const before = await debtOf(account)

    const result = await tick({
      ...h,
      assessment: atRisk(),
      state: { remaining: 10_000n * WAD, price: WAD },
    })

    expect(result.acted).toBe(true)
    expect(result.repay).toBe(120n * WAD + (120n * WAD) / 50n)
    /*
     * The assertion that matters, and it is about the DEBT rather than the
     * market's balance. Both a transfer to the market and a real repayment move
     * the same tokens to the same address; only one of them makes the position
     * healthier, and a balance assertion would pass for the version of this
     * agent that donates to the pool and leaves the user just as liquidatable.
     */
    expect(await debtOf(account)).toBe(before - (result.repay as bigint))
    expect((await h.jobs.getJob(h.jobId)).events.map((e) => e.type)).toContain('spend')
  }, 120_000)

  it('never sends anything when the assessment disagrees with the protocol', async () => {
    const h = await harness(10_000n * WAD)
    const before = await debtOf(account)

    const result = await tick({
      ...h,
      assessment: atRisk({ consistency: { verified: false, detail: 'differs by 4e17' } }),
      state: { remaining: 10_000n * WAD, price: WAD },
    })

    expect(result.acted).toBe(false)
    expect(result.reason).toContain('inconsistent')
    expect(await debtOf(account)).toBe(before)
  }, 120_000)

  it('stops at the mandate rather than at the chain when the cap is the problem', async () => {
    // The engine's cap is below the repayment, so the action must never be sent.
    const h = await harness(10n * WAD, 10_000n * WAD)
    const before = await debtOf(account)

    const result = await tick({
      ...h,
      assessment: atRisk(),
      state: { remaining: 10_000n * WAD, price: WAD },
    })

    expect(result.acted).toBe(false)
    expect(result.deniedBy).toBe('session_total_cap')
    expect(result.reason).toContain('mandate refused')
    // Nothing reached the chain: a refusal upstream is cheaper and clearer than
    // a reverted transaction, and the user pays no gas for it.
    expect(await debtOf(account)).toBe(before)
  }, 120_000)

  it('is refused by the chain when the mandate and the caveats disagree', async () => {
    // The off-chain engine allows it; the on-chain caveat does not. This is the
    // case that would be invisible without T0, and it must still move nothing.
    const h = await harness(10_000n * WAD, 10n * WAD)
    const before = await debtOf(account)

    const result = await tick({
      ...h,
      assessment: atRisk(),
      state: { remaining: 10_000n * WAD, price: WAD },
    })

    expect(result.acted).toBe(false)
    expect(result.deniedBy).toBe('chain')
    expect(await debtOf(account)).toBe(before)
  }, 120_000)
})
