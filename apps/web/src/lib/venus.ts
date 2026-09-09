export const VENUS_GUARDIAN = {
  agentId: '315943',
  chainId: 97,
  asset: '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c' as `0x${string}`,
  market: '0xb7526572FFE56AB9D7489838Bf2E18e3323b441A' as `0x${string}`,
  repayBorrowSelector: '0x0e752702',
  label: 'USDT on Venus',
} as const

const MAINNET_GUARDIAN = {
  ...VENUS_GUARDIAN,
  chainId: 56,
  asset: '0x55d398326f99059fF775485246999027B3197955' as `0x${string}`,
  market: '0xfD5840Cd36d94D7229439859C0112a4185BC0255' as `0x${string}`,
} as const

/** Select by the signed mandate account network, never the registry's network. */
export function venusGuardianFor(chainId: number) {
  if (chainId === 56) return MAINNET_GUARDIAN
  if (chainId === 97) return VENUS_GUARDIAN
  throw new Error('This network is not supported for Venus repayment.')
}
