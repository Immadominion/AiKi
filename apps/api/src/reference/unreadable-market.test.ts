import { expect, it, vi } from 'vitest'
import { UnreadableMarkets, VenusYieldClient } from './yield/client.js'

/**
 * Which market, by name.
 *
 * Measured on a real hire. Somebody asked for a yield report over three Venus
 * markets, one was a valid address that is not a Venus market, and the answer
 * was "I could not complete this report. The on-chain read or evidence record
 * was unavailable." That reads as an outage on AiKi's side. It was one wrong
 * address out of three, the report was cancelled, and nothing in the answer
 * said which one, so the only move left was to send it again and get the same
 * sentence. It was sent again. It said the same thing.
 */

const VUSDT = `0x${'11'.repeat(20)}` as const
const NOT_A_MARKET = `0x${'22'.repeat(20)}` as const

const reader = (readable: string[]) =>
  new VenusYieldClient('http://127.0.0.1:0', {
    readContract: vi.fn(async ({ address, functionName }: never) => {
      const at = String(address).toLowerCase()
      if (!readable.includes(at)) throw new Error('execution reverted')
      return functionName === 'symbol' ? 'vUSDT' : 1_000_000_000n
    }),
  } as never)

it('names the market that did not answer, rather than blaming the chain', async () => {
  const client = reader([VUSDT])
  await expect(client.assess([VUSDT, NOT_A_MARKET], true)).rejects.toThrow(
    new RegExp(NOT_A_MARKET, 'i'),
  )
})

it('names every one that failed, not whichever lost the race', async () => {
  /*
   * Promise.all rejects with the first failure, so a buyer who got two
   * addresses wrong would fix one and be sent back for the other. allSettled
   * costs one extra read and answers the whole question.
   */
  const third = `0x${'33'.repeat(20)}` as const
  const client = reader([VUSDT])
  const failure = await client.assess([VUSDT, NOT_A_MARKET, third], true).catch((e) => e)
  expect(failure).toBeInstanceOf(UnreadableMarkets)
  expect(failure.markets).toEqual([NOT_A_MARKET, third])
})

it('still reports when every market answers', async () => {
  const client = reader([VUSDT])
  const assessment = await client.assess([VUSDT], true)
  expect(assessment.routes).toHaveLength(1)
})

it('is a buyer problem, so the endpoint may repeat it back', async () => {
  // The generic message exists to keep RPC urls and credentials out of a public
  // response. An address the buyer typed is already theirs, so saying it back
  // leaks nothing and is the only thing that helps.
  const failure = new UnreadableMarkets([NOT_A_MARKET])
  expect(failure.message).toContain(NOT_A_MARKET)
  expect(failure.message).toMatch(/does not answer as a Venus market/)
})
