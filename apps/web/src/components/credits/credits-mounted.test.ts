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

test('double submits cannot duplicate a payment check and new rails clear only the form', async () => {
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
  assert.match(rendered(), /10,000 points added/)
  assert.match(rendered(), new RegExp(hash))
  assert.ok(
    renderer?.root
      .findAllByType('a')
      .some((link) => link.props.href === `https://bscscan.com/tx/${hash}`),
  )
})

for (const failure of ['balance', 'configuration', 'invalid configuration', 'both'] as const) {
  test(`confirmed payment and hash survive a failed ${failure} refresh; retry is read-only`, async () => {
    api.credits = async () => balance
    api.treasury = async () => mainnet
    let deposits = 0
    api.depositCredits = async () => {
      deposits++
      if (failure === 'balance' || failure === 'both')
        api.credits = async () => {
          throw new Error('Balance temporarily unavailable.')
        }
      if (failure === 'configuration' || failure === 'both')
        api.treasury = async () => {
          throw new Error('Payment details temporarily unavailable.')
        }
      if (failure === 'invalid configuration')
        api.treasury = async () => ({ available: false as const })
      return { points: 10000, balance: 15000, amount: '1 USDT' }
    }
    await mount()
    await act(async () =>
      renderer?.root.findByType('input').props.onChange({ target: { value: hash } }),
    )
    await act(async () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} }))
    assert.match(rendered(), /10,000 points added/)
    assert.match(rendered(), new RegExp(hash))
    assert.match(rendered(), /Do not send it again/)
    assert.equal(renderer?.root.findAllByType('form').length, 0)
    const retry = button('Refresh account details')
    assert.ok(retry)
    let refreshBalance: (value: CreditBalance) => void = () => {}
    api.credits = async () =>
      new Promise((resolve) => {
        refreshBalance = resolve
      })
    api.treasury = async () => mainnet
    await act(async () => {
      void retry.props.onClick()
    })
    assert.match(rendered(), /10,000 points added/)
    assert.match(rendered(), new RegExp(hash))
    assert.equal(button('Refreshing account details…')?.props.disabled, true)
    assert.equal(deposits, 1)
    await act(async () => refreshBalance({ ...balance, balance: 15000 }))
    assert.match(rendered(), /15,000/)
    assert.match(rendered(), /10,000 points added/)
    assert.equal(deposits, 1)
  })
}

test('already-credited receipt survives refresh failure without claiming a refreshed balance', async () => {
  api.credits = async () => balance
  api.treasury = async () => mainnet
  api.depositCredits = async () => {
    api.credits = async () => {
      throw new Error('Balance temporarily unavailable.')
    }
    throw new ApiError(409, 'DEPOSIT_ALREADY_CREDITED', 'Already credited.', false)
  }
  await mount()
  await act(async () =>
    renderer?.root.findByType('input').props.onChange({ target: { value: hash } }),
  )
  await act(async () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.match(rendered(), /This payment was already credited/)
  assert.match(rendered(), new RegExp(hash))
  assert.doesNotMatch(rendered(), /Your balance has been refreshed/)
  assert.ok(button('Refresh account details'))
})

for (const refresh of ['new rail', 'balance failure', 'configuration failure'] as const) {
  for (const outcome of ['credited', 'already credited'] as const) {
    test(`pending verification survives ${refresh} unmount and preserves its ${outcome} receipt`, async () => {
      api.credits = async () => balance
      api.treasury = async () => mainnet
      let finish: () => void = () => {}
      let deposits = 0
      api.depositCredits = async () => {
        deposits++
        return new Promise((resolve, reject) => {
          finish = () =>
            outcome === 'credited'
              ? resolve({ points: 10000, balance: 15000, amount: '1 USDT' })
              : reject(new ApiError(409, 'DEPOSIT_ALREADY_CREDITED', 'Already credited.', false))
        })
      }
      await mount()
      await act(async () =>
        renderer?.root.findByType('input').props.onChange({ target: { value: hash } }),
      )
      await act(async () => {
        void renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} })
      })
      if (refresh === 'new rail')
        api.treasury = async () => ({
          ...mainnet,
          chainId: 97,
          decimals: 6,
          finality: 'confirmations',
          token: `0x${'33'.repeat(20)}`,
        })
      if (refresh === 'balance failure')
        api.credits = async () => {
          throw new Error('Balance temporarily unavailable.')
        }
      if (refresh === 'configuration failure')
        api.treasury = async () => {
          throw new Error('Payment details temporarily unavailable.')
        }
      await act(async () => button('Refresh balance')?.props.onClick())
      if (refresh === 'new rail') {
        assert.match(rendered(), /Verify a testnet deposit/)
        assert.equal(renderer?.root.findByType('input').props.value, '')
      } else assert.equal(renderer?.root.findAllByType('form').length, 0)
      assert.doesNotMatch(rendered(), /Payment credited/)
      await act(async () => finish())
      assert.match(rendered(), /Payment credited/)
      assert.match(
        rendered(),
        outcome === 'credited' ? /10,000 points added/ : /This payment was already credited/,
      )
      const receipt = renderer?.root
        .findAllByType('section')
        .find((node) => node.props['aria-labelledby'] === 'credit-receipt-title')
      assert.ok(receipt)
      assert.equal(receipt.findByType('code').children.join(''), hash)
      assert.equal(receipt.findByType('a').props.href, `https://bscscan.com/tx/${hash}`)
      assert.match(
        JSON.stringify(receipt.findAllByType('p').map((node) => node.children)),
        /BNB Smart Chain Mainnet/,
      )
      assert.equal(deposits, 1)
    })
  }
}

test('wallet invalidation clears a confirmed receipt and its transaction hash', async () => {
  api.credits = async () => balance
  api.treasury = async () => mainnet
  api.depositCredits = async () => ({ points: 10000, balance: 15000, amount: '1 USDT' })
  await mount()
  await act(async () =>
    renderer?.root.findByType('input').props.onChange({ target: { value: hash } }),
  )
  await act(async () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.match(rendered(), /10,000 points added/)
  await act(async () => {
    invalidateWalletSession()
  })
  assert.doesNotMatch(rendered(), /10,000 points added/)
  assert.doesNotMatch(rendered(), new RegExp(hash))
})

test('late payment response cannot publish a receipt after the wallet session changes', async () => {
  api.credits = async () => balance
  api.treasury = async () => mainnet
  let complete: (value: Awaited<ReturnType<typeof api.depositCredits>>) => void = () => {}
  api.depositCredits = async () =>
    new Promise((resolve) => {
      complete = resolve
    })
  await mount()
  await act(async () =>
    renderer?.root.findByType('input').props.onChange({ target: { value: hash } }),
  )
  await act(async () => {
    void renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} })
  })
  await act(async () => {
    invalidateWalletSession()
  })
  await act(async () => complete({ points: 10000, balance: 15000, amount: '1 USDT' }))
  assert.doesNotMatch(rendered(), /10,000 points added/)
  assert.doesNotMatch(rendered(), new RegExp(hash))
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
