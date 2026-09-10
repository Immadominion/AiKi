import { getAddress } from 'viem'
import { createSiweMessage } from 'viem/siwe'
import {
  acceptWalletSession,
  invalidateWalletSession,
  isWalletSessionCurrent,
  walletSession,
} from './wallet-session'

/**
 * The thinnest possible bridge to an injected EIP-1193 wallet.
 *
 * No SDK: connecting and watching accounts needs four requests, and every
 * dependency here would outweigh the code. Missing extensions leave the app
 * disconnected; fixture wallets are available only through the development panel.
 */
export const BSC_CHAIN_ID = 56

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, handler: (payload: unknown) => void): void
  removeListener?(event: string, handler: (payload: unknown) => void): void
}

export interface WalletOption {
  uuid: string
  name: string
  rdns: string
  icon: string
  provider: Eip1193Provider
}

const PROVIDER_KEY = 'aiki.wallet.provider'
const PROVIDER_CHANGED = 'aiki:wallet-provider-changed'
let selectedProvider: Eip1193Provider | null = null

export function selectWallet(wallet: WalletOption) {
  selectedProvider = wallet.provider
  try {
    localStorage.setItem(PROVIDER_KEY, wallet.rdns)
  } catch {
    /* The wallet selection still works without browser storage. */
  }
  window.dispatchEvent(new Event(PROVIDER_CHANGED))
}

/** EIP-6963 announcements distinguish extensions that share window.ethereum. */
export function discoverWallets(onChange: (wallets: WalletOption[]) => void) {
  const wallets = new Map<string, WalletOption>()
  let preferred: string | null = null
  try {
    preferred = localStorage.getItem(PROVIDER_KEY)
  } catch {
    /* No saved preference. */
  }
  const announce = (event: Event) => {
    const detail = (event as CustomEvent).detail as {
      info?: Omit<WalletOption, 'provider'>
      provider?: Eip1193Provider
    }
    if (
      !detail?.info?.uuid ||
      !detail.info.name ||
      typeof detail.provider?.request !== 'function'
    ) {
      return
    }
    const wallet = { ...detail.info, provider: detail.provider }
    wallets.set(wallet.uuid, wallet)
    if (!selectedProvider && preferred === wallet.rdns) selectWallet(wallet)
    onChange([...wallets.values()])
  }
  window.addEventListener('eip6963:announceProvider', announce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  return () => window.removeEventListener('eip6963:announceProvider', announce)
}

const provider = (): Eip1193Provider | null => {
  if (typeof window === 'undefined') return null
  if (selectedProvider) return selectedProvider
  const injected = (window as { ethereum?: Eip1193Provider }).ethereum
  return injected ?? null
}

export const hasInjectedWallet = () => provider() !== null

/** A saved EIP-6963 choice must arrive before restoration can use a provider. */
export function walletReadyForRestore(wallets: WalletOption[]) {
  if (selectedProvider) return true
  try {
    const preferred = localStorage.getItem(PROVIDER_KEY)
    return !preferred || wallets.some((wallet) => wallet.rdns === preferred)
  } catch {
    return true
  }
}

/** Read permission already granted to this origin without opening a wallet prompt. */
export async function readInjectedAccount() {
  const eth = provider()
  if (!eth) return null
  try {
    const accounts = (await eth.request({ method: 'eth_accounts' })) as string[]
    const address = accounts[0]
    if (!address) return null
    const chainHex = (await eth.request({ method: 'eth_chainId' })) as string
    return { address, chainId: Number.parseInt(chainHex, 16) }
  } catch {
    return null
  }
}

export type ConnectResult =
  | { kind: 'connected'; address: string; chainId: number }
  | { kind: 'no_wallet' }
  | { kind: 'rejected' }

export async function connectInjected(): Promise<ConnectResult> {
  const eth = provider()
  if (!eth) return { kind: 'no_wallet' }
  try {
    const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
    const address = accounts[0]
    if (!address) return { kind: 'rejected' }
    // BNB Chain is where the registry lives; ask once, tolerate a refusal.
    try {
      await eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${BSC_CHAIN_ID.toString(16)}` }],
      })
    } catch {
      /* staying on another chain is the user's call; we record what it is */
    }
    const active = await readInjectedAccount()
    return active ? { kind: 'connected', ...active } : { kind: 'rejected' }
  } catch {
    return { kind: 'rejected' }
  }
}

/** Fires with the new address list on every account change; [] means locked. */
export function watchAccounts(
  onChange: (accounts: string[]) => void,
  onChainChange?: (chainId: number) => void,
): () => void {
  const handler = (payload: unknown) =>
    onChange(Array.isArray(payload) ? (payload as string[]) : [])
  let eth: Eip1193Provider | null = null
  const disconnect = () => onChange([])
  const chain = (payload: unknown) => {
    if (typeof payload !== 'string') return
    const chainId = Number.parseInt(payload, 16)
    if (Number.isFinite(chainId)) onChainChange?.(chainId)
  }
  const detach = () => {
    eth?.removeListener?.('accountsChanged', handler)
    eth?.removeListener?.('disconnect', disconnect)
    eth?.removeListener?.('chainChanged', chain)
  }
  const attach = () => {
    detach()
    eth = provider()
    eth?.on?.('accountsChanged', handler)
    eth?.on?.('disconnect', disconnect)
    eth?.on?.('chainChanged', chain)
  }
  attach()
  window.addEventListener(PROVIDER_CHANGED, attach)
  return () => {
    detach()
    window.removeEventListener(PROVIDER_CHANGED, attach)
  }
}

/**
 * Empty means this origin, which is how it is deployed: the app proxies /v1 to
 * the API so the session cookie is same-origin. Local development points at the
 * dev API on another port instead.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? ''

// Cookie writes are ordered so an old verification response cannot undo logout.
let cookieWrite: Promise<unknown> = Promise.resolve()
function writeSessionCookie<T>(write: () => Promise<T>): Promise<T> {
  const result = cookieWrite.then(write, write)
  cookieWrite = result.catch(() => {})
  return result
}

function clearSessionCookie() {
  return writeSessionCookie(() =>
    fetch(`${API}/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      signal: AbortSignal.timeout(15_000),
    }).then(() => {}),
  )
}

export async function restoreWalletSession(address: string, chainId: number) {
  const revision = invalidateWalletSession()
  try {
    await cookieWrite
    const response = await fetch(`${API}/v1/auth/me`, {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    const session = response.ok
      ? ((await response.json()) as { address?: string; chainId?: number })
      : null
    if (!isWalletSessionCurrent(revision)) return false
    if (session?.address?.toLowerCase() === address.toLowerCase() && session.chainId === chainId) {
      return acceptWalletSession(address, revision)
    }
  } catch {
    if (!isWalletSessionCurrent(revision)) return false
  }
  await signOut()
  return false
}

/**
 * Proving the address, not just reading it.
 *
 * Connecting shows AiKi which address you hold. Signing in proves you control
 * it, which is what every mandate route requires: without this step the API
 * would be taking a caller's word for whose money it is about to limit.
 */
export async function signIn(address: string, chainId: number): Promise<'signed-in' | 'declined'> {
  const revision = invalidateWalletSession()
  const eth = provider()
  if (!eth) return 'declined'
  try {
    await clearSessionCookie()
    if (!isWalletSessionCurrent(revision)) return 'declined'
    const response = await fetch(`${API}/v1/auth/nonce`, {
      method: 'POST',
      credentials: 'include',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return 'declined'
    const { nonce } = (await response.json()) as { nonce: string }
    if (!isWalletSessionCurrent(revision)) return 'declined'

    // getAddress applies EIP-55 checksumming, which EIP-4361 requires and wallets
    // return without; createSiweMessage builds the rest to spec, so the exact
    // bytes the wallet shows are the bytes the server re-parses.
    const message = createSiweMessage({
      domain: window.location.host,
      address: getAddress(address),
      statement:
        'Sign in to AiKi. This proves you control this address. It grants no permission to move funds.',
      uri: window.location.origin,
      version: '1',
      chainId,
      nonce,
      issuedAt: new Date(),
    })

    let signature: string
    try {
      signature = (await eth.request({
        method: 'personal_sign',
        params: [message, address],
      })) as string
    } catch {
      return 'declined'
    }

    return await writeSessionCookie(async () => {
      if (!isWalletSessionCurrent(revision)) return 'declined'
      // The active account may have changed while the signature prompt was open.
      const active = await readInjectedAccount()
      if (
        !active ||
        active.address.toLowerCase() !== address.toLowerCase() ||
        active.chainId !== chainId ||
        !isWalletSessionCurrent(revision)
      )
        return 'declined'
      const verified = await fetch(`${API}/v1/auth/verify`, {
        method: 'POST',
        credentials: 'include',
        signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      })
      if (!verified.ok || !isWalletSessionCurrent(revision)) return 'declined'
      const session = (await verified.json()) as { address?: string; chainId?: number }
      return session.address?.toLowerCase() === address.toLowerCase() &&
        session.chainId === chainId &&
        acceptWalletSession(address, revision)
        ? 'signed-in'
        : 'declined'
    })
  } catch {
    return 'declined'
  }
}

export async function signOut() {
  invalidateWalletSession()
  await clearSessionCookie().catch(() => {})
}

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** One voice for the three connect outcomes, wherever the button lives. */
export const CONNECT_TOAST: Record<ConnectOutcome, string> = {
  injected:
    'Wallet connected and signed in. AiKi can read your balances; it still cannot move anything.',
  unsigned:
    'Wallet connected, but sign-in was not completed. Sign in to use Fast mode or hire an agent.',
  simulated: 'A development wallet is active. No real wallet is connected.',
  no_wallet:
    'No wallet found. Open AiKi in MetaMask or a browser with a wallet extension, then connect.',
  rejected: 'Wallet connection was not completed. Choose a wallet to try again.',
}

export type ConnectOutcome = 'injected' | 'unsigned' | 'simulated' | 'no_wallet' | 'rejected'

/**
 * Sign a mandate, in the wallet, with the wallet's own typed-data prompt.
 *
 * `personal_sign` above proves who you are; this authorises what an agent may
 * do with your money, and the two must look different to the person approving
 * them. `eth_signTypedData_v4` is what makes that possible: a wallet renders
 * the caveats as named fields rather than as a wall of hex, so somebody can read
 * the cap they are agreeing to before they agree to it.
 *
 * The typed data comes from the API, which computed it from the mandate already
 * stored and will verify the signature against the same bytes. Building it here
 * would put a second copy of that logic in the browser, free to drift, and then
 * a person would sign what their browser believed rather than what the chain
 * will hold.
 */
export async function signMandate(
  address: string,
  typedData: { domain: unknown; types: unknown; primaryType: string; message: unknown },
): Promise<`0x${string}` | 'declined'> {
  const eth = provider()
  if (!eth) return 'declined'
  try {
    const signature = (await eth.request({
      method: 'eth_signTypedData_v4',
      // Stringified, because that is what the method expects and several wallets
      // reject an object outright rather than saying why.
      params: [address, JSON.stringify(typedData)],
    })) as string
    return signature as `0x${string}`
  } catch {
    // Declining to sign is an ordinary answer and not an error. The caller
    // reports that nothing was authorised, which is exactly what happened.
    return 'declined'
  }
}

export interface ReviewedWalletTransaction {
  chainId: 56
  from: string
  to: string
  data: `0x${string}`
  value: '0'
}

export class WalletTransactionError extends Error {
  constructor(
    readonly code: 4001 | 'WALLET_CHANGED' | 'INVALID_TRANSACTION' | 'SUBMISSION_UNKNOWN',
    message: string,
    readonly mayHaveSubmitted: boolean,
  ) {
    super(message)
  }
}

/** One explicit owner transaction. A returned hash survives a wallet change so callers
 * can retain it for recovery; walletCurrent=false must discard private account UI. */
export async function sendWalletTransaction(
  owner: string,
  input: ReviewedWalletTransaction,
): Promise<{ transactionHash: `0x${string}`; walletCurrent: boolean }> {
  const transaction = structuredClone(input),
    session = walletSession(),
    eth = provider()
  const validAddress = (v: unknown): v is string =>
    typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v)
  if (
    !transaction ||
    Object.keys(transaction).sort().join(',') !== 'chainId,data,from,to,value' ||
    transaction.chainId !== 56 ||
    transaction.value !== '0' ||
    !validAddress(owner) ||
    !validAddress(transaction.from) ||
    !validAddress(transaction.to) ||
    transaction.from.toLowerCase() !== owner.toLowerCase() ||
    typeof transaction.data !== 'string' ||
    !/^0x(?:[0-9a-f]{2}){4,}$/i.test(transaction.data)
  )
    throw new WalletTransactionError(
      'INVALID_TRANSACTION',
      'This is not a reviewed BNB mainnet contract transaction.',
      false,
    )
  const current = async () => {
    if (!eth || provider() !== eth) return false
    const accounts = await eth.request({ method: 'eth_accounts' })
    const chain = await eth.request({ method: 'eth_chainId' })
    const active = walletSession()
    return (
      Array.isArray(accounts) &&
      typeof accounts[0] === 'string' &&
      accounts[0].toLowerCase() === owner.toLowerCase() &&
      chain === '0x38' &&
      provider() === eth &&
      active.revision === session.revision &&
      active.address === owner.toLowerCase()
    )
  }
  if (!(await current().catch(() => false)) || !eth)
    throw new WalletTransactionError(
      'WALLET_CHANGED',
      'Connect and sign in with the same wallet on BNB mainnet before continuing.',
      false,
    )
  let hash: unknown
  try {
    hash = await eth.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from: transaction.from,
          to: transaction.to,
          data: transaction.data,
          value: '0x0',
          chainId: '0x38',
        },
      ],
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 4001)
      throw new WalletTransactionError(
        4001,
        'You declined this transaction. Nothing was submitted by AiKi.',
        false,
      )
    throw new WalletTransactionError(
      'SUBMISSION_UNKNOWN',
      'The wallet did not return a transaction hash. Check its activity before trying again.',
      true,
    )
  }
  if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash) || /^0x0{64}$/i.test(hash))
    throw new WalletTransactionError(
      'SUBMISSION_UNKNOWN',
      'The wallet returned no verifiable transaction hash. Check its activity; do not send again.',
      true,
    )
  return {
    transactionHash: hash.toLowerCase() as `0x${string}`,
    walletCurrent: await current().catch(() => false),
  }
}
