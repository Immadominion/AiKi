import { readFileSync } from 'node:fs'
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  type Hex,
  http,
  keccak256,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JobService } from '../jobs/service.js'
import { erc20TransferCall, execute, type SignedDelegation } from './executor.js'

/**
 * The full path from "an agent wants to do something" to "the chain did it".
 *
 * Everything else in this repository stops one step short: the policy engine
 * decides, the enforcers would refuse, the receipt would attest. This is the
 * test that the pieces are actually connected, and it is deliberately a real
 * chain rather than a mock. An agent proposes a transfer, the policy engine
 * rules on it, a relayer that holds no authority submits the redemption, and the
 * assertion is on the token contract's own balances afterwards.
 *
 * The manager here is ours rather than MetaMask's deployed one, because anvil
 * forking BSC is rate-limited by the public archive endpoints. That half is
 * covered separately and properly by onchain/test/ForkRealManager.t.sol, which
 * redeems through the real deployed contract. Between them: our enforcers work
 * with their manager, and our server can drive a redemption end to end.
 */
const RPC = 'http://127.0.0.1:8545'
const CHAIN_ID = 31337
// anvil's first two default accounts. Local test chain, published by anvil itself.
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const RELAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

const artifact = (name: string, contract = name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../onchain/out/${name}.sol/${contract}.json`, import.meta.url),
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

async function deploy(name: string, args: unknown[] = [], contract = name): Promise<Address> {
  const { abi, bytecode } = artifact(name, contract)
  const hash = await wallet.deployContract({
    abi: abi as never,
    bytecode: bytecode.object,
    args: args as never,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error(`${name} did not deploy`)
  return receipt.contractAddress
}

describe.skipIf(!reachable)('execute (against a real chain)', () => {
  let manager: Address
  let account: Address
  let token: Address
  let sessionEnforcer: Address
  let perActionEnforcer: Address
  let expiryEnforcer: Address
  const recipient = '0x000000000000000000000000000000000000dEaD' as Address

  beforeAll(async () => {
    // The manager will not accept a mandate without an expiry caveat, and needs
    // to know which enforcer that caveat must name, so this one comes first.
    expiryEnforcer = await deploy('ExpiryEnforcer')
    manager = await deploy('AiKiDelegationManager', [expiryEnforcer])
    account = await deploy('AiKiMandateAccount', [owner.address, manager])
    sessionEnforcer = await deploy('SessionTotalCapEnforcer', [manager])
    perActionEnforcer = await deploy('PerActionCapEnforcer', [manager])
    token = await deploy('MockERC20')
    const hash = await wallet.writeContract({
      address: token,
      abi: parseAbi(['function mint(address to, uint256 amount)']),
      functionName: 'mint',
      args: [account, 1_000n * 10n ** 18n],
    })
    await publicClient.waitForTransactionReceipt({ hash })
  }, 120_000)

  afterAll(() => {})

  /** A mandate signed by the account owner, exactly as the app would produce. */
  async function mandate(perCap: bigint, sessionCap: bigint): Promise<SignedDelegation> {
    const transferSelector = keccak256(new TextEncoder().encode('transfer(address,uint256)')).slice(
      0,
      10,
    ) as Hex
    const sites = [{ target: token, selector: transferSelector, asset: token, argIndex: 1 }]
    const siteType = {
      type: 'tuple[]',
      components: [
        { name: 'target', type: 'address' },
        { name: 'selector', type: 'bytes4' },
        { name: 'asset', type: 'address' },
        { name: 'argIndex', type: 'uint8' },
      ],
    } as const
    const terms = (cap: bigint) =>
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, siteType], [token, cap, sites])

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
        { enforcer: perActionEnforcer, terms: terms(perCap), args: '0x' },
        { enforcer: sessionEnforcer, terms: terms(sessionCap), args: '0x' },
      ],
      salt: 0n,
      epoch: 0n,
      signature: '0x' as Hex,
    }

    // The manager computes its own digest, so the test cannot get the typehash
    // wrong without the redemption failing loudly.
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

  const balanceOf = (who: Address) =>
    publicClient.readContract({
      address: token,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [who],
    }) as Promise<bigint>

  it('carries an allowed action from policy to a state change on chain', async () => {
    const jobs = new JobService()
    const authorization = await jobs.authorize(
      [
        {
          kind: 'per_action_cap',
          label: 'each',
          value: (200n * 10n ** 18n).toString(),
          tier: 'T0',
        },
        {
          kind: 'session_total_cap',
          label: 'total',
          value: (500n * 10n ** 18n).toString(),
          tier: 'T0',
        },
      ],
      owner.address,
    )
    const job = await jobs.createJob(authorization.id, 'exec-1')
    const delegation = await mandate(200n * 10n ** 18n, 500n * 10n ** 18n)

    const amount = 150n * 10n ** 18n
    const action = {
      target: token,
      selector: '0xa9059cbb',
      asset: token,
      amount,
      at: new Date().toISOString(),
    }

    // 1. The policy engine rules first. Nothing reaches the chain unless it does.
    const verdict = await jobs.attempt(job.id, action)
    expect(verdict.allow).toBe(true)

    const before = await balanceOf(recipient)
    // 2. The relayer submits. It holds no authority; the caveats do.
    const outcome = await execute({
      rpcUrl: RPC,
      chainId: CHAIN_ID,
      delegationManager: manager,
      relayerKey: RELAYER_KEY,
      delegation,
      action,
      callData: erc20TransferCall(recipient, amount),
    })

    expect(outcome.status).toBe('landed')
    // 3. The assertion is on the token contract, not on our own bookkeeping.
    expect(await balanceOf(recipient)).toBe(before + amount)
    expect((await jobs.getJob(job.id)).events.map((e) => e.type)).toContain('spend')
  }, 120_000)

  it('refuses on chain what the policy engine would have refused, and moves nothing', async () => {
    const delegation = await mandate(100n * 10n ** 18n, 500n * 10n ** 18n)
    const amount = 150n * 10n ** 18n // over the 100 per-action cap
    const before = await balanceOf(recipient)

    const outcome = await execute({
      rpcUrl: RPC,
      chainId: CHAIN_ID,
      delegationManager: manager,
      relayerKey: RELAYER_KEY,
      delegation,
      action: {
        target: token,
        selector: '0xa9059cbb',
        asset: token,
        amount,
        at: new Date().toISOString(),
      },
      callData: erc20TransferCall(recipient, amount),
    })

    // Not 'landed', which is the property under test: the enforcer stopped it.
    // Which flavour of refusal depends on the node. Anvil rejects it at
    // estimation, so nothing is submitted and there is no hash; a node that
    // accepts and mines it would report 'reverted' with one. Asserting the
    // specific flavour would be asserting a property of the RPC rather than of
    // the enforcers.
    expect(outcome.status).not.toBe('landed')
    expect(outcome.revertReason).toBeTruthy()
    // A hash is claimed only when a transaction actually exists.
    if (outcome.status === 'refused') expect(outcome.transactionHash).toBeUndefined()
    expect(await balanceOf(recipient)).toBe(before)
  }, 120_000)
})
