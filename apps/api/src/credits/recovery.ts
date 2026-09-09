import type postgres from 'postgres'
import type { DepositConfig } from './deposit.js'
import { creditDeposit } from './deposit.js'
import { InMemoryCreditStore, ISSUANCE_ACCOUNT } from './store.js'

export interface RecoveryEntry {
  id: string
  owner: string
  delta: string
  reason: string
  reference: string | null
  detail: Record<string, unknown>
}

export interface DepositRecoveryReview {
  status: 'verified_uncredited' | 'already_credited' | 'conflict'
  applied: false
  owner: string
  transactionHash: string
  points: number
  amount: string
  payment: Record<string, unknown>
  ledgerEntries: { id: string; owner: string; delta: string; reference: string | null }[]
  note: string
}

/** All fields name the historical rail explicitly; current deployment defaults cannot select it. */
export function recoveryInput(
  values: Record<string, string | undefined>,
  rpcUrl: string | undefined,
): { config: DepositConfig; owner: string; transactionHash: string } {
  const chain = values['chain-id']
  if (chain !== '56' && chain !== '97')
    throw new Error('Select historical chain 56 or 97 explicitly.')
  const address = (key: string): `0x${string}` => {
    const value = values[key]
    if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value))
      throw new Error(`Supply a nonzero ${key} address.`)
    return value.toLowerCase() as `0x${string}`
  }
  const hash = values['transaction-hash']
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error('Supply the original transaction hash.')
  if (!rpcUrl)
    throw new Error('CREDITS_RECOVERY_RPC_URL is required; no current-rail fallback is used.')
  try {
    if (!['https:', 'http:'].includes(new URL(rpcUrl).protocol)) throw new Error()
  } catch {
    throw new Error('CREDITS_RECOVERY_RPC_URL must be an HTTP or HTTPS URL.')
  }
  return {
    config: {
      chainId: chain === '56' ? 56 : 97,
      decimals: chain === '56' ? 18 : 6,
      token: address('token'),
      treasury: address('treasury'),
      rpcUrl,
    },
    owner: address('owner'),
    transactionHash: hash.toLowerCase(),
  }
}

/**
 * Verify a historical payment without connecting its verifier to a persistent
 * credit writer. The normal receipt/finality/token rules run against isolated
 * memory; only a read-only database snapshot can enter this operator tool.
 * A returned candidate is not a credit or an authorization to issue one.
 */
export async function reviewHistoricalDeposit(input: {
  sql: postgres.Sql
  config: DepositConfig
  owner: string
  transactionHash: string
}): Promise<DepositRecoveryReview> {
  const parsed = recoveryInput(
    {
      'chain-id': String(input.config.chainId),
      token: input.config.token,
      treasury: input.config.treasury,
      owner: input.owner,
      'transaction-hash': input.transactionHash,
    },
    input.config.rpcUrl,
  )
  if (input.config.decimals !== parsed.config.decimals)
    throw new Error('Historical token decimals must match the explicitly selected network.')
  const memory = new InMemoryCreditStore()
  const verified = await creditDeposit({ ...parsed, credits: memory })
  const [verifiedEntry] = await memory.history(parsed.owner)
  if (!verifiedEntry) throw new Error('The historical payment could not be verified.')

  const entries = await input.sql.begin(
    'isolation level repeatable read read only',
    async (sql) =>
      sql<RecoveryEntry[]>`
      SELECT id::text, owner, delta::text, reason, reference, detail
        FROM credit_entries
       WHERE lower(reference) IN (${parsed.transactionHash}, ${`${parsed.transactionHash}:src`})
          OR (owner = ${ISSUANCE_ACCOUNT} AND detail->>'repairs' IN (
            SELECT id::text FROM credit_entries WHERE lower(reference) = ${parsed.transactionHash}
          ))
       ORDER BY reference, id
    `,
  )
  const payer = entries.find((entry) => entry.reference?.toLowerCase() === parsed.transactionHash)
  const source = entries.find((entry) => entry.owner === ISSUANCE_ACCOUNT)
  const sameRail =
    payer &&
    String(payer.detail.chainId) === String(parsed.config.chainId) &&
    typeof payer.detail.token === 'string' &&
    payer.detail.token.toLowerCase() === parsed.config.token.toLowerCase() &&
    (payer.detail.treasury === undefined ||
      (typeof payer.detail.treasury === 'string' &&
        payer.detail.treasury.toLowerCase() === parsed.config.treasury.toLowerCase())) &&
    (payer.detail.decimals === undefined || payer.detail.decimals === parsed.config.decimals) &&
    (payer.detail.baseUnits === undefined ||
      payer.detail.baseUnits === verifiedEntry.detail.baseUnits)
  const matched =
    entries.length === 2 &&
    payer &&
    source &&
    payer.id !== source.id &&
    payer.owner.toLowerCase() === parsed.owner &&
    payer.reason === 'deposit' &&
    source.reason === 'deposit' &&
    payer.delta === String(verified.points) &&
    source.delta === String(-verified.points) &&
    sameRail
  const status =
    entries.length === 0 ? 'verified_uncredited' : matched ? 'already_credited' : 'conflict'
  return {
    status,
    applied: false,
    owner: parsed.owner,
    transactionHash: parsed.transactionHash,
    points: verified.points,
    amount: verified.amount,
    payment: verifiedEntry.detail,
    ledgerEntries: entries.map(({ id, owner, delta, reference }) => ({
      id,
      owner,
      delta,
      reference,
    })),
    note:
      status === 'verified_uncredited'
        ? 'Receipt verified on the explicitly selected historical rail. No points were issued. Any recovery requires reviewed, atomic crediting under the original globally unique transaction hash; recheck the ledger before applying it.'
        : status === 'already_credited'
          ? 'The original payment and both ledger legs match. No recovery credit is needed or was issued.'
          : 'The original hash or issuance leg is already occupied but does not match this payment. Do not issue another credit or rewrite historical balances; investigate the listed entries.',
  }
}
