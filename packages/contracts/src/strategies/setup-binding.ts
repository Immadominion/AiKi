import type { StrategyBinding } from './index'

/** Canonical fixed-pool order: tick price is token1 (WBNB) per token0 (USDT). */
export const STRATEGY_REVIEWED_TOKENS = {
  usdt: { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18 },
  wbnb: { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18 },
} as const

// ABI selector and keccak256 kind tags are pinned to the reviewed Solidity ABIs.
const identities = {
  yield: ['732a447f', 'fde9779a99f7ef20f4a7e65f2e1a558d610b001ce616f3e6751fce41ba2dbd07'],
  grid: ['8143dc49', 'd75c65ef4fd2ad2e6df9dbe0b23d36df04d8dc431febbb028cca25cda59b0797'],
  lp: ['f8bf97a0', '6023ffe81a935fb1746c409e1451b8c3345e54e35bb672d629cd8e221b3927c1'],
} as const
const nonzero = (value: unknown, bytes: number): value is `0x${string}` =>
  typeof value === 'string' &&
  new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`, 'i').test(value) &&
  !/^0x0+$/i.test(value)

/** Browser-safe exact ABI encoding. Structural review only; never a signature/chain proof. */
export function encodeStrategyBindingTerms(binding: StrategyBinding): `0x${string}` {
  if (
    binding?.version !== 1 ||
    binding.chainId !== 56 ||
    !Object.hasOwn(identities, binding.kind) ||
    !nonzero(binding.vault, 20) ||
    !nonzero(binding.controller, 20) ||
    binding.vault.toLowerCase() === binding.controller.toLowerCase() ||
    !nonzero(binding.policyHash, 32) ||
    !nonzero(binding.runtimeCodeHash, 32)
  )
    throw new Error('Invalid strategy binding.')
  const [selector, kind] = identities[binding.kind]
  return `0x${binding.vault.slice(2).padStart(64, '0')}${binding.policyHash.slice(2)}${binding.runtimeCodeHash.slice(2)}${selector.padEnd(64, '0')}${kind}`.toLowerCase() as `0x${string}`
}
