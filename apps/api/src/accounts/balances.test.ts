import { accountTokensFor } from '@aiki/contracts'
import { expect, it, vi } from 'vitest'
import type { ChainReader } from '../authority/chain-reader.js'
import { readAccountBalances } from './balances.js'

/**
 * Every case here is the same question: does an unreadable balance ever come
 * back looking like an empty one? Zero and unknown render identically and mean
 * opposite things to somebody who has just sent money to this address, so each
 * failure path is pinned separately rather than trusted to a shared catch.
 */

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const

const reader = (over: Partial<ChainReader> = {}): ChainReader => ({
  ownerOf: async () => null,
  isValidSignature: async () => false,
  ...over,
})

it('reports what the chain returned, in base units', async () => {
  const balances = vi.fn(async (_account: `0x${string}`, tokens: { symbol: string }[]) => ({
    native: '12345',
    tokens: tokens.map((token) => ({
      address: '0x2222222222222222222222222222222222222222' as const,
      symbol: token.symbol,
      decimals: 18,
      raw: '99',
    })),
  }))
  const result = await readAccountBalances({
    chain: reader({ balances }),
    chainId: 56,
    account: ACCOUNT,
  })
  expect(result?.native).toBe('12345')
  expect(result?.tokens.map((token) => token.symbol)).toEqual(['USDT', 'WBNB'])
  expect(balances).toHaveBeenCalledWith(ACCOUNT, accountTokensFor(56))
})

it('asks for the tokens that chain actually uses', async () => {
  const seen: { symbol: string; decimals: number }[][] = []
  const balances = async (_a: `0x${string}`, tokens: { symbol: string; decimals: number }[]) => {
    seen.push(tokens)
    return { native: '0', tokens: [] }
  }
  await readAccountBalances({ chain: reader({ balances }), chainId: 97, account: ACCOUNT })
  // Testnet USDT is six decimals and there is no reviewed WBNB there. Reading a
  // mainnet token list against testnet would report somebody else's balance.
  expect(seen[0]).toEqual([
    { address: '0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c', symbol: 'USDT', decimals: 6 },
  ])
})

it('is null when the deployment cannot read a chain at all', async () => {
  expect(await readAccountBalances({ chainId: 56, account: ACCOUNT })).toBeNull()
})

it('is null when the reader does not implement balances', async () => {
  expect(await readAccountBalances({ chain: reader(), chainId: 56, account: ACCOUNT })).toBeNull()
})

it('is null on an execution chain with no reviewed token list', async () => {
  const balances = vi.fn()
  expect(
    await readAccountBalances({ chain: reader({ balances }), chainId: 999, account: ACCOUNT }),
  ).toBeNull()
  // Never called: a native-only answer would name the one balance no agent can
  // spend and imply the tokens were checked.
  expect(balances).not.toHaveBeenCalled()
})

it('is null when the read throws', async () => {
  const balances = async () => {
    throw new Error('rpc down')
  }
  expect(
    await readAccountBalances({ chain: reader({ balances }), chainId: 56, account: ACCOUNT }),
  ).toBeNull()
})

it('is null when the read outlives its timeout', async () => {
  const balances = () => new Promise<never>(() => {})
  const started = Date.now()
  expect(
    await readAccountBalances({
      chain: reader({ balances }),
      chainId: 56,
      account: ACCOUNT,
      timeoutMs: 20,
    }),
  ).toBeNull()
  expect(Date.now() - started).toBeLessThan(1_000)
})

it('does not hold the process open after a slow read resolves late', async () => {
  const balances = () =>
    new Promise<{ native: string; tokens: [] }>((resolve) =>
      setTimeout(() => resolve({ native: '1', tokens: [] }), 40),
    )
  const spy = vi.spyOn(globalThis, 'clearTimeout')
  await readAccountBalances({
    chain: reader({ balances }),
    chainId: 56,
    account: ACCOUNT,
    timeoutMs: 5_000,
  })
  expect(spy).toHaveBeenCalled()
  spy.mockRestore()
})
