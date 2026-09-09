import type { Address, Hex } from 'viem'
import { deploymentAddress } from './attempts.js'
import { MANDATE_ACCOUNT_BYTECODE } from './bytecode.js'

// Compiler-derived offsets, pinned against the full artifact in bytecode.test.
// The runtime is embedded verbatim in creation code; only the immutable manager
// words are patched by the constructor. The owner is storage, checked separately.
export const ACCOUNT_RUNTIME_OFFSET = 276
export const ACCOUNT_MANAGER_OFFSETS = [1392, 1544] as const

export function expectedAccountRuntime(manager: Address): Hex {
  const word = deploymentAddress(manager).slice(2).padStart(64, '0')
  let runtime = MANDATE_ACCOUNT_BYTECODE.slice(2 + ACCOUNT_RUNTIME_OFFSET * 2)
  for (const offset of ACCOUNT_MANAGER_OFFSETS)
    runtime = `${runtime.slice(0, offset * 2)}${word}${runtime.slice(offset * 2 + 64)}`
  return `0x${runtime}`
}
