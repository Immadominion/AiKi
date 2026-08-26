// Generates test/vectors/policy-vectors.json by driving the REAL evaluatePolicy.
//
// This file imports apps/api/src/authority/policy.ts directly (Node 24 strips the types), so
// the expected verdicts in the corpus are produced by the off-chain evaluator itself and not
// by a transcription of it. A transcription can drift; this cannot.
//
//   node onchain/tools/gen-vectors.mjs
//
// The corpus is replayed by test/Parity.t.sol. Both sides go red when either moves.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const POLICY = resolve(HERE, '../../apps/api/src/authority/policy.ts')
const { compilePolicy, evaluatePolicy } = await import(POLICY)

const OUT = resolve(HERE, '../test/vectors/policy-vectors.json')

// ---------------------------------------------------------------------------------------
// Value pools.
//
// Every allowlist entry is a canonical lowercase 0x-prefixed 40-hex address and every selector
// is a canonical lowercase 0x-prefixed 8-hex string. That is deliberate and it is the ONLY way
// the two evaluators can be compared at all: evaluatePolicy compares lowercased STRINGS, so it
// happily accepts '0xvenus' (the existing unit test does exactly that) and treats '0x1',
// '0x01' and '0x00000001' as three different values. A 20-byte address and a bytes4 have no
// such freedom. The compiler must reject anything that is not already canonical; a corpus
// built on non-canonical values would be comparing two different predicates.
//
// asset values are ADDRESSES here for the same reason. Off chain Money.asset is a symbol
// ('USDT', 'BNB', and policy.test.ts uses 'u'); the chain knows only addresses. An asset_scope
// expressed in symbols is not chain-enforceable at all.
const TARGETS = [
  '0x00000000000000000000000000000000000000a1',
  '0x00000000000000000000000000000000000000a2',
  '0x00000000000000000000000000000000000000a3',
  '0x00000000000000000000000000000000000000a4',
]
const ASSETS = [
  '0x00000000000000000000000000000000000000d1',
  '0x00000000000000000000000000000000000000d2',
  '0x00000000000000000000000000000000000000d3',
]
const SELECTORS = ['0xa9059cbb', '0x23b872dd', '0x095ea7b3', '0xdeadbeef', '0x0e752702']

const BASE_AT = 1_800_000_000 // whole seconds; well past 2026 so nothing is in the past

const iso = (sec) => new Date(sec * 1000).toISOString()

// Deterministic PRNG so the corpus is reproducible byte for byte.
function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(0x41694b69) // "AiKi"
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]

const rows = []

// `constraints` here is the normalised on-chain-friendly shape. `toOffChain` turns each entry
// back into the exact `Constraint` object evaluatePolicy consumes.
function toOffChain(c) {
  if (c.kind === 'per_action_cap' || c.kind === 'session_total_cap') {
    return { kind: c.kind, label: c.kind, value: c.cap, tier: 'T0' }
  }
  if (c.kind === 'expiry') {
    return { kind: 'expiry', label: 'expiry', value: iso(Number(c.expiry)), tier: 'T0' }
  }
  return { kind: c.kind, label: c.kind, value: c.values, tier: 'T0' }
}

function addRow(name, constraints, action, spent) {
  const policy = compilePolicy(constraints.map(toOffChain))
  const offChainAction = {
    target: action.target,
    selector: action.selector,
    asset: action.asset,
    amount: BigInt(action.amount),
    at: iso(Number(action.at)),
  }
  const expect = evaluatePolicy(policy, offChainAction, BigInt(spent))

  const expiryC = constraints.find((c) => c.kind === 'expiry')
  rows.push({
    name,
    constraintCount: constraints.length,
    // Whole seconds, or "0" meaning the policy carries no expiry constraint at all. The chain
    // REQUIRES an expiry caveat (see AiKiDelegationManager._validate), so the harness compiles
    // an explicit far-future expiry in that case. An unbounded mandate must sign its
    // unboundedness rather than omit it.
    expirySeconds: expiryC ? String(expiryC.expiry) : '0',
    constraints: constraints.map((c) => ({
      kind: c.kind,
      values: c.values ?? [],
      cap: c.cap ?? '0',
      expiry: c.expiry ?? '0',
    })),
    action: {
      target: action.target,
      selector: action.selector,
      asset: action.asset,
      amount: String(action.amount),
      at: String(action.at),
    },
    spent: String(spent),
    expect: { allow: expect.allow, rule: expect.rule, reason: expect.reason },
  })
}

const allow = (kind, values) => ({ kind, values })
const cap = (kind, c) => ({ kind, cap: String(c) })
const exp = (sec) => ({ kind: 'expiry', expiry: String(sec) })
const act = (o) => ({
  target: TARGETS[0],
  selector: SELECTORS[0],
  asset: ASSETS[0],
  amount: '100',
  at: String(BASE_AT),
  ...o,
})

// ---------------------------------------------------------------------------------------
// 1. Hand-written boundary cases. Every one of these is a place where an off-by-one or a
//    reflexive shortcut silently widens the mandate.

addRow(
  'contract_allowlist: target present',
  [allow('contract_allowlist', [TARGETS[0]])],
  act({}),
  0,
)
addRow('contract_allowlist: target absent', [allow('contract_allowlist', [TARGETS[1]])], act({}), 0)
addRow(
  'contract_allowlist: match at last position',
  [allow('contract_allowlist', [TARGETS[1], TARGETS[2], TARGETS[0]])],
  act({}),
  0,
)
// THE inversion. [].includes(x) is always false, so an empty allowlist denies EVERYTHING.
// `if (terms.length == 0) return; // no restriction` turns this into allow-all.
addRow(
  'contract_allowlist: EMPTY list denies everything',
  [allow('contract_allowlist', [])],
  act({}),
  0,
)

addRow(
  'selector_allowlist: selector present',
  [allow('selector_allowlist', [SELECTORS[0]])],
  act({}),
  0,
)
addRow(
  'selector_allowlist: selector absent',
  [allow('selector_allowlist', [SELECTORS[1]])],
  act({}),
  0,
)
addRow(
  'selector_allowlist: EMPTY list denies everything',
  [allow('selector_allowlist', [])],
  act({}),
  0,
)

addRow('asset_scope: asset in scope', [allow('asset_scope', [ASSETS[0]])], act({}), 0)
addRow('asset_scope: asset out of scope', [allow('asset_scope', [ASSETS[1]])], act({}), 0)
addRow('asset_scope: EMPTY scope denies everything', [allow('asset_scope', [])], act({}), 0)

// policy.ts line 64 denies on `amount > cap`, so equality is ALLOWED. `require(amount < cap)`
// is off by one and breaks "spend exactly your cap".
addRow('per_action_cap: amount below cap', [cap('per_action_cap', 100)], act({ amount: '99' }), 0)
addRow(
  'per_action_cap: amount EQUALS cap (allowed)',
  [cap('per_action_cap', 100)],
  act({ amount: '100' }),
  0,
)
addRow(
  'per_action_cap: amount cap+1 (denied)',
  [cap('per_action_cap', 100)],
  act({ amount: '101' }),
  0,
)
addRow(
  'per_action_cap: zero cap, zero amount (allowed)',
  [cap('per_action_cap', 0)],
  act({ amount: '0' }),
  0,
)
addRow(
  'per_action_cap: zero cap, one wei (denied)',
  [cap('per_action_cap', 0)],
  act({ amount: '1' }),
  0,
)
addRow(
  'per_action_cap: 18-decimal magnitudes',
  [cap('per_action_cap', '250000000000000000000')],
  act({ amount: '250000000000000000000' }),
  0,
)

// policy.ts line 66 denies on `spent + amount > cap`; equality allowed; check is prospective.
addRow('session_total_cap: room left', [cap('session_total_cap', 100)], act({ amount: '10' }), 50)
addRow(
  'session_total_cap: spent + amount EQUALS cap (allowed)',
  [cap('session_total_cap', 100)],
  act({ amount: '50' }),
  50,
)
addRow(
  'session_total_cap: spent + amount is cap+1 (denied)',
  [cap('session_total_cap', 100)],
  act({ amount: '51' }),
  50,
)
addRow(
  'session_total_cap: budget exhausted, zero amount (allowed)',
  [cap('session_total_cap', 100)],
  act({ amount: '0' }),
  100,
)
addRow(
  'session_total_cap: budget exhausted, one wei (denied)',
  [cap('session_total_cap', 100)],
  act({ amount: '1' }),
  100,
)

// policy.ts line 54 denies on `at >= expiresAt`, so equality DENIES and the on-chain condition
// is `block.timestamp < expiresAt` -- strictly less-than.
addRow('expiry: one second before deadline', [exp(BASE_AT + 1)], act({ at: String(BASE_AT) }), 0)
addRow('expiry: exactly AT the deadline (denied)', [exp(BASE_AT)], act({ at: String(BASE_AT) }), 0)
addRow('expiry: one second after deadline', [exp(BASE_AT - 1)], act({ at: String(BASE_AT) }), 0)

// Ordering. evaluatePolicy returns the FIRST failing constraint, so which rule a user sees
// depends on array order -- and the chain must agree, or the receipt disagrees with the chain.
addRow(
  'ordering: allowlist first, both fail -> reports contract_allowlist',
  [allow('contract_allowlist', [TARGETS[1]]), cap('per_action_cap', 1)],
  act({ amount: '100' }),
  0,
)
addRow(
  'ordering: cap first, both fail -> reports per_action_cap',
  [cap('per_action_cap', 1), allow('contract_allowlist', [TARGETS[1]])],
  act({ amount: '100' }),
  0,
)
// Expiry is HOISTED out of the loop (policy.ts line 54), so it is reported first no matter
// where it sits in the array. The chain compiles it to caveat index 0 to match.
addRow(
  'ordering: expiry is hoisted and wins over an earlier failing allowlist',
  [allow('contract_allowlist', [TARGETS[1]]), exp(BASE_AT)],
  act({ at: String(BASE_AT) }),
  0,
)

addRow(
  'full mandate: everything passes',
  [
    exp(BASE_AT + 3600),
    allow('contract_allowlist', [TARGETS[0], TARGETS[1]]),
    allow('selector_allowlist', [SELECTORS[0]]),
    allow('asset_scope', [ASSETS[0]]),
    cap('per_action_cap', '1000'),
    cap('session_total_cap', '5000'),
  ],
  act({ amount: '250' }),
  1000,
)
addRow(
  'full mandate: session cap is the binding constraint',
  [
    exp(BASE_AT + 3600),
    allow('contract_allowlist', [TARGETS[0]]),
    allow('selector_allowlist', [SELECTORS[0]]),
    allow('asset_scope', [ASSETS[0]]),
    cap('per_action_cap', '1000'),
    cap('session_total_cap', '5000'),
  ],
  act({ amount: '250' }),
  4800,
)

// ---------------------------------------------------------------------------------------
// 2. Fuzz sweep. Random constraint subsets, orders, and actions, all scored by the real
//    evaluatePolicy. Kinds are unique per row: the manager rejects duplicate enforcer
//    addresses outright (a stateful enforcer double-counts under duplication while
//    evaluatePolicy shares one counter), and that intentional divergence has its own test.
const KINDS = [
  'expiry',
  'contract_allowlist',
  'selector_allowlist',
  'asset_scope',
  'per_action_cap',
  'session_total_cap',
]

for (let i = 0; i < 160; i++) {
  const action = act({
    target: pick(TARGETS),
    selector: pick(SELECTORS),
    asset: pick(ASSETS),
    amount: String(Math.floor(rnd() * 400)),
    at: String(BASE_AT),
  })
  const spent = Math.floor(rnd() * 400)

  const chosen = KINDS.filter(() => rnd() < 0.55)
  if (chosen.length === 0) chosen.push(pick(KINDS))
  // shuffle
  for (let j = chosen.length - 1; j > 0; j--) {
    const k = Math.floor(rnd() * (j + 1))
    ;[chosen[j], chosen[k]] = [chosen[k], chosen[j]]
  }

  // Biased so that roughly half the corpus lands on the allow path. An all-deny corpus proves
  // only that the chain says no a lot, which a contract that reverts unconditionally would
  // also pass.
  const constraints = chosen.map((kind) => {
    if (kind === 'expiry') {
      return exp(BASE_AT + (rnd() < 0.72 ? 1 + Math.floor(rnd() * 600) : -Math.floor(rnd() * 3)))
    }
    if (kind === 'per_action_cap') {
      // Straddle the boundary deliberately: exactly the amount, one under, one over.
      const a = Number(action.amount)
      const r = rnd()
      if (r < 0.25) return cap(kind, a)
      if (r < 0.4) return cap(kind, Math.max(0, a - 1))
      if (r < 0.7) return cap(kind, a + Math.floor(rnd() * 200))
      return cap(kind, Math.floor(rnd() * 400))
    }
    if (kind === 'session_total_cap') {
      const total = Number(action.amount) + spent
      const r = rnd()
      if (r < 0.25) return cap(kind, total)
      if (r < 0.4) return cap(kind, Math.max(0, total - 1))
      if (r < 0.7) return cap(kind, total + Math.floor(rnd() * 200))
      return cap(kind, Math.floor(rnd() * 800))
    }
    const pool =
      kind === 'selector_allowlist' ? SELECTORS : kind === 'asset_scope' ? ASSETS : TARGETS
    const hit =
      kind === 'selector_allowlist'
        ? action.selector
        : kind === 'asset_scope'
          ? action.asset
          : action.target
    const values = []
    if (rnd() < 0.65) values.push(hit)
    const n = Math.floor(rnd() * 3) // 0 entries is a real and important case
    for (let k = 0; k < n; k++) {
      const v = pick(pool)
      if (!values.includes(v)) values.push(v)
    }
    // shuffle so a hit is not always at index 0
    for (let j = values.length - 1; j > 0; j--) {
      const k = Math.floor(rnd() * (j + 1))
      ;[values[j], values[k]] = [values[k], values[j]]
    }
    return allow(kind, values)
  })

  addRow(`fuzz #${i}`, constraints, action, spent)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify({ count: rows.length, rows }, null, 1)}\n`)

const denies = rows.filter((r) => !r.expect.allow).length
console.log(
  `wrote ${rows.length} vectors (${rows.length - denies} allow / ${denies} deny) -> ${OUT}`,
)
const byRule = {}
for (const r of rows) byRule[r.expect.rule] = (byRule[r.expect.rule] ?? 0) + 1
console.log('rule coverage:', byRule)
