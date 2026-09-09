import type { CreditBalance } from '../../lib/api'

export interface CreditRail {
  chainId: 97
  token: string
  treasury: string
  pointsPerUsdt: number
  confirmations: number
}

const address = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value)

/** Match the only payment chain the current deposit verifier supports. */
export function creditRail(value: unknown): CreditRail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const config = value as Record<string, unknown>
  if (
    config.available === false ||
    config.chainId !== 97 ||
    !address(config.token) ||
    !address(config.treasury) ||
    typeof config.pointsPerUsdt !== 'number' ||
    !Number.isSafeInteger(config.pointsPerUsdt) ||
    config.pointsPerUsdt <= 0 ||
    typeof config.confirmations !== 'number' ||
    !Number.isSafeInteger(config.confirmations) ||
    config.confirmations < 1
  )
    return null
  return {
    chainId: 97,
    token: config.token,
    treasury: config.treasury,
    pointsPerUsdt: config.pointsPerUsdt,
    confirmations: config.confirmations,
  }
}

export function canVerifyDeposit(rail: CreditRail | null, wallet: string): boolean {
  return Boolean(rail && address(wallet) && rail.treasury.toLowerCase() !== wallet.toLowerCase())
}

export function paymentHash(value: string): string {
  const hash = value.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error(
      'Paste the complete transaction hash, starting with 0x and followed by 64 characters.',
    )
  return hash.toLowerCase()
}

/** Ledger points are whole integers, not a rounded token balance. */
export function points(value: unknown, signed = false): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return '--'
  const normalized = Object.is(value, -0) ? 0 : value
  return `${signed && normalized > 0 ? '+' : ''}${normalized.toLocaleString('en-US')}`
}

export function creditEntryLabel(reason: string, delta: number): string {
  const labels: Record<string, string> = {
    welcome: 'Welcome points',
    deposit: 'Points added',
    fast_mode: 'Fast mode usage',
    job_funding: 'Work payment reserved',
    job_earnings: 'Work earnings',
    job_refund: 'Work refund',
    platform_fee: 'Marketplace fee',
  }
  if (reason === 'fast_mode_hold')
    return delta < 0 ? 'Reserved for a Fast turn' : 'Unused Fast points returned'
  return labels[reason] ?? 'Points adjustment'
}

export function creditLimitRows(limits: CreditBalance['limits']) {
  if (!limits) return []
  return [
    ['Fast turns per minute', limits.walletPerMinute, ''],
    ['Active turns per wallet', limits.walletConcurrent, ''],
    ['Maximum held per turn', limits.maximumTurnPoints, ' points'],
    ['Your rolling 24-hour limit', limits.walletDailyPoints, ' points'],
    ['All-wallet rolling 24-hour limit', limits.globalDailyPoints, ' points'],
    ['Active turns across AiKi', limits.globalConcurrent, ''],
  ].map(([label, value, unit]) => ({ label: String(label), value: `${points(value)}${unit}` }))
}
