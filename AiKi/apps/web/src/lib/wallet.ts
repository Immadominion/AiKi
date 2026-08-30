import { getAddress } from 'viem'
import { createSiweMessage } from 'viem/siwe'

/**
 * The thinnest possible bridge to an injected EIP-1193 wallet.
 *
 * No SDK: connecting and watching accounts needs four requests, and every
 * dependency here would outweigh the code. When no extension exists the app
 * falls back to a clearly-labelled simulated wallet rather than a dead button,
 * because a walkable demo beats a wall — but it never lets the simulation
 * pass as a connection.
 */
export const BSC_CHAIN_ID = 56

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, handler: (payload: unknown) => void): void
  removeListener?(event: string, handler: (payload: unknown) => void): void
}

const provider = (): Eip1193Provider | null => {
  if (typeof window === 'undefined') return null
  const injected = (window as { ethereum?: Eip1193Provider }).ethereum
  return injected ?? null
}

export const hasInjectedWallet = () => provider() !== null

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
    const chainHex = (await eth.request({ method: 'eth_chainId' })) as string
    return { kind: 'connected', address, chainId: Number.parseInt(chainHex, 16) }
  } catch {
    return { kind: 'rejected' }
  }
}

/** Fires with the new address list on every account change; [] means locked. */
export function watchAccounts(onChange: (accounts: string[]) => void): () => void {
  const eth = provider()
  if (!eth?.on) return () => {}
  const handler = (payload: unknown) =>
    onChange(Array.isArray(payload) ? (payload as string[]) : [])
  eth.on('accountsChanged', handler)
  return () => eth.removeListener?.('accountsChanged', handler)
}

/**
 * Empty means this origin, which is how it is deployed: the app proxies /v1 to
 * the API so the session cookie is same-origin. Local development points at the
 * dev API on another port instead.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? ''

/**
 * Proving the address, not just reading it.
 *
 * Connecting shows AiKi which address you hold. Signing in proves you control
 * it, which is what every mandate route requires: without this step the API
 * would be taking a caller's word for whose money it is about to limit.
 */
export async function signIn(address: string, chainId: number): Promise<'signed-in' | 'declined'> {
  const eth = provider()
  if (!eth) return 'declined'
  const { nonce } = (await (
    await fetch(`${API}/v1/auth/nonce`, { method: 'POST', credentials: 'include' })
  ).json()) as { nonce: string }

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

  const verified = await fetch(`${API}/v1/auth/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  })
  return verified.ok ? 'signed-in' : 'declined'
}

export async function signOut() {
  await fetch(`${API}/v1/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {})
}

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** One voice for the three connect outcomes, wherever the button lives. */
export const CONNECT_TOAST: Record<ConnectOutcome, string> = {
  injected:
    'Wallet connected and signed in. AiKi can read your balances; it still cannot move anything.',
  unsigned:
    'Wallet connected, but you did not finish signing in. You can browse; hiring an agent needs the signature.',
  simulated: 'No wallet extension found, so this is a simulated wallet. Every screen says so.',
  rejected: 'The wallet declined the connection. Nothing was connected.',
}

export type ConnectOutcome = 'injected' | 'unsigned' | 'simulated' | 'rejected'

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
