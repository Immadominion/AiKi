import { guardianFor } from '@aiki/contracts/guardian'

/** Retained only for the explicitly named legacy fixture identity. */
export const VENUS_GUARDIAN = {
  ...guardianFor(97),
  agentId: '315943',
  label: 'USDT on Venus',
} as const

/** Select by the signed mandate account network, never the registry's network. */
export function venusGuardianFor(chainId: number) {
  return { ...guardianFor(chainId), agentId: '315943', label: 'USDT on Venus' } as const
}
