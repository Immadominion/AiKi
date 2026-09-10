import {
  DELEGATION_TYPES,
  delegationDomain,
  delegationMessage,
  ROOT_AUTHORITY,
} from '@aiki/contracts/delegation'
import type { StrategySetupView, StrategyWalletAction } from '@aiki/contracts/strategies'
import {
  encodeStrategyBindingTerms,
  STRATEGY_REVIEWED_TOKENS,
  type StrategyAuthorizationPreparation,
  YieldAllocationVaultAbi,
} from '@aiki/contracts/strategies'
import { encodeAbiParameters, encodeFunctionData, type Hex, hashTypedData } from 'viem'
import { strategyApi } from './api'
import { createTransactionJournal, type StrategyControllerDependencies } from './controller'
import { buildStrategyInput, initialPolicyValues, POLICY_FIELDS } from './policy'
import type { ReadyStrategyConfig } from './review'

export const addressAt = (byte: string) => `0x${byte.repeat(20)}` as Hex
export const hashAt = (byte: string) => `0x${byte.repeat(32)}` as Hex
export const owner = addressAt('11'),
  controller = addressAt('22'),
  vault = addressAt('33'),
  transactionHash = hashAt('aa')
export const config: ReadyStrategyConfig = {
  available: true,
  chainId: 56,
  configurationHash: hashAt('44'),
  manager: addressAt('55'),
  executor: addressAt('66'),
  bindingEnforcer: addressAt('77'),
  expiryEnforcer: '0x15d7a002e420f66c08ff0f0446f47668c6099121',
  kinds: ['yield', 'grid', 'lp'],
  factories: {
    yield: { address: addressAt('88'), runtimeCodeHash: hashAt('88') },
    grid: { address: addressAt('89'), runtimeCodeHash: hashAt('89') },
    lp: { address: addressAt('90'), runtimeCodeHash: hashAt('90') },
  },
  schedulerReady: true,
}
export function filledValues(kind: 'yield' | 'grid' | 'lp' = 'yield') {
  const values = initialPolicyValues(kind)
  for (const field of POLICY_FIELDS[kind])
    if (!values[field.key])
      values[field.key] = field.unit === 'USDT' ? '10.25' : field.unit === 'WBNB' ? '0.0125' : '100'
  values.gasLimitBnb = '0.001'
  return values
}
export function setupFixture(): StrategySetupView {
  const input = buildStrategyInput('yield', controller, filledValues(), [], 2000000000n)
  const deploy = {
    chainId: 56 as const,
    from: owner,
    to: addressAt('88'),
    data: '0x12345678' as Hex,
    value: '0' as const,
  }
  return {
    id: 'setup-1',
    owner,
    chainId: 56,
    kind: 'yield',
    input,
    gasLimitWei: '1000000000000000',
    prepared: {
      version: 1,
      chainId: 56,
      kind: 'yield',
      owner,
      controller,
      input,
      requestDigest: hashAt('99'),
      configurationDigest: config.configurationHash,
      policyHash: hashAt('10'),
      predictedVault: vault,
      block: { number: '100', hash: hashAt('12'), timestamp: '2000000000' },
      unsignedTransaction: deploy,
      alreadyDeployed: true,
    },
    binding: {
      version: 1,
      chainId: 56,
      kind: 'yield',
      vault,
      controller,
      policyHash: hashAt('10'),
      runtimeCodeHash: hashAt('13'),
    },
    status: 'DEPLOYED',
    revision: '1',
    actions: [fundAction()],
    authorization: null,
    readiness: {
      ready: false,
      reasons: ['Sign and enable before starting.'],
      schedulerReady: true,
    },
  }
}
export function fundAction(): StrategyWalletAction {
  return {
    id: 'action-1',
    kind: 'fund',
    status: 'PREPARED',
    transactionHash: null,
    transaction: {
      chainId: 56,
      from: owner,
      to: vault,
      value: '0',
      data: encodeFunctionData({
        abi: YieldAllocationVaultAbi,
        functionName: 'fund',
        args: [10n ** 18n],
      }),
    },
    review: {
      summary: 'Deposit exactly 1 USDT',
      assets: [
        {
          token: STRATEGY_REVIEWED_TOKENS.usdt.address,
          amount: '1000000000000000000',
          decimals: 18,
        },
      ],
    },
  }
}
export function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
  }
}
export function authorizationFixture(setup = setupFixture()): StrategyAuthorizationPreparation {
  if (!setup.binding) throw new Error('Fixture requires a deployed binding')
  const unsigned = {
    delegate: config.executor,
    delegator: controller,
    authority: ROOT_AUTHORITY,
    caveats: [
      {
        enforcer: config.expiryEnforcer,
        terms: encodeAbiParameters([{ type: 'uint256' }], [BigInt(setup.input.common.expiresAt)]),
        args: '0x' as Hex,
      },
      {
        enforcer: config.bindingEnforcer,
        terms: encodeStrategyBindingTerms(setup.binding),
        args: '0x' as Hex,
      },
    ],
    salt: '1',
    epoch: '0',
  }
  const domain = { ...delegationDomain(56, config.manager), chainId: 56 as const },
    signedMessage = delegationMessage(unsigned)
  return {
    setupId: setup.id,
    review: {
      owner,
      manager: config.manager,
      executor: config.executor,
      binding: setup.binding,
      input: setup.input,
      expiresAt: new Date(Number(setup.input.common.expiresAt) * 1000).toISOString(),
      gasLimitWei: setup.gasLimitWei,
      plannerPolicy: { minimumBenefit: '1' },
      summary: 'Only this immutable strategy vault may execute.',
    },
    unsigned,
    domain,
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: { ...signedMessage, salt: '1', epoch: '0' },
    digest: hashTypedData({
      domain,
      types: DELEGATION_TYPES,
      primaryType: 'Delegation',
      message: signedMessage,
    }),
  }
}
export function controllerFixture() {
  const state = {
    setup: setupFixture(),
    config: structuredClone(config),
    wallet: owner,
    revision: 1,
    sends: 0,
    submits: 0,
    finalizes: 0,
    starts: 0,
  }
  const deps: StrategyControllerDependencies = {
    api: {
      ...strategyApi,
      config: async () => state.config,
      detail: async () => structuredClone(state.setup),
      submitAction: async (_id, actionId, hash) => {
        state.submits++
        state.setup.actions = state.setup.actions.map((a) =>
          a.id === actionId ? { ...a, status: 'SUBMITTED', transactionHash: hash as Hex } : a,
        )
        return structuredClone(state.setup)
      },
      finalizeAction: async (_id, actionId) => {
        state.finalizes++
        state.setup.actions = state.setup.actions.map((a) =>
          a.id === actionId ? { ...a, status: 'FINALIZED' } : a,
        )
        return structuredClone(state.setup)
      },
      start: async () => {
        state.starts++
        state.setup.status = 'ACTIVE'
        return structuredClone(state.setup)
      },
    },
    account: async () => ({ address: controller, chainId: 56, network: 'mainnet' }),
    readWallet: async () => ({ address: state.wallet, chainId: 56 }),
    session: () => ({
      address: state.wallet,
      revision: state.revision,
      signal: new AbortController().signal,
    }),
    send: async () => {
      state.sends++
      return { transactionHash, walletCurrent: true }
    },
    journal: createTransactionJournal(() => memory),
    network: async () => {
      throw new Error('Not used by wallet-action fixture')
    },
    sign: async () => {
      throw new Error('No real signatures in fixture')
    },
    signWallet: async () => {
      throw new Error('No wallet prompt in fixture')
    },
  }
  const memory = memoryStorage()
  return { state, deps }
}
