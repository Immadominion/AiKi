import type { ProjectedPassport } from '@aiki/contracts'
import { type ExecutionNetwork, parseExecutionNetwork } from '@aiki/contracts/guardian'
import { hasCurrentLiveness } from '@aiki/contracts/probe-freshness'
import { paletteFor } from '@/components/home/live-shards'
import { AGENT_BG, AGENT_BY_KEY, type AgentKey } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'

/**
 * What the mandate builder needs to know about the thing being hired.
 *
 * The builder itself is real: it previews limits against the API's deployed
 * enforcers, creates an authorization, signs an EIP-712 delegation and opens a
 * job. All of that worked. It just could not be pointed at a real agent,
 * because it read its name, price and permissions out of the example table, so
 * the only agents on the marketplace you could actually hire were six that do
 * not exist.
 */
export interface HireSubject {
  key: string
  name: string
  initial: string
  bg: string
  /** What one run costs, as the marketplace would quote it. */
  price: string
  priceModel: string
  capabilities: { name: string; does: string; permissions: string[] }[]
  /** Explicit first-party activation, never inferred from an agent's name or category. */
  guardianActivation?: boolean
  execution?: ExecutionNetwork
  /** Assets this agent may move. Empty means it only reads. */
  spends: { asset: `0x${string}`; symbol: string; decimals: number }[]
  /** Contracts and functions the agent may call while doing its work. */
  callScope?:
    | {
        contracts: `0x${string}`[]
        selectors: string[]
        label: string
      }
    | undefined
}

export const isAgentId = (key: string) => /^\d+$/.test(key)

/** One of the six examples, so existing links keep working. */
export function hireSubjectFromFixture(key: AgentKey, execution?: ExecutionNetwork): HireSubject {
  const row = AGENT_BY_KEY[key]
  const detail = DETAILS[key]
  // Only ever called with one of the six example keys.
  if (!row || !detail) throw new Error(`No example agent called ${key}.`)
  const subject: HireSubject = {
    key,
    name: row.name,
    initial: row.initial,
    bg: AGENT_BG[key] ?? '#171715',
    price: row.price,
    priceModel: detail.priceModel,
    capabilities: detail.capabilities,
    spends: detail.spends,
    ...(key === 'guardian' ? { guardianActivation: true } : {}),
  }
  return key === 'guardian' && execution ? withGuardianNetwork(subject, execution) : subject
}

/** This exact BSC registration is the first-party Guardian, not any similarly named agent. */
export function isGuardianPassport(passport: ProjectedPassport): boolean {
  return (
    passport.agentId === '315943' &&
    passport.chainId === 56 &&
    passport.registry?.toLowerCase() === '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432' &&
    passport.identity?.tokenId === passport.agentId &&
    passport.identity.registrationFile.resolved === true &&
    passport.identity.registrationFile.reciprocalProofVerified === true &&
    hasCurrentLiveness(passport)
  )
}

export function guardianSubjectFromPassport(passport: ProjectedPassport): HireSubject {
  if (!isGuardianPassport(passport))
    throw new Error('This registration is not the verified Guardian.')
  return {
    key: passport.agentId,
    name: 'Venus Guardian',
    initial: 'V',
    bg: paletteFor(passport.agentId).bg,
    price: 'No report purchased',
    priceModel: 'Separate repayment authority; network gas still applies',
    capabilities: [],
    spends: [],
    guardianActivation: true,
  }
}

export function withGuardianNetwork(subject: HireSubject, value: ExecutionNetwork): HireSubject {
  if (!subject.guardianActivation || !['guardian', '315943'].includes(subject.key))
    throw new Error('This agent does not provide Guardian activation.')
  const execution = parseExecutionNetwork(value)
  const { guardian } = execution
  return {
    ...subject,
    execution,
    capabilities: [
      {
        name: 'Automatic Venus repayment',
        does: 'Repays USDT debt held by your mandate account, within your signed limits.',
        permissions: ['repay_borrow', 'spend_usdt'],
      },
    ],
    spends: [{ asset: guardian.asset, symbol: 'USDT', decimals: guardian.decimals }],
    callScope: {
      contracts: [guardian.market],
      selectors: [guardian.repayBorrowSelector],
      label: `the Venus USDT market on BNB ${execution.network}`,
    },
  }
}

/**
 * A real agent, from its passport and its own published price.
 *
 * `spends` is the interesting one. For the examples it was a fact somebody
 * wrote down; for a registry agent nobody knows, and the safe unknown is not
 * the empty list. An agent recorded as moving nothing gets a mandate with no
 * spend cap on it, so treating "we do not know" as "it only reads" would hand
 * out exactly the mandate a person would least want. It is assumed to be able
 * to move the settlement asset until it has been observed doing otherwise.
 */
export function hireSubjectFromPassport(
  passport: ProjectedPassport,
  quote: { price: string; asset: string; decimals: number } | null,
  settlementAsset: { address: `0x${string}`; symbol: string; decimals: number },
): HireSubject {
  const display = (passport.name ?? `Agent ${passport.agentId}`).replace(/^AiKi\s+/i, '')
  const priced = quote
    ? `${(Number(quote.price) / 10 ** quote.decimals).toFixed(3)} ${quote.asset}`
    : 'No published price'
  return {
    key: passport.agentId,
    name: display,
    initial: (display.charAt(0) || '?').toUpperCase(),
    bg: paletteFor(passport.agentId).bg,
    price: priced,
    priceModel: quote ? 'Per run, from the price it publishes' : 'Publishes no price',
    capabilities: [
      {
        name: display,
        does: passport.description ?? 'This agent publishes no description of what it does.',
        // Named as a permission the mandate can cap, because that is the point
        // of the screen this feeds.
        permissions: ['spend_settlement_asset'],
      },
    ],
    spends: [
      {
        asset: settlementAsset.address,
        symbol: settlementAsset.symbol,
        // Carried through because a spend cap is denominated in base units of
        // this asset, and the screen that sets one thinks in dollars.
        decimals: settlementAsset.decimals,
      },
    ],
  }
}
