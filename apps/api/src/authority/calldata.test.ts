import { encodeFunctionData, parseAbi } from 'viem'
import { expect, it } from 'vitest'
import { namesRecipient, recipientOf, selectorOf } from './calldata.js'

/**
 * The decode is checked against calldata viem actually encoded, not against
 * hand-written hex, because the whole value of this module is that the offset
 * it reads is the offset a real wallet writes.
 */

const ERC20 = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const VENUS = parseAbi(['function repayBorrow(uint256 amount) returns (uint256)'])

const TO = '0x00000000000000000000000000000000000000aa' as const
const FROM = '0x00000000000000000000000000000000000000bb' as const

it('reads the destination of a real transfer', () => {
  const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [TO, 5n] })
  expect(recipientOf('0xa9059cbb', data)).toBe(TO)
})

it('reads the destination of transferFrom, which is the second argument', () => {
  const data = encodeFunctionData({
    abi: ERC20,
    functionName: 'transferFrom',
    args: [FROM, TO, 5n],
  })
  // Reading argument zero here would bound the source and leave the destination
  // free, which is the exact mistake this test exists to catch.
  expect(recipientOf('0x23b872dd', data)).toBe(TO)
})

it('treats an approval spender as the destination', () => {
  const data = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [TO, 5n] })
  expect(recipientOf('0x095ea7b3', data)).toBe(TO)
})

it('is null for a call shape that names nobody', () => {
  const data = encodeFunctionData({ abi: VENUS, functionName: 'repayBorrow', args: [5n] })
  expect(recipientOf('0x0e752702', data)).toBeNull()
  expect(namesRecipient('0x0e752702')).toBe(false)
  expect(namesRecipient('0xa9059cbb')).toBe(true)
})

it('is null rather than a guess when the calldata is too short', () => {
  expect(recipientOf('0xa9059cbb', '0xa9059cbb')).toBeNull()
  expect(recipientOf('0xa9059cbb', '0xa9059cbb00ff')).toBeNull()
  expect(recipientOf('0x23b872dd', `0x23b872dd${'0'.repeat(64)}`)).toBeNull()
})

it('refuses a word that is not a clean address', () => {
  // Something in the leading twelve bytes means this word is not an address.
  const dirty = `0xa9059cbb${'1'.repeat(24)}${'a'.repeat(40)}`
  expect(recipientOf('0xa9059cbb', dirty)).toBeNull()
})

it('does not care about 0x or case, in the selector OR the body', () => {
  const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [TO, 1n] })
  expect(recipientOf('0xA9059CBB', data)).toBe(TO)
  expect(recipientOf('0xa9059cbb', data.slice(2))).toBe(TO)
  // Checksum-cased calldata is well formed and used to decode to null, which
  // refused a payment the mandate names with the untrue reason that no
  // destination could be read.
  expect(recipientOf('0xa9059cbb', data.toUpperCase().replace('0X', '0x'))).toBe(TO)
  expect(recipientOf('0xa9059cbb', data.toUpperCase())).toBe(TO)
})

it('reads the selector the calldata carries, not one supplied beside it', () => {
  const transfer = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [TO, 1n] })
  expect(selectorOf(transfer)).toBe('0xa9059cbb')
  expect(selectorOf(transfer.toUpperCase())).toBe('0xa9059cbb')
  expect(selectorOf(transfer.slice(2))).toBe('0xa9059cbb')
  // Nothing to compare against rather than a guess.
  expect(selectorOf('0x')).toBeNull()
  expect(selectorOf('0xa905')).toBeNull()
  expect(selectorOf('0xzzzzzzzz')).toBeNull()
})

it('is null for an unknown selector even when the calldata would decode', () => {
  const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [TO, 1n] })
  expect(recipientOf('0xdeadbeef', data)).toBeNull()
})
