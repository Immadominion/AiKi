/**
 * Probe sweep CLI.
 *
 *   pnpm --filter @aiki/api probe -- --limit 300
 *   pnpm --filter @aiki/api probe -- --inspect 50285
 *
 * Draws a sample spread across the canonical BSC ERC-8004 registry, resolves each
 * registration file, probes every declared endpoint, and reports what is actually
 * reachable. This is the measurement behind AiKi's Data Quality claim, so it is
 * built to produce a number we can defend rather than one that looks good.
 */

import { writeFileSync } from 'node:fs'
import type { LivenessState } from '@aiki/contracts'
import type { DeclaredService } from './detect.js'
import { mapLimit, type ProbeAgentResult, probeAgent } from './probe.js'
import {
  budgetRemaining,
  CHAIN_ID,
  getAgent,
  hasKey,
  listAgents,
  REGISTRY,
  type ScanAgent,
} from './scan-client.js'

/**
 * Sample the registry.
 *
 * Uses many small offsets rather than a few large pages. A page returns adjacent
 * agents, and on a registry dominated by bulk minting those come from one batch and
 * are near-identical — so a few big pages is cluster sampling wearing the costume of
 * a random sample, and any percentage taken from it is falsely precise.
 */
async function sampleAgents(target: number): Promise<ScanAgent[]> {
  const first = await listAgents(1, 0)
  const total = first.total
  console.log(`  registry holds ${total.toLocaleString()} agents on chain ${CHAIN_ID}`)

  const perDraw = 3
  const draws = Math.ceil(target / perDraw)
  const stride = Math.max(1, Math.floor(total / draws))

  const out: ScanAgent[] = []
  const seen = new Set<string>()

  for (let i = 0; i < draws && out.length < target; i++) {
    const offset = Math.min(total - perDraw, i * stride + Math.floor(Math.random() * stride))
    try {
      const page = await listAgents(perDraw, Math.max(0, offset))
      for (const a of page.items ?? []) {
        if (!seen.has(a.agent_id)) {
          seen.add(a.agent_id)
          out.push(a)
        }
      }
    } catch (err) {
      console.warn(`  offset ${offset} failed: ${(err as Error).message}`)
    }
  }
  return out.slice(0, target)
}

/**
 * Extract declared services from a detail record.
 *
 * The registration file is parsed into `raw_metadata.offchain_content`; the raw
 * agentURI is `raw_metadata.offchain_uri`. Prefer the parsed file because it keeps
 * `transport`, which D3 needs to tell a stdio MCP entry (declared but not remotely
 * callable) from a real network endpoint.
 */
function extractServices(detail: Awaited<ReturnType<typeof getAgent>>): {
  services: DeclaredService[]
  agentUri?: string
} {
  const content = detail.raw_metadata?.offchain_content
  const services: DeclaredService[] = []

  for (const s of content?.services ?? []) {
    const endpoint = String(s.endpoint ?? '')
    if (!endpoint) continue
    services.push({
      name: String(s.name ?? s.type ?? 'service'),
      endpoint,
      ...(s.version ? { version: String(s.version) } : {}),
      ...(s.transport ? { transport: String(s.transport) } : {}),
    })
  }

  const agentUri = detail.raw_metadata?.offchain_uri
  return agentUri ? { services, agentUri } : { services }
}

async function inspectOne(tokenId: string) {
  const d = await getAgent(tokenId)
  console.log(`\nDetail for token ${tokenId}:\n`)
  for (const [k, v] of Object.entries(d)) {
    const t = Array.isArray(v) ? `array[${v.length}]` : v === null ? 'null' : typeof v
    console.log(`  ${k.padEnd(28)} ${t.padEnd(9)} ${JSON.stringify(v)?.slice(0, 90) ?? ''}`)
  }
  console.log(
    '\n  offchain_content:',
    JSON.stringify(d.raw_metadata?.offchain_content)?.slice(0, 400),
  )
  console.log()
}

async function main() {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag)
    return i > -1 ? process.argv[i + 1] : undefined
  }

  const inspect = arg('--inspect')
  if (inspect) return inspectOne(inspect)

  const target = Number(arg('--limit') ?? 100)
  const concurrency = Number(arg('--concurrency') ?? 8)

  if (!hasKey()) {
    console.warn('⚠  EIGHT004SCAN_API_KEY not set — anonymous limits, this will be slow.\n')
  }

  console.log(`Sampling ${target} agents…`)
  const agents = await sampleAgents(target)
  console.log(`  drew ${agents.length}\n`)

  console.log('Resolving registration files…')
  const resolved = await mapLimit(agents, concurrency, async (a) => {
    try {
      return { agent: a, ...extractServices(await getAgent(a.token_id)) }
    } catch {
      return { agent: a, services: [] as DeclaredService[] }
    }
  })
  const withServices = resolved.filter((r) => r.services.length > 0).length
  console.log(`  ${withServices}/${resolved.length} declare at least one service`)
  console.log(`  (${budgetRemaining()} req remaining this minute)\n`)

  // D10 needs a cross-agent view: count how many agents declare each exact URL.
  // A URL shared by many identities cannot be agent-specific, and D1 cannot see
  // this because a URL with no identifier in it has nothing to vary.
  const endpointCounts = new Map<string, number>()
  for (const r of resolved) {
    const first = r.services[0]?.endpoint
    if (first) endpointCounts.set(first, (endpointCounts.get(first) ?? 0) + 1)
  }

  console.log('Probing endpoints…')
  const results: ProbeAgentResult[] = await mapLimit(resolved, concurrency, (r) => {
    const first = r.services[0]?.endpoint
    const shared = first ? (endpointCounts.get(first) ?? 1) - 1 : 0
    return probeAgent({
      agentId: r.agent.token_id,
      registry: `eip155:${CHAIN_ID}:${REGISTRY}`,
      services: r.services,
      ...(r.agentUri ? { agentUri: r.agentUri } : {}),
      sharedWithOtherAgents: shared,
    })
  })

  const byState = new Map<LivenessState, number>()
  for (const r of results) byState.set(r.verdict.state, (byState.get(r.verdict.state) ?? 0) + 1)

  const blocks = new Set(results.map((r) => Math.floor(Number(r.agentId) / 1000))).size
  const live = byState.get('LIVE') ?? 0
  const reciprocal = results.filter((r) => r.reciprocal?.verified).length
  const zeroCost = results.filter((r) => r.registrationWasZeroCost).length

  const line = '─'.repeat(60)
  console.log(`\n${line}`)
  console.log(`PROBE SWEEP — ${results.length} agents, BSC chain ${CHAIN_ID}`)
  console.log(`sample drawn from ${blocks} distinct 1k-id blocks`)
  console.log(line)
  for (const [state, n] of [...byState.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${state.padEnd(17)} ${String(n).padStart(4)}  ${((n / results.length) * 100).toFixed(1).padStart(5)}%`,
    )
  }
  console.log(line)
  console.log(`  genuinely LIVE          ${live}  (${((live / results.length) * 100).toFixed(1)}%)`)
  console.log(`  declared a service      ${withServices}`)
  console.log(`  reciprocal proof (D8)   ${reciprocal}`)
  console.log(`  data: URI (D4)          ${zeroCost}`)
  if (blocks < 15) {
    console.log('\n  ⚠ CLUSTERED SAMPLE — too few distinct registry locations to quote')
    console.log('    these as ecosystem percentages. Raise --limit.')
  }
  console.log(line)

  const impostors = results.filter((r) => r.verdict.state === 'IMPOSTOR_STATIC')
  if (impostors.length) {
    console.log(`\nIMPOSTOR_STATIC (${impostors.length}):`)
    for (const i of impostors.slice(0, 3)) console.log(`  ${i.agentId}: ${i.verdict.detail}`)
  }

  const out = `probe-sweep-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(
    out,
    JSON.stringify(
      {
        sweptAt: new Date().toISOString(),
        chainId: CHAIN_ID,
        registry: REGISTRY,
        sampled: results.length,
        distinctBlocks: blocks,
        declaredService: withServices,
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
