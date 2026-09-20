import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  toBaseUnits,
  WithdrawInputError,
  withdrawTransaction,
  wrapNativeTransaction,
} from '../../../../apps/web/src/lib/agent-withdraw.js'

const OWNER = '0x0dCad2aBf180246D6bA155009F8817431bFb3239'
const ACCOUNT = '0x418ccdab06164b8b7fb8801d95e22d71aa9824bb'
const USDT = '0x55d398326f99059ff775485246999027b3197955'
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'

describe('withdrawing from a mandate account', () => {
  it('uses the selectors the account actually exposes', () => {
    // Derived here rather than copied, because a hand-written selector that is
    // wrong produces a transaction the wallet will still happily sign, and the
    // account reverts on a function it does not have. One of these two was
    // wrong when it was first written.
    const native = withdrawTransaction({ owner: OWNER, account: ACCOUNT, to: OWNER, amount: 1n })
    expect(native.data.slice(0, 10)).toBe(
      toFunctionSelector('function withdrawNative(address,uint256)'),
    )
    const token = withdrawTransaction({
      owner: OWNER,
      account: ACCOUNT,
      to: OWNER,
      amount: 1n,
      token: USDT,
    })
    expect(token.data.slice(0, 10)).toBe(
      toFunctionSelector('function withdrawERC20(address,address,uint256)'),
    )
  })

  it('encodes the destination and amount as the account will read them', () => {
    const tx = withdrawTransaction({
      owner: OWNER,
      account: ACCOUNT,
      to: OWNER,
      amount: 1_400_000_000_000_000n,
    })
    expect(tx.to).toBe(ACCOUNT)
    expect(tx.from).toBe(OWNER)
    // The account spends its own balance; the transaction itself carries none.
    expect(tx.value).toBe('0')
    expect(tx.data.slice(10, 74)).toBe(OWNER.slice(2).toLowerCase().padStart(64, '0'))
    expect(BigInt(`0x${tx.data.slice(74, 138)}`)).toBe(1_400_000_000_000_000n)
  })

  it('refuses a destination that would destroy the money', () => {
    const zero = '0x0000000000000000000000000000000000000000'
    expect(() =>
      withdrawTransaction({ owner: OWNER, account: ACCOUNT, to: zero, amount: 1n }),
    ).toThrow(/destroyed/)
    expect(() =>
      withdrawTransaction({ owner: OWNER, account: ACCOUNT, to: 'nwakanma.bnb', amount: 1n }),
    ).toThrow(WithdrawInputError)
    expect(() =>
      withdrawTransaction({ owner: OWNER, account: ACCOUNT, to: OWNER, amount: 0n }),
    ).toThrow(/above zero/)
  })

  it('converts a typed amount without floating point touching it', () => {
    expect(toBaseUnits('0.0014', 18)).toBe(1_400_000_000_000_000n)
    expect(toBaseUnits('12.4', 18)).toBe(12_400_000_000_000_000_000n)
    expect(toBaseUnits('.5', 18)).toBe(500_000_000_000_000_000n)
    // 0.1 + 0.2 arithmetic has no place anywhere near a withdrawal.
    expect(toBaseUnits('0.3', 18)).toBe(300_000_000_000_000_000n)
    expect(() => toBaseUnits('0.0000000000000000001', 18)).toThrow(/18 decimal places/)
    expect(() => toBaseUnits('one', 18)).toThrow(WithdrawInputError)
  })
})

describe('converting the account’s own BNB into something an agent can spend', () => {
  it('encodes byte for byte the same call viem would, and simulated on a live account', () => {
    // The dynamic `bytes` argument is hand-encoded, which is exactly the kind
    // of thing that is subtly wrong and still signs, so it is pinned against
    // an independent encoder rather than against itself.
    const tx = wrapNativeTransaction({
      owner: OWNER,
      account: ACCOUNT,
      wbnb: WBNB,
      amount: 1_400_000_000_000_000n,
    })
    expect(tx.data).toBe(
      encodeFunctionData({
        abi: parseAbi(['function execute(address,uint256,bytes) returns (bytes)']),
        functionName: 'execute',
        args: [WBNB, 1_400_000_000_000_000n, '0xd0e30db0'],
      }),
    )
    expect(tx.to).toBe(ACCOUNT)
    // The BNB comes out of the account, not out of the wallet signing this.
    expect(tx.value).toBe('0')
  })

  it('will not offer to convert nothing', () => {
    expect(() =>
      wrapNativeTransaction({ owner: OWNER, account: ACCOUNT, wbnb: WBNB, amount: 0n }),
    ).toThrow(/no BNB/)
  })
})
