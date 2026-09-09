import type postgres from 'postgres'
import { creditsNetwork } from '../config/credits-network.js'
import type { DepositConfig } from './deposit.js'
import { checkLedger, type LedgerBacking, type LedgerFinding } from './reconcile.js'
import { treasuryBackingPoints } from './treasury.js'

const HISTORICAL_KEYS = [
  'CREDITS_HISTORICAL_CHAIN_ID',
  'CREDITS_HISTORICAL_TOKEN_ADDRESS',
  'CREDITS_HISTORICAL_TREASURY_ADDRESS',
  'CREDITS_HISTORICAL_RPC_URL',
] as const
const TESTNET_TOKEN = '0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c'

/**
 * A historical treasury is for observation only. It cannot advertise payments
 * or select a deposit-claim network, and it never inherits current-rail values.
 */
export function historicalCreditNetworks(env: Record<string, string | undefined>): DepositConfig[] {
  if (!HISTORICAL_KEYS.some((key) => env[key] !== undefined)) return []
  const chainId = env.CREDITS_HISTORICAL_CHAIN_ID
  if (chainId !== '56' && chainId !== '97')
    throw new Error('CREDITS_HISTORICAL_CHAIN_ID must explicitly select 56 or 97.')
  if (!env.CREDITS_HISTORICAL_TREASURY_ADDRESS || !env.CREDITS_HISTORICAL_RPC_URL)
    throw new Error('Historical credits require an explicit treasury and dedicated RPC URL.')
  const token = env.CREDITS_HISTORICAL_TOKEN_ADDRESS
  if (chainId === '97' && token && token.toLowerCase() !== TESTNET_TOKEN)
    throw new Error('Historical testnet credits require the pinned original USDT token.')
  const config = creditsNetwork({
    CREDITS_CHAIN_ID: chainId,
    CREDITS_TOKEN_ADDRESS: token,
    CREDITS_TREASURY_ADDRESS: env.CREDITS_HISTORICAL_TREASURY_ADDRESS,
    CREDITS_RPC_URL: env.CREDITS_HISTORICAL_RPC_URL,
  })
  if (!config) throw new Error('Historical credits configuration is unavailable.')
  return [config]
}

/** Fresh chain/decimals/balance reads for each rail, followed by one read-only ledger snapshot. */
export async function checkCreditLedger(
  sql: postgres.Sql,
  current: DepositConfig | undefined,
  historical: readonly DepositConfig[] = [],
): Promise<LedgerFinding[]> {
  const [backingPoints, historicalBackings] = await Promise.all([
    treasuryBackingPoints(current),
    Promise.all(
      historical.map(
        async (config): Promise<LedgerBacking> => ({
          chainId: config.chainId,
          token: config.token,
          treasury: config.treasury,
          backingPoints: await treasuryBackingPoints(config),
        }),
      ),
    ),
  ])
  return sql.begin('isolation level repeatable read read only', async (snapshot) =>
    checkLedger(snapshot as unknown as postgres.Sql, backingPoints, current, historicalBackings),
  )
}
