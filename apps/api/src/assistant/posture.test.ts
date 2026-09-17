import { expect, it } from 'vitest'
import { SYSTEM } from './run.js'

/**
 * What Fast reaches for first.
 *
 * Asked twice whether agents could trade, Fast spent two turns and eleven
 * hundred points offering to search instead of searching, and led both replies
 * with what it could not do. Both answers were accurate. Neither told the
 * person anything, and the second one charged them to be asked a question back.
 *
 * These pin the order rather than the wording, because order is the behaviour.
 * A rule that says go and look only works if it is read before the list of
 * things not to do, and an instruction to lead with what works only works if it
 * is not buried underneath seventy prohibitions.
 */

it('says to go and look, before it says anything about not doing things', () => {
  const look = SYSTEM.indexOf('Look before you answer')
  const can = SYSTEM.indexOf('What you can do.')
  const cannot = SYSTEM.indexOf('What you cannot do, and why')
  expect(look).toBeGreaterThan(-1)
  expect(can).toBeGreaterThan(look)
  expect(cannot).toBeGreaterThan(can)
})

it('names the thing a reply must not end with', () => {
  // The exact shape of the failure: a refusal with a question attached, which
  // reads as helpful and costs a whole turn to deliver nothing.
  expect(SYSTEM).toMatch(/shall I search/i)
  expect(SYSTEM).toMatch(/would you like me to\s*\n?\s*look\?" is not one/i)
})

it('says AiKi can swap, and does not carry the old reason it could not', () => {
  /*
   * The prompt used to explain in detail that trading was impossible: "no
   * exchange router is allowlistable, and the cap enforcers cannot read an
   * amount out of a swap". Both halves were false. A router is an ordinary
   * address, and PerActionCapEnforcer charges max(declared, realised) where
   * realised is a balanceOf delta its own comment calls decode-free. The claim
   * survived for weeks because nobody read the enforcer.
   */
  expect(SYSTEM).toMatch(/You CAN swap/)
  for (const lie of [
    'genuinely cannot do it',
    'no exchange router is allowlistable',
    'cannot read an amount out of a swap',
  ])
    expect(SYSTEM, lie).not.toContain(lie)
})

it('still offers hiring somebody who trades, which is a different thing', () => {
  expect(SYSTEM).toContain('hire somebody who already does it')
})

it('still forbids the sentence this all started with', () => {
  /*
   * "No agent on AiKi can take control of your money, ever." False about other
   * people's agents when it was written, and false about AiKi's own now.
   */
  expect(SYSTEM).toContain('Do NOT tell anyone that no agent on this platform can move money')
})
