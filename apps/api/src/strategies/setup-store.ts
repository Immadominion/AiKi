import { randomUUID } from 'node:crypto'
import type { UnsignedDelegation } from '@aiki/contracts'
import type {
  PreparedStrategyDeployment,
  StrategyAuthorizationReview,
  StrategyBinding,
  StrategyWalletAction,
} from '@aiki/contracts/strategies'
import type postgres from 'postgres'
import { type Hex, keccak256, stringToHex } from 'viem'
import type { CompiledPolicy } from '../authority/policy.js'
import { ClientError } from '../http/errors.js'
import { nonzeroHash } from './operation.js'

export const setupJSON = (value: unknown): postgres.JSONValue =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  )
export const setupDigest = (value: unknown): Hex => {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, ordered(item)]),
          )
        : value
  return keccak256(stringToHex(JSON.stringify(setupJSON(ordered(value)))))
}
export const setupMissing = () =>
  new ClientError('No such strategy setup.', { statusCode: 404, code: 'NOT_FOUND' })
export const setupConflict = (
  message = 'Strategy setup changed. Refresh the reviewed state before continuing.',
) => new ClientError(message, { statusCode: 409, code: 'STRATEGY_SETUP_CHANGED' })

export interface StrategySetupRow {
  id: string
  owner: Hex
  idempotency_key: string
  request_digest: Hex
  prepared: PreparedStrategyDeployment
  gas_limit_wei: string
  binding: StrategyBinding | null
  unsigned_authority: UnsignedDelegation | null
  authority_review: StrategyAuthorizationReview | null
  compiled_policy: CompiledPolicy | null
  authority_digest: Hex | null
  authorization_id: string | null
  job_id: string | null
  watch_id: string | null
  signed_at: Date | null
  revision: string
  created_at: Date
  updated_at: Date
}
interface ActionRow {
  id: string
  setup_id: string
  request_digest: Hex
  kind: StrategyWalletAction['kind']
  transaction_data: StrategyWalletAction['transaction']
  review: StrategyWalletAction['review']
  state: StrategyWalletAction['status']
  transaction_hash: Hex | null
  receipt_block: string | null
  receipt_hash: Hex | null
}
const actionView = (row: ActionRow): StrategyWalletAction => ({
  id: row.id,
  kind: row.kind,
  status: row.state,
  transaction: row.transaction_data,
  review: row.review,
  transactionHash: row.transaction_hash,
})

/** Owner-scoped records only. Wallet requests are data; this store never sends one. */
export class PostgresStrategySetupStore {
  constructor(private readonly sql: postgres.Sql) {}

  async get(id: string, owner: Hex): Promise<StrategySetupRow> {
    const [row] = await this.sql<
      StrategySetupRow[]
    >`SELECT * FROM strategy_setups WHERE id=${id} AND owner=${owner.toLowerCase()}`
    if (!row) throw setupMissing()
    return row
  }
  async list(owner: Hex): Promise<StrategySetupRow[]> {
    return this.sql<
      StrategySetupRow[]
    >`SELECT * FROM strategy_setups WHERE owner=${owner.toLowerCase()} ORDER BY created_at DESC,id DESC LIMIT 100`
  }
  async byKey(owner: Hex, key: string): Promise<StrategySetupRow | null> {
    const [row] = await this.sql<
      StrategySetupRow[]
    >`SELECT * FROM strategy_setups WHERE owner=${owner.toLowerCase()} AND idempotency_key=${key}`
    return row ?? null
  }
  async authority(
    id: string,
    owner: Hex,
  ): Promise<{ delegation: unknown; status: string; expiresAt: Date | null } | null> {
    const [row] = await this.sql<
      { delegation: unknown; status: string; expires_at: Date | null }[]
    >`SELECT a.delegation,a.status,a.expires_at FROM strategy_setups s
      JOIN authorizations a ON a.id=s.authorization_id WHERE s.id=${id} AND s.owner=${owner.toLowerCase()} AND a.owner=s.owner`
    return row
      ? { delegation: row.delegation, status: row.status, expiresAt: row.expires_at }
      : null
  }
  async pendingAttempts(id: string, owner: Hex): Promise<string[]> {
    return (
      await this.sql<
        { id: string }[]
      >`SELECT e.id FROM execution_attempts e JOIN strategy_setups s ON s.authorization_id=e.authorization_id
      WHERE s.id=${id} AND s.owner=${owner.toLowerCase()} AND e.purpose='strategy' AND e.state IN ('PREPARING','SUBMITTED','UNCONFIRMED') LIMIT 10`
    ).map((row) => row.id)
  }
  async transaction<T>(
    id: string,
    owner: Hex,
    work: (tx: postgres.TransactionSql, row: StrategySetupRow) => Promise<T>,
  ): Promise<T> {
    // postgres' generic UnwrapPromiseArray wrapper does not change a scalar transaction result.
    return (await this.sql.begin(async (tx) => {
      const [row] = await tx<
        StrategySetupRow[]
      >`SELECT * FROM strategy_setups WHERE id=${id} AND owner=${owner.toLowerCase()} FOR UPDATE`
      if (!row) throw setupMissing()
      return work(tx, row)
    })) as T
  }
  async create(input: {
    owner: Hex
    key: string
    digest: Hex
    prepared: PreparedStrategyDeployment
    gasLimitWei: bigint
  }): Promise<StrategySetupRow> {
    if (!/^[\x21-\x7e]{1,160}$/.test(input.key))
      throw new ClientError('A bounded Idempotency-Key is required.')
    return this.sql.begin(async (tx) => {
      await tx`INSERT INTO strategy_setups(id,owner,idempotency_key,request_digest,prepared,gas_limit_wei)
        VALUES (${randomUUID()},${input.owner.toLowerCase()},${input.key},${input.digest},${tx.json(setupJSON(input.prepared))},${input.gasLimitWei.toString()})
        ON CONFLICT(owner,idempotency_key) DO NOTHING`
      const [row] = await tx<
        StrategySetupRow[]
      >`SELECT * FROM strategy_setups WHERE owner=${input.owner.toLowerCase()} AND idempotency_key=${input.key} FOR UPDATE`
      if (!row || row.request_digest !== input.digest)
        throw setupConflict('This retry key already belongs to different reviewed strategy limits.')
      return row
    })
  }
  async actions(id: string, owner: Hex): Promise<StrategyWalletAction[]> {
    await this.get(id, owner)
    const rows = await this.sql<
      ActionRow[]
    >`SELECT a.* FROM strategy_setup_actions a JOIN strategy_setups s ON s.id=a.setup_id
      WHERE a.setup_id=${id} AND s.owner=${owner.toLowerCase()} ORDER BY (a.state IN ('PREPARED','SUBMITTED','NEEDS_REVIEW')) DESC,a.created_at DESC,a.id DESC LIMIT 100`
    // Always include the sole unresolved action, even after more than 100 owner steps.
    // Return chronological history for the UI, with that unresolved action last.
    return rows.reverse().map(actionView)
  }
  async action(id: string, owner: Hex, actionId: string): Promise<StrategyWalletAction> {
    const [row] = await this.sql<
      ActionRow[]
    >`SELECT a.* FROM strategy_setup_actions a JOIN strategy_setups s ON s.id=a.setup_id
      WHERE s.id=${id} AND s.owner=${owner.toLowerCase()} AND a.id=${actionId}`
    if (!row) throw setupMissing()
    return actionView(row)
  }
  async prepareAction(
    id: string,
    owner: Hex,
    digest: Hex,
    action: Omit<StrategyWalletAction, 'id' | 'status' | 'transactionHash'>,
    intent?: { key: string; digest: Hex },
  ): Promise<StrategyWalletAction> {
    return this.transaction(id, owner, async (tx) => {
      if (intent) {
        await tx`INSERT INTO strategy_setup_intents(setup_id,intent_key,request_digest) VALUES(${id},${intent.key},${intent.digest}) ON CONFLICT(setup_id,intent_key) DO NOTHING`
        const [held] = await tx<
          { request_digest: Hex }[]
        >`SELECT request_digest FROM strategy_setup_intents WHERE setup_id=${id} AND intent_key=${intent.key}`
        if (!held || held.request_digest !== intent.digest)
          throw setupConflict(
            'This wallet intent key already belongs to different reviewed amounts.',
          )
      }
      const [same] = await tx<
        ActionRow[]
      >`SELECT * FROM strategy_setup_actions WHERE setup_id=${id} AND request_digest=${digest}`
      if (same) return actionView(same)
      const pending =
        await tx`SELECT id FROM strategy_setup_actions WHERE setup_id=${id} AND state IN ('PREPARED','SUBMITTED','NEEDS_REVIEW') LIMIT 1`
      if (pending.length)
        throw setupConflict(
          'Resolve the existing wallet request before preparing another. Its recorded hash must not be replaced.',
        )
      const [row] = await tx<
        ActionRow[]
      >`INSERT INTO strategy_setup_actions(id,setup_id,request_digest,kind,transaction_data,review)
        VALUES(${randomUUID()},${id},${digest},${action.kind},${tx.json(setupJSON(action.transaction))},${tx.json(setupJSON(action.review))}) RETURNING *`
      if (!row) throw setupConflict()
      return actionView(row)
    })
  }
  async submitAction(id: string, owner: Hex, actionId: string, hash: Hex): Promise<void> {
    if (!nonzeroHash(hash)) throw new ClientError('An exact wallet transaction hash is required.')
    await this.transaction(id, owner, async (tx) => {
      const [row] = await tx<
        ActionRow[]
      >`SELECT * FROM strategy_setup_actions WHERE id=${actionId} AND setup_id=${id} FOR UPDATE`
      if (!row) throw setupMissing()
      if (row.transaction_hash && row.transaction_hash !== hash.toLowerCase())
        throw setupConflict('A recorded wallet transaction hash cannot be replaced.')
      if (row.transaction_hash) return
      await tx`UPDATE strategy_setup_actions SET transaction_hash=${hash.toLowerCase()},state='SUBMITTED',updated_at=now() WHERE id=${actionId}`
    })
  }
  async finishAction(input: {
    id: string
    owner: Hex
    actionId: string
    hash: Hex
    status: 'FINALIZED' | 'REVERTED' | 'NEEDS_REVIEW'
    block?: { number: string; hash: Hex }
    binding?: StrategyBinding
  }): Promise<void> {
    await this.transaction(input.id, input.owner, async (tx, row) => {
      const [action] = await tx<
        ActionRow[]
      >`SELECT * FROM strategy_setup_actions WHERE id=${input.actionId} AND setup_id=${input.id} FOR UPDATE`
      if (!action || action.transaction_hash !== input.hash.toLowerCase()) throw setupConflict()
      if (action.state === 'FINALIZED' || action.state === 'REVERTED') {
        if (
          action.state !== input.status ||
          (input.block &&
            (action.receipt_block !== input.block.number ||
              action.receipt_hash !== input.block.hash.toLowerCase()))
        )
          throw setupConflict()
        return
      }
      if (input.binding) {
        if (row.binding && setupDigest(row.binding) !== setupDigest(input.binding))
          throw setupConflict()
        await tx`UPDATE strategy_setups SET binding=${tx.json(setupJSON(input.binding))},revision=revision+1,updated_at=now() WHERE id=${input.id}`
      }
      await tx`UPDATE strategy_setup_actions SET state=${input.status},receipt_block=${input.block?.number ?? null},receipt_hash=${input.block?.hash.toLowerCase() ?? null},updated_at=now() WHERE id=${input.actionId}`
    })
  }
}
