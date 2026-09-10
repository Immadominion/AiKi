import {
  DELEGATION_TYPES,
  delegationDomain,
  delegationMessage,
  ROOT_AUTHORITY,
} from '@aiki/contracts/delegation'
import {
  encodeStrategyBindingTerms,
  GridStrategyVaultAbi,
  PancakeLPVaultAbi,
  STRATEGY_REVIEWED_TOKENS,
  type StrategyAuthorizationPreparation,
  type StrategyPublicConfig,
  type StrategySetupView,
  type StrategyWalletAction,
  YieldAllocationVaultAbi,
} from '@aiki/contracts/strategies'
import {
  type Abi,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  hashTypedData,
  parseAbi,
} from 'viem'

export type ReadyStrategyConfig = Extract<StrategyPublicConfig, { available: true }>
export const canonical = (value: unknown): string => {
  const order = (item: unknown): unknown =>
    typeof item === 'bigint'
      ? item.toString()
      : Array.isArray(item)
        ? item.map(order)
        : item && typeof item === 'object'
          ? Object.fromEntries(
              Object.entries(item)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, v]) => [key, order(v)]),
            )
          : item
  return JSON.stringify(order(value))
}
export const address = (v: unknown): v is Hex =>
  typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v)
export const hash = (v: unknown): v is Hex =>
  typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v) && !/^0x0{64}$/i.test(v)
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const fail = (): never => {
  throw new Error(
    'The transaction or mandate no longer matches the reviewed strategy. Refresh before continuing.',
  )
}
export function assertConfig(value: StrategyPublicConfig): asserts value is ReadyStrategyConfig {
  if (
    !value?.available ||
    value.chainId !== 56 ||
    !hash(value.configurationHash) ||
    !address(value.manager) ||
    !address(value.executor) ||
    !address(value.bindingEnforcer) ||
    !address(value.expiryEnforcer) ||
    value.expiryEnforcer.toLowerCase() === value.bindingEnforcer.toLowerCase() ||
    typeof value.schedulerReady !== 'boolean' ||
    !Array.isArray(value.kinds) ||
    new Set(value.kinds).size !== value.kinds.length ||
    value.kinds.some(
      (k) =>
        !['yield', 'grid', 'lp'].includes(k) ||
        !address(value.factories?.[k]?.address) ||
        !hash(value.factories?.[k]?.runtimeCodeHash),
    )
  )
    fail()
}
export function assertSetup(setup: StrategySetupView, owner: string, config?: ReadyStrategyConfig) {
  if (
    !setup ||
    !address(owner) ||
    !same(setup.owner, owner) ||
    setup.chainId !== 56 ||
    setup.input.chainId !== 56 ||
    setup.input.kind !== setup.kind ||
    !address(setup.input.controller) ||
    !same(setup.prepared.owner, owner) ||
    !same(setup.prepared.controller, setup.input.controller) ||
    setup.prepared.kind !== setup.kind ||
    canonical(setup.prepared.input) !== canonical(setup.input) ||
    !hash(setup.prepared.policyHash) ||
    !hash(setup.prepared.requestDigest) ||
    !hash(setup.prepared.configurationDigest) ||
    !/^[1-9][0-9]*$/.test(setup.gasLimitWei) ||
    BigInt(setup.gasLimitWei) >= 1n << 256n ||
    !address(setup.prepared.predictedVault) ||
    !Array.isArray(setup.actions)
  )
    fail()
  if (
    setup.binding &&
    (!same(setup.binding.vault, setup.prepared.predictedVault) ||
      !same(setup.binding.controller, setup.input.controller) ||
      !same(setup.binding.policyHash, setup.prepared.policyHash) ||
      setup.binding.kind !== setup.kind ||
      setup.binding.chainId !== 56)
  )
    fail()
  if (
    config &&
    (!config.kinds.includes(setup.kind) ||
      !config.factories[setup.kind] ||
      setup.prepared.configurationDigest !== config.configurationHash)
  )
    fail()
}
const approveABI = parseAbi(['function approve(address spender,uint256 amount) returns (bool)'])
const nftABI = parseAbi(['function approve(address to,uint256 tokenId)'])
const NFT_MANAGER = '0x46a15b0b27311cedf172ab29e4f4766fbE7F4364'.toLowerCase()
const yieldTokens = [
  STRATEGY_REVIEWED_TOKENS.usdt.address,
  '0xfd5840cd36d94d7229439859c0112a4185bc0255',
  '0xa9251ca9de909cb71783723713b21e4233fbf1b1',
]
const token = (value: unknown) =>
  same(value, STRATEGY_REVIEWED_TOKENS.usdt.address) ||
  same(value, STRATEGY_REVIEWED_TOKENS.wbnb.address)

/** Decode wallet bytes locally. API prose is not permission to approve an arbitrary spender. */
export function assertWalletAction(
  action: StrategyWalletAction,
  setup: StrategySetupView,
  config: ReadyStrategyConfig,
) {
  assertConfig(config)
  assertSetup(setup, setup.owner, config)
  const tx = action.transaction,
    vault = setup.prepared.predictedVault
  if (tx?.chainId !== 56 || tx.value !== '0' || !same(tx.from, setup.owner) || !address(tx.to))
    fail()
  if (action.kind === 'deploy') {
    if (
      !same(tx.to, config.factories[setup.kind]?.address ?? '') ||
      canonical(tx) !== canonical(setup.prepared.unsignedTransaction)
    )
      fail()
    return
  }
  if (!setup.binding || !same(setup.binding.vault, vault)) fail()
  const abi: Abi =
    action.kind === 'approve' || action.kind === 'approve_reset'
      ? approveABI
      : action.kind === 'approve_nft'
        ? nftABI
        : setup.kind === 'yield'
          ? YieldAllocationVaultAbi
          : setup.kind === 'grid'
            ? GridStrategyVaultAbi
            : PancakeLPVaultAbi
  const decoded = decodeFunctionData({ abi, data: tx.data })
  if (
    encodeFunctionData({ abi, functionName: decoded.functionName, args: decoded.args }) !==
    tx.data.toLowerCase()
  )
    fail()
  const args = decoded.args ?? []
  const assets = action.review.assets ?? []
  if (
    assets.some(
      (asset) =>
        !/^(0|[1-9][0-9]*)$/.test(asset.amount) ||
        asset.decimals !== (same(asset.token, yieldTokens[1] ?? '') ? 8 : 18),
    )
  )
    fail()
  if (action.kind === 'approve' || action.kind === 'approve_reset') {
    if (
      decoded.functionName !== 'approve' ||
      !token(tx.to) ||
      !same(args[0], vault) ||
      assets.length !== 1 ||
      !same(assets[0]?.token, tx.to) ||
      typeof args[1] !== 'bigint' ||
      args[1].toString() !== assets[0]?.amount ||
      assets[0]?.decimals !== 18 ||
      (action.kind === 'approve_reset' ? args[1] !== 0n : args[1] <= 0n)
    )
      fail()
    return
  }
  if (action.kind === 'approve_nft') {
    if (
      setup.kind !== 'lp' ||
      !same(tx.to, NFT_MANAGER) ||
      decoded.functionName !== 'approve' ||
      !same(args[0], vault) ||
      typeof args[1] !== 'bigint' ||
      args[1].toString() !== action.review.tokenId
    )
      fail()
    return
  }
  if (!same(tx.to, vault)) fail()
  if (action.kind === 'resume' || action.kind === 'pause') {
    if (decoded.functionName !== action.kind || args.length) fail()
  } else if (action.kind === 'enroll') {
    if (
      setup.kind !== 'lp' ||
      decoded.functionName !== 'enroll' ||
      String(args[0]) !== action.review.tokenId
    )
      fail()
  } else if (action.kind === 'fund') {
    if (decoded.functionName !== 'fund' || setup.kind === 'lp') fail()
    if (setup.kind === 'yield') {
      if (
        assets.length !== 1 ||
        !same(assets[0]?.token, STRATEGY_REVIEWED_TOKENS.usdt.address) ||
        String(args[0]) !== assets[0]?.amount
      )
        fail()
    } else if (
      args[0] !== action.review.rungIndex ||
      assets.length !== 2 ||
      !same(assets[0]?.token, STRATEGY_REVIEWED_TOKENS.usdt.address) ||
      !same(assets[1]?.token, STRATEGY_REVIEWED_TOKENS.wbnb.address) ||
      String(args[1]) !== assets[0]?.amount ||
      String(args[2]) !== assets[1]?.amount
    )
      fail()
  } else if (action.kind === 'withdraw') {
    if (action.review.recipient && !same(action.review.recipient, setup.owner)) fail()
    if (setup.kind === 'yield') {
      if (
        decoded.functionName !== 'recover' ||
        !yieldTokens.some((t) => same(args[0], t)) ||
        assets.length !== 1 ||
        !same(args[0], assets[0]?.token ?? '') ||
        String(args[1]) !== assets[0]?.amount
      )
        fail()
    } else if (setup.kind === 'grid') {
      if (
        decoded.functionName !== 'withdraw' ||
        args[0] !== action.review.rungIndex ||
        !same(args[3], setup.owner) ||
        assets.length !== 2 ||
        !same(assets[0]?.token, STRATEGY_REVIEWED_TOKENS.usdt.address) ||
        !same(assets[1]?.token, STRATEGY_REVIEWED_TOKENS.wbnb.address) ||
        String(args[1]) !== assets[0]?.amount ||
        String(args[2]) !== assets[1]?.amount
      )
        fail()
    } else if (decoded.functionName !== 'withdrawPosition' || args.length) fail()
  } else fail()
}

export function assertStrategySigning(
  prep: StrategyAuthorizationPreparation,
  setup: StrategySetupView,
  config: ReadyStrategyConfig,
) {
  assertConfig(config)
  assertSetup(setup, setup.owner, config)
  if (
    !setup.binding ||
    prep.setupId !== setup.id ||
    !same(prep.review.owner, setup.owner) ||
    canonical(prep.domain) !== canonical(delegationDomain(56, config.manager)) ||
    canonical(prep.types) !== canonical(DELEGATION_TYPES) ||
    prep.primaryType !== 'Delegation' ||
    prep.unsigned.authority !== ROOT_AUTHORITY ||
    canonical(prep.message) !== canonical(delegationMessage(prep.unsigned)) ||
    !same(prep.review.manager, config.manager) ||
    !same(prep.review.executor, config.executor) ||
    canonical(prep.review.binding) !== canonical(setup.binding) ||
    canonical(prep.review.input) !== canonical(setup.input) ||
    prep.review.expiresAt !== new Date(Number(setup.input.common.expiresAt) * 1000).toISOString() ||
    prep.review.gasLimitWei !== setup.gasLimitWei ||
    !same(prep.unsigned.delegate, config.executor) ||
    !same(prep.unsigned.delegator, setup.input.controller) ||
    prep.unsigned.caveats.length !== 2 ||
    !same(prep.unsigned.caveats[0]?.enforcer, config.expiryEnforcer) ||
    prep.unsigned.caveats[0]?.terms !==
      encodeAbiParameters([{ type: 'uint256' }], [BigInt(setup.input.common.expiresAt)]) ||
    prep.unsigned.caveats[0]?.args !== '0x' ||
    !same(prep.unsigned.caveats[1]?.enforcer, config.bindingEnforcer) ||
    prep.unsigned.caveats[1]?.terms !== encodeStrategyBindingTerms(setup.binding) ||
    prep.unsigned.caveats[1]?.args !== '0x' ||
    hashTypedData({
      domain: prep.domain,
      types: prep.types,
      primaryType: prep.primaryType,
      message: {
        ...prep.message,
        salt: BigInt(prep.message.salt),
        epoch: BigInt(prep.message.epoch),
      },
    }) !== prep.digest
  )
    fail()
}
