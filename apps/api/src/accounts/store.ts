import postgres from 'postgres'
import type { Address, Hex } from 'viem'
import { type DeploymentAttempt, type DeploymentState, deploymentPending } from './attempts.js'

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
  beginDeployment(attempt: DeploymentAttempt): Promise<boolean>
  pendingDeployment(owner: string, chainId: number): Promise<DeploymentAttempt | null>
  recordDeploymentHash(id: string, hash: Hex, expectedAddress: Address): Promise<void>
  finishDeployment(id: string, state: 'REFUSED' | 'REVERTED' | 'UNCONFIRMED'): Promise<void>
  finalizeDeployment(attempt: DeploymentAttempt): Promise<MandateAccount>
}

const lower = (owner: string) => owner.toLowerCase()

export class InMemoryAccountStore implements AccountStore {
  private readonly rows = new Map<string, MandateAccount>()
  private readonly attempts = new Map<string, DeploymentAttempt>()
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

  async beginDeployment(attempt: DeploymentAttempt) {
    if (this.rows.has(this.key(attempt.owner, attempt.chainId))) return false
    if (
      [...this.attempts.values()].some(
        (entry) =>
          deploymentPending(entry.state) &&
          entry.chainId === attempt.chainId &&
          (entry.owner === attempt.owner || entry.funder === attempt.funder),
      )
    )
      return false
    this.attempts.set(attempt.id, { ...attempt })
    return true
  }

  async pendingDeployment(owner: string, chainId: number) {
    const found = [...this.attempts.values()].find(
      (entry) =>
        entry.owner === lower(owner) && entry.chainId === chainId && deploymentPending(entry.state),
    )
    return found ? { ...found } : null
  }

  async recordDeploymentHash(id: string, hash: Hex, expectedAddress: Address) {
    const attempt = this.attempts.get(id)
    if (
      !attempt ||
      !deploymentPending(attempt.state) ||
      (attempt.transactionHash &&
        (attempt.transactionHash !== hash || attempt.expectedAddress !== expectedAddress))
    )
      throw new Error('Deployment hash cannot be changed.')
    attempt.transactionHash = hash
    attempt.expectedAddress = expectedAddress
    attempt.state = 'SUBMITTED'
  }

  async finishDeployment(id: string, state: 'REFUSED' | 'REVERTED' | 'UNCONFIRMED') {
    const attempt = this.attempts.get(id)
    if (attempt && deploymentPending(attempt.state)) attempt.state = state
  }

  async finalizeDeployment(expected: DeploymentAttempt) {
    const attempt = this.attempts.get(expected.id)
    if (
      !attempt ||
      !sameDeployment(attempt, expected) ||
      (!deploymentPending(attempt.state) && attempt.state !== 'LANDED')
    )
      throw new Error('Deployment changed during verification.')
    const record = deploymentRecord(expected)
    const prior = this.rows.get(this.key(expected.owner, expected.chainId))
    if (
      prior &&
      (prior.address.toLowerCase() !== record.address ||
        prior.deployedTx.toLowerCase() !== record.deployedTx)
    )
      throw new Error('A different account is already recorded.')
    this.rows.set(this.key(expected.owner, expected.chainId), prior ?? record)
    attempt.state = 'LANDED'
    return prior ?? record
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

  async beginDeployment(attempt: DeploymentAttempt) {
    return this.sql.begin(async (tx) => {
      // Serialize this read/insert with finalization. Otherwise an INSERT can
      // read "no account", wait on the pending unique index while another
      // transaction finalizes, then insert a duplicate deployment after commit.
      await tx`SELECT pg_advisory_xact_lock(1095322442, ${attempt.chainId}::integer)`
      const rows = await tx`
        INSERT INTO account_deployment_attempts (id, owner, chain_id, funder, manager, state, created_at)
        SELECT ${attempt.id}, ${attempt.owner}, ${attempt.chainId}, ${attempt.funder}, ${attempt.manager}, 'PREPARING', ${attempt.createdAt}
        WHERE NOT EXISTS (SELECT 1 FROM mandate_accounts WHERE owner = ${attempt.owner} AND chain_id = ${attempt.chainId})
        ON CONFLICT DO NOTHING RETURNING id
      `
      return rows.length === 1
    })
  }

  async pendingDeployment(owner: string, chainId: number) {
    const rows = await this.sql<DeploymentRow[]>`
      SELECT * FROM account_deployment_attempts WHERE owner = ${lower(owner)} AND chain_id = ${chainId}
      AND state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED')
    `
    return rows[0] ? toDeployment(rows[0]) : null
  }

  async recordDeploymentHash(id: string, hash: Hex, expectedAddress: Address) {
    const rows = await this.sql`
      UPDATE account_deployment_attempts SET transaction_hash = ${hash}, expected_address = ${expectedAddress}, state = 'SUBMITTED', updated_at = now()
      WHERE id = ${id} AND state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED')
      AND (transaction_hash IS NULL OR (transaction_hash = ${hash} AND expected_address = ${expectedAddress}))
      RETURNING id
    `
    if (rows.length !== 1) throw new Error('Deployment hash cannot be changed.')
  }

  async finishDeployment(id: string, state: 'REFUSED' | 'REVERTED' | 'UNCONFIRMED') {
    await this.sql`
      UPDATE account_deployment_attempts SET state = ${state}, updated_at = now()
      WHERE id = ${id} AND state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED')
    `
  }

  async finalizeDeployment(expected: DeploymentAttempt) {
    const record = deploymentRecord(expected)
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(1095322442, ${expected.chainId}::integer)`
      const rows = await tx<
        DeploymentRow[]
      >`SELECT * FROM account_deployment_attempts WHERE id = ${expected.id} FOR UPDATE`
      const attempt = rows[0] ? toDeployment(rows[0]) : null
      if (
        !attempt ||
        !sameDeployment(attempt, expected) ||
        (!deploymentPending(attempt.state) && attempt.state !== 'LANDED')
      )
        throw new Error('Deployment changed during verification.')
      await tx`
        INSERT INTO mandate_accounts (owner, chain_id, address, deployed_tx, created_at)
        VALUES (${record.owner}, ${record.chainId}, ${record.address}, ${record.deployedTx}, ${record.createdAt})
        ON CONFLICT (owner, chain_id) DO NOTHING
      `
      const accounts = await tx<
        Row[]
      >`SELECT * FROM mandate_accounts WHERE owner = ${record.owner} AND chain_id = ${record.chainId}`
      const account = accounts[0] ? toAccount(accounts[0]) : null
      if (
        !account ||
        account.address.toLowerCase() !== record.address ||
        account.deployedTx.toLowerCase() !== record.deployedTx
      )
        throw new Error('A different account is already recorded.')
      await tx`UPDATE account_deployment_attempts SET state = 'LANDED', updated_at = now() WHERE id = ${expected.id}`
      return account
    })
  }
}

const sameDeployment = (a: DeploymentAttempt, b: DeploymentAttempt) =>
  a.owner === b.owner &&
  a.chainId === b.chainId &&
  a.funder === b.funder &&
  a.manager === b.manager &&
  a.transactionHash === b.transactionHash &&
  a.expectedAddress === b.expectedAddress

function deploymentRecord(attempt: DeploymentAttempt): MandateAccount {
  if (!attempt.transactionHash || !attempt.expectedAddress)
    throw new Error('Deployment identity is incomplete.')
  return {
    owner: attempt.owner,
    chainId: attempt.chainId,
    address: attempt.expectedAddress,
    deployedTx: attempt.transactionHash,
    createdAt: attempt.createdAt,
  }
}

interface DeploymentRow {
  id: string
  owner: Address
  chain_id: number
  funder: Address
  manager: Address
  state: DeploymentState
  transaction_hash: Hex | null
  expected_address: Address | null
  created_at: Date | string
}

const toDeployment = (row: DeploymentRow): DeploymentAttempt => ({
  id: row.id,
  owner: row.owner,
  chainId: Number(row.chain_id),
  funder: row.funder,
  manager: row.manager,
  state: row.state,
  ...(row.transaction_hash ? { transactionHash: row.transaction_hash } : {}),
  ...(row.expected_address ? { expectedAddress: row.expected_address } : {}),
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
})

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
