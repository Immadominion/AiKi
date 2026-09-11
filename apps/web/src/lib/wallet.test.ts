import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, test } from 'node:test'
import { act, createElement, useState } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { ToastProvider, useToast } from '../components/ui/Toast'
import { MockProvider, useMock } from '../mock/store'
import { EMPTY } from '../mock/types'
import { api } from './api'
import {
  CONNECT_TOAST,
  connectInjected,
  discoverWallets,
  restoreWalletSession,
  selectWallet,
  signIn,
  signOut,
  type WalletOption,
  watchAccounts,
} from './wallet'
import { acceptWalletSession, invalidateWalletSession, walletSession } from './wallet-session'

const A = '0x16240f6655f5f9e0a4965a27f857e59c4922255a'
const B = '0x1111111111111111111111111111111111111111'
const originalFetch = globalThis.fetch
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
)
const storage = new Map<string, string>()
const browser = Object.assign(new EventTarget(), {
  location: { host: 'www.useaiki.xyz', origin: 'https://www.useaiki.xyz' },
})
Object.defineProperty(globalThis, 'window', { value: browser, configurable: true })
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
  configurable: true,
})
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
let renderer: ReactTestRenderer | undefined
let mounted: ReturnType<typeof useMock>
let notify: ReturnType<typeof useToast>
let privateDraft: string
let changePrivateDraft: (value: string) => void

function AccountProbe() {
  mounted = useMock()
  notify = useToast()
  const [draft, setDraft] = useState('')
  privateDraft = draft
  changePrivateDraft = setDraft
  return createElement('output', null, mounted.ready ? 'ready' : 'loading')
}

async function mountAccount() {
  await act(async () => {
    renderer = create(
      createElement(
        ToastProvider,
        null,
        createElement(MockProvider, null, createElement(AccountProbe)),
      ),
    )
  })
}

function saveAccount(address = A) {
  storage.set(
    'aiki.mock.v1',
    JSON.stringify({ ...EMPTY, connected: true, walletKind: 'injected', address, chainId: 56 }),
  )
}

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  globalThis.fetch = originalFetch
  invalidateWalletSession()
  storage.clear()
  Reflect.deleteProperty(browser, 'ethereum')
})
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  if (originalActEnvironment)
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment)
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

function wallet(name: string, address = A) {
  const calls: string[] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const state = {
    address,
    chainId: 56,
    rejectConnection: false,
    requestAccounts: null as null | (() => Promise<string[]>),
    sign: async () => '0x1234',
  }
  const option: WalletOption = {
    uuid: name,
    name,
    rdns: `test.${name}`,
    icon: '',
    provider: {
      request: async ({ method }) => {
        calls.push(method)
        if (method === 'eth_requestAccounts' && state.rejectConnection)
          throw new Error('User rejected connection')
        if (method === 'eth_requestAccounts')
          return state.requestAccounts ? state.requestAccounts() : [state.address]
        if (method === 'eth_accounts') return [state.address]
        if (method === 'eth_chainId') return `0x${state.chainId.toString(16)}`
        if (method === 'personal_sign') return state.sign()
        return null
      },
      on: (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event)?.add(handler)
      },
      removeListener: (event, handler) => {
        listeners.get(event)?.delete(handler)
      },
    },
  }
  return {
    option,
    calls,
    state,
    emit: (event: string, payload: unknown) => {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
  }
}

function authServer(address = A) {
  const calls: {
    path: string
    credentials: RequestCredentials | undefined
    walletAddress: string | null
  }[] = []
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    calls.push({
      path,
      credentials: init?.credentials,
      walletAddress: new Headers(init?.headers).get('x-aiki-wallet-address'),
    })
    if (path.endsWith('/nonce')) return Response.json({ nonce: 'testnonce12345678' })
    if (path.endsWith('/logout')) return Response.json({ ok: true })
    return Response.json({ address, chainId: 56 })
  }
  return calls
}

test('no injected wallet returns no_wallet, never a simulated address', async () => {
  assert.deepEqual(await connectInjected(), { kind: 'no_wallet' })
})

test('no-wallet connection during bootstrap still finishes loading', async () => {
  let finishLogout: ((response: Response) => void) | undefined
  let first = true
  globalThis.fetch = async () => {
    if (first) {
      first = false
      return new Promise((resolve) => {
        finishLogout = resolve
      })
    }
    return Response.json({ ok: true })
  }
  await mountAccount()
  assert.equal(mounted.ready, false)
  await act(async () => {
    assert.equal(await mounted.connect(), 'no_wallet')
  })
  await act(async () => {
    finishLogout?.(Response.json({ ok: true }))
  })
  assert.equal(mounted.ready, true)
  assert.equal(mounted.state.connected, false)
})

test('mounted restoration waits for the saved EIP-6963 wallet without erasing it', async () => {
  const metamask = wallet('MetaMask')
  const fallback = wallet('Other wallet', '')
  Object.assign(browser, { ethereum: fallback.option.provider })
  storage.set('aiki.wallet.provider', metamask.option.rdns)
  saveAccount()
  const saved = storage.get('aiki.mock.v1')
  const calls = authServer()
  await mountAccount()
  assert.equal(mounted.ready, true)
  assert.equal(mounted.authenticated, false)
  assert.equal(storage.get('aiki.mock.v1'), saved)
  assert.deepEqual(fallback.calls, [])
  assert.equal(calls.length, 0)

  await act(async () => {
    const { provider, ...info } = metamask.option
    browser.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: { info, provider } }),
    )
  })
  assert.equal(mounted.state.address, A)
  assert.equal(mounted.authenticated, true)
  assert.equal(mounted.ready, true)
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/v1/auth/me'],
  )
})

for (const changed of ['account', 'chain'] as const) {
  test(`mounted ${changed} change during session restoration still finishes loading`, async () => {
    const selected = wallet('MetaMask')
    selectWallet(selected.option)
    saveAccount()
    let finishRestore: ((response: Response) => void) | undefined
    globalThis.fetch = async (input) =>
      String(input).endsWith('/me')
        ? new Promise((resolve) => {
            finishRestore = resolve
          })
        : Response.json({ ok: true })
    await mountAccount()
    assert.ok(finishRestore)
    assert.equal(mounted.ready, false)
    await act(async () => {
      changePrivateDraft('Private work for wallet A')
    })

    await act(async () => {
      if (changed === 'account') {
        selected.state.address = B
        selected.emit('accountsChanged', [B])
      } else {
        selected.state.chainId = 97
        selected.emit('chainChanged', '0x61')
      }
      finishRestore?.(Response.json({ address: A, chainId: 56 }))
    })
    assert.equal(mounted.ready, true)
    assert.equal(mounted.authenticated, false)
    assert.equal(mounted.state.address, changed === 'account' ? B : A)
    assert.equal(mounted.state.chainId, changed === 'chain' ? 97 : 56)
    assert.equal(privateDraft, '')
  })
}

test('declining a connection during bootstrap still finishes loading', async () => {
  const selected = wallet('MetaMask')
  selected.state.rejectConnection = true
  selectWallet(selected.option)
  let finishLogout: ((response: Response) => void) | undefined
  let first = true
  globalThis.fetch = async () => {
    if (first) {
      first = false
      return new Promise((resolve) => {
        finishLogout = resolve
      })
    }
    return Response.json({ ok: true })
  }
  await mountAccount()
  await act(async () => {
    assert.equal(await mounted.connect(), 'rejected')
  })
  await act(async () => {
    finishLogout?.(Response.json({ ok: true }))
  })
  assert.equal(mounted.ready, true)
  assert.equal(mounted.authenticated, false)
})

test('connection progress is shared and duplicate triggers join the same wallet handoff', async () => {
  const selected = wallet('MetaMask')
  let finishSignature: ((signature: string) => void) | undefined
  selected.state.sign = () =>
    new Promise((resolve) => {
      finishSignature = resolve
    })
  selectWallet(selected.option)
  authServer()
  await mountAccount()

  let first: Promise<unknown> | undefined
  let second: Promise<unknown> | undefined
  await act(async () => {
    first = mounted.connect()
    second = mounted.connect()
    await Promise.resolve()
    await Promise.resolve()
  })

  assert.equal(first, second)
  assert.equal(mounted.connectionPhase, 'signing')
  assert.equal(selected.calls.filter((method) => method === 'eth_requestAccounts').length, 1)
  assert.equal(selected.calls.filter((method) => method === 'personal_sign').length, 1)

  await act(async () => {
    finishSignature?.('0x1234')
    assert.equal(await first, 'injected')
  })
  assert.equal(mounted.connectionPhase, 'idle')
})

test('disconnect releases a stalled signature so another wallet can connect', async () => {
  const firstWallet = wallet('First wallet')
  let finishFirstSignature: ((signature: string) => void) | undefined
  firstWallet.state.sign = () =>
    new Promise((resolve) => {
      finishFirstSignature = resolve
    })
  selectWallet(firstWallet.option)
  authServer()
  await mountAccount()

  let firstConnection: Promise<unknown> | undefined
  await act(async () => {
    firstConnection = mounted.connect()
    await Promise.resolve()
    await Promise.resolve()
  })
  assert.equal(mounted.connectionPhase, 'signing')

  const secondWallet = wallet('Second wallet')
  await act(async () => {
    mounted.disconnect()
    selectWallet(secondWallet.option)
  })
  await act(async () => {
    assert.equal(await mounted.connect(), 'injected')
  })
  assert.equal(mounted.authenticated, true)
  assert.equal(mounted.connectionPhase, 'idle')

  await act(async () => {
    finishFirstSignature?.('0x1234')
    assert.equal(await firstConnection, 'unsigned')
  })
  assert.equal(mounted.authenticated, true)
  assert.equal(mounted.connectionPhase, 'idle')
  assert.equal(secondWallet.calls.filter((method) => method === 'personal_sign').length, 1)
})

test('an old connection prompt cannot cancel a newer wallet handoff', async () => {
  const firstWallet = wallet('First wallet')
  let finishFirstAccounts: ((accounts: string[]) => void) | undefined
  firstWallet.state.requestAccounts = () =>
    new Promise((resolve) => {
      finishFirstAccounts = resolve
    })
  selectWallet(firstWallet.option)
  authServer()
  await mountAccount()

  let firstConnection: Promise<unknown> | undefined
  await act(async () => {
    firstConnection = mounted.connect()
    await Promise.resolve()
  })
  assert.equal(mounted.connectionPhase, 'connecting')

  const secondWallet = wallet('Second wallet')
  let finishSecondAccounts: ((accounts: string[]) => void) | undefined
  secondWallet.state.requestAccounts = () =>
    new Promise((resolve) => {
      finishSecondAccounts = resolve
    })
  await act(async () => {
    mounted.disconnect()
    selectWallet(secondWallet.option)
  })

  let secondConnection: Promise<unknown> | undefined
  await act(async () => {
    secondConnection = mounted.connect()
    await Promise.resolve()
  })
  assert.equal(mounted.connectionPhase, 'connecting')

  await act(async () => {
    finishFirstAccounts?.([firstWallet.state.address])
    assert.equal(await firstConnection, 'unsigned')
  })
  assert.equal(mounted.connectionPhase, 'connecting')

  await act(async () => {
    finishSecondAccounts?.([secondWallet.state.address])
    assert.equal(await secondConnection, 'injected')
  })
  assert.equal(mounted.authenticated, true)
  assert.equal(mounted.connectionPhase, 'idle')
})

for (const outcome of ['injected', 'unsigned'] as const) {
  test(`${outcome} connection notification survives the private-state remount`, async () => {
    // Guard the actual layout wiring as well as the mounted provider behavior below.
    const layout = readFileSync(new URL('../app/(app)/layout.tsx', import.meta.url), 'utf8')
    assert.match(layout, /<ToastProvider>\s*<MockProvider>/)
    const selected = wallet('MetaMask')
    if (outcome === 'unsigned')
      selected.state.sign = async () => {
        throw new Error('User rejected')
      }
    selectWallet(selected.option)
    authServer()
    await mountAccount()
    const originalNotify = notify
    const connect = mounted.connect
    await act(async () => {
      const result = await connect()
      assert.equal(result, outcome)
      originalNotify(CONNECT_TOAST[result])
    })
    assert.equal(mounted.authenticated, outcome === 'injected')
    assert.equal(notify, originalNotify)
    assert.ok(JSON.stringify(renderer?.toJSON()).includes(CONNECT_TOAST[outcome]))
  })
}

test('EIP-6963 selection directs connection, signing and listeners to the chosen wallet', async () => {
  const phantom = wallet('Phantom', B)
  const metamask = wallet('MetaMask')
  const discovered: WalletOption[][] = []
  const stopDiscovery = discoverWallets((options) => discovered.push(options))
  for (const item of [phantom, metamask]) {
    const { provider, ...info } = item.option
    browser.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: { info, provider } }),
    )
  }
  assert.deepEqual(
    discovered.at(-1)?.map((item) => item.name),
    ['Phantom', 'MetaMask'],
  )
  selectWallet(phantom.option)
  const changed: string[][] = []
  const stopAccounts = watchAccounts((accounts) => changed.push(accounts))
  selectWallet(metamask.option)
  phantom.emit('accountsChanged', [B])
  metamask.emit('accountsChanged', [A])
  assert.deepEqual(changed, [[A]])
  assert.deepEqual(await connectInjected(), { kind: 'connected', address: A, chainId: 56 })
  authServer()
  assert.equal(await signIn(A, 56), 'signed-in')
  assert.ok(metamask.calls.includes('personal_sign'))
  assert.deepEqual(phantom.calls, [])
  stopAccounts()
  stopDiscovery()
})

test('provider disconnect and chain changes are observed on the chosen wallet', () => {
  const selected = wallet('MetaMask')
  selectWallet(selected.option)
  const accounts: string[][] = []
  const chains: number[] = []
  const stop = watchAccounts(
    (value) => accounts.push(value),
    (value) => chains.push(value),
  )
  selected.emit('chainChanged', '0x61')
  selected.emit('disconnect', {})
  assert.deepEqual(chains, [97])
  assert.deepEqual(accounts, [[]])
  stop()
  selected.emit('accountsChanged', [B])
  assert.equal(accounts.length, 1)
})

test('account changes stop attaching old cookies before server logout completes', async () => {
  acceptWalletSession(A, invalidateWalletSession())
  const before = walletSession()
  const calls = authServer()
  await api.me()
  invalidateWalletSession()
  await api.me()
  assert.equal(before.signal.aborted, true)
  assert.deepEqual(
    calls.map((call) => call.credentials),
    ['include', 'omit'],
  )
  assert.deepEqual(
    calls.map((call) => call.walletAddress),
    [A, null],
  )
  assert.equal(acceptWalletSession(A, before.revision), false)
})

test('late API responses from the previous wallet are discarded', async () => {
  acceptWalletSession(A, invalidateWalletSession())
  let respond: ((response: Response) => void) | undefined
  globalThis.fetch = () =>
    new Promise((resolve) => {
      respond = resolve
    })
  const request = api.me()
  invalidateWalletSession()
  respond?.(Response.json({ address: A, chainId: 56 }))
  await assert.rejects(request, /wallet changed/i)
})

test('stored sessions restore only when their wallet and chain match', async () => {
  const calls = authServer(A.toUpperCase())
  assert.equal(await restoreWalletSession(A, 56), true)
  assert.equal(walletSession().address, A)
  assert.equal(await restoreWalletSession(B, 56), false)
  assert.equal(walletSession().address, null)
  assert.equal(calls.at(-1)?.path, '/v1/auth/logout')
  assert.equal(await restoreWalletSession(A, 97), false)
})

test('declining sign-in removes the old authenticated wallet', async () => {
  const selected = wallet('MetaMask')
  selected.state.sign = async () => {
    throw new Error('User rejected')
  }
  selectWallet(selected.option)
  acceptWalletSession(B, invalidateWalletSession())
  const calls = authServer()
  assert.equal(await signIn(A, 56), 'declined')
  assert.equal(walletSession().address, null)
  assert.equal(
    calls.some((call) => call.path.endsWith('/verify')),
    false,
  )
})

test('an account changed during the signature prompt cannot authenticate the old account', async () => {
  const selected = wallet('MetaMask')
  selected.state.sign = async () => {
    selected.state.address = B
    return '0x1234'
  }
  selectWallet(selected.option)
  const calls = authServer()
  assert.equal(await signIn(A, 56), 'declined')
  assert.equal(walletSession().address, null)
  assert.equal(
    calls.some((call) => call.path.endsWith('/verify')),
    false,
  )
})

test('logout wins when verification is already in flight', async () => {
  selectWallet(wallet('MetaMask').option)
  const paths: string[] = []
  let finishVerify: ((response: Response) => void) | undefined
  let startedVerify: (() => void) | undefined
  const verifying = new Promise<void>((resolve) => {
    startedVerify = resolve
  })
  globalThis.fetch = async (input) => {
    const path = String(input)
    paths.push(path)
    if (path.endsWith('/nonce')) return Response.json({ nonce: 'testnonce12345678' })
    if (path.endsWith('/verify')) {
      startedVerify?.()
      return new Promise((resolve) => {
        finishVerify = resolve
      })
    }
    return Response.json({ ok: true })
  }
  const signing = signIn(A, 56)
  await verifying
  const logout = signOut()
  assert.equal(walletSession().address, null)
  finishVerify?.(Response.json({ address: A, chainId: 56 }))
  assert.equal(await signing, 'declined')
  await logout
  assert.equal(paths.at(-1), '/v1/auth/logout')
  assert.equal(walletSession().address, null)
})

test('unauthenticated API errors explain the sign-in requirement', async () => {
  globalThis.fetch = async () =>
    Response.json({ error: { message: 'No valid session.' } }, { status: 401 })
  await assert.rejects(api.me(), /Sign in with your connected wallet to continue/)
})

test('an expired server session clears the authenticated wallet locally', async () => {
  acceptWalletSession(A, invalidateWalletSession())
  globalThis.fetch = async () => Response.json({}, { status: 401 })
  await assert.rejects(api.me(), /Sign in/)
  assert.equal(walletSession().address, null)
})
