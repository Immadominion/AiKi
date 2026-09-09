import type { CreditBalance } from '../../lib/api'

export interface CreditRail {
  chainId: 56 | 97
  decimals: 6 | 18
  finality: 'finalized' | 'confirmations'
  token: string
  treasury: string
  pointsPerUsdt: number
  confirmations: number
}

const address = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value)

/** Offer only a complete rail whose chain and token units match the verifier. */
export function creditRail(value: unknown): CreditRail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const config = value as Record<string, unknown>
  if (
    config.available === false ||
    (config.chainId !== 56 && config.chainId !== 97) ||
    config.decimals !== (config.chainId === 56 ? 18 : 6) ||
    config.finality !== (config.chainId === 56 ? 'finalized' : 'confirmations') ||
    !address(config.token) ||
    (config.chainId === 56 &&
      config.token.toLowerCase() !== '0x55d398326f99059ff775485246999027b3197955') ||
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
    chainId: config.chainId,
    decimals: config.decimals as 6 | 18,
    finality: config.finality as 'finalized' | 'confirmations',
    token: config.token,
    treasury: config.treasury,
    pointsPerUsdt: config.pointsPerUsdt,
    confirmations: config.confirmations,
  }
}

export function creditNetworkLabel(rail: CreditRail): string {
  return rail.chainId === 56 ? 'BNB Smart Chain Mainnet' : 'BNB Smart Chain Testnet'
}

export function creditExplorer(rail: CreditRail): string {
  return rail.chainId === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com'
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
