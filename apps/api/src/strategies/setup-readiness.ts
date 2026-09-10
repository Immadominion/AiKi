import {
  DELEGATION_TYPES,
  delegationDomain,
  delegationMessage,
  ROOT_AUTHORITY,
  type SignedDelegation,
  type UnsignedDelegation,
} from '@aiki/contracts'
import { type Hex, hashStruct, hashTypedData, keccak256, parseAbi } from 'viem'
import {
  assertStrategyGrant,
  encodeStrategyBindingTerms,
  encodeStrategyExpiryTerms,
  STRATEGY_EXPIRY_ENFORCER,
} from './grant.js'

export { STRATEGY_EXPIRY_ENFORCER } from './grant.js'

import { nonzeroAddress } from './operation.js'
import {
  isVerifiedStrategySnapshot,
  type StrategySnapshotReader,
  type VerifiedStrategySnapshot,
} from './snapshot.js'

const ACCOUNT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function DELEGATION_MANAGER() view returns (address)',
  'function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)',
])
const MANAGER_ABI = parseAbi([
  'function EXPIRY_ENFORCER() view returns (address)',
  'function epochOf(address delegator) view returns (uint256)',
  'function isDisabled(bytes32 delegationHash) view returns (bool)',
  'function getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,uint256 epoch,bytes signature) delegation) pure returns (bytes32)',
  'function getDelegationDigest((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,uint256 epoch,bytes signature) delegation) view returns (bytes32)',
])
const same = (value: unknown, expected: string) =>
  typeof value === 'string' && value.toLowerCase() === expected.toLowerCase()
const integer = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78)
    throw new Error('Invalid authority integer.')
  const number = BigInt(value)
  if (number >= 1n << 256n) throw new Error('Invalid authority integer.')
  return number
}
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item))

export function strategyUnsignedDelegation(input: {
  snapshot: VerifiedStrategySnapshot
  executor: Hex
  salt: string
  epoch: string
}): UnsignedDelegation {
  if (!isVerifiedStrategySnapshot(input.snapshot) || !nonzeroAddress(input.executor))
    throw new Error('Verified strategy authority is required.')
  integer(input.salt)
  integer(input.epoch)
  return {
    delegate: input.executor.toLowerCase() as Hex,
    delegator: input.snapshot.binding.controller,
    authority: ROOT_AUTHORITY,
    caveats: [
      {
        enforcer: STRATEGY_EXPIRY_ENFORCER.address,
        terms: encodeStrategyExpiryTerms(input.snapshot.expiresAt),
        args: '0x',
      },
      {
        enforcer: input.snapshot.bindingEnforcer.address,
        terms: encodeStrategyBindingTerms(input.snapshot.binding),
        args: '0x',
      },
    ],
    salt: input.salt,
    epoch: input.epoch,
  }
}

export async function readStrategyEpoch(
  snapshot: VerifiedStrategySnapshot,
  reader: StrategySnapshotReader,
): Promise<string> {
  if (!isVerifiedStrategySnapshot(snapshot))
    throw new Error('Verified strategy authority is required.')
  const epoch = await reader.readContract({
    address: snapshot.manager,
    abi: MANAGER_ABI,
    functionName: 'epochOf',
    args: [snapshot.binding.controller],
    blockNumber: snapshot.block.number,
  })
  if (typeof epoch !== 'bigint' || epoch < 0n || epoch >= 1n << 256n)
    throw new Error('Strategy authority is unavailable.')
  return epoch.toString()
}

/** Does not call the generic caveat compiler: a strategy signs its one immutable vault policy. */
export async function verifyStrategyMandate(input: {
  snapshot: VerifiedStrategySnapshot
  delegation: unknown
  owner: Hex
  executor: Hex
  reader: StrategySnapshotReader
  nowSeconds?: number
}): Promise<{ ready: true; digest: Hex } | { ready: false; retryable: boolean; reason: string }> {
  const denied = (retryable: boolean) => ({
    ready: false as const,
    retryable,
    reason: retryable
      ? 'Current strategy authority could not be verified. No action was submitted.'
      : 'The signed strategy authority no longer matches this owner, vault, or manager.',
  })
  try {
    const { snapshot, reader } = input
    const owner = input.owner,
      executor = input.executor
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
    if (
      !isVerifiedStrategySnapshot(snapshot) ||
      !nonzeroAddress(owner) ||
      !nonzeroAddress(executor) ||
      same(owner, executor) ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      snapshot.expiresAt <= BigInt(now) ||
      !same(snapshot.owner, owner)
    )
      return denied(false)
    if (BigInt(now) < snapshot.block.timestamp || BigInt(now) - snapshot.block.timestamp > 30n)
      return denied(true)
    const delegation = structuredClone(input.delegation) as SignedDelegation
    const salt = integer(delegation.salt),
      epoch = integer(delegation.epoch)
    const expected = strategyUnsignedDelegation({
      snapshot,
      executor,
      salt: delegation.salt,
      epoch: delegation.epoch,
    })
    // Preserve each signed byte. Input order/casing cannot substitute different permissions.
    if (
      canonical(delegationMessage(delegation)).toLowerCase() !==
        canonical(delegationMessage(expected)).toLowerCase() ||
      delegation.caveats.some((caveat) => caveat.args !== '0x')
    )
      return denied(false)
    assertStrategyGrant({
      delegation: { ...delegation, salt, epoch },
      binding: snapshot.binding,
      executor,
      bindingEnforcer: snapshot.bindingEnforcer.address,
    })
    const digest = hashTypedData({
      domain: delegationDomain(56, snapshot.manager),
      types: DELEGATION_TYPES,
      primaryType: 'Delegation',
      message: delegationMessage(delegation),
    })
    const delegationHash = hashStruct({
      types: DELEGATION_TYPES,
      primaryType: 'Delegation',
      data: delegationMessage(delegation),
    })
    const signed = { ...delegation, salt, epoch }
    const read = (
      address: Hex,
      abi: typeof ACCOUNT_ABI | typeof MANAGER_ABI,
      functionName: string,
      args?: readonly unknown[],
    ) =>
      reader.readContract({
        address,
        abi,
        functionName,
        ...(args ? { args } : {}),
        blockNumber: snapshot.block.number,
      })
    if ((await reader.getChainId()) !== 56) return denied(true)
    const [
      currentOwner,
      manager,
      currentEpoch,
      disabled,
      chainDigest,
      chainHash,
      accepted,
      expiryEnforcer,
      expiryCode,
    ] = await Promise.all([
      read(snapshot.binding.controller, ACCOUNT_ABI, 'owner'),
      read(snapshot.binding.controller, ACCOUNT_ABI, 'DELEGATION_MANAGER'),
      read(snapshot.manager, MANAGER_ABI, 'epochOf', [snapshot.binding.controller]),
      read(snapshot.manager, MANAGER_ABI, 'isDisabled', [delegationHash]),
      read(snapshot.manager, MANAGER_ABI, 'getDelegationDigest', [signed]),
      read(snapshot.manager, MANAGER_ABI, 'getDelegationHash', [signed]),
      read(snapshot.binding.controller, ACCOUNT_ABI, 'isValidSignature', [
        digest,
        delegation.signature,
      ]),
      read(snapshot.manager, MANAGER_ABI, 'EXPIRY_ENFORCER'),
      reader.getBytecode({
        address: STRATEGY_EXPIRY_ENFORCER.address,
        blockNumber: snapshot.block.number,
      }),
    ])
    if (
      !same(currentOwner, owner) ||
      !same(manager, snapshot.manager) ||
      currentEpoch !== epoch ||
      disabled !== false ||
      !same(chainDigest, digest) ||
      !same(chainHash, delegationHash) ||
      !same(accepted, '0x1626ba7e') ||
      !same(expiryEnforcer, STRATEGY_EXPIRY_ENFORCER.address) ||
      !expiryCode ||
      keccak256(expiryCode) !== STRATEGY_EXPIRY_ENFORCER.runtimeCodeHash
    )
      return denied(false)
    const block = (await reader.getBlock({ blockNumber: snapshot.block.number })) as {
      number?: unknown
      hash?: unknown
      timestamp?: unknown
    } | null
    if (
      !block ||
      block.number !== snapshot.block.number ||
      !same(block.hash, snapshot.block.hash) ||
      block.timestamp !== snapshot.block.timestamp ||
      (await reader.getChainId()) !== 56
    )
      return denied(true)
    return { ready: true, digest }
  } catch {
    return denied(true)
  }
}
