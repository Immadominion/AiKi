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

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** One voice for the three connect outcomes, wherever the button lives. */
export const CONNECT_TOAST: Record<'injected' | 'simulated' | 'rejected', string> = {
  injected: 'Wallet connected. AiKi can read your balances; it still cannot move anything.',
  simulated: 'No wallet extension found, so this is a simulated wallet. Every screen says so.',
  rejected: 'The wallet declined the connection. Nothing was connected.',
}
