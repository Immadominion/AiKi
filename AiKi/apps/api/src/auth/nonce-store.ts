import postgres from 'postgres'

/**
 * Nonces exist to make a signature usable exactly once.
 *
 * Consuming one must therefore be atomic: two requests replaying the same
 * signed message must not both find it unconsumed. Every implementation here
 * returns true to at most one caller per nonce.
 */
export interface NonceStore {
  issue(nonce: string, ttlSeconds: number): Promise<void>
  /** True only for the first caller with a live, unconsumed nonce. */
  consume(nonce: string): Promise<boolean>
}

export class InMemoryNonceStore implements NonceStore {
  private readonly live = new Map<string, number>()

  async issue(nonce: string, ttlSeconds: number) {
    this.live.set(nonce, Date.now() + ttlSeconds * 1000)
  }

  async consume(nonce: string) {
    const expiry = this.live.get(nonce)
    if (expiry === undefined) return false
    this.live.delete(nonce)
    if (expiry <= Date.now()) return false
    // Opportunistic sweep: without it an unbounded map is a slow memory leak.
    if (this.live.size > 10_000)
      for (const [key, at] of this.live) if (at <= Date.now()) this.live.delete(key)
    return true
  }
}

export class PostgresNonceStore implements NonceStore {
  private readonly sql: postgres.Sql

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 3 })
  }

  async issue(nonce: string, ttlSeconds: number) {
    await this.sql`
      INSERT INTO auth_nonces (nonce, issued_at, expires_at)
      VALUES (${nonce}, now(), now() + ${`${ttlSeconds} seconds`}::interval)
    `
  }

  // The UPDATE is the lock: only one transaction can move consumed_at from NULL,
  // so a replayed signature loses the race rather than passing twice.
  async consume(nonce: string) {
    const rows = await this.sql<{ nonce: string }[]>`
      UPDATE auth_nonces SET consumed_at = now()
      WHERE nonce = ${nonce} AND consumed_at IS NULL AND expires_at > now()
      RETURNING nonce
    `
    return rows.length === 1
  }

  /** Expired nonces are noise; nothing depends on keeping them. */
  async sweep() {
    await this.sql`DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 day'`
  }

  async close() {
    await this.sql.end()
  }
}
