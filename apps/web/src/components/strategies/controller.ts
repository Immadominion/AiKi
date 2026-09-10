import type {
  StrategyAuthorizationPreparation,
  StrategySetupView,
  StrategyWalletAction,
} from '@aiki/contracts/strategies'
import { loadExecutionNetwork, signPreparedDelegation } from '@/components/hire/guardian-activation'
import { api } from '@/lib/api'
import {
  readInjectedAccount,
  sendWalletTransaction,
  signMandate,
  WalletTransactionError,
} from '@/lib/wallet'
import { walletSession } from '@/lib/wallet-session'
import { strategyApi } from './api'
import {
  address,
  assertConfig,
  assertSetup,
  assertStrategySigning,
  assertWalletAction,
  canonical,
  hash,
  type ReadyStrategyConfig,
} from './review'

export interface StrategyTransactionMemo {
  setupId: string
  actionId: string
  owner: string
  status: 'wallet_open' | 'unknown' | 'submitted'
  transactionHash?: `0x${string}`
}
export interface StrategyTransactionJournal {
  get(owner: string, setupId: string, actionId: string): StrategyTransactionMemo | null
  put(memo: StrategyTransactionMemo): void
  clear(owner: string, setupId: string, actionId: string): void
}
export function createTransactionJournal(
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): StrategyTransactionJournal {
  const memory = new Map<string, StrategyTransactionMemo>()
  const key = (owner: string, setup: string, action: string) =>
    `aiki.strategy-tx:${owner.toLowerCase()}:${setup}:${action}`
  return {
    get(owner, setupId, actionId) {
      const k = key(owner, setupId, actionId)
      const recent = memory.get(k)
      if (recent) return { ...recent }
      try {
        const value: unknown = JSON.parse(storage().getItem(k) ?? 'null')
        if (
          value &&
          typeof value === 'object' &&
          'owner' in value &&
          value.owner === owner.toLowerCase() &&
          'setupId' in value &&
          value.setupId === setupId &&
          'actionId' in value &&
          value.actionId === actionId &&
          'status' in value &&
          ['wallet_open', 'unknown', 'submitted'].includes(String(value.status))
        ) {
          const memo = value as StrategyTransactionMemo
          if (memo.transactionHash === undefined || hash(memo.transactionHash)) return memo
        }
      } catch {
        /* The current tab's in-memory record remains authoritative. */
      }
      return memory.get(k) ?? null
    },
    put(memo) {
      const copy = { ...memo, owner: memo.owner.toLowerCase() },
        k = key(copy.owner, copy.setupId, copy.actionId)
      memory.set(k, copy)
      try {
        storage().setItem(k, JSON.stringify(copy))
      } catch {
        // Without this pre-popup marker a reload after lost acknowledgement could send twice.
        if (copy.status === 'wallet_open') {
          memory.delete(k)
          throw new Error(
            'Enable browser session storage before confirming a transaction so interrupted requests can be recovered safely.',
          )
        }
        // The original persisted wallet-open marker still prevents a resend after reload.
      }
    },
    clear(owner, setupId, actionId) {
      const k = key(owner, setupId, actionId)
      memory.delete(k)
      try {
        storage().removeItem(k)
      } catch {
        /* A stale record only forces a receipt refresh. */
      }
    },
  }
}
export const strategyJournal = createTransactionJournal(() => sessionStorage)
export interface StrategyControllerDependencies {
  api: typeof strategyApi
  account: typeof api.account
  readWallet: typeof readInjectedAccount
  session: typeof walletSession
  send: typeof sendWalletTransaction
  journal: StrategyTransactionJournal
  network: typeof loadExecutionNetwork
  sign: typeof signPreparedDelegation
  signWallet: typeof signMandate
}
const defaults: StrategyControllerDependencies = {
  api: strategyApi,
  account: () => api.account(),
  readWallet: readInjectedAccount,
  session: walletSession,
  send: sendWalletTransaction,
  journal: strategyJournal,
  network: loadExecutionNetwork,
  sign: signPreparedDelegation,
  signWallet: signMandate,
}
const changed = () =>
  new Error(
    'Your wallet, account or strategy configuration changed. Sign in and refresh before continuing.',
  )

export async function assertStrategyWallet(
  owner: string,
  revision: number,
  deps: Pick<StrategyControllerDependencies, 'readWallet' | 'session'> = defaults,
) {
  const active = await deps.readWallet(),
    session = deps.session()
  if (
    !address(owner) ||
    !active ||
    active.chainId !== 56 ||
    active.address.toLowerCase() !== owner.toLowerCase() ||
    session.revision !== revision ||
    session.address !== owner.toLowerCase()
  )
    throw changed()
}

async function fresh(
  setup: StrategySetupView,
  reviewed: ReadyStrategyConfig,
  deps: StrategyControllerDependencies,
  revision: number,
) {
  const guard = () => assertStrategyWallet(setup.owner, revision, deps)
  await guard()
  const config = await deps.api.config()
  await guard()
  assertConfig(config)
  if (canonical(config) !== canonical(reviewed)) throw changed()
  const current = await deps.api.detail(setup.id)
  await guard()
  assertSetup(current, setup.owner, config)
  if (
    canonical(current.input) !== canonical(setup.input) ||
    current.prepared.requestDigest !== setup.prepared.requestDigest ||
    current.gasLimitWei !== setup.gasLimitWei
  )
    throw changed()
  const account = await deps.account()
  await guard()
  if (
    account.chainId !== 56 ||
    account.address?.toLowerCase() !== setup.input.controller.toLowerCase()
  )
    throw changed()
  return { current, config, guard }
}

export async function reconcileStrategyAction(
  setup: StrategySetupView,
  actionId: string,
  suppliedHash?: string,
  dependencies: Partial<StrategyControllerDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies },
    revision = deps.session().revision
  await assertStrategyWallet(setup.owner, revision, deps)
  const action = setup.actions.find((item) => item.id === actionId)
  if (!action) throw new Error('Refresh to find this transaction.')
  const memo = deps.journal.get(setup.owner, setup.id, actionId)
  const known = action.transactionHash ?? memo?.transactionHash
  if (
    suppliedHash &&
    (!hash(suppliedHash) || (known && known.toLowerCase() !== suppliedHash.toLowerCase()))
  )
    throw new Error(
      'Use the exact original transaction hash, not a replacement or another payment.',
    )
  const transactionHash = known ?? suppliedHash
  if (!hash(transactionHash))
    throw new Error(
      'Paste the original transaction hash from your wallet activity. Do not send the transaction again.',
    )
  deps.journal.put({
    owner: setup.owner,
    setupId: setup.id,
    actionId,
    status: 'submitted',
    transactionHash,
  })
  if (!action.transactionHash) {
    await deps.api.submitAction(setup.id, actionId, transactionHash)
    await assertStrategyWallet(setup.owner, revision, deps)
  }
  const result = await deps.api.finalizeAction(setup.id, actionId)
  await assertStrategyWallet(setup.owner, revision, deps)
  assertSetup(result, setup.owner)
  const recorded = result.actions.find((item) => item.id === actionId)
  if (!recorded || recorded.transactionHash?.toLowerCase() !== transactionHash.toLowerCase())
    throw new Error('The original transaction is still being checked. Keep its hash and refresh.')
  if (recorded.status === 'FINALIZED' || recorded.status === 'REVERTED')
    deps.journal.clear(setup.owner, setup.id, actionId)
  return result
}

/** A journal marker is durable BEFORE opening the popup; only a definitive rejection
 * unlocks a resend. A valid returned hash is saved even when the active wallet changes. */
export async function sendStrategyAction(
  setup: StrategySetupView,
  config: ReadyStrategyConfig,
  action: StrategyWalletAction,
  dependencies: Partial<StrategyControllerDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies },
    revision = deps.session().revision
  const checked = await fresh(setup, config, deps, revision)
  const current = checked.current.actions.find((item) => item.id === action.id)
  if (
    !current ||
    canonical(current.transaction) !== canonical(action.transaction) ||
    canonical(current.review) !== canonical(action.review) ||
    current.kind !== action.kind
  )
    throw new Error('The reviewed transaction changed. Refresh its details before confirming.')
  const memo = deps.journal.get(setup.owner, setup.id, action.id)
  if (current.transactionHash || memo?.transactionHash)
    return reconcileStrategyAction(checked.current, action.id, undefined, deps)
  if (memo || current.status !== 'PREPARED')
    throw new Error(
      'A wallet request may already have been submitted. Check its activity and recover the original hash; do not send again.',
    )
  assertWalletAction(current, checked.current, checked.config)
  await checked.guard()
  // Recheck after the final await so two button handlers cannot both open a popup.
  if (deps.journal.get(setup.owner, setup.id, action.id))
    throw new Error('This wallet request is already in progress.')
  const marker: StrategyTransactionMemo = {
    owner: setup.owner,
    setupId: setup.id,
    actionId: action.id,
    status: 'wallet_open',
  }
  deps.journal.put(marker)
  let result: Awaited<ReturnType<typeof sendWalletTransaction>>
  try {
    result = await deps.send(setup.owner, current.transaction)
  } catch (error) {
    if (error instanceof WalletTransactionError && !error.mayHaveSubmitted)
      deps.journal.clear(setup.owner, setup.id, action.id)
    else deps.journal.put({ ...marker, status: 'unknown' })
    throw error
  }
  deps.journal.put({ ...marker, status: 'submitted', transactionHash: result.transactionHash })
  if (!result.walletCurrent) throw changed()
  await checked.guard()
  return reconcileStrategyAction(checked.current, action.id, result.transactionHash, deps)
}

export async function signStrategyAuthorization(
  setup: StrategySetupView,
  config: ReadyStrategyConfig,
  reviewed: StrategyAuthorizationPreparation,
  dependencies: Partial<StrategyControllerDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies },
    revision = deps.session().revision
  const checked = await fresh(setup, config, deps, revision)
  if (checked.current.authorization?.signedAt) return checked.current
  const prepared = await deps.api.prepareAuthorization(setup.id)
  await checked.guard()
  if (canonical(prepared) !== canonical(reviewed))
    throw new Error('The mandate review changed. Review the current limits before signing.')
  assertStrategySigning(prepared, checked.current, checked.config)
  const network = await deps.network()
  await checked.guard()
  if (network.chainId !== 56 || network.manager.toLowerCase() !== config.manager.toLowerCase())
    throw changed()
  const signed = await deps.sign(
    { ...prepared, unsigned: { ...prepared.unsigned } },
    network,
    setup.input.controller,
    setup.owner,
    {
      network: deps.network,
      account: deps.account,
      readWallet: deps.readWallet,
      session: deps.session,
      sign: async (address, typedData) => {
        await checked.guard()
        const currentConfig = await deps.api.config()
        await checked.guard()
        if (canonical(currentConfig) !== canonical(config) || deps.session().revision !== revision)
          throw changed()
        // Keep the parent review's revision across the shared helper's asynchronous preflight.
        return deps.signWallet(address, typedData)
      },
    },
  )
  await checked.guard()
  const after = await deps.api.prepareAuthorization(setup.id)
  await checked.guard()
  if (canonical(after) !== canonical(prepared))
    throw new Error('The strategy changed while the wallet was open. No signature was filed.')
  const latest = await deps.api.config()
  await checked.guard()
  if (canonical(latest) !== canonical(config)) throw changed()
  const result = await deps.api.fileAuthorization(setup.id, signed.signature as string)
  await checked.guard()
  assertSetup(result, setup.owner, config)
  if (!result.authorization?.signedAt || result.authorization.digest !== prepared.digest)
    throw new Error(
      'The signature has not been confirmed. Refresh this same setup; no strategy was started.',
    )
  return result
}

const starting = new Map<string, Promise<StrategySetupView>>()
export function startStrategySetup(
  setup: StrategySetupView,
  config: ReadyStrategyConfig,
  dependencies: Partial<StrategyControllerDependencies> = {},
): Promise<StrategySetupView> {
  const key = `${setup.owner.toLowerCase()}:${setup.id}`
  const pending = starting.get(key)
  if (pending) return pending
  const task = (async () => {
    const deps = { ...defaults, ...dependencies },
      revision = deps.session().revision
    const checked = await fresh(setup, config, deps, revision)
    // Lost acknowledgements resume the same setup, never create a second watch.
    if (checked.current.status === 'ACTIVE') return checked.current
    if (
      !checked.current.authorization?.signedAt ||
      !checked.current.readiness.ready ||
      !checked.current.readiness.schedulerReady ||
      !checked.config.schedulerReady
    )
      throw new Error(
        'Funding, onchain enablement, the signed mandate and scheduler must all be verified before starting.',
      )
    const result = await deps.api.start(setup.id)
    await checked.guard()
    assertSetup(result, setup.owner, config)
    if (result.status !== 'ACTIVE')
      throw new Error(
        'Activation was not confirmed. Refresh this same setup; do not create another.',
      )
    return result
  })().finally(() => starting.delete(key))
  starting.set(key, task)
  return task
}
