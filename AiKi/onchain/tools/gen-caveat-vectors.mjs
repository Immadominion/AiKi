// Generates test/vectors/caveat-vectors.json by driving the REAL compileCaveats.
//
// The claim this exists to support is the product's whole point: the limit a person sets in
// the mandate builder is the limit the chain refuses to exceed. That claim spans two languages.
// `compileCaveats` turns a Constraint[] into caveat terms in TypeScript; the enforcers read
// those terms in Solidity. Nothing checks that they agree, and a terms encoding that is subtly
// wrong does not fail loudly: it produces a mandate that either reverts everything or, far
// worse, enforces nothing while rendering as enforced.
//
// So the terms in this corpus are produced by the compiler itself, never transcribed, and
// test/CaveatParity.t.sol feeds those exact bytes to the real enforcers and checks the verdict
// the compiler promised. Both sides go red when either moves.
//
//   npx tsx onchain/tools/gen-caveat-vectors.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { compileCaveats, overallTier } = await import(
  resolve(HERE, '../../apps/api/src/authority/caveats.ts')
)

const OUT = resolve(HERE, '../test/vectors/caveat-vectors.json')

// Enforcer addresses are placeholders keyed by name: the Solidity side deploys its own suite
// and substitutes them, because what is under test is the TERMS, not where a contract landed.
const NAMES = [
  'ExpiryEnforcer',
  'AllowedTargetsEnforcer',
  'AllowedSelectorsEnforcer',
  'AssetScopeEnforcer',
  'PerActionCapEnforcer',
  'SessionTotalCapEnforcer',
]
const DEPLOYMENT = {
  chainId: 0,
  network: 'testnet',
  audited: false,
  registry: `0x${'00'.repeat(20)}`,
  manager: `0x${'00'.repeat(20)}`,
  enforcers: NAMES.map((name, i) => ({
    name,
    address: `0x${String(i + 1).padStart(40, '0')}`,
    codeHash: `0x${'00'.repeat(32)}`,
  })),
}
const byAddress = new Map(DEPLOYMENT.enforcers.map((e) => [e.address.toLowerCase(), e.name]))

// The token address is fixed so the Solidity side can place a real ERC-20 there with `etch`:
// the cap terms embed it, and an asset the enforcer cannot find is a different test.
const ASSET = '0x00000000000000000000000000000000000000d1'
const TARGET = ASSET // an ERC-20 transfer calls the token itself
const TRANSFER = '0xa9059cbb'
const APPROVE = '0x095ea7b3'
const EXPIRES_AT = 2_000_000_000

const ether = (n) => (BigInt(n) * 10n ** 18n).toString()
const expiry = () => ({
  kind: 'expiry',
  value: new Date(EXPIRES_AT * 1000).toISOString(),
  tier: 'T0',
  label: 'expiry',
})
const scope = (selectors = [TRANSFER]) => [
  { kind: 'contract_allowlist', value: [TARGET], tier: 'T0', label: 'targets' },
  { kind: 'selector_allowlist', value: selectors, tier: 'T0', label: 'selectors' },
  { kind: 'asset_scope', value: [ASSET], tier: 'T0', label: 'assets' },
]

/** Each case: a mandate, and the actions the compiler's promise implies about it. */
const CASES = [
  {
    name: 'per-action cap refuses the action above it and allows the one below',
    constraints: [
      expiry(),
      ...scope(),
      { kind: 'per_action_cap', value: ether(10), tier: 'T0', label: '10 per action' },
    ],
    actions: [
      { amount: ether(8), allow: true },
      { amount: ether(10), allow: true, note: 'the boundary is inclusive' },
      { amount: ether(11), allow: false },
    ],
  },
  {
    name: 'session cap counts across redemptions, not just within one',
    constraints: [
      expiry(),
      ...scope(),
      { kind: 'per_action_cap', value: ether(10), tier: 'T0', label: '10 per action' },
      { kind: 'session_total_cap', value: ether(25), tier: 'T0', label: '25 in total' },
    ],
    actions: [
      { amount: ether(10), allow: true },
      { amount: ether(10), allow: true },
      { amount: ether(10), allow: false, note: '30 would pass the 25 total' },
    ],
  },
  {
    name: 'a target outside the allowlist is refused whatever the amount',
    constraints: [
      expiry(),
      { kind: 'contract_allowlist', value: [`0x${'00'.repeat(19)}ff`], tier: 'T0', label: 'other' },
      { kind: 'selector_allowlist', value: [TRANSFER], tier: 'T0', label: 'selectors' },
      { kind: 'asset_scope', value: [ASSET], tier: 'T0', label: 'assets' },
    ],
    actions: [{ amount: ether(1), allow: false }],
  },
  {
    name: 'expiry alone still binds, and small amounts pass under it',
    constraints: [expiry()],
    actions: [{ amount: ether(1), allow: true }],
  },
  {
    // The case where the declared amount is the ONLY protection. A transfer moves
    // balance, so the cap enforcers reconcile afterwards and charge whichever of
    // declared and realised is larger; a wrong amount position is caught by that
    // reconciliation and never reaches the cap. `approve` moves nothing, realised
    // is zero, and the cap has only the calldata to go on. If the compiler pointed
    // at the wrong argument here, an unlimited approval would pass a ten-unit cap
    // and nothing downstream would notice.
    name: 'a cap on approve is held up by the declared amount alone',
    constraints: [
      expiry(),
      ...scope([APPROVE]),
      { kind: 'per_action_cap', value: ether(10), tier: 'T0', label: '10 per action' },
    ],
    actions: [
      { selector: APPROVE, amount: ether(8), allow: true, moves: false },
      { selector: APPROVE, amount: ether(11), allow: false, moves: false },
    ],
  },
]

const rows = CASES.map((testCase) => {
  const { caveats, outcomes } = compileCaveats(testCase.constraints, DEPLOYMENT)
  return {
    name: testCase.name,
    asset: ASSET,
    target: TARGET,
    selector: TRANSFER,
    expiresAt: String(EXPIRES_AT),
    overallTier: overallTier(outcomes),
    caveatCount: caveats.length,
    caveats: caveats.map((c) => ({
      enforcer: byAddress.get(c.enforcer.toLowerCase()) ?? 'UNKNOWN',
      terms: c.terms,
    })),
    actionCount: testCase.actions.length,
    actions: testCase.actions.map((a) => ({
      selector: a.selector ?? TRANSFER,
      amount: a.amount,
      allow: a.allow,
      // Whether the call actually moves value from the delegator, which decides
      // both what the test may assert and whether the cap enforcers have a
      // realised amount to reconcile against at all.
      moves: a.moves ?? true,
      note: a.note ?? '',
    })),
  }
})

for (const row of rows) {
  if (row.caveats.some((c) => c.enforcer === 'UNKNOWN'))
    throw new Error(`${row.name}: compiled a caveat for an enforcer not in the deployment`)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify({ count: rows.length, rows }, null, 2)}\n`)
console.log(`wrote ${rows.length} caveat vectors to ${OUT}`)
for (const row of rows) {
  const allows = row.actions.filter((a) => a.allow).length
  console.log(
    `  ${row.overallTier}  ${row.caveatCount} caveats  ${allows} allow / ${row.actionCount - allows} deny  ${row.name}`,
  )
}
