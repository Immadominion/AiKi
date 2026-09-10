/**
 * Explicit operator-only workflow, never started by scheduler or API import.
 * tsx src/reference/refresh-first-party-cli.ts             verifies only
 * tsx src/reference/refresh-first-party-cli.ts --persist   appends genuine verified evidence
 * No API keys are printed; no private keys, paid hires or financial calls are used.
 */
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'
import { BSC_MAINNET } from '../config/chains.js'
import { PostgresEvidenceStore } from '../evidence/postgres-store.js'
import { persistVerification } from '../prober/evidence-sink.js'
import { prepareFirstPartyReportRefresh } from './refresh-first-party.js'

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--persist'))
    throw new Error('Only the optional --persist flag is accepted; identities are fixed.')
  const persist = args[0] === '--persist'
  const databaseUrl = process.env.DATABASE_URL
  if (persist && !databaseUrl) throw new Error('Persistence requires DATABASE_URL.')
  const client = createPublicClient({
    chain: bsc,
    transport: http(process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org', {
      timeout: 15_000,
      retryCount: 0,
    }),
  })
  const abi = parseAbi([
    'function tokenURI(uint256) view returns(string)',
    'function ownerOf(uint256) view returns(address)',
  ])
  const verified = await prepareFirstPartyReportRefresh({
    chainId: () => client.getChainId(),
    identity: async (agentId) => {
      const block = await client.getBlock({ blockTag: 'finalized' })
      if (
        typeof block.number !== 'bigint' ||
        block.number < 0n ||
        !block.hash ||
        /^0x0+$/.test(block.hash)
      )
        throw new Error('A verified finalized BSC block is required.')
      const request = {
        address: BSC_MAINNET.contracts.erc8004Identity,
        abi,
        args: [BigInt(agentId)] as const,
        blockNumber: block.number,
      }
      const [uri, owner] = await Promise.all([
        client.readContract({ ...request, functionName: 'tokenURI' }),
        client.readContract({ ...request, functionName: 'ownerOf' }),
      ])
      if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash)
        throw new Error('Finalized identity block changed during verification.')
      return { uri, owner }
    },
  })
  // All four have passed the same real prober before opening a writable store.
  const store = persist && databaseUrl ? new PostgresEvidenceStore(databaseUrl) : undefined
  try {
    for (const result of verified) {
      const saved = store ? await persistVerification(store, result) : undefined
      console.log(
        JSON.stringify({
          agentId: result.agentId,
          state: result.probe.verdict.state,
          probedAt: result.probe.probedAt,
          reciprocalVerified: result.probe.reciprocal?.verified === true,
          persisted: Boolean(saved),
          observationsInserted: saved?.observationsInserted ?? 0,
        }),
      )
    }
  } finally {
    await store?.close()
  }
}

void main().catch(() => {
  // Provider errors can include credential-bearing RPC URLs. Never print them.
  console.error(
    'Report refresh failed. No financial action was performed. Inspect stored observations before retrying persistence.',
  )
  process.exitCode = 1
})
