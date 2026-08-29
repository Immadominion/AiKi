import { type Address, encodeAbiParameters, type Hex } from 'viem'
import type { EnforcerDeployment } from '../config/enforcers.js'
import { ClientError } from '../http/errors.js'
import type { Constraint } from './policy.js'

/**
 * The seam between what a person asked for and what a chain can hold.
 *
 * `policy.ts` is the normative meaning of a mandate and it is deliberately
 * off-chain: it decides whether an action is permitted. This file is the other
 * half, and it is the reason a mandate can be more than an opinion. It turns the
 * same constraints into the caveats the deployed enforcers read, so the limit a
 * user set in the builder is the limit the chain itself refuses to exceed.
 *
 * It compiles what it can and is explicit about what it cannot. A constraint
 * with no enforcer behind it does not silently vanish and does not silently
 * become weaker: it comes back marked T2 with the reason, and the UI is expected
 * to say that rather than render a badge the chain will not honour.
 */

/** The on-wire caveat shape the manager and the enforcers agree on. */
export interface CompiledCaveat {
  enforcer: Address
  terms: Hex
  args: Hex
}

export interface ConstraintOutcome {
  constraint: Constraint
  /** T0 only when a registered enforcer actually holds this on chain. */
  tier: 'T0' | 'T2'
  enforcer: string | null
  /** Said out loud next to the control, never buried. */
  why: string
}

export interface CaveatCompilation {
  caveats: CompiledCaveat[]
  outcomes: ConstraintOutcome[]
}

/** Matches `Constants.MAX_ALLOWLIST` in Types.sol. Exceeding it reverts as InvalidTerms. */
const MAX_ALLOWLIST = 32

/**
 * Where the amount sits in a call's arguments, per selector.
 *
 * `AmountSite.argIndex` is the zero-based word after the selector, and the
 * enforcers fail closed when a site does not resolve. A cap over calldata whose
 * shape we cannot read is not a cap, so an unknown selector is refused here
 * rather than compiled into a caveat that would revert every action it touched.
 */
const AMOUNT_ARG_INDEX: Record<string, number> = {
  '0xa9059cbb': 1, // transfer(address,uint256)
  '0x23b872dd': 2, // transferFrom(address,address,uint256)
  '0x095ea7b3': 1, // approve(address,uint256)
}

const AMOUNT_SITE_TUPLE = {
  name: 'sites',
  type: 'tuple[]',
  components: [
    { name: 'target', type: 'address' },
    { name: 'selector', type: 'bytes4' },
    { name: 'asset', type: 'address' },
    { name: 'argIndex', type: 'uint8' },
  ],
} as const

const listOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String).map((v) => v.toLowerCase()) : []

/** Packed, unpadded, exactly as AllowedTargetsEnforcer and AllowedSelectorsEnforcer slice it. */
const pack = (values: string[]): Hex =>
  `0x${values.map((v) => v.replace(/^0x/, '')).join('')}` as Hex

interface AmountSite {
  target: Address
  selector: Hex
  asset: Address
  argIndex: number
}

/**
 * Every (target, selector, asset) a cap could be charged against.
 *
 * A cap enforcer is handed the sites it should look at; anything not listed
 * resolves to nothing and is refused. So a cap is only expressible once the
 * mandate has already said which contracts, which functions and which assets are
 * in play, which is the right order anyway: "at most ten" is meaningless until
 * you have said ten of what, sent where.
 */
function sitesFor(targets: string[], selectors: string[], asset: string): AmountSite[] {
  const sites: AmountSite[] = []
  for (const target of targets) {
    for (const selector of selectors) {
      const argIndex = AMOUNT_ARG_INDEX[selector]
      if (argIndex === undefined) continue
      sites.push({
        target: target as Address,
        selector: selector as Hex,
        asset: asset as Address,
        argIndex,
      })
    }
  }
  return sites
}

const capTerms = (asset: string, cap: bigint, sites: AmountSite[]): Hex =>
  encodeAbiParameters(
    [{ name: 'asset', type: 'address' }, { name: 'cap', type: 'uint256' }, AMOUNT_SITE_TUPLE],
    [asset as Address, cap, sites],
  )

const soft = (constraint: Constraint, why: string): ConstraintOutcome => ({
  constraint,
  tier: 'T2',
  enforcer: null,
  why,
})

/**
 * Compile a mandate into caveats the deployed suite will hold.
 *
 * Throws only for a mandate that cannot be signed at all. Everything else is
 * reported per constraint, because a mandate where three limits are on chain and
 * one is not is a real and useful thing, provided nobody is told otherwise.
 */
export function compileCaveats(
  constraints: Constraint[],
  deployment: EnforcerDeployment,
): CaveatCompilation {
  const at = (name: string): Address | null =>
    (deployment.enforcers.find((e) => e.name === name)?.address as Address) ?? null

  const expiryEnforcer = at('ExpiryEnforcer')
  if (!expiryEnforcer)
    throw new ClientError('This deployment has no expiry enforcer, so no mandate can be signed.', {
      code: 'NO_EXPIRY_ENFORCER',
    })

  const expiry = constraints.find((c) => c.kind === 'expiry')
  /*
   * Not a preference. The manager reads `caveats[0].enforcer` and reverts with
   * MissingExpiryCaveat when it is not the expiry enforcer it was constructed
   * with, precisely so an unbounded standing authorization cannot be signed by
   * accident. A mandate without an expiry is authority that never lapses.
   */
  if (!expiry || typeof expiry.value !== 'string')
    throw new ClientError('A mandate must carry an expiry before it can be held on chain.', {
      code: 'EXPIRY_REQUIRED',
    })
  const expiresAt = Date.parse(expiry.value)
  if (Number.isNaN(expiresAt))
    throw new ClientError('Expiry must be ISO-8601.', { code: 'EXPIRY_INVALID' })

  const caveats: CompiledCaveat[] = [
    {
      enforcer: expiryEnforcer,
      terms: encodeAbiParameters(
        [{ name: 'expiresAt', type: 'uint256' }],
        [BigInt(Math.floor(expiresAt / 1000))],
      ),
      args: '0x',
    },
  ]
  const outcomes: ConstraintOutcome[] = [
    {
      constraint: expiry,
      tier: 'T0',
      enforcer: 'ExpiryEnforcer',
      why: 'The chain refuses any action after this time.',
    },
  ]

  const targets = listOf(constraints.find((c) => c.kind === 'contract_allowlist')?.value)
  const selectors = listOf(constraints.find((c) => c.kind === 'selector_allowlist')?.value)
  const assets = listOf(constraints.find((c) => c.kind === 'asset_scope')?.value)

  for (const constraint of constraints) {
    if (constraint.kind === 'expiry') continue

    if (constraint.kind === 'contract_allowlist' || constraint.kind === 'selector_allowlist') {
      const isTargets = constraint.kind === 'contract_allowlist'
      const values = isTargets ? targets : selectors
      const name = isTargets ? 'AllowedTargetsEnforcer' : 'AllowedSelectorsEnforcer'
      const enforcer = at(name)
      const width = isTargets ? 40 : 8
      if (!enforcer) {
        outcomes.push(soft(constraint, `No ${name} is deployed, so AiKi counts this instead.`))
        continue
      }
      // Empty terms would mean "no restriction" to the enforcer, turning a
      // deny-list into an allow-all. An allowlist of nothing is not a mandate.
      if (values.length === 0) {
        outcomes.push(soft(constraint, 'This list is empty, so there is nothing to enforce.'))
        continue
      }
      if (values.length > MAX_ALLOWLIST) {
        outcomes.push(
          soft(constraint, `More than ${MAX_ALLOWLIST} entries cannot be held on chain.`),
        )
        continue
      }
      if (values.some((v) => v.replace(/^0x/, '').length !== width)) {
        outcomes.push(soft(constraint, 'One of these entries is not the right length.'))
        continue
      }
      caveats.push({ enforcer, terms: pack(values), args: '0x' })
      outcomes.push({
        constraint,
        tier: 'T0',
        enforcer: name,
        why: 'The chain refuses anything outside this list.',
      })
      continue
    }

    if (constraint.kind === 'asset_scope') {
      const enforcer = at('AssetScopeEnforcer')
      const sites = assets.flatMap((asset) => sitesFor(targets, selectors, asset))
      if (!enforcer || assets.length === 0 || sites.length === 0) {
        outcomes.push(
          soft(
            constraint,
            'An asset scope needs the contracts and functions it applies to before the chain can hold it.',
          ),
        )
        continue
      }
      caveats.push({
        enforcer,
        terms: encodeAbiParameters(
          [{ name: 'scoped', type: 'address[]' }, AMOUNT_SITE_TUPLE],
          [assets as Address[], sites.slice(0, MAX_ALLOWLIST)],
        ),
        args: '0x',
      })
      outcomes.push({
        constraint,
        tier: 'T0',
        enforcer: 'AssetScopeEnforcer',
        why: 'The chain refuses a call that moves anything else.',
      })
      continue
    }

    if (constraint.kind === 'per_action_cap' || constraint.kind === 'session_total_cap') {
      const perAction = constraint.kind === 'per_action_cap'
      const name = perAction ? 'PerActionCapEnforcer' : 'SessionTotalCapEnforcer'
      const enforcer = at(name)
      let cap: bigint
      try {
        cap = BigInt(String(constraint.value))
      } catch {
        outcomes.push(soft(constraint, 'This cap is not a whole number of base units.'))
        continue
      }
      if (!enforcer) {
        outcomes.push(soft(constraint, `No ${name} is deployed, so AiKi counts this instead.`))
        continue
      }
      /*
       * A cap is denominated in exactly one asset: CapTermsLib refuses a call
       * that moves a different one rather than pricing it. With several assets in
       * scope the honest compilation is one caveat each, which means "ten of
       * this AND ten of that", not ten across both. Saying so is the point;
       * combining them would need a price and there is no oracle here.
       */
      const usable = assets.filter((asset) => sitesFor(targets, selectors, asset).length > 0)
      if (usable.length === 0) {
        outcomes.push(
          soft(
            constraint,
            'A cap needs the asset, contracts and functions it applies to before the chain can read an amount out of a call.',
          ),
        )
        continue
      }
      for (const asset of usable) {
        caveats.push({
          enforcer,
          terms: capTerms(asset, cap, sitesFor(targets, selectors, asset).slice(0, MAX_ALLOWLIST)),
          args: '0x',
        })
      }
      outcomes.push({
        constraint,
        tier: 'T0',
        enforcer: name,
        why:
          usable.length === 1
            ? 'The chain refuses an action over this amount.'
            : `The chain refuses an action over this amount, separately for each of the ${usable.length} assets in scope.`,
      })
      continue
    }

    // `condition` and anything added later: no enforcer exists, so it is counted
    // by AiKi before relaying and must never render as T0.
    outcomes.push(
      soft(constraint, 'No contract can hold this one, so AiKi counts it before relaying.'),
    )
  }

  return { caveats, outcomes }
}

/** The weakest link, which is the only honest headline for a mandate. */
export const overallTier = (outcomes: ConstraintOutcome[]): 'T0' | 'T2' =>
  outcomes.every((o) => o.tier === 'T0') ? 'T0' : 'T2'

/**
 * What a mandate's limits are actually worth, decided here rather than accepted.
 *
 * `Constraint.tier` arrives from whoever posted the mandate, and `compilePolicy`
 * reduced those claimed tiers into `weakestTier`, so a caller could assert T0 on
 * every line and the API would store and serve it back having checked nothing.
 * That is the API vouching for enforcement it never verified, which is the same
 * fault `003201a` closed for the numbers on the dashboard.
 *
 * The tier is a fact about the deployed enforcer set, so it is derived from
 * trying to compile against that set. Never throws: a mandate that cannot be
 * held on chain at all is not an error, it is a mandate AiKi counts, and it has
 * to be able to say so.
 */
export function describeEnforcement(
  constraints: Constraint[],
  deployment: EnforcerDeployment | undefined,
): { tier: 'T0' | 'T2'; network: string | null; audited: boolean; outcomes: ConstraintOutcome[] } {
  const counted = (why: string) => ({
    tier: 'T2' as const,
    network: deployment?.network ?? null,
    audited: deployment?.audited ?? false,
    outcomes: constraints.map((constraint) => soft(constraint, why)),
  })

  if (!deployment)
    return counted('No enforcers are deployed for this API, so AiKi counts every limit.')

  try {
    const { outcomes } = compileCaveats(constraints, deployment)
    return {
      tier: overallTier(outcomes),
      network: deployment.network,
      audited: deployment.audited,
      outcomes,
    }
  } catch (error) {
    // The mandate cannot be signed at all: no expiry, or none the chain can read.
    // Every limit in it is therefore counted by AiKi, and the reason is the one
    // the compiler gave rather than a summary of it.
    return counted(error instanceof Error ? error.message : 'This mandate cannot be held on chain.')
  }
}

/**
 * The same constraints, each carrying the tier it actually earned.
 *
 * Handed to `compilePolicy` so the stored mandate and its `weakestTier` describe
 * what is enforced rather than what was asserted.
 */
export const withDerivedTiers = (outcomes: ConstraintOutcome[]): Constraint[] =>
  outcomes.map((o) => ({ ...o.constraint, tier: o.tier }))
