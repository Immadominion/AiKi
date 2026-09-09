import { keccak256 } from 'viem'
import { expect, it } from 'vitest'
import type { JsonRpcClient } from './assertions.js'
import {
  AIKI_ENFORCERS_BSC_TESTNET,
  assertEnforcerDeployment,
  type EnforcerDeployment,
  enforcementClaim,
} from './enforcers.js'

/** Any bytecode the real set does not run, so the pinned-hash check has teeth. */
const FAKE_CODE = '0xfeed' as const

/**
 * A stand-in for the deployed suite, answering the three questions the assertion
 * asks. Each can be spoiled independently, because each failure means something
 * different and only separate tests can tell them apart.
 */
function fakeChain(
  overrides: {
    chainId?: number
    code?: Record<string, string>
    resolves?: Record<string, string>
    links?: Record<string, string>
  } = {},
): JsonRpcClient {
  const real: Record<string, string> = {}
  // Bytecode whose keccak is the pinned hash cannot be invented here, so the
  // fake returns code and the test pins the hash of THAT, which is the same
  // check performed against a different corpus.
  for (const e of AIKI_ENFORCERS_BSC_TESTNET.enforcers) real[e.address] = FAKE_CODE
  const code = { ...real, ...overrides.code }
  return {
    async request<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'eth_chainId')
        return `0x${(overrides.chainId ?? AIKI_ENFORCERS_BSC_TESTNET.chainId).toString(16)}` as T
      if (method === 'eth_getCode') return (code[String(params[0]).toLowerCase()] ?? '0x') as T
      if (method === 'eth_call') {
        const to = String((params[0] as { to: string }).to).toLowerCase()
        // The fake resolves every name to the pinned address unless told not to.
        const data = String((params[0] as { data: string }).data)
        for (const [getter, expected] of [
          ['EXPIRY_ENFORCER', AIKI_ENFORCERS_BSC_TESTNET.enforcers[0]?.address],
          ['DELEGATION_MANAGER', AIKI_ENFORCERS_BSC_TESTNET.manager],
        ]) {
          if (data === keccak256(new TextEncoder().encode(`${getter}()`)).slice(0, 10)) {
            const address = overrides.links?.[`${to}:${getter}`] ?? expected
            return `0x${address?.slice(2).padStart(64, '0')}` as T
          }
        }
        if (to !== AIKI_ENFORCERS_BSC_TESTNET.registry) throw new Error('unexpected call target')
        const named = AIKI_ENFORCERS_BSC_TESTNET.enforcers.find((e) => {
          const hex = [...new TextEncoder().encode(e.name)]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          return data.includes(hex)
        })
        const answer = named
          ? (overrides.resolves?.[named.name] ?? named.address)
          : '0x0000000000000000000000000000000000000000'
        return `0x${answer.slice(2).padStart(64, '0')}` as T
      }
      throw new Error(`unexpected method ${method}`)
    },
  }
}

/**
 * A deployment whose pinned hashes match what the fake actually serves.
 *
 * Computed rather than written down. A hardcoded digest here would be a constant
 * nobody can check, and getting it wrong makes the positive test fail for a
 * reason that has nothing to do with what it is testing.
 */
const pinnedToFake = (): EnforcerDeployment => ({
  ...AIKI_ENFORCERS_BSC_TESTNET,
  enforcers: AIKI_ENFORCERS_BSC_TESTNET.enforcers.map((e) => ({
    ...e,
    codeHash: keccak256(FAKE_CODE),
  })),
})

it('refuses a chain that is not the one the deployment is pinned to', async () => {
  await expect(
    assertEnforcerDeployment(fakeChain({ chainId: 56 }), AIKI_ENFORCERS_BSC_TESTNET),
  ).rejects.toThrow(/pinned to chain 97/)
})

it('refuses an enforcer address with no code', async () => {
  const first = AIKI_ENFORCERS_BSC_TESTNET.enforcers[0]
  if (!first) throw new Error('fixture has no enforcers')
  await expect(
    assertEnforcerDeployment(
      fakeChain({ code: { [first.address]: '0x' } }),
      AIKI_ENFORCERS_BSC_TESTNET,
    ),
  ).rejects.toThrow(/has no deployed bytecode/)
})

it('refuses code that is not the code these claims were made about', async () => {
  // The fake serves 0xfeed; the real config pins the hash of the real bytecode.
  await expect(assertEnforcerDeployment(fakeChain(), AIKI_ENFORCERS_BSC_TESTNET)).rejects.toThrow(
    /runs code we did not pin/,
  )
})

it('refuses a registry that resolves a name somewhere else', async () => {
  const first = AIKI_ENFORCERS_BSC_TESTNET.enforcers[0]
  if (!first) throw new Error('fixture has no enforcers')
  const squatter = `0x${'11'.repeat(20)}`
  await expect(
    assertEnforcerDeployment(fakeChain({ resolves: { [first.name]: squatter } }), pinnedToFake()),
  ).rejects.toThrow(/disagrees with this config/)
})

it('accepts the set when chain, code hash and registry all agree', async () => {
  const checked = await assertEnforcerDeployment(fakeChain(), pinnedToFake())
  expect(checked.map((c) => c.name)).toEqual(
    AIKI_ENFORCERS_BSC_TESTNET.enforcers.map((e) => e.name),
  )
})

it('requires mainnet pins for the manager and registry as well as the enforcers', async () => {
  const deployment: EnforcerDeployment = {
    ...pinnedToFake(),
    chainId: 56,
    network: 'mainnet',
  }
  await expect(assertEnforcerDeployment(fakeChain({ chainId: 56 }), deployment)).rejects.toThrow(
    'manager and registry code hashes',
  )
  const pinned = {
    ...deployment,
    managerCodeHash: keccak256(FAKE_CODE),
    registryCodeHash: keccak256(FAKE_CODE),
  }
  const code = { [deployment.manager]: FAKE_CODE, [deployment.registry]: FAKE_CODE }
  expect(await assertEnforcerDeployment(fakeChain({ chainId: 56, code }), pinned)).toHaveLength(6)
  await expect(
    assertEnforcerDeployment(
      fakeChain({ chainId: 56, code: { ...code, [deployment.manager]: '0xdead' } }),
      pinned,
    ),
  ).rejects.toThrow('AiKiDelegationManager')
  await expect(
    assertEnforcerDeployment(
      fakeChain({ chainId: 56, code: { ...code, [deployment.registry]: '0x' } }),
      pinned,
    ),
  ).rejects.toThrow('AiKiEnforcerRegistry')

  for (const [contract, getter] of [
    [deployment.manager, 'EXPIRY_ENFORCER'],
    [deployment.registry, 'DELEGATION_MANAGER'],
    ...deployment.enforcers
      .filter((entry) => ['PerActionCapEnforcer', 'SessionTotalCapEnforcer'].includes(entry.name))
      .map((entry) => [entry.address, 'DELEGATION_MANAGER']),
  ]) {
    await expect(
      assertEnforcerDeployment(
        fakeChain({
          chainId: 56,
          code,
          links: { [`${contract}:${getter}`]: `0x${'dd'.repeat(20)}` },
        }),
        pinned,
      ),
    ).rejects.toThrow('reviewed contract wiring')
  }
})

it('will not let a testnet deployment claim T0 without saying so', () => {
  // The whole point of the rule that started this: T0 means the chain refuses
  // the transaction, and a reader assumes that sentence is about their money.
  const claim = enforcementClaim(AIKI_ENFORCERS_BSC_TESTNET)
  expect(claim.tier).toBe('T0')
  expect(claim.qualifier).toMatch(/testnet/)
  expect(claim.qualifier).toMatch(/audit/)

  const audited = enforcementClaim({
    ...AIKI_ENFORCERS_BSC_TESTNET,
    network: 'mainnet',
    audited: true,
  })
  expect(audited.qualifier).toBeNull()
})
