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
import { beforeAll, describe, expect, it } from 'vitest'
import type { SignedDelegation } from '../execution/executor.js'
import { settle } from './settle.js'

/**
 * Money actually moving, to the right two places.
 *
 * /v1/quotes returned amount "0" until now, which is a polite way of saying
 * nobody had been paid. This asserts on the token contract's balances after a
 * settlement: the payer is debited the total, the agent receives the price, the
 * treasury receives the fee, and the three add up.
 */
const RPC = 'http://127.0.0.1:8545'
const CHAIN_ID = 31337
// anvil accounts 2 and 3. execution/executor.test.ts uses 0 and 1: sharing a
// deployer across two files that vitest runs in parallel makes their nonces race.
const OWNER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex
const RELAYER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex

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

describe.skipIf(!reachable)('settle (against a real chain)', () => {
  const payee = '0x00000000000000000000000000000000000a6e17' as Address
  const treasury = '0x0000000000000000000000000000000000a1c1e5' as Address
  let manager: Address
  let account: Address
  let token: Address
  let sessionEnforcer: Address
  let expiryEnforcer: Address

  beforeAll(async () => {
    expiryEnforcer = await deploy('ExpiryEnforcer')
    manager = await deploy('AiKiDelegationManager', [expiryEnforcer])
    account = await deploy('AiKiMandateAccount', [owner.address, manager])
    sessionEnforcer = await deploy('SessionTotalCapEnforcer', [manager])
    token = await deploy('MockERC20')
    const hash = await wallet.writeContract({
      address: token,
      abi: parseAbi(['function mint(address to, uint256 amount)']),
      functionName: 'mint',
      args: [account, 10_000n * 10n ** 18n],
    })
    await publicClient.waitForTransactionReceipt({ hash })
  }, 120_000)

  async function mandate(sessionCap: bigint): Promise<SignedDelegation> {
    const selector = keccak256(new TextEncoder().encode('transfer(address,uint256)')).slice(
      0,
      10,
    ) as Hex
    const siteType = {
      type: 'tuple[]',
      components: [
        { name: 'target', type: 'address' },
        { name: 'selector', type: 'bytes4' },
        { name: 'asset', type: 'address' },
        { name: 'argIndex', type: 'uint8' },
      ],
    } as const
    const terms = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, siteType],
      [token, sessionCap, [{ target: token, selector, asset: token, argIndex: 1 }]],
    )
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
        { enforcer: sessionEnforcer, terms, args: '0x' },
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

  const balanceOf = (who: Address) =>
    publicClient.readContract({
      address: token,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [who],
    }) as Promise<bigint>

  const chainConfig = () => ({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    delegationManager: manager,
    relayerKey: RELAYER_KEY,
  })

  it('pays the agent and the platform from one mandate, and the numbers add up', async () => {
    const price = 100n * 10n ** 18n
    const delegation = await mandate(1_000n * 10n ** 18n)

    const payerBefore = await balanceOf(account)
    const outcome = await settle({
      chain: chainConfig(),
      delegation,
      asset: token,
      payee,
      treasury,
      price,
    })

    expect(outcome.settled).toBe(true)
    expect(await balanceOf(payee)).toBe(price)
    expect(await balanceOf(treasury)).toBe(outcome.priced.platformFee)
    // The payer is out exactly the total that was quoted, not a wei more.
    expect(await balanceOf(account)).toBe(payerBefore - outcome.priced.total)
    expect(outcome.priced.price + outcome.priced.platformFee).toBe(outcome.priced.total)
  }, 120_000)

  it('pays nobody when the mandate cannot cover the agent', async () => {
    const delegation = await mandate(10n * 10n ** 18n) // cap below the price
    const payeeBefore = await balanceOf(payee)
    const treasuryBefore = await balanceOf(treasury)

    const outcome = await settle({
      chain: chainConfig(),
      delegation,
      asset: token,
      payee,
      treasury,
      price: 100n * 10n ** 18n,
    })

    expect(outcome.pricePaid).toBe(false)
    expect(outcome.settled).toBe(false)
    // Crucially the fee is never attempted: taking a platform cut for work that
    // was never paid for is the worst available ordering.
    expect(outcome.transactions.some((t) => t.leg === 'fee')).toBe(false)
    expect(await balanceOf(payee)).toBe(payeeBefore)
    expect(await balanceOf(treasury)).toBe(treasuryBefore)
  }, 120_000)

  it('reports a half-settlement rather than hiding it', async () => {
    // A cap that fits the price and not the fee. The agent gets paid, AiKi does
    // not, and the outcome says so instead of claiming success or failure.
    const price = 100n * 10n ** 18n
    const delegation = await mandate(price)
    const payeeBefore = await balanceOf(payee)
    const treasuryBefore = await balanceOf(treasury)

    const outcome = await settle({
      chain: chainConfig(),
      delegation,
      asset: token,
      payee,
      treasury,
      price,
    })

    expect(outcome.pricePaid).toBe(true)
    expect(outcome.feePaid).toBe(false)
    expect(outcome.settled).toBe(false)
    expect(outcome.detail).toContain('AiKi is unpaid')
    expect(await balanceOf(payee)).toBe(payeeBefore + price)
    expect(await balanceOf(treasury)).toBe(treasuryBefore)
  }, 120_000)
})
