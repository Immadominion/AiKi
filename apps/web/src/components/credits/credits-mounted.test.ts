import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { ApiError, api, type CreditBalance } from '../../lib/api'
import { invalidateWalletSession } from '../../lib/wallet-session'
import { ConnectedCredits } from './CreditsView'

const original = {
  credits: api.credits,
  treasury: api.treasury,
  depositCredits: api.depositCredits,
}
const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })
let renderer: ReactTestRenderer | undefined
const wallet = `0x${'11'.repeat(20)}`
const hash = `0x${'ab'.repeat(32)}`
const mainnet = {
  chainId: 56,
  decimals: 18,
  finality: 'finalized' as const,
  token: '0x55d398326f99059ff775485246999027b3197955',
  treasury: `0x${'22'.repeat(20)}`,
  pointsPerUsdt: 10000,
  confirmations: 3,
}
const balance: CreditBalance = {
  balance: 5000,
  worthUsd: 0.5,
  pointsPerUsdt: 10000,
  minimumToAsk: 100,
  model: 'Test fixture',
  history: [],
}
const rendered = () => JSON.stringify(renderer?.toJSON())
const button = (label: string) =>
  renderer?.root.findAllByType('button').find((node) => node.children.includes(label))
async function mount(address = wallet) {
  await act(async () => {
    renderer = create(createElement(ConnectedCredits, { address }))
  })
}
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  Object.assign(api, original)
})
after(() => {
  if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct)
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf)
  else Reflect.deleteProperty(globalThis, 'self')
})

test('mainnet points screen shows the correct network, amount and token explorer', async () => {
  api.credits = async () => balance
  api.treasury = async () => mainnet
  await mount()
  assert.match(rendered(), /BNB Smart Chain Mainnet/)
  assert.match(rendered(), /10,000/)
  assert.match(rendered(), /Verify a USDT payment/)
  assert.match(rendered(), /and network finality/)
  assert.doesNotMatch(rendered(), /Testnet|testnet|Mainnet purchases are not available/)
  const links = renderer?.root.findAllByType('a').map((link) => link.props.href)
  assert.ok(links?.includes(`https://bscscan.com/address/${mainnet.token}`))
  assert.ok(links?.includes(`https://bscscan.com/address/${mainnet.treasury}`))
})

test('testnet remains explicitly marked and never directs users to mainnet addresses', async () => {
  api.credits = async () => balance
  api.treasury = async () => ({
    ...mainnet,
    chainId: 97,
    decimals: 6,
    finality: 'confirmations',
    token: `0x${'33'.repeat(20)}`,
  })
  await mount()
  assert.match(rendered(), /BNB Smart Chain Testnet/)
  assert.match(rendered(), /Do not send real BNB or mainnet USDT/)
  const links = renderer?.root.findAllByType('a').map((link) => link.props.href)
  assert.ok(links?.includes(`https://testnet.bscscan.com/address/${mainnet.treasury}`))
  assert.doesNotMatch(rendered(), /BNB Smart Chain Mainnet/)
})

test('invalid and unverified rails keep balances readable without showing payment addresses', async () => {
  api.credits = async () => balance
  for (const rail of [{ ...mainnet, decimals: 6 }, { available: false as const }]) {
    api.treasury = async () => rail
    await mount()
    assert.match(rendered(), /5,000/)
    assert.match(rendered(), /Do not send funds/)
    assert.equal(renderer?.root.findAllByType('form').length, 0)
    assert.ok(!rendered().includes(mainnet.treasury))
    await act(async () => renderer?.unmount())
  }
  api.treasury = async () => {
    throw new ApiError(503, 'DEPOSIT_NETWORK_MISMATCH', 'Unavailable.', true)
  }
  await mount()
  assert.match(rendered(), /Payment details could not be loaded/)
  assert.ok(!rendered().includes(mainnet.treasury))
  api.treasury = async () => mainnet
  await act(async () => button('Check again')?.props.onClick())
  await act(async () => {})
  assert.match(rendered(), /Verify a USDT payment/)
})

test('receiving treasury cannot buy points with a self-transfer', async () => {
  api.credits = async () => balance
  api.treasury = async () => mainnet
  await mount(mainnet.treasury.toUpperCase())
  assert.match(rendered(), /A transfer to yourself cannot buy points/)
  assert.equal(renderer?.root.findAllByType('form').length, 0)
})

test('payment retries preserve the same hash and refresh an already-credited payment', async () => {
  api.credits = async () => balance
  api.treasury = async () => mainnet
  const submitted: string[] = []
  api.depositCredits = async (transactionHash) => {
    submitted.push(transactionHash)
    throw new ApiError(
      409,
      submitted.length === 1 ? 'DEPOSIT_CONFIRMING' : 'DEPOSIT_ALREADY_CREDITED',
      submitted.length === 1 ? 'Still confirming. Retry the same hash.' : 'Already credited.',
      true,
    )
  }
  await mount()
  await act(async () =>
    renderer?.root.findByType('input').props.onChange({ target: { value: hash } }),
  )
  await act(async () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.match(rendered(), /Still confirming/)
  assert.equal(renderer?.root.findByType('input').props.value, hash)
  await act(async () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.deepEqual(submitted, [hash, hash])
  assert.match(rendered(), /This payment was already credited/)
  assert.match(rendered(), /Do not send it again/)
})

test('double submits cannot duplicate a payment check and new rail configuration clears its form', async () => {
  api.credits = async () => balance
  api.treasury = async () => mainnet
  let complete: (value: Awaited<ReturnType<typeof api.depositCredits>>) => void = () => {}
  let calls = 0
  api.depositCredits = async () => {
    ++calls
    return new Promise((resolve) => {
      complete = resolve
    })
  }
  await mount()
  await act(async () =>
    renderer?.root.findByType('input').props.onChange({ target: { value: hash } }),
  )
  await act(async () => {
    void renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} })
    void renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} })
  })
  assert.equal(calls, 1)
  assert.equal(button('Checking the payment...')?.props.disabled, true)
  await act(async () => complete({ points: 10000, balance: 15000, amount: '1 USDT' }))
  assert.match(rendered(), /10,000 points added/)
  api.treasury = async () => ({ ...mainnet, treasury: `0x${'44'.repeat(20)}` })
  await act(async () => button('Refresh balance')?.props.onClick())
  await act(async () => {})
  assert.equal(renderer?.root.findByType('input').props.value, '')
  assert.doesNotMatch(rendered(), /10,000 points added/)
})

test('wallet invalidation discards private balances and late responses from the previous session', async () => {
  let resolveOld: (value: CreditBalance) => void = () => {}
  api.credits = async () =>
    new Promise((resolve) => {
      resolveOld = resolve
    })
  api.treasury = async () => mainnet
  await mount()
  api.credits = async () => {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in again.', false)
  }
  await act(async () => {
    invalidateWalletSession()
  })
  await act(async () => resolveOld({ ...balance, balance: 987654 }))
  assert.match(rendered(), /Sign in again/)
  assert.doesNotMatch(rendered(), /987,654/)
  assert.equal(renderer?.root.findAllByType('form').length, 0)
})
