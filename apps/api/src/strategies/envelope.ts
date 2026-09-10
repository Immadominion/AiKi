import { ROOT_AUTHORITY } from '@aiki/contracts/delegation'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
} from 'viem'
import {
  DELEGATION_ABI,
  DELEGATION_TUPLE,
  encodeSingleExecution,
  type SignedDelegation,
} from '../execution/executor.js'
import { encodeStrategyOperation, type StrategyOperation } from './operation.js'

const SINGLE_MODE = `0x${'00'.repeat(32)}` as Hex

/** Stored permissions are data, not typed credentials. Reject malformed or coercible integers. */
export function decodeStoredStrategyDelegation(value: unknown): SignedDelegation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Missing stored strategy permission.')
  const raw = value as Record<string, unknown>
  const integer = (value: unknown): bigint => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
      throw new Error('Invalid stored permission integer.')
    const parsed = BigInt(value)
    if (parsed >= 1n << 256n) throw new Error('Stored permission integer overflow.')
    return parsed
  }
  const delegation = {
    ...raw,
    salt: integer(raw.salt),
    epoch: integer(raw.epoch),
  } as unknown as SignedDelegation
  // ABI encoding validates nested addresses, byte lengths and the full caveat structure.
  encodeAbiParameters([DELEGATION_TUPLE], [[delegation]])
  return delegation
}

export function encodeStrategyEnvelope(
  operation: StrategyOperation,
  delegation: SignedDelegation,
): Hex {
  const context = encodeAbiParameters([DELEGATION_TUPLE], [[delegation]])
  return encodeFunctionData({
    abi: DELEGATION_ABI,
    functionName: 'redeemDelegations',
    args: [
      [context],
      [SINGLE_MODE],
      [encodeSingleExecution(operation.binding.vault, 0n, encodeStrategyOperation(operation))],
    ],
  })
}

/** Reverts have no events: the exact intended inner call must be proven independently. */
export function assertStrategyEnvelope(
  input: Hex,
  operation: StrategyOperation,
  executor: Hex,
): void {
  const decoded = decodeFunctionData({ abi: DELEGATION_ABI, data: input })
  const [contexts, modes, executions] = decoded.args
  if (
    contexts.length !== 1 ||
    modes.length !== 1 ||
    executions.length !== 1 ||
    modes[0] !== SINGLE_MODE
  )
    throw new Error('Strategy execution must be a single direct redemption.')
  const expected = encodeSingleExecution(
    operation.binding.vault,
    0n,
    encodeStrategyOperation(operation),
  )
  if (executions[0]?.toLowerCase() !== expected.toLowerCase())
    throw new Error('Strategy redemption contains a different call.')
  const context = contexts[0]
  if (!context) throw new Error('Missing strategy permission context.')
  const [delegations] = decodeAbiParameters([DELEGATION_TUPLE], context)
  if (delegations.length !== 1) throw new Error('Strategy redemption must use one root delegation.')
  const delegation = delegations[0]
  if (!delegation) throw new Error('Missing strategy delegation.')
  if (
    delegation.delegator.toLowerCase() !== operation.binding.controller.toLowerCase() ||
    delegation.delegate.toLowerCase() !== executor.toLowerCase() ||
    delegation.authority !== ROOT_AUTHORITY ||
    delegation.caveats.some((caveat) => caveat.args !== '0x')
  )
    throw new Error('Strategy delegation identity differs from the prepared operation.')
  if (
    encodeAbiParameters([DELEGATION_TUPLE], [[delegation]]).toLowerCase() !==
      context.toLowerCase() ||
    encodeFunctionData({
      abi: DELEGATION_ABI,
      functionName: 'redeemDelegations',
      args: decoded.args,
    }).toLowerCase() !== input.toLowerCase()
  )
    throw new Error('Strategy redemption encoding is not canonical.')
}
