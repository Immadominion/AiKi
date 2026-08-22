import type { Money } from '@aiki/contracts'
import { cn } from '@/lib/cn'

/**
 * Money, rendered from integer minor units.
 *
 * `decimals` ALWAYS comes from the payload. USDT on BSC is 18, not 6 — assuming 6
 * makes every amount wrong by a factor of 10^12, and it is the highest-frequency
 * bug risk in the whole codebase. There is deliberately no default.
 */
export function formatMoney(m: Money, maxFrac = 2): string {
  const negative = m.amount.startsWith('-')
  const raw = negative ? m.amount.slice(1) : m.amount
  const padded = raw.padStart(m.decimals + 1, '0')
  const whole = padded.slice(0, padded.length - m.decimals) || '0'
  const frac = m.decimals > 0 ? padded.slice(padded.length - m.decimals) : ''

  const wholeFmt = Number(whole).toLocaleString('en-US')
  const fracTrimmed = frac.slice(0, maxFrac).replace(/0+$/, '')

  return `${negative ? '-' : ''}${wholeFmt}${fracTrimmed ? `.${fracTrimmed}` : ''}`
}

export function MoneyValue({
  value,
  showAsset = true,
  className,
}: {
  value: Money
  showAsset?: boolean
  className?: string
}) {
  return (
    <span className={cn('tnum whitespace-nowrap', className)}>
      {formatMoney(value)}
      {showAsset && <span className="ml-1 text-grey-500">{value.asset}</span>}
    </span>
  )
}
