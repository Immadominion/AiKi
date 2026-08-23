/**
 * Registry indexer CLI.
 *
 *   pnpm --filter @aiki/api index -- --blocks 20000
 *   pnpm --filter @aiki/api index -- --probe-span
 */

import {
  blockNumber,
  indexRegistry,
  probeMaxSpan,
  REGISTRY,
  type RegisteredEvent,
} from './registry.js'

const RPC = process.env.BSC_RPC_URL ?? 'https://bsc-rpc.publicnode.com'

/** Never write credential-bearing RPC URLs to a terminal, log aggregator, or screenshot. */
function rpcLabel(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'configured RPC endpoint'
  }
}

async function main() {
  const arg = (f: string) => {
    const i = process.argv.indexOf(f)
    return i > -1 ? process.argv[i + 1] : undefined
  }

  if (process.argv.includes('--probe-span')) {
    console.log(`Probing eth_getLogs span cap on ${RPC}…`)
    console.log(`  max span: ${await probeMaxSpan(RPC)} blocks`)
    return
  }

  const blocks = Number(arg('--blocks') ?? 5000)
  const explicitFrom = arg('--from-block')
  const latest = await blockNumber(RPC, 'latest')
  const finalized = await blockNumber(RPC, 'finalized')

  console.log(`RPC host  ${rpcLabel(RPC)}`)
  console.log(`registry  ${REGISTRY}`)
  console.log(`latest    ${latest.toLocaleString()}`)
  console.log(`finalized ${finalized.toLocaleString()}  (lag ${latest - finalized})`)
  if (!Number.isSafeInteger(blocks) || blocks < 1)
    throw new Error('--blocks must be a positive integer')
  const from = explicitFrom === undefined ? finalized - blocks + 1 : Number(explicitFrom)
  if (!Number.isSafeInteger(from) || from < 0)
    throw new Error('--from-block must be a non-negative integer')
  const to = Math.min(from + blocks - 1, finalized)
  console.log(`scanning blocks ${from.toLocaleString()}–${to.toLocaleString()}…\n`)

  const all: RegisteredEvent[] = []
  const t0 = Date.now()

  for await (const batch of indexRegistry({ url: RPC, stopAtBlock: to }, from, (c) => {
    process.stdout.write(
      `\r  block ${c.lastIndexedBlock.toLocaleString()}  agents ${c.agentsSeen}   `,
    )
  })) {
    all.push(...batch)
  }

  const secs = (Date.now() - t0) / 1000
  console.log(`\n\ndone in ${secs.toFixed(1)}s — ${all.length} Registered events\n`)

  if (!all.length) return

  const ids = all.map((e) => BigInt(e.agentId))
  const owners = new Set(all.map((e) => e.owner))
  const schemes = new Map<string, number>()
  for (const e of all) {
    const s = e.agentURI.startsWith('data:')
      ? 'data:'
      : e.agentURI.startsWith('ipfs://')
        ? 'ipfs://'
        : e.agentURI.startsWith('http')
          ? 'https://'
          : 'other'
    schemes.set(s, (schemes.get(s) ?? 0) + 1)
  }

  const first = all[0]
  const last = all[all.length - 1]
  if (!first || !last) throw new Error('No events in range — nothing to summarise.')
  const blocksSpanned = last.blockNumber - first.blockNumber + 1
  const perDay = (all.length / (blocksSpanned * 0.45)) * 86_400

  console.log(`agentId range     ${ids[0]} … ${ids[ids.length - 1]}`)
  console.log(`distinct owners   ${owners.size} / ${all.length}`)
  // Registration is BURSTY, so extrapolating a daily rate from a short window is
  // unreliable. Measured: a 9,000-block (~75 min) window implied ~27,000/day, while
  // the agentId delta over 11.5 hours implied ~4,400/day — a 6x overstatement.
  // Label it as what it is and prefer an agentId delta across a long gap.
  const windowMins = Math.round((blocksSpanned * 0.45) / 60)
  console.log(
    `rate in window    ~${Math.round(perDay).toLocaleString()}/day extrapolated from ${windowMins}min ` +
      '— BURSTY, do not quote',
  )
  console.log('agentURI schemes:')
  for (const [s, n] of [...schemes].sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${s.padEnd(10)} ${String(n).padStart(5)}  ${((n / all.length) * 100).toFixed(1)}%`,
    )
  }

  // Bulk-mint signature: few owners holding many identities.
  const byOwner = new Map<string, number>()
  for (const e of all) byOwner.set(e.owner, (byOwner.get(e.owner) ?? 0) + 1)
  const top = [...byOwner].sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (top[0] && top[0][1] > 1) {
    console.log('top owners:')
    for (const [o, n] of top) console.log(`  ${o}  ${n}`)
  }
}

main().catch((e) => {
  if (e?.name === 'ArchiveRequiredError') {
    console.error(`\n  ${e.message}\n`)
    process.exit(2)
  }
  console.error(e)
  process.exit(1)
})
