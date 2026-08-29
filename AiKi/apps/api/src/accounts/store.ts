import postgres from 'postgres'

export interface MandateAccount {
  owner: string
  chainId: number
  address: `0x${string}`
  deployedTx: string
  createdAt: string
}

export interface AccountStore {
  find(owner: string, chainId: number): Promise<MandateAccount | null>
  /**
   * Record an account, or return the one already recorded.
   *
   * Not "insert": two requests racing to create an account for the same person
   * must not both win, or their mandates would be split across two accounts and
   * half their limits would sit against the wrong one. The primary key decides,
   * and the loser is handed the winner's account rather than an error.
   */
  claim(record: MandateAccount): Promise<MandateAccount>
}

const lower = (owner: string) => owner.toLowerCase()

export class InMemoryAccountStore implements AccountStore {
  private readonly rows = new Map<string, MandateAccount>()
  private key = (owner: string, chainId: number) => `${lower(owner)}:${chainId}`

  async find(owner: string, chainId: number) {
    return this.rows.get(this.key(owner, chainId)) ?? null
  }

  async claim(record: MandateAccount) {
    const key = this.key(record.owner, record.chainId)
    const held = this.rows.get(key)
    if (held) return held
    const stored = { ...record, owner: lower(record.owner) }
    this.rows.set(key, stored)
    return stored
  }
}

export class PostgresAccountStore implements AccountStore {
  private readonly sql: postgres.Sql
  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 4, idle_timeout: 20 })
  }

  async find(owner: string, chainId: number) {
    const rows = await this.sql<Row[]>`
      SELECT * FROM mandate_accounts WHERE owner = ${lower(owner)} AND chain_id = ${chainId}
    `
    const row = rows[0]
    return row ? toAccount(row) : null
  }

  async claim(record: MandateAccount) {
    // DO NOTHING then read back, rather than DO UPDATE: the first account
    // recorded for somebody is the one that stands, because their existing
    // mandates already point at it.
    await this.sql`
      INSERT INTO mandate_accounts (owner, chain_id, address, deployed_tx, created_at)
      VALUES (${lower(record.owner)}, ${record.chainId}, ${record.address}, ${record.deployedTx}, ${record.createdAt})
      ON CONFLICT (owner, chain_id) DO NOTHING
    `
    const found = await this.find(record.owner, record.chainId)
    if (!found) throw new Error('mandate account vanished immediately after being written')
    return found
  }

  async close() {
    await this.sql.end()
  }
}

interface Row {
  owner: string
  chain_id: number | string
  address: `0x${string}`
  deployed_tx: string
  created_at: string | Date
}

const toAccount = (row: Row): MandateAccount => ({
  owner: row.owner,
  // INTEGER has arrived as a string from this driver before, and a chain id read
  // as "97" never equals 97.
  chainId: Number(row.chain_id),
  address: row.address,
  deployedTx: row.deployed_tx,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
})
