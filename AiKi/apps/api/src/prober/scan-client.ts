/**
 * 8004scan client.
 *
 * THE IMPORTANT THING: there are two API surfaces and they are NOT the same tier.
 *
 *   /api/v1/public/*   free/anonymous. 10 req/min. IGNORES your API key entirely.
 *                      Envelope { success, data, meta.pagination }. `offset` ignored,
 *                      paginates by `page`.
 *   /api/v1/*          authenticated. 180 req/min, 20,000/day with a key.
 *                      Envelope { items, limit, offset, total }. `offset` WORKS.
 *                      Query params are snake_case here (`chain_id`), camelCase on
 *                      /public (`chainId`). The wrong casing is SILENTLY IGNORED
 *                      rather than erroring, which yields a cross-chain sample.
 *
 * "public" in the path means unauthenticated, not "the public API". Using it with a
 * Pro key silently gives you 1/18th of your throughput and a different envelope.
 * Verified 19 Aug 2026: /public 429s at request 11; /api/v1 served 30/30 with
 * x-ratelimit-remaining-minute counting down from 180.
 *
 * Rate-limit headers also differ: /public sends `x-ratelimit-limit` (hard-coded to
 * 10 and untrustworthy); /api/v1 sends `x-ratelimit-limit-minute` and `-day`, which
 * are accurate.
 */

const BASE = 'https://8004scan.io/api/v1'
const KEY = process.env.EIGHT004SCAN_API_KEY ?? ''

export const REGISTRY = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432'
export const CHAIN_ID = 56

export interface ScanAgent {
  agent_id: string
  token_id: string
  name: string | null
  description: string | null
  supported_protocols: string[] | null
  x402_supported: boolean | null
  owner_address: string | null
  created_at: string
}

export interface ListPage {
  items: ScanAgent[]
  limit: number
  offset: number
  total: number
}

/** Parsed ERC-8004 registration file plus the raw URI it came from. */
export interface AgentDetail {
  token_id: string
  raw_metadata?: {
    offchain_content?: {
      name?: string
      services?: {
        name?: string
        type?: string
        endpoint?: string
        version?: string
        transport?: string
      }[]
      supportedTrust?: string[]
      active?: boolean
    }
    offchain_uri?: string
    onchain?: unknown
  }
  is_endpoint_verified?: boolean
  health_status?: unknown
  [k: string]: unknown
}

let remainingMinute = Number.POSITIVE_INFINITY

/** Requests remaining in the current minute, per the last response seen. */
export function budgetRemaining(): number {
  return remainingMinute
}

async function get<T>(path: string, attempt = 0): Promise<T> {
  // Ease off before they have to refuse us.
  if (remainingMinute <= 2) {
    await new Promise((r) => setTimeout(r, 3_000))
    remainingMinute = Number.POSITIVE_INFINITY
  }

  const res = await fetch(`${BASE}${path}`, {
    headers: KEY ? { 'X-API-Key': KEY, 'X-Access-Token': KEY } : {},
  })

  const rm = res.headers.get('x-ratelimit-remaining-minute')
  if (rm !== null) remainingMinute = Number(rm)

  if (res.status === 429) {
    if (attempt >= 4) throw new Error(`8004scan ${path} → rate limited after ${attempt} retries`)
    const wait = 2 ** attempt * 3_000
    await new Promise((r) => setTimeout(r, wait))
    return get<T>(path, attempt + 1)
  }
  if (!res.ok) throw new Error(`8004scan ${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

/** One page of the registry. `offset` is honoured on this surface. */
export function listAgents(limit: number, offset: number): Promise<ListPage> {
  // snake_case! `chainId` is SILENTLY IGNORED on this surface — it returns the
  // all-chain total (742,106) and a cross-chain sample, while `chain_id` correctly
  // filters to 258,523 BSC agents. The /public surface uses camelCase for the same
  // parameter. Verified 20 Aug 2026.
  return get<ListPage>(`/agents?chain_id=${CHAIN_ID}&limit=${limit}&offset=${offset}`)
}

/** Full record. Note the path includes the contract address — /agents/{id} 404s. */
export function getAgent(tokenId: string): Promise<AgentDetail> {
  return get<AgentDetail>(`/agents/${CHAIN_ID}/${REGISTRY}/${tokenId}`)
}

export function hasKey(): boolean {
  return KEY.length > 0
}
