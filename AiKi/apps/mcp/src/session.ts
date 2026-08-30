import type { AikiClient } from './client.js'
import { type Identity, keyLocation, loadIdentity, signIn } from './identity.js'

/**
 * Being somebody, but only when something needs it.
 *
 * Sign-in is deferred rather than done at startup, for two reasons. A server
 * that authenticates on boot fails on boot when there is no key, and an MCP
 * server that fails on boot is one the client reports as broken rather than as
 * read-only — when in fact every discovery tool works perfectly well without a
 * key. And a session that is established lazily is established once, at the
 * moment it is first needed, rather than being refreshed on a timer nobody is
 * watching.
 */
export class NeedsIdentity extends Error {
  constructor() {
    super(
      'This needs an identity, and there is no key yet. Run create_wallet to make one — it stays ' +
        `on this machine at ${keyLocation} — or set AIKI_PRIVATE_KEY if you already have one. ` +
        'Reading the marketplace needs neither.',
    )
  }
}

export class Session {
  private identity: Identity | null = null

  constructor(
    private readonly client: AikiClient,
    private readonly domain: string,
  ) {}

  /** The identity, signing in first if this is the first time it is needed. */
  async require(): Promise<Identity> {
    if (this.identity && this.client.signedIn) return this.identity
    const identity = loadIdentity()
    if (!identity) throw new NeedsIdentity()
    await signIn(this.client, identity, this.domain)
    this.identity = identity
    return identity
  }

  /** Forces a fresh sign-in, for when a key has just been created. */
  reset() {
    this.identity = null
    this.client.forget()
  }
}
