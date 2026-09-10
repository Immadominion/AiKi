import { ROOT_AUTHORITY } from '@aiki/contracts/delegation'
import {
  GridStrategyVaultAbi,
  PancakeLPVaultAbi,
  type StrategyBinding,
  YieldAllocationVaultAbi,
} from '@aiki/contracts/strategies'
import { type Abi, encodeAbiParameters, type Hex, toFunctionSelector } from 'viem'
import type { SignedDelegation } from '../execution/executor.js'
import { nonzeroAddress, STRATEGY_KIND_HASH, validateStrategyBinding } from './operation.js'

const invalid = () => new Error('Invalid signed strategy grant.')
const bytes = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value)
const uint256 = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= 0n && value < 1n << 256n
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

function selector(abi: Abi, name: string): Hex {
  const operation = abi.find((entry) => entry.type === 'function' && entry.name === name)
  if (operation?.type !== 'function') throw invalid()
  return toFunctionSelector(operation)
}

const selectors = {
  yield: selector(YieldAllocationVaultAbi, 'reallocate'),
  grid: selector(GridStrategyVaultAbi, 'execute'),
  lp: selector(PancakeLPVaultAbi, 'rebalance'),
} as const

/** Exact StrategyBindingEnforcer terms. The selector is derived from the reviewed vault ABI. */
export function encodeStrategyBindingTerms(binding: StrategyBinding): Hex {
  try {
    validateStrategyBinding(binding)
    return encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes4' },
        { type: 'bytes32' },
      ],
      [
        binding.vault,
        binding.policyHash,
        binding.runtimeCodeHash,
        selectors[binding.kind],
        STRATEGY_KIND_HASH[binding.kind],
      ],
    )
  } catch {
    throw invalid()
  }
}

/**
 * Pure structural admission, NOT signature authentication or a live-chain proof.
 * The server must supply its reviewed enforcer address and freshly verified vault
 * binding. A full manager simulation must still verify the owner signature, epoch,
 * revocation, contract identities and every additional signed restriction.
 */
export function assertStrategyGrant(input: {
  delegation: SignedDelegation
  binding: StrategyBinding
  executor: Hex
  bindingEnforcer: Hex
}): void {
  try {
    const { delegation, binding, executor, bindingEnforcer } = input
    const expected = encodeStrategyBindingTerms(binding).toLowerCase()
    if (
      !nonzeroAddress(executor) ||
      !nonzeroAddress(bindingEnforcer) ||
      !nonzeroAddress(delegation.delegator) ||
      !nonzeroAddress(delegation.delegate) ||
      delegation.delegator.toLowerCase() !== binding.controller.toLowerCase() ||
      delegation.delegate.toLowerCase() !== executor.toLowerCase() ||
      typeof delegation.authority !== 'string' ||
      delegation.authority.toLowerCase() !== ROOT_AUTHORITY ||
      !uint256(delegation.salt) ||
      !uint256(delegation.epoch) ||
      !Array.isArray(delegation.caveats) ||
      !bytes(delegation.signature) ||
      delegation.signature.length !== 132
    )
      throw invalid()

    // Mirror the reviewed mandate account's strict 65-byte ECDSA shape without
    // claiming that these bytes recover the current owner for the manager digest.
    const r = BigInt(`0x${delegation.signature.slice(2, 66)}`)
    const s = BigInt(`0x${delegation.signature.slice(66, 130)}`)
    const v = Number.parseInt(delegation.signature.slice(130), 16)
    if (r === 0n || r >= CURVE_ORDER || s === 0n || s > CURVE_ORDER / 2n || (v !== 27 && v !== 28))
      throw invalid()

    let matches = 0
    for (const caveat of delegation.caveats) {
      if (!nonzeroAddress(caveat.enforcer) || !bytes(caveat.terms) || caveat.args !== '0x')
        throw invalid()
      if (caveat.enforcer.toLowerCase() !== bindingEnforcer.toLowerCase()) continue
      matches++
      // Exact comparison also rejects trailing bytes and noncanonical ABI padding.
      if (caveat.terms.length !== 322 || caveat.terms.toLowerCase() !== expected) throw invalid()
    }
    if (matches !== 1) throw invalid()
  } catch {
    throw invalid()
  }
}
