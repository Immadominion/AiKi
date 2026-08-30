import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Address, createPublicClient, formatEther, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { bscTestnet } from 'viem/chains'
import { createSiweMessage } from 'viem/siwe'
import type { AikiClient } from './client.js'

/**
 * Who the model is acting as.
 *
 * The hard part of putting a marketplace behind a language model is not the
 * tools, it is identity: a mandate belongs to somebody, and "somebody" has to
 * mean a key. Three ways to have one, in the order they are looked for:
 *
 *   1. AIKI_PRIVATE_KEY in the environment, for anyone who already has a key
 *      and knows what they are doing with it.
 *   2. A key this server generated earlier, kept at ~/.aiki/key.
 *   3. None, in which case every read still works and the first thing that
 *      needs an identity says exactly how to get one.
 *
 * Option 2 is the one worth explaining. Requiring a browser extension before a
 * model can do anything at all would put a wallet in the way of every first
 * conversation. Instead the model can make a key, tell the person the address,
 * and ask them to send it some testnet BNB — which is a sentence a person can
 * act on without knowing what a delegation is.
 *
 * The key is written 0600 and never leaves the machine. It is worth being blunt
 * in the docs about what it is: a real key, on a real chain, and the reason that
 * is defensible here is that it holds only what somebody deliberately sends it,
 * and everything it can authorise is bounded by caveats a contract enforces.
 */

const KEY_PATH = join(homedir(), '.aiki', 'key')

export interface Identity {
  account: ReturnType<typeof privateKeyToAccount>
  /** How the key was obtained, so the model can explain itself. */
  source: 'environment' | 'stored' | 'generated'
}

const read = (): Hex | null => {
  try {
    const value = readFileSync(KEY_PATH, 'utf8').trim()
    return /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as Hex) : null
  } catch {
    return null
  }
}

export function loadIdentity(): Identity | null {
  const fromEnv = process.env.AIKI_PRIVATE_KEY
  if (fromEnv && /^0x[0-9a-fA-F]{64}$/.test(fromEnv))
    return { account: privateKeyToAccount(fromEnv as Hex), source: 'environment' }
  const stored = read()
  return stored ? { account: privateKeyToAccount(stored), source: 'stored' } : null
}

/** Makes one and keeps it, or returns the one already kept. */
export function createIdentity(): Identity {
  const existing = loadIdentity()
  if (existing) return existing
  const key = generatePrivateKey()
  mkdirSync(dirname(KEY_PATH), { recursive: true, mode: 0o700 })
  writeFileSync(KEY_PATH, `${key}\n`, { mode: 0o600 })
  // Set again explicitly: writeFileSync only applies the mode when it creates
  // the file, and a key left world-readable by an earlier run is exactly the
  // failure this is guarding.
  chmodSync(KEY_PATH, 0o600)
  return { account: privateKeyToAccount(key), source: 'generated' }
}

export const keyLocation = KEY_PATH

export async function balanceOf(rpcUrl: string, address: Address): Promise<string> {
  const client = createPublicClient({ chain: bscTestnet, transport: http(rpcUrl) })
  return formatEther(await client.getBalance({ address }))
}

/**
 * Sign in, the same way the website does.
 *
 * There is no API-token path on purpose. A token would be a second way to be
 * somebody, with its own revocation story and its own way of going wrong, and
 * the product already has one that is proven: the account proves itself by
 * signing, exactly once, and everything after that is a session.
 */
export async function signIn(client: AikiClient, identity: Identity, domain: string) {
  const { nonce } = await client.post<{ nonce: string }>('/v1/auth/nonce')
  const message = createSiweMessage({
    address: identity.account.address,
    chainId: 97,
    domain,
    nonce,
    uri: `https://${domain}`,
    version: '1',
    statement: 'Sign in to AiKi.',
  })
  const signature = await identity.account.signMessage({ message })
  return client.post<{ address: string; chainId: number }>('/v1/auth/verify', {
    message,
    signature,
  })
}
