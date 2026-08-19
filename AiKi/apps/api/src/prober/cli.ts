/**
 * Probe sweep CLI.
 *
 *   pnpm --filter @aiki/api probe -- --limit 100
 *
 * Samples agents from the canonical BSC ERC-8004 registry via 8004scan, resolves
 * each registration file, probes every declared endpoint, and reports what is
 * actually reachable.
 *
 * This is the measurement behind AiKi's "Data Quality" claim. It is meant to be
 * re-runnable and to produce a number we can defend, not a marketing figure.
 */

import { writeFileSync } from 'node:fs'
import type { LivenessState } from '@aiki/contracts'
import type { DeclaredService } from './detect.js'
import { type ProbeAgentResult, mapLimit, probeAgent } from './probe.js'

const BASE = 'https://8004scan.io/api/v1/public'
const CHAIN_ID = 56
const REGISTRY = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432'

const KEY = process.env.EIGHT004SCAN_API_KEY ?? ''

interface ScanAgent {
  agent_id: string
  token_id: string
  name: string | null
  description: string | null
  supported_protocols: string[] | null
  x402_supported: boolean | null
  owner_address: string | null
  created_at: string
}

/**
 * 8004scan client with adaptive rate-limit handling.
 *
 * Measured behaviour (19 Aug 2026), which is stranger than the docs suggest:
 *  - `x-ratelimit-limit` always reports 10, even on a Pro-upgraded key, and even
 *    while the same key is happily serving a 14-request burst. The LIMIT field is
 *    not trustworthy.
 *  - `x-ratelimit-remaining` DOES decrement and does reach 0 — and requests keep
 *    succeeding past that point. So `remaining: 0` is soft backpressure, not a wall.
 *  - A hard 429 does eventually arrive under sustained load, and its body carries
 *    `error.details.resetAt`, which is precise and worth obeying exactly.
 *
 * Conclusion: do not hard-code a rate. Treat `remaining: 0` as "ease off", obey
 * `resetAt` on a real 429, and let the true ceiling be discovered at runtime. That
 * is robust whether or not the Pro upgrade is actually applied to this key.
 */
interface Pagination { page: number; limit: number; total: number; hasMore: boolean }
/** Last seen meta.pagination — the only place the registry total is exposed. */
let lastPagination: Pagination | null = null
/** How many distinct registry locations the sample drew from. */
let sampledPages = 0

async function scan<T>(path: string, attempt = 0, _captureMeta = false): Promise<T> {
  // Send BOTH header names. Their OpenAPI documents X-API-Key; their MCP config
  // uses X-Access-Token. Which one gates the Pro tier is undocumented, so send both.
  const headers: Record<string, string> = KEY
    ? { 'X-API-Key': KEY, 'X-Access-Token': KEY }
    : {}
  const res = await fetch(`${BASE}${path}`, { headers })

  // Soft backpressure: slow down before they have to say no.
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '1')
  if (res.ok && remaining <= 0) await new Promise((r) => setTimeout(r, 1_500))

  if (res.status === 429) {
    if (attempt >= 4) throw new Error(`8004scan ${path} → rate limited, gave up after ${attempt}`)
    const body = (await res.json().catch(() => ({}))) as {
      error?: { details?: { resetAt?: string } }
    }
    const resetAt = body.error?.details?.resetAt
    const waitMs = resetAt
      ? Math.max(1_000, new Date(resetAt).getTime() - Date.now() + 500)
      : 2 ** attempt * 2_000
    console.log(`    rate limited — waiting ${Math.ceil(waitMs / 1000)}s`)
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 70_000)))
    return scan<T>(path, attempt + 1)
  }

  if (!res.ok) throw new Error(`8004scan ${path} → HTTP ${res.status}`)

  const json = (await res.json()) as {
    success?: boolean
    data?: T
    meta?: { pagination?: Pagination }
  }
  if (json.meta?.pagination) lastPagination = json.meta.pagination
  // NOTE: the PUBLIC api envelopes as { success, data } with pagination under
  // meta.pagination. The undocumented /api/v1 endpoint uses { items, total }
  // instead. They are not interchangeable.
  return (json.data ?? (json as unknown)) as T
}

/**
 * Pull a sample spread across the whole registry.
 *
 * CRITICAL: this API ignores `offset` entirely — it paginates with `page`, and
 * `meta.pagination` returns { page, limit, total, hasMore }. Passing offset silently
 * returns page 1 every time, which yields a sample of only the newest agents. Those
 * are minted minutes ago and declare nothing, so the sweep reports "0% declare a
 * service" and looks like a devastating finding when it is actually a sampling bug.
 * Verified 19 Aug 2026: offset=0 and offset=100000 return identical token_ids.
 */
async function sampleAgents(total: number): Promise<ScanAgent[]> {
  // Small pageSize on purpose. A page returns CONSECUTIVE token ids, and on a
  // registry dominated by bulk minting, consecutive agents come from the same
  // batch and are near-identical — so 3 pages of 25 is 3 clusters, not 75
  // independent draws. Reporting a percentage from that overstates precision
  // badly (see the 5 identical {agentId} placeholders at 203497-203507, all one
  // batch). Detail lookups cost 1 request per agent and dominate the budget
  // anyway, so buying page diversity here is nearly free.
  const pageSize = 3
  const first = await scan<ScanAgent[]>(`/agents?chainId=${CHAIN_ID}&limit=1&page=1`, 0, true)
  const totalAgents = lastPagination?.total ?? 0
  const maxPage = Math.max(1, Math.floor(totalAgents / pageSize))
  console.log(`  registry holds ${totalAgents.toLocaleString()} agents (${maxPage.toLocaleString()} pages)`)
  void first

  const wanted = Math.ceil(total / pageSize)
  // Track cluster count so the report can be honest about sample design.
  sampledPages = wanted
  // Deterministic spread across the registry so runs are comparable, plus a
  // rotating offset so repeated sweeps do not always hit the same pages.
  const stride = Math.max(1, Math.floor(maxPage / wanted))
  const jitter = Math.floor((Date.now() / 60000) % stride)

  const out: ScanAgent[] = []
  const seen = new Set<string>()
  for (let i = 0; i < wanted && out.length < total; i++) {
    const page = Math.min(maxPage, 1 + i * stride + jitter)
    try {
      const batch = await scan<ScanAgent[]>(
        `/agents?chainId=${CHAIN_ID}&limit=${pageSize}&page=${page}`,
      )
      for (const a of batch ?? []) {
        if (!seen.has(a.agent_id)) {
          seen.add(a.agent_id)
          out.push(a)
        }
      }
    } catch (err) {
      console.warn(`  page ${page} failed: ${(err as Error).message}`)
    }
  }
  return out.slice(0, total)
}

/**
 * Resolve declared services from an agent detail record.
 *
 * 8004scan does NOT return a `services` array — it FLATTENS the ERC-8004 service
 * entries into named columns (`mcp_server`, `a2a_endpoint`, `agent_url`), with the
 * original registration file under `raw_metadata.offchain`.
 *
 * This was discovered with `--inspect` after a guessed field name produced
 * "0/25 declare a service", which looks like a finding and was actually a bug.
 * Verify field names against a real record; never infer them.
 */
async function resolveServices(
  agent: ScanAgent,
): Promise<{ services: DeclaredService[]; agentUri?: string }> {
  try {
    const detail = await scan<Record<string, unknown>>(`/agents/${CHAIN_ID}/${agent.token_id}`)

    const raw = detail.raw_metadata as { offchain?: unknown } | undefined
    const offchain = raw?.offchain as
      | { services?: unknown[]; type?: string; uri?: string }
      | undefined

    const services: DeclaredService[] = []

    // Preferred: the verbatim registration file, which preserves `transport`
    // (needed for D3 — a stdio MCP entry is declared but not remotely callable).
    if (Array.isArray(offchain?.services)) {
      for (const s of offchain.services) {
        const o = s as Record<string, unknown>
        const endpoint = String(o.endpoint ?? '')
        if (!endpoint) continue
        services.push({
          name: String(o.name ?? o.type ?? 'service'),
          endpoint,
          ...(o.version ? { version: String(o.version) } : {}),
          ...(o.transport ? { transport: String(o.transport) } : {}),
        })
      }
    }

    // Fallback: the flattened columns.
    if (services.length === 0) {
      const flat: [string, unknown][] = [
        ['MCP', detail.mcp_server],
        ['A2A', detail.a2a_endpoint],
        ['web', detail.agent_url],
      ]
      for (const [name, value] of flat) {
        if (typeof value === 'string' && value.length > 0) {
          services.push({ name, endpoint: value })
        }
      }
    }

    const agentUri =
      (detail.offchain_uri as string | undefined) ??
      (detail.agent_uri as string | undefined) ??
      offchain?.uri

    return agentUri ? { services, agentUri } : { services }
  } catch {
    return { services: [] }
  }
}

/**
 * Dump one detail record's shape. Field names on the public API are undocumented,
 * so we discover them rather than guessing — a wrong guess reads as "0 agents
 * declare a service", which looks like a finding and is actually a bug.
 */
async function inspectOne(tokenId: string) {
  const detail = await scan<Record<string, unknown>>(`/agents/${CHAIN_ID}/${tokenId}`)
  console.log(`\nDetail record for token ${tokenId}:\n`)
  for (const [k, v] of Object.entries(detail)) {
    const t = Array.isArray(v) ? `array[${v.length}]` : v === null ? 'null' : typeof v
    const preview = JSON.stringify(v)?.slice(0, 110) ?? ''
    console.log(`  ${k.padEnd(26)} ${t.padEnd(10)} ${preview}`)
  }
  console.log()
}

async function main() {
  const argLimit = process.argv.indexOf('--limit')
  const limit = argLimit > -1 ? Number(process.argv[argLimit + 1]) : 50
  // The public tier is 10 req/min. Serial is not a preference, it is the ceiling.
  const argConc = process.argv.indexOf('--concurrency')
  const concurrency = argConc > -1 ? Number(process.argv[argConc + 1]) : 2

  const argInspect = process.argv.indexOf('--inspect')
  if (argInspect > -1) {
    await inspectOne(process.argv[argInspect + 1] ?? '270262')
    return
  }

  if (!KEY) {
    console.warn('⚠  EIGHT004SCAN_API_KEY not set — running at anonymous rate limits.\n')
  }

  console.log(`Sampling ${limit} agents across the BSC registry…`)
  const agents = await sampleAgents(limit)
  console.log(`  got ${agents.length}\n`)

  console.log('Resolving registration files…')
  const resolved = await mapLimit(agents, concurrency, async (a) => ({
    agent: a,
    ...(await resolveServices(a)),
  }))
  const withServices = resolved.filter((r) => r.services.length > 0).length
  console.log(`  ${withServices}/${resolved.length} declare at least one service\n`)

  console.log('Probing endpoints…')
  const results: ProbeAgentResult[] = await mapLimit(resolved, concurrency, (r) =>
    probeAgent({
      agentId: r.agent.token_id,
      registry: `eip155:${CHAIN_ID}:${REGISTRY}`,
      services: r.services,
      ...(r.agentUri ? { agentUri: r.agentUri } : {}),
    }),
  )

  // ── report ────────────────────────────────────────────────────────────────
  const byState = new Map<LivenessState, number>()
  for (const r of results) byState.set(r.verdict.state, (byState.get(r.verdict.state) ?? 0) + 1)

  const reciprocal = results.filter((r) => r.reciprocal?.verified).length
  const zeroCost = results.filter((r) => r.registrationWasZeroCost).length
  const live = byState.get('LIVE') ?? 0

  // Report sample DESIGN alongside the numbers. A percentage from clustered
  // draws is not the same statistic as one from independent draws, and this
  // product does not get to be sloppy about that.
  const blocks = new Set(results.map((r) => Math.floor(Number(r.agentId) / 1000))).size

  console.log(`\n${'─'.repeat(58)}`)
  console.log(`PROBE SWEEP — ${results.length} agents, BSC chain ${CHAIN_ID}`)
  console.log(`sample: ${sampledPages} registry locations, ${blocks} distinct 1k-id blocks`)
  console.log('─'.repeat(58))
  for (const [state, n] of [...byState.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((n / results.length) * 100).toFixed(1)
    console.log(`  ${state.padEnd(17)} ${String(n).padStart(4)}  ${pct.padStart(5)}%`)
  }
  console.log('─'.repeat(58))
  console.log(`  genuinely LIVE          ${live}  (${((live / results.length) * 100).toFixed(1)}%)`)
  if (blocks < 10) {
    console.log('  ⚠ CLUSTERED SAMPLE — too few distinct registry locations to')
    console.log('    quote these as ecosystem percentages. Raise --limit.')
  }
  console.log(`  reciprocal proof (D8)   ${reciprocal}`)
  console.log(`  data: URI, zero-cost    ${zeroCost}`)
  console.log('─'.repeat(58))

  const impostors = results.filter((r) => r.verdict.state === 'IMPOSTOR_STATIC')
  if (impostors.length > 0) {
    console.log(`\nIMPOSTOR_STATIC detail (${impostors.length}):`)
    for (const i of impostors.slice(0, 3)) {
      console.log(`  agent ${i.agentId}: ${i.verdict.detail}`)
    }
  }

  const out = `probe-sweep-${Date.now()}.json`
  writeFileSync(
    out,
    JSON.stringify(
      {
        sweptAt: new Date().toISOString(),
        chainId: CHAIN_ID,
        registry: REGISTRY,
        sampled: results.length,
        byState: Object.fromEntries(byState),
        reciprocalVerified: reciprocal,
        zeroCostRegistrations: zeroCost,
        results,
      },
      null,
      2,
    ),
  )
  console.log(`\nFull results → ${out}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
