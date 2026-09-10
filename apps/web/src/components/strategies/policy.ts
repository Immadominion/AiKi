import type { StrategyKind, StrategySetupInput } from '@aiki/contracts/strategies'
import { formatUnits, parseUnits } from 'viem'

export type StrategyFormValues = Record<string, string>
export interface StrategyField {
  key: string
  label: string
  unit: 'USDT' | 'WBNB' | 'bps' | 'ticks' | 'seconds' | 'liquidity'
  hint: string
  advanced?: boolean
  initial?: string
  zero?: boolean
  negative?: boolean
}
const money = (
  key: string,
  label: string,
  unit: 'USDT' | 'WBNB',
  hint: string,
  advanced = false,
  zero = false,
): StrategyField => ({ key, label, unit, hint, advanced, zero })
const bps = (key: string, label: string, initial: string, hint: string): StrategyField => ({
  key,
  label,
  unit: 'bps',
  initial,
  hint,
  advanced: true,
  zero: true,
})
const ticks = (key: string, label: string, hint: string, negative = false): StrategyField => ({
  key,
  label,
  unit: 'ticks',
  hint,
  negative,
})
const oracle: StrategyField[] = [
  {
    key: 'twapWindow',
    label: 'Average-price window',
    unit: 'seconds',
    initial: '300',
    hint: 'Retained onchain history is required. No spot-price fallback.',
    advanced: true,
  },
  {
    key: 'maxDeviationTicks',
    label: 'Maximum spot deviation',
    unit: 'ticks',
    initial: '100',
    hint: 'Distance from the time-weighted average price.',
    advanced: true,
  },
]
export const POLICY_FIELDS: Record<StrategyKind, StrategyField[]> = {
  yield: [
    money(
      'maxPrincipal',
      'Lifetime funding limit',
      'USDT',
      'Explicit deposits only. Withdrawals do not replenish this limit.',
    ),
    money(
      'maxMove',
      'Maximum per move',
      'USDT',
      'One atomic move between idle funds, Venus and Aave.',
    ),
    money(
      'minIdle',
      'Minimum idle reserve',
      'USDT',
      'USDT retained outside lending venues.',
      false,
      true,
    ),
    money(
      'maxTurnover',
      'Lifetime movement limit',
      'USDT',
      'Moving the same capital again counts again.',
      true,
    ),
    money(
      'maxVenusExposure',
      'Maximum Venus allocation',
      'USDT',
      'No borrowing; exposure is limited to supplied USDT.',
      true,
      true,
    ),
    money(
      'maxAaveExposure',
      'Maximum Aave allocation',
      'USDT',
      'Aave V3 BNB supplied USDT only.',
      true,
      true,
    ),
    money(
      'maxLossPerMove',
      'Maximum loss per move',
      'USDT',
      'Measured execution loss, not protection from protocol failure.',
      true,
      true,
    ),
    money(
      'maxCumulativeLoss',
      'Lifetime execution-loss limit',
      'USDT',
      'Gains do not replenish this allowance.',
      true,
      true,
    ),
    bps(
      'maxLossBps',
      'Relative loss limit per move',
      '100',
      '100 basis points = 1%. The stricter absolute and relative limit applies.',
    ),
  ],
  grid: [
    ticks(
      'tickLower',
      'Lower pool tick',
      'Fixed USDT/WBNB pool range. This is a pool tick, not a USD price.',
      true,
    ),
    ticks(
      'tickUpper',
      'Upper pool tick',
      'Higher ticks mean more WBNB per USDT; neither boundary may be changed after deployment.',
      true,
    ),
    money(
      'fundingCap0',
      'Lifetime USDT funding limit',
      'USDT',
      'USDT is token 0. Only explicitly funded rung inventory may trade.',
    ),
    money(
      'fundingCap1',
      'Lifetime WBNB funding limit',
      'WBNB',
      'WBNB is token 1. Native BNB is not accepted.',
    ),
    money(
      'maxInput0',
      'Maximum USDT per trade',
      'USDT',
      'Exact-input ceiling for USDT → WBNB.',
      true,
    ),
    money(
      'maxInput1',
      'Maximum WBNB per trade',
      'WBNB',
      'Exact-input ceiling for WBNB → USDT.',
      true,
    ),
    money(
      'turnoverCap0',
      'Lifetime USDT traded',
      'USDT',
      'Reused proceeds still count toward turnover.',
      true,
    ),
    money(
      'turnoverCap1',
      'Lifetime WBNB traded',
      'WBNB',
      'Never added to the USDT limit as mixed raw units.',
      true,
    ),
    ...oracle,
    {
      key: 'minLiquidity',
      label: 'Minimum pool liquidity',
      unit: 'liquidity',
      hint: 'Raw V3 liquidity units, not tokens or dollars. Both current and historical liquidity must qualify.',
      advanced: true,
    },
    bps(
      'maxSlippageBps',
      'Maximum swap slippage',
      '100',
      '100 basis points = 1%; pool fees are checked separately.',
    ),
    bps(
      'minFillBps',
      'Minimum filled input',
      '9500',
      '9500 basis points = 95% of the requested input.',
    ),
    bps(
      'minCycleGainBps',
      'Minimum theoretical cycle spread',
      '100',
      'After both fees and slippage allowances; excludes gas and does not guarantee profit.',
    ),
    {
      key: 'hysteresisTicks',
      label: 'Rearming distance',
      unit: 'ticks',
      initial: '10',
      hint: 'The price must cross back far enough before the opposite trade can arm.',
      advanced: true,
    },
  ],
  lp: [
    money(
      'maxPositionValueQuote',
      'Maximum enrolled position value',
      'USDT',
      'One unstaked Pancake V3 USDT/WBNB NFT, valued using the average pool price.',
    ),
    ticks(
      'rangeWidth',
      'Replacement range width',
      'Whole ticks, aligned to this pool’s tick spacing. The range recenters near the average price.',
    ),
    money(
      'maxSwap0',
      'Maximum USDT swapped',
      'USDT',
      'Per replacement. A zero-swap replacement is considered first.',
      false,
      true,
    ),
    money(
      'maxSwap1',
      'Maximum WBNB swapped',
      'WBNB',
      'Per replacement, inside the same reviewed pool.',
      false,
      true,
    ),
    ...oracle,
    {
      key: 'minPoolLiquidity',
      label: 'Minimum remaining pool liquidity',
      unit: 'liquidity',
      hint: 'Raw V3 liquidity units. Must still hold after removing your old position.',
      advanced: true,
    },
    {
      key: 'maxCenterOffsetTicks',
      label: 'Maximum range-center offset',
      unit: 'ticks',
      initial: '50',
      zero: true,
      hint: 'Distance from the average-price tick.',
      advanced: true,
    },
    bps(
      'maxSwapSlippageBps',
      'Maximum swap slippage',
      '100',
      '100 basis points = 1%. Enforced for actual swap input.',
    ),
    bps(
      'maxLiquiditySlippageBps',
      'Maximum burn and mint slippage',
      '100',
      'Both removal and replacement amounts are checked atomically.',
    ),
    bps(
      'minSwapFillBps',
      'Minimum filled swap input',
      '9500',
      '9500 basis points = 95% of requested input.',
    ),
    bps(
      'minDeployedBps',
      'Minimum capital redeployed',
      '8000',
      '8000 basis points = 80%; the rest stays in the vault as tracked idle tokens.',
    ),
    money(
      'maxLossQuote',
      'Maximum loss per replacement',
      'USDT',
      'Measured across removal, swaps and minting; collected fees do not hide execution loss.',
      true,
      true,
    ),
    money(
      'maxCumulativeLossQuote',
      'Lifetime execution-loss limit',
      'USDT',
      'Not insurance against market movement or impermanent loss.',
      true,
      true,
    ),
    bps(
      'maxLossBps',
      'Relative loss per replacement',
      '100',
      'The stricter relative and absolute execution-loss limit applies.',
    ),
  ],
}
export const STRATEGY_COPY: Record<StrategyKind, { name: string; summary: string; risk: string }> =
  {
    yield: {
      name: 'USDT yield allocation',
      summary: 'Move supplied USDT between Venus, Aave and an idle reserve.',
      risk: 'No borrowing or swaps. Protocol solvency and future yields are not guaranteed.',
    },
    grid: {
      name: 'Pancake spot grid',
      summary: 'Trade explicitly funded USDT and WBNB across your fixed pool ticks.',
      risk: 'No leverage, automatic regridding or guaranteed profit. Price may leave your range.',
    },
    lp: {
      name: 'Pancake LP rebalancing',
      summary: 'Atomically replace one enrolled USDT/WBNB position within immutable limits.',
      risk: 'The vault holds replacement NFTs and idle tokens. This does not protect against impermanent loss.',
    },
  }

export function initialPolicyValues(kind: StrategyKind): StrategyFormValues {
  return {
    days: '30',
    minInterval: '300',
    maxDeadlineDelay: '120',
    gasLimitBnb: '',
    ...Object.fromEntries(POLICY_FIELDS[kind].map((field) => [field.key, field.initial ?? ''])),
  }
}
export class StrategyFieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}
export function rawAmount(
  value: string,
  label: string,
  decimals = 18,
  zero = false,
  field = label,
): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || (value.split('.')[1]?.length ?? 0) > decimals)
    throw new StrategyFieldError(
      field,
      `${label} needs a decimal amount with at most ${decimals} decimal places.`,
    )
  const raw = parseUnits(value, decimals)
  if (raw < (zero ? 0n : 1n) || raw >= 1n << 256n)
    throw new StrategyFieldError(
      field,
      `${label} must be ${zero ? 'zero or a positive' : 'a positive'} amount within the token limit.`,
    )
  return raw.toString()
}
/** Match setup admission's fixed ceiling before any API or wallet request. */
export function strategyGasLimitWei(value: string): string {
  const raw = rawAmount(value, 'Network gas ceiling', 18, false, 'gasLimitBnb')
  if (BigInt(raw) > 10n ** 15n)
    throw new StrategyFieldError('gasLimitBnb', 'Choose a network gas ceiling up to 0.001 BNB.')
  return raw
}
function integer(value: string, key: string, min: number, max: number) {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value) || value === '-0')
    throw new StrategyFieldError(key, 'Use a whole number, without spaces or scientific notation.')
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new StrategyFieldError(
      key,
      `Choose a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.`,
    )
  return n
}
export interface GridRungForm {
  buyTick: string
  sellTick: string
  lot0: string
  lot1: string
  initialSell: boolean
}
export const emptyRung = (): GridRungForm => ({
  buyTick: '',
  sellTick: '',
  lot0: '',
  lot1: '',
  initialSell: true,
})

/** Display amounts become exact canonical base-unit strings once, before API preparation.
 * Protocol identity and economic policy acceptance remain independently checked by the API/factory. */
export function buildStrategyInput(
  kind: StrategyKind,
  controller: `0x${string}`,
  values: StrategyFormValues,
  rungs: GridRungForm[],
  nowSeconds: bigint,
  retainedExpiry?: string,
): StrategySetupInput {
  const days = integer(values.days ?? '', 'days', 1, 365)
  if (!/^0x[0-9a-f]{40}$/i.test(controller) || /^0x0{40}$/i.test(controller))
    throw new StrategyFieldError('controller', 'Create and verify your mandate account first.')
  const policy = Object.fromEntries(
    POLICY_FIELDS[kind].map((field) => {
      const value = values[field.key] ?? ''
      if (field.unit === 'USDT' || field.unit === 'WBNB')
        return [field.key, rawAmount(value, field.label, 18, field.zero, field.key)]
      if (field.unit === 'liquidity') {
        const raw = rawAmount(value, field.label, 0, false, field.key)
        if (BigInt(raw) >= 1n << 128n)
          throw new StrategyFieldError(field.key, 'Pool liquidity must fit a uint128 value.')
        return [field.key, raw]
      }
      return [
        field.key,
        integer(
          value,
          field.key,
          field.negative ? -887272 : field.zero ? 0 : 1,
          field.unit === 'bps' ? 10000 : field.unit === 'seconds' ? 86400 : 887272,
        ),
      ]
    }),
  )
  const expiresAt = retainedExpiry ?? (nowSeconds + BigInt(days) * 86400n).toString()
  if (
    !/^[1-9][0-9]*$/.test(expiresAt) ||
    BigInt(expiresAt) <= nowSeconds ||
    BigInt(expiresAt) >= 1n << 64n
  )
    throw new StrategyFieldError(
      'days',
      'This retained setup has expired. Review a new policy before continuing.',
    )
  const common = {
    expiresAt,
    minInterval: integer(values.minInterval ?? '', 'minInterval', 0, 2592000),
    maxDeadlineDelay: integer(values.maxDeadlineDelay ?? '', 'maxDeadlineDelay', 1, 3600),
  }
  const base = { version: 1 as const, chainId: 56 as const, controller, common }
  if (kind === 'grid') {
    if (!rungs.length || rungs.length > 32)
      throw new StrategyFieldError('rungs', 'Add between one and 32 grid rungs.')
    return {
      ...base,
      kind,
      policy,
      rungs: rungs.map((rung, index) => ({
        buyTick: integer(rung.buyTick, `rung-${index}-buyTick`, -887272, 887272),
        sellTick: integer(rung.sellTick, `rung-${index}-sellTick`, -887272, 887272),
        lot0: rawAmount(rung.lot0, 'USDT lot size', 18, false, `rung-${index}-lot0`),
        lot1: rawAmount(rung.lot1, 'WBNB lot size', 18, false, `rung-${index}-lot1`),
        initialSell: rung.initialSell,
      })),
    } as StrategySetupInput
  }
  return { ...base, kind, policy } as StrategySetupInput
}

export function displayPolicyValue(field: StrategyField, value: unknown): string {
  if (
    (field.unit === 'USDT' || field.unit === 'WBNB') &&
    typeof value === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(value)
  )
    return `${formatUnits(BigInt(value), 18)} ${field.unit}`
  return `${String(value)} ${field.unit}`
}
