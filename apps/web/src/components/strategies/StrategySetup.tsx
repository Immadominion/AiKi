'use client'

import type {
  StrategyAuthorizationPreparation,
  StrategyKind,
  StrategyPublicConfig,
  StrategySetupView,
  StrategyWalletAction,
  StrategyWalletActionRequest,
} from '@aiki/contracts/strategies'
import { STRATEGY_REVIEWED_TOKENS } from '@aiki/contracts/strategies'
import type { Route } from 'next'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { formatUnits, keccak256, stringToHex } from 'viem'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount } from '@/components/shell/prefs'
import { api } from '@/lib/api'
import { subscribeWalletSession, walletSession } from '@/lib/wallet-session'
import { strategyApi } from './api'
import {
  assertStrategyWallet,
  reconcileStrategyAction,
  sendStrategyAction,
  signStrategyAuthorization,
  startStrategySetup,
  strategyJournal,
} from './controller'
import {
  AmountField,
  FOCUS,
  INPUT,
  PANEL,
  PolicyForm,
  PolicyReview,
  PRIMARY,
  SECONDARY,
} from './PolicyForm'
import {
  buildStrategyInput,
  emptyRung,
  type GridRungForm,
  initialPolicyValues,
  rawAmount,
  STRATEGY_COPY,
  StrategyFieldError,
} from './policy'
import {
  address,
  assertSetup,
  assertStrategySigning,
  assertWalletAction,
  canonical,
  hash,
} from './review'
import { StrategyActivity } from './StrategyActivity'

const explanation = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'This request was not confirmed. Refresh the same setup before trying again.'
const label: Record<StrategySetupView['status'], string> = {
  DRAFT: 'Deployment not confirmed',
  DEPLOYED: 'Vault deployed · not running',
  SIGNED: 'Mandate signed · not running',
  ACTIVE: 'Automation active',
  PAUSED: 'Automation paused',
  NEEDS_REVIEW: 'Execution needs review',
}
const transactionLabel: Record<StrategyWalletAction['status'], string> = {
  PREPARED: 'Awaiting your confirmation',
  SUBMITTED: 'Waiting for finality',
  FINALIZED: 'Transaction finalized',
  REVERTED: 'Transaction reverted',
  NEEDS_REVIEW: 'Transaction needs review',
}
const tokenNames = new Map<string, string>([
  [STRATEGY_REVIEWED_TOKENS.usdt.address, 'USDT'],
  [STRATEGY_REVIEWED_TOKENS.wbnb.address, 'WBNB'],
  ['0xfd5840cd36d94d7229439859c0112a4185bc0255', 'vUSDT'],
  ['0xa9251ca9de909cb71783723713b21e4233fbf1b1', 'aUSDT'],
])

export function StrategySetup({
  kind,
  initialSetupId,
}: {
  kind: StrategyKind
  initialSetupId?: string | undefined
}) {
  const account = useAccount()
  const sessionKey = useSyncExternalStore(
    subscribeWalletSession,
    () => `${walletSession().revision}:${walletSession().address ?? ''}`,
    () => '',
  )
  const [connecting, setConnecting] = useState(false),
    [problem, setProblem] = useState<string | null>(null)
  const copy = STRATEGY_COPY[kind]
  return (
    <PageCard
      title={copy.name}
      count="BNB mainnet · 56"
      tabs={[]}
      tabHint=""
      back={{ href: '/explore', label: 'Explore agents' }}
    >
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div className="max-w-prose space-y-2">
          <p className="text-body m-0 text-sm leading-relaxed">{copy.summary}</p>
          <p className="text-muted m-0 text-sm leading-relaxed">
            {copy.risk} A report is separate from this funded, signed strategy.
          </p>
        </div>
        {!account.authenticated || !walletSession().address ? (
          <section className={PANEL}>
            <h2 className="m-0 text-base font-bold">
              {account.connected
                ? 'Sign in to set up your strategy'
                : 'Connect your wallet to get started'}
            </h2>
            <p className="text-muted mt-2 text-sm leading-relaxed">
              Signing in proves your identity. It does not deploy a vault, move funds or grant
              trading authority.
            </p>
            <button
              className={PRIMARY}
              type="button"
              disabled={connecting}
              onClick={async () => {
                setConnecting(true)
                setProblem(null)
                try {
                  const result = await account.connect()
                  if (result !== 'injected')
                    setProblem(
                      'Wallet sign-in was not completed. Your strategy has not been started.',
                    )
                } catch (error) {
                  setProblem(explanation(error))
                } finally {
                  setConnecting(false)
                }
              }}
            >
              {connecting ? 'Connecting…' : account.connected ? 'Sign in' : 'Connect wallet'}
            </button>
            {problem ? (
              <p role="alert" className="text-work-ink text-sm">
                {problem}
              </p>
            ) : null}
          </section>
        ) : (
          <ConnectedStrategySetup
            key={`${kind}:${sessionKey}`}
            kind={kind}
            owner={account.address}
            initialSetupId={initialSetupId}
          />
        )}
      </div>
    </PageCard>
  )
}

interface Attempt {
  fingerprint: string
  key: string
  expiresAt: string
}
export function ConnectedStrategySetup({
  kind,
  owner,
  initialSetupId,
}: {
  kind: StrategyKind
  owner: string
  initialSetupId?: string | undefined
}) {
  const router = useRouter(),
    alive = useRef(true),
    pending = useRef(false),
    attempt = useRef<Attempt | null>(null)
  const revision = useRef(walletSession().revision)
  const [config, setConfig] = useState<StrategyPublicConfig | null>(null),
    [account, setAccount] = useState<string | null>(null)
  const [setups, setSetups] = useState<StrategySetupView[]>([]),
    [view, setView] = useState<StrategySetupView | null>(null)
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState<string | null>(null),
    [problem, setProblem] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | undefined>()
  useEffect(() => {
    if (!fieldError || busy) return
    const element = document.getElementById(`strategy-${fieldError.field}`)
    const details = element?.closest('details')
    if (details) details.open = true
    element?.focus()
  }, [fieldError, busy])
  const [values, setValues] = useState(() => initialPolicyValues(kind)),
    [rungs, setRungs] = useState<GridRungForm[]>([emptyRung()])
  const [authorization, setAuthorization] = useState<StrategyAuthorizationPreparation | null>(null)
  const walletIntent = useRef<{ fingerprint: string; key: string; actionId?: string } | null>(null)
  const [amount0, setAmount0] = useState(''),
    [amount1, setAmount1] = useState(''),
    [tokenId, setTokenId] = useState('')
  const [rungIndex, setRungIndex] = useState('0'),
    [withdrawToken, setWithdrawToken] = useState<string>(STRATEGY_REVIEWED_TOKENS.usdt.address)
  const [recoveryHash, setRecoveryHash] = useState(''),
    [journalTick, setJournalTick] = useState(0)
  const readyConfig =
    config?.available && config.kinds.includes(kind) && config.factories[kind] ? config : null
  const guard = async () => {
    await assertStrategyWallet(owner, revision.current)
    if (!alive.current) throw new Error('This setup view is no longer active.')
  }
  const accept = (next: StrategySetupView) => {
    assertSetup(next, owner)
    if (next.kind !== kind || !alive.current || walletSession().revision !== revision.current)
      return
    if (next.id !== view?.id) walletIntent.current = null
    setView(next)
    setSetups((old) => [next, ...old.filter((item) => item.id !== next.id)])
  }
  const refresh = async (id = view?.id ?? initialSetupId) => {
    const currentRevision = revision.current
    const [runtime, owned, mandate] = await Promise.all([
      strategyApi.config(),
      strategyApi.list(),
      api.account(),
    ])
    if (
      !alive.current ||
      walletSession().revision !== currentRevision ||
      walletSession().address !== owner.toLowerCase()
    )
      return
    if (
      runtime.chainId !== 56 ||
      mandate.chainId !== 56 ||
      (mandate.address !== null && !address(mandate.address))
    )
      throw new Error(
        'The mainnet strategy configuration or mandate account could not be verified.',
      )
    const matching = owned.setups.filter((item) => item.kind === kind)
    for (const item of matching) assertSetup(item, owner)
    setConfig(runtime)
    setAccount(mandate.address)
    setSetups(matching)
    if (id) {
      const current = await strategyApi.detail(id)
      if (walletSession().revision !== currentRevision || !alive.current) return
      accept(current)
    }
    setLoading(false)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: owner/session keyed mount; refreshing state must not start another automatic fetch.
  useEffect(() => {
    alive.current = true
    void refresh(initialSetupId).catch((error) => {
      if (alive.current) {
        setProblem(explanation(error))
        setLoading(false)
      }
    })
    return () => {
      alive.current = false
    }
    // One owner/session-scoped mount. Parent remounts on every account/session revision.
  }, [initialSetupId])
  const run = async (name: string, fn: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(name)
    setProblem(null)
    try {
      await fn()
    } catch (error) {
      if (alive.current && walletSession().revision === revision.current)
        setProblem(explanation(error))
    } finally {
      pending.current = false
      if (alive.current) {
        setBusy(null)
        setJournalTick((tick) => tick + 1)
      }
    }
  }
  const select = (next: StrategySetupView) => {
    accept(next)
    setAuthorization(null)
    setRecoveryHash('')
    router.replace(`/strategy/${kind}?setup=${encodeURIComponent(next.id)}` as Route)
  }
  const prepare = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFieldError(undefined)
    void run('Preparing review', async () => {
      if (!readyConfig || !address(account))
        throw new Error(
          'Verify the deployed strategy configuration and your mandate account first.',
        )
      const storageKey = `aiki.strategy-setup:${owner.toLowerCase()}:${kind}`
      const fingerprint = keccak256(stringToHex(canonical({ kind, account, values, rungs })))
      let prior = attempt.current
      try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
        if (
          stored &&
          typeof stored === 'object' &&
          'fingerprint' in stored &&
          hash(stored.fingerprint) &&
          'key' in stored &&
          typeof stored.key === 'string' &&
          'expiresAt' in stored &&
          typeof stored.expiresAt === 'string'
        )
          prior = stored as Attempt
      } catch {
        /* In-memory retry identity remains available. */
      }
      if (prior && prior.fingerprint !== fingerprint)
        throw new Error(
          'An earlier preparation is unconfirmed. Restore the same inputs and retry, or refresh your existing setups before creating a different policy.',
        )
      let input: ReturnType<typeof buildStrategyInput>, gasLimitWei: string
      try {
        input = buildStrategyInput(
          kind,
          account,
          values,
          rungs,
          BigInt(Math.floor(Date.now() / 1000)),
          prior?.expiresAt,
        )
        gasLimitWei = rawAmount(
          values.gasLimitBnb ?? '',
          'Network gas ceiling',
          18,
          false,
          'gasLimitBnb',
        )
      } catch (error) {
        if (error instanceof StrategyFieldError) {
          setFieldError({ field: error.field, message: error.message })
          const element = document.getElementById(`strategy-${error.field}`)
          const details = element?.closest('details')
          if (details) details.open = true
          element?.focus()
        }
        throw error
      }
      await guard()
      const current = await strategyApi.config()
      await guard()
      if (canonical(current) !== canonical(readyConfig))
        throw new Error('Configuration changed. Refresh and review again.')
      const nextAttempt = prior ?? {
        fingerprint,
        key: crypto.randomUUID(),
        expiresAt: input.common.expiresAt,
      }
      attempt.current = nextAttempt
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(nextAttempt))
      } catch {
        /* Deterministic server request still uses this in-memory key. */
      }
      const next = await strategyApi.prepare(input, gasLimitWei, nextAttempt.key)
      await guard()
      assertSetup(next, owner, readyConfig)
      if (canonical(next.input) !== canonical(input) || next.gasLimitWei !== gasLimitWei)
        throw new Error(
          'The prepared policy differs from your inputs. No transaction was requested.',
        )
      select(next)
      attempt.current = null
      try {
        sessionStorage.removeItem(storageKey)
      } catch {
        /* A retained key only reopens the same preparation. */
      }
    })
  }
  const prepareAction = (request: StrategyWalletActionRequest) =>
    void run('Preparing transaction', async () => {
      if (!view || !readyConfig)
        throw new Error('Refresh the verified strategy configuration first.')
      const storageKey = `aiki.strategy-intent:${owner.toLowerCase()}:${view.id}`
      const fingerprint = keccak256(stringToHex(canonical(request)))
      let previous = walletIntent.current
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
        if (
          saved &&
          typeof saved === 'object' &&
          'fingerprint' in saved &&
          hash(saved.fingerprint) &&
          'key' in saved &&
          typeof saved.key === 'string'
        )
          previous = saved as NonNullable<typeof previous>
      } catch {
        /* Preserve this tab's exact intent key. */
      }
      const previousActionId = previous?.actionId
      const completed = previousActionId
        ? view.actions.find((item) => item.id === previousActionId)
        : undefined
      if (
        completed &&
        (completed.status === 'REVERTED' ||
          (completed.status === 'FINALIZED' && completed.kind === request.kind))
      )
        previous = null
      if (previous && previous.fingerprint !== fingerprint)
        throw new Error(
          'A previous wallet intent is unresolved. Restore its inputs and continue the same review before preparing different amounts.',
        )
      const intent = previous ?? { fingerprint, key: crypto.randomUUID() }
      walletIntent.current = intent
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(intent))
      } catch {
        throw new Error(
          'Enable browser session storage before preparing wallet transactions so the same funding intent can be recovered.',
        )
      }
      await guard()
      const next = await strategyApi.prepareAction(view.id, request, intent.key)
      await guard()
      assertSetup(next, owner, readyConfig)
      const action = [...next.actions].reverse().find((item) => item.status === 'PREPARED')
      if (!action) throw new Error('No wallet transaction was prepared. Refresh the current state.')
      walletIntent.current = { ...intent, actionId: action.id }
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(walletIntent.current))
      } catch {
        /* The durable request key was already stored before this API request. */
      }
      assertWalletAction(action, next, readyConfig)
      accept(next)
      setAuthorization(null)
    })
  const funding = (withdraw = false) => {
    try {
      if (kind === 'lp') {
        prepareAction(
          withdraw
            ? { kind: 'withdraw' }
            : { kind: 'enroll', tokenId: rawAmount(tokenId, 'Position NFT ID', 0) },
        )
        return
      }
      if (kind === 'yield') {
        prepareAction(
          withdraw
            ? {
                kind: 'withdraw',
                token: withdrawToken as `0x${string}`,
                amount: rawAmount(
                  amount0,
                  'Recovery amount',
                  withdrawToken === '0xfd5840cd36d94d7229439859c0112a4185bc0255' ? 8 : 18,
                ),
              }
            : { kind: 'fund', assets: rawAmount(amount0, 'USDT funding amount') },
        )
        return
      }
      if (!/^(0|[1-9][0-9]*)$/.test(rungIndex) || Number(rungIndex) > 31)
        throw new Error('Choose a valid grid rung.')
      const amounts = {
        rungIndex: Number(rungIndex),
        amount0: rawAmount(amount0, 'USDT amount', 18, true),
        amount1: rawAmount(amount1, 'WBNB amount', 18, true),
      }
      prepareAction(withdraw ? { kind: 'withdraw', ...amounts } : { kind: 'fund', ...amounts })
    } catch (error) {
      setProblem(explanation(error))
    }
  }
  const latestAction = view
    ? [...view.actions]
        .reverse()
        .find((item) => ['PREPARED', 'SUBMITTED', 'NEEDS_REVIEW'].includes(item.status))
    : undefined
  // The tick deliberately refreshes the local recovery marker after every wallet outcome.
  void journalTick
  const memo = view && latestAction ? strategyJournal.get(owner, view.id, latestAction.id) : null
  const transactionHash = latestAction?.transactionHash ?? memo?.transactionHash
  const recoveryOnly = !!memo || latestAction?.status !== 'PREPARED'
  let actionProblem: string | null = null
  if (latestAction && view && readyConfig)
    try {
      assertWalletAction(latestAction, view, readyConfig)
    } catch (error) {
      actionProblem = explanation(error)
    }

  if (loading)
    return (
      <section className={`${PANEL} space-y-4`} role="status" aria-label="Loading strategy setup">
        <p className="text-muted m-0 text-sm">
          Checking deployment configuration and your existing setups…
        </p>
        <div aria-hidden className="h-11 rounded-xl bg-tray motion-safe:animate-pulse" />
        <div aria-hidden className="h-40 rounded-xl bg-tray motion-safe:animate-pulse" />
      </section>
    )

  return (
    <div className="space-y-5" aria-busy={!!busy}>
      {problem ? (
        <section
          role="alert"
          className="rounded-2xl border border-work-ink/20 bg-work-bg p-4 text-sm text-work-ink"
        >
          <p className="m-0 leading-relaxed">{problem}</p>
          <button
            type="button"
            className={`${SECONDARY} mt-3`}
            disabled={!!busy}
            onClick={() => void run('Refreshing', () => refresh())}
          >
            Refresh this setup
          </button>
        </section>
      ) : null}
      {!readyConfig ? (
        <section className={`${PANEL} bg-warn-bg`} role="status">
          <h2 className="m-0 text-base font-bold">Automation setup is not ready on this network</h2>
          <p className="text-body mt-2 mb-0 text-sm leading-relaxed">
            {config && !config.available
              ? config.reason
              : 'The reviewed factory and execution configuration could not be verified.'}{' '}
            Do not send funds to an unverified vault.
          </p>
          <button
            type="button"
            className={`${SECONDARY} mt-3`}
            disabled={!!busy}
            onClick={() => void run('Checking configuration', () => refresh())}
          >
            Check configuration again
          </button>
        </section>
      ) : null}
      {setups.length ? (
        <section className={PANEL}>
          <label htmlFor="strategy-existing" className="mb-2 block text-sm font-bold">
            Your existing setups
          </label>
          <select
            id="strategy-existing"
            className={INPUT}
            value={view?.id ?? ''}
            disabled={!!busy}
            onChange={(event) => {
              const next = setups.find((item) => item.id === event.target.value)
              if (next) select(next)
            }}
          >
            <option value="">Choose a setup to continue</option>
            {setups.map((item) => (
              <option key={item.id} value={item.id}>
                {label[item.status]} · {item.prepared.predictedVault.slice(0, 8)}…
                {item.prepared.predictedVault.slice(-4)}
              </option>
            ))}
          </select>
          {view ? (
            <button
              type="button"
              className={`${SECONDARY} mt-3`}
              disabled={!!busy || !!latestAction}
              onClick={() => {
                setView(null)
                setAuthorization(null)
                setRecoveryHash('')
                walletIntent.current = null
                router.replace(`/strategy/${kind}` as Route)
              }}
            >
              Review a separate policy
            </button>
          ) : null}
          {view ? (
            <p className="text-muted mt-2 mb-0 text-xs">
              A separate policy creates a separate vault. It never changes or stops this one.
            </p>
          ) : null}
        </section>
      ) : (
        <p className="text-muted m-0 text-sm">
          No strategy vaults yet. Review a policy below to prepare your first one.
        </p>
      )}
      {!view ? (
        <>
          <section className={PANEL}>
            <h2 className="m-0 text-base font-bold">1. Your mandate account</h2>
            <p className="text-muted mt-2 text-sm leading-relaxed">
              The current owner of this account controls vault recovery. Creating it does not give
              an agent permission or move investment capital.
            </p>
            {account ? (
              <code className="block break-all text-xs">{account}</code>
            ) : (
              <button
                type="button"
                className={PRIMARY}
                disabled={!!busy || !readyConfig}
                onClick={() =>
                  void run('Creating mandate account', async () => {
                    await guard()
                    const result = await api.createAccount()
                    await guard()
                    if (result.chainId !== 56 || !address(result.address))
                      throw new Error('Account deployment is not confirmed on mainnet.')
                    await refresh()
                  })
                }
              >
                {busy === 'Creating mandate account'
                  ? 'Checking account deployment…'
                  : 'Create mandate account'}
              </button>
            )}
          </section>
          <PolicyForm
            kind={kind}
            values={values}
            rungs={rungs}
            onValues={setValues}
            onRungs={setRungs}
            onSubmit={prepare}
            busy={!!busy}
            blocked={!readyConfig || !account}
            problem={fieldError}
          />
        </>
      ) : (
        <>
          <section className={PANEL}>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="m-0 flex-1 text-base font-bold">{label[view.status]}</h2>
              <button
                type="button"
                className={SECONDARY}
                disabled={!!busy}
                onClick={() => void run('Refreshing', () => refresh())}
              >
                Refresh status
              </button>
            </div>
            <dl className="mt-4 grid min-w-0 gap-3 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-muted">
                  {view.binding ? 'Verified vault' : 'Predicted vault · not yet verified'}
                </dt>
                <dd className="mt-1 ml-0 break-all font-mono">{view.prepared.predictedVault}</dd>
              </div>
              <div>
                <dt className="text-muted">Immutable policy hash</dt>
                <dd className="mt-1 ml-0 break-all font-mono">{view.prepared.policyHash}</dd>
              </div>
              <div>
                <dt className="text-muted">Network gas ceiling per operation</dt>
                <dd className="mt-1 ml-0 break-words font-semibold">
                  {formatUnits(BigInt(view.gasLimitWei), 18)} BNB
                </dd>
              </div>
              <div>
                <dt className="text-muted">Mandate account</dt>
                <dd className="mt-1 ml-0 break-all font-mono">{view.input.controller}</dd>
              </div>
            </dl>
            {view.binding ? (
              <a
                className={`mt-3 inline-flex min-h-10 items-center text-sm font-semibold text-ink-app underline underline-offset-4 ${FOCUS}`}
                href={`https://bscscan.com/address/${view.binding.vault}`}
                target="_blank"
                rel="noreferrer"
              >
                View vault and direct owner controls ↗
              </a>
            ) : null}
          </section>
          <PolicyReview input={view.input} />
          <StrategyActivity watch={view.watch} />
          {latestAction ? (
            <section className={`${PANEL} space-y-3`} aria-label="Review wallet transaction">
              <h2 className="m-0 text-base font-bold">
                {latestAction.kind === 'deploy'
                  ? '2. Deploy your paused vault'
                  : 'Review one wallet transaction'}
              </h2>
              <p className="text-body m-0 text-sm leading-relaxed">{latestAction.review.summary}</p>
              {latestAction.review.assets?.map((asset) => (
                <p key={asset.token} className="m-0 break-words text-sm font-bold tabular-nums">
                  {formatUnits(BigInt(asset.amount), asset.decimals)}{' '}
                  {tokenNames.get(asset.token.toLowerCase()) ?? 'reviewed receipt tokens'}
                  <span className="text-muted mt-1 block break-all font-mono text-xs font-normal">
                    {asset.token}
                  </span>
                </p>
              ))}
              {latestAction.review.tokenId ? (
                <p className="m-0 break-all text-sm font-semibold">
                  Position NFT #{latestAction.review.tokenId}
                </p>
              ) : null}
              <p className="text-muted m-0 text-xs">
                {transactionLabel[latestAction.status]}. Network gas is separate. Confirm only if
                the wallet shows BNB mainnet and the same contract.
              </p>
              <details>
                <summary
                  className={`flex min-h-10 cursor-pointer items-center text-xs font-semibold ${FOCUS}`}
                >
                  Exact transaction details
                </summary>
                <code className="block break-all rounded-xl bg-surface-sunk p-3 text-xs leading-relaxed">
                  From: {latestAction.transaction.from}
                  <br />
                  To: {latestAction.transaction.to}
                  <br />
                  Native value: 0 BNB
                  <br />
                  Data: {latestAction.transaction.data}
                </code>
              </details>
              {actionProblem ? (
                <p role="alert" className="text-work-ink text-sm">
                  {actionProblem}
                </p>
              ) : null}
              {transactionHash ? (
                <a
                  className={`inline-flex min-h-10 items-center break-all text-sm underline ${FOCUS}`}
                  href={`https://bscscan.com/tx/${transactionHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Original transaction: {transactionHash.slice(0, 12)}… ↗
                </a>
              ) : null}
              {recoveryOnly && !transactionHash ? (
                <AmountField
                  id="recovery-hash"
                  label="Original transaction hash"
                  value={recoveryHash}
                  onChange={setRecoveryHash}
                  mode="text"
                  hint="Find the hash in your wallet activity. Do not submit a replacement or repeat the transaction."
                />
              ) : null}
              <button
                type="button"
                className={PRIMARY}
                disabled={
                  !!busy ||
                  (!recoveryOnly && (!readyConfig || !!actionProblem)) ||
                  (recoveryOnly && !transactionHash && !hash(recoveryHash))
                }
                onClick={() =>
                  void run(
                    recoveryOnly ? 'Checking original transaction' : 'Awaiting wallet confirmation',
                    async () => {
                      const next = recoveryOnly
                        ? await reconcileStrategyAction(
                            view,
                            latestAction.id,
                            transactionHash ?? recoveryHash,
                          )
                        : readyConfig
                          ? await sendStrategyAction(view, readyConfig, latestAction)
                          : null
                      if (next) accept(next)
                    },
                  )
                }
              >
                {busy === 'Awaiting wallet confirmation'
                  ? 'Confirm in your wallet…'
                  : recoveryOnly
                    ? 'Check original transaction'
                    : 'Confirm this transaction in wallet'}
              </button>
            </section>
          ) : null}
          {view.binding ? (
            <>
              <section className={PANEL}>
                <h2 className="m-0 text-base font-bold">3. Fund or enroll explicitly</h2>
                <p className="text-muted mt-2 text-sm leading-relaxed">
                  {kind === 'lp'
                    ? 'Approve only your selected unstaked NFT, then enroll it with a separate confirmation. The executor never receives blanket NFT approval.'
                    : 'Funding may need an exact token approval first. Each step is reviewed and confirmed separately; no transaction sequence runs automatically.'}
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {kind === 'grid' && view.input.kind === 'grid' ? (
                    <div>
                      <label
                        htmlFor="strategy-fund-rung"
                        className="mb-2 block text-sm font-semibold"
                      >
                        Rung
                      </label>
                      <select
                        id="strategy-fund-rung"
                        value={rungIndex}
                        onChange={(event) => setRungIndex(event.target.value)}
                        className={INPUT}
                      >
                        {view.input.rungs.map((rung, i) => (
                          <option key={`${rung.buyTick}:${rung.sellTick}`} value={String(i)}>
                            Rung {i + 1}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {kind === 'lp' ? (
                    <AmountField
                      id="position-id"
                      label="Position NFT ID"
                      mode="numeric"
                      value={tokenId}
                      onChange={setTokenId}
                    />
                  ) : (
                    <AmountField
                      id="fund-usdt"
                      label="USDT amount"
                      value={amount0}
                      onChange={setAmount0}
                    />
                  )}
                  {kind === 'grid' ? (
                    <AmountField
                      id="fund-wbnb"
                      label="WBNB amount"
                      value={amount1}
                      onChange={setAmount1}
                    />
                  ) : null}
                </div>
                <button
                  type="button"
                  className={`${SECONDARY} mt-4`}
                  disabled={!!busy || !readyConfig || !!latestAction}
                  onClick={() => funding()}
                >
                  {kind === 'lp' ? 'Review NFT enrollment step' : 'Review next funding step'}
                </button>
              </section>
              <section className={`${PANEL} space-y-3`}>
                <h2 className="m-0 text-base font-bold">4. Enable, sign and start separately</h2>
                <p className="text-muted m-0 text-sm leading-relaxed">
                  Onchain enablement does not start the scheduler. A mandate permits only this
                  vault’s immutable strategy operation, not funding or recovery.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={SECONDARY}
                    disabled={!!busy || !readyConfig || !!latestAction}
                    onClick={() => prepareAction({ kind: 'resume' })}
                  >
                    Review onchain enablement
                  </button>
                  <button
                    type="button"
                    className={SECONDARY}
                    disabled={
                      !!busy || !readyConfig || !!latestAction || !!view.authorization?.signedAt
                    }
                    onClick={() =>
                      void run('Preparing mandate review', async () => {
                        await guard()
                        const prepared = await strategyApi.prepareAuthorization(view.id)
                        await guard()
                        if (!readyConfig) throw new Error('Refresh configuration first.')
                        assertStrategySigning(prepared, view, readyConfig)
                        setAuthorization(prepared)
                      })
                    }
                  >
                    {view.authorization?.signedAt
                      ? 'Mandate signature confirmed'
                      : 'Review strategy mandate'}
                  </button>
                </div>
                {authorization ? (
                  <section className="space-y-3 rounded-xl border border-ink-app/15 bg-surface-sunk p-4">
                    <p className="m-0 text-sm font-semibold">{authorization.review.summary}</p>
                    <p className="text-body m-0 break-all text-xs">
                      Executor: {authorization.review.executor}
                      <br />
                      Manager: {authorization.review.manager}
                      <br />
                      Signing digest: {authorization.digest}
                    </p>
                    <p className="text-muted m-0 text-xs">
                      All immutable limits above are bound by this vault’s policy hash. Signing does
                      not fund or start it.
                    </p>
                    <button
                      type="button"
                      className={PRIMARY}
                      disabled={!!busy || !readyConfig}
                      onClick={() =>
                        void run('Awaiting mandate signature', async () => {
                          if (!readyConfig) return
                          const next = await signStrategyAuthorization(
                            view,
                            readyConfig,
                            authorization,
                          )
                          accept(next)
                          setAuthorization(null)
                        })
                      }
                    >
                      Sign this strategy mandate
                    </button>
                  </section>
                ) : null}
                <div className="rounded-xl bg-surface-sunk p-3" role="status">
                  <p className="m-0 text-sm font-semibold">
                    {view.readiness.ready ? 'Server readiness checks passed' : 'Not ready to start'}
                  </p>
                  {view.readiness.reasons.length ? (
                    <ul className="text-body mt-2 mb-0 space-y-1 pl-4 text-xs">
                      {view.readiness.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                  {!view.readiness.schedulerReady ? (
                    <p className="text-body mb-0 text-xs">
                      The scheduler is not ready. No automation will start.
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={PRIMARY}
                  disabled={
                    !!busy ||
                    !readyConfig ||
                    !view.readiness.ready ||
                    !view.readiness.schedulerReady ||
                    view.status === 'ACTIVE'
                  }
                  onClick={() =>
                    void run('Starting this strategy', async () => {
                      if (readyConfig) accept(await startStrategySetup(view, readyConfig))
                    })
                  }
                >
                  {view.status === 'ACTIVE' ? 'Automation is active' : 'Start this strategy'}
                </button>
              </section>
              <section className={PANEL}>
                <h2 className="m-0 text-base font-bold">Pause and recovery</h2>
                <p className="text-muted mt-2 text-sm leading-relaxed">
                  Stopping AiKi does not cancel an already submitted transaction. Onchain pause is a
                  separate owner transaction. Recovery never automatically restarts automation.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={SECONDARY}
                    disabled={!!busy || view.status === 'PAUSED'}
                    onClick={() =>
                      void run('Pausing automation', async () => {
                        await guard()
                        const next = await strategyApi.pause(view.id)
                        await guard()
                        accept(next)
                      })
                    }
                  >
                    Pause AiKi automation
                  </button>
                  <button
                    type="button"
                    className={SECONDARY}
                    disabled={!!busy || !readyConfig || !!latestAction}
                    onClick={() => prepareAction({ kind: 'pause' })}
                  >
                    Review onchain pause
                  </button>
                  <button
                    type="button"
                    className={SECONDARY}
                    disabled={!!busy}
                    onClick={() =>
                      void run('Checking pending execution', async () => {
                        await guard()
                        const next = await strategyApi.recover(view.id)
                        await guard()
                        accept(next)
                      })
                    }
                  >
                    Reconcile pending execution
                  </button>
                </div>
                <details className="mt-4 rounded-xl border border-ink-app/10 p-3">
                  <summary
                    className={`flex min-h-10 cursor-pointer items-center text-sm font-bold ${FOCUS}`}
                  >
                    Recover my assets
                  </summary>
                  <p className="text-muted text-xs leading-relaxed">
                    Assets go only to your owner wallet.{' '}
                    {kind === 'lp'
                      ? 'The current NFT and tracked idle tokens are returned. This vault cannot enroll another position afterward.'
                      : 'Use the amount fields above; withdrawals do not replenish lifetime limits.'}
                  </p>
                  {kind === 'yield' ? (
                    <div className="space-y-3">
                      <label
                        htmlFor="strategy-withdraw-token"
                        className="block text-sm font-semibold"
                      >
                        Token to recover
                      </label>
                      <select
                        id="strategy-withdraw-token"
                        className={INPUT}
                        value={withdrawToken}
                        onChange={(event) => setWithdrawToken(event.target.value)}
                      >
                        <option value={STRATEGY_REVIEWED_TOKENS.usdt.address}>
                          Idle USDT (18 decimals)
                        </option>
                        <option value="0xfd5840cd36d94d7229439859c0112a4185bc0255">
                          Venus vUSDT receipt (8 decimals)
                        </option>
                        <option value="0xa9251ca9de909cb71783723713b21e4233fbf1b1">
                          Aave aUSDT receipt (18 decimals)
                        </option>
                      </select>
                      <AmountField
                        id="recover-amount"
                        label="Selected token amount to recover"
                        value={amount0}
                        onChange={setAmount0}
                      />
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={`${SECONDARY} mt-3`}
                    disabled={!!busy || !readyConfig || !!latestAction}
                    onClick={() => funding(true)}
                  >
                    Review asset recovery
                  </button>
                </details>
              </section>
            </>
          ) : null}
          {view.actions.length ? (
            <section className={PANEL}>
              <h2 className="m-0 text-base font-bold">Wallet receipts</h2>
              <ul className="m-0 mt-3 list-none space-y-3 p-0">
                {[...view.actions].reverse().map((action) => (
                  <li
                    key={action.id}
                    className="flex flex-wrap items-start gap-2 border-t border-ink-app/10 pt-3 text-xs"
                  >
                    <span className="min-w-0 flex-1 leading-relaxed">
                      {action.review.summary}
                      <span className="text-muted mt-1 block">
                        {transactionLabel[action.status]}
                      </span>
                    </span>
                    {action.transactionHash ? (
                      <a
                        className={`inline-flex min-h-10 items-center font-semibold underline ${FOCUS}`}
                        href={`https://bscscan.com/tx/${action.transactionHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View receipt ↗
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <Link
            className={`inline-flex min-h-11 items-center text-sm underline ${FOCUS}`}
            href="/explore"
          >
            Return to agents; report hiring remains separate
          </Link>
        </>
      )}
    </div>
  )
}
