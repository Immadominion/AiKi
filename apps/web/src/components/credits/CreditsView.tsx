'use client'

import Link from 'next/link'
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { fastReturnHref } from '@/components/home/FastPoints'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount } from '@/components/shell/prefs'
import { useToast } from '@/components/ui/Toast'
import { ApiError, api, type CreditBalance } from '@/lib/api'
import { route } from '@/lib/routes'
import { CONNECT_TOAST } from '@/lib/wallet'
import { subscribeWalletSession, walletSession } from '@/lib/wallet-session'
import {
  type CreditRail,
  canVerifyDeposit,
  creditEntryLabel,
  creditExplorer,
  creditLimitRows,
  creditNetworkLabel,
  creditRail,
  paymentHash,
  points,
} from './credits'

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-app'
const BUTTON = `min-h-11 rounded-xl bg-ink-app px-4 py-3 text-sm font-bold text-surface disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`
const SECONDARY = `min-h-11 rounded-xl bg-surface-sunk px-4 py-3 text-sm font-bold text-ink-app ring-1 ring-ink-app/10 disabled:opacity-50 ${FOCUS}`

export function CreditsView() {
  const { ready, authenticated, walletKind, address, connect } = useAccount()
  const say = useToast()
  const [connecting, setConnecting] = useState(false)
  return (
    <PageCard
      title="Points"
      count=""
      tabs={[]}
      tabHint=""
      headerSlot={
        <div>
          <h1 className="m-0 text-xl font-extrabold tracking-tight">Your points</h1>
          <p className="text-muted mt-1 mb-0 max-w-prose text-sm leading-relaxed">
            Pay for Fast mode and marketplace work. See where every point goes.
          </p>
        </div>
      }
    >
      {!ready ? (
        <Loading />
      ) : authenticated && walletKind === 'injected' ? (
        <ConnectedCredits key={address.toLowerCase()} address={address} />
      ) : (
        <section className="max-w-xl space-y-4 py-6">
          <h2 className="text-lg font-bold">Sign in to see your points</h2>
          <p className="text-muted text-sm leading-relaxed">
            Your balance and payment history belong to your wallet. Signing a message does not move
            money.
          </p>
          <button
            type="button"
            className={BUTTON}
            disabled={connecting}
            aria-busy={connecting}
            onClick={async () => {
              setConnecting(true)
              try {
                say(CONNECT_TOAST[await connect()])
              } finally {
                setConnecting(false)
              }
            }}
          >
            {connecting ? 'Waiting for your wallet...' : 'Connect and sign in'}
          </button>
        </section>
      )}
    </PageCard>
  )
}

function Loading() {
  return (
    <div role="status" aria-label="Loading your points" className="max-w-4xl space-y-4 py-4">
      <div className="h-28 rounded-2xl bg-surface-sunk" />
      <div className="h-44 rounded-2xl bg-surface-sunk" />
      <span className="text-muted text-sm">Loading your points...</span>
    </div>
  )
}

export function ConnectedCredits({ address }: { address: string }) {
  const session = useSyncExternalStore(
    subscribeWalletSession,
    () => `${walletSession().revision}:${walletSession().address ?? ''}`,
    () => 'server',
  )
  return <CreditsAccount key={`${address.toLowerCase()}:${session}`} address={address} />
}

function CreditsAccount({ address }: { address: string }) {
  const [returnHref, setReturnHref] = useState('/app')
  const [credits, setCredits] = useState<CreditBalance | null>(null)
  const [rail, setRail] = useState<CreditRail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [railError, setRailError] = useState(false)
  const alive = useRef(true)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    const [balance, config] = await Promise.allSettled([api.credits(), api.treasury()])
    if (!alive.current || request !== generation.current) return
    if (balance.status === 'fulfilled') setCredits(balance.value)
    else {
      setCredits(null)
      setError(
        balance.reason instanceof Error
          ? balance.reason.message
          : 'Your balance could not be loaded.',
      )
    }
    setRail(config.status === 'fulfilled' ? creditRail(config.value) : null)
    setRailError(config.status === 'rejected')
    setLoading(false)
  }, [])
  useEffect(() => {
    if (typeof window !== 'undefined') setReturnHref(fastReturnHref(window.location.search))
    alive.current = true
    void load()
    return () => {
      alive.current = false
      generation.current++
    }
  }, [load])
  if (loading && !credits) return <Loading />
  if (error || !credits)
    return (
      <section role="alert" className="max-w-xl space-y-4 py-6">
        <h2 className="text-lg font-bold">Your balance is unavailable</h2>
        <p className="text-muted text-sm">{error ?? 'Try loading your points again.'}</p>
        <button type="button" className={BUTTON} onClick={() => void load()} disabled={loading}>
          Try again
        </button>
      </section>
    )
  return (
    <div className="max-w-4xl space-y-8 pb-4">
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-surface-sunk p-5">
        <div>
          <p className="text-muted m-0 text-sm">Available to use</p>
          <p className="mt-1 mb-0 flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-4xl font-bold tabular-nums">
              {points(credits.balance)}
            </span>
            <span className="text-muted text-sm">points</span>
          </p>
          <p className="text-muted mt-2 mb-0 text-xs leading-relaxed">
            Reserved points are not included. Points cannot currently be withdrawn or exchanged for
            money.
          </p>
        </div>
        <button
          type="button"
          className={SECONDARY}
          onClick={() => void load()}
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? 'Refreshing...' : 'Refresh balance'}
        </button>
      </section>

      <section aria-labelledby="credit-add-title" className="space-y-3">
        <h2 id="credit-add-title" className="m-0 text-base font-bold">
          Add points
        </h2>
        <p className="text-muted m-0 max-w-prose text-sm leading-relaxed">
          Buy AiKi points with USDT at checkout. Holding USDT in your wallet does not add points.
          Your points are added after you verify the payment below.
        </p>
        {rail ? (
          <>
            <p className="text-muted m-0 max-w-prose text-sm leading-relaxed">
              Pay with USDT on {creditNetworkLabel(rail)}. Use only the token and receiving address
              shown below.
            </p>
            <p className="text-sm">
              <span className="font-mono tabular-nums">1</span>{' '}
              {rail.chainId === 97 ? 'testnet USDT' : 'USDT'} adds{' '}
              <span className="font-mono tabular-nums">{points(rail.pointsPerUsdt)}</span> points.
            </p>
            {canVerifyDeposit(rail, address) ? (
              <Payment
                key={`${rail.chainId}:${rail.token}:${rail.treasury}`}
                rail={rail}
                onVerified={load}
                refreshing={loading}
              />
            ) : (
              <p className="rounded-2xl bg-surface-sunk p-4 text-sm leading-relaxed">
                This wallet is AiKi’s receiving treasury. A transfer to yourself cannot buy points.
                Use a different paying wallet to add points.
              </p>
            )}
          </>
        ) : (
          <div className="rounded-2xl bg-surface-sunk p-4 text-sm leading-relaxed">
            <p className="m-0">
              {railError
                ? 'Payment details could not be loaded. Do not send funds until they are available.'
                : 'A supported payment network and receiving address are not configured. Do not send funds.'}
            </p>
            <button
              type="button"
              className={`${SECONDARY} mt-3`}
              disabled={loading}
              onClick={() => void load()}
            >
              Check again
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="credit-limits-title" className="space-y-3">
        <h2 id="credit-limits-title" className="m-0 text-base font-bold">
          Fast mode limits
        </h2>
        <p className="text-muted text-sm">
          Longer messages can need more points. Fast checks before spending.
        </p>
        <p className="text-muted m-0 max-w-prose text-sm leading-relaxed">
          Usage is metered, not a flat fee per message. AiKi reserves points before a turn, charges
          confirmed usage, and returns the unused amount when the turn settles.
        </p>
        {credits.limits ? (
          <dl className="m-0 grid gap-x-6 rounded-2xl border border-ink-app/10 px-4 sm:grid-cols-2">
            {creditLimitRows(credits.limits).map((row) => (
              <div
                key={row.label}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-ink-app/5 py-4 last:border-0"
              >
                <dt className="text-muted text-xs">{row.label}</dt>
                <dd className="m-0 font-mono text-sm font-bold tabular-nums">{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted text-sm">
            This deployment has not published its current limits.
          </p>
        )}
        <p className="text-muted m-0 text-xs leading-relaxed">
          A turn whose outcome is not confirmed keeps its remaining points held until
          reconciliation. Refreshing or waiting does not release them or run the work twice. You can
          still browse the marketplace.
        </p>
        <Link
          href={route(returnHref)}
          className={`inline-flex min-h-11 items-center text-sm font-bold text-ink-app underline underline-offset-4 ${FOCUS}`}
        >
          {returnHref === '/app' ? 'Back to Fast mode' : 'Back to this conversation'}
        </Link>
      </section>

      <section aria-labelledby="credit-history-title" className="space-y-3">
        <h2 id="credit-history-title" className="m-0 text-base font-bold">
          Recent point activity
        </h2>
        <p className="text-muted m-0 text-xs">
          Your latest <span className="font-mono tabular-nums">20</span> ledger entries.
          Reservations and returned points are shown separately.
        </p>
        {credits.history.length ? (
          <ul className="m-0 list-none divide-y divide-ink-app/10 rounded-2xl border border-ink-app/10 px-4">
            {credits.history.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-4 py-4">
                <div className="min-w-0">
                  <p className="m-0 text-sm font-semibold">
                    {creditEntryLabel(entry.reason, entry.delta)}
                  </p>
                  <p className="text-muted mt-1 mb-0 text-xs">
                    {Number.isFinite(Date.parse(entry.createdAt))
                      ? new Date(entry.createdAt).toLocaleString('en-US', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })
                      : 'Date unavailable'}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-sm font-bold tabular-nums">
                  {points(entry.delta, true)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-2xl bg-surface-sunk p-4 text-sm">
            No point activity yet. Your purchases, usage, and returned points will appear here.
          </p>
        )}
      </section>
    </div>
  )
}

function Payment({
  rail,
  onVerified,
  refreshing,
}: {
  rail: CreditRail
  onVerified: () => Promise<void>
  refreshing: boolean
}) {
  const say = useToast()
  const [hash, setHash] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlight.current || refreshing) return
    setError(null)
    setSuccess(null)
    let transactionHash: string
    try {
      transactionHash = paymentHash(hash)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Check the transaction hash.')
      input.current?.focus()
      return
    }
    inFlight.current = true
    setBusy(true)
    try {
      const result = await api.depositCredits(transactionHash)
      if (!alive.current) return
      setSuccess(
        `${points(result.points)} points added. Your updated balance is ${points(result.balance)} points.`,
      )
      await onVerified()
    } catch (problem) {
      if (!alive.current) return
      if (problem instanceof ApiError && problem.code === 'DEPOSIT_ALREADY_CREDITED') {
        setSuccess(
          'This payment was already credited. Your balance has been refreshed. Do not send it again.',
        )
        await onVerified()
      } else
        setError(
          problem instanceof Error
            ? problem.message
            : 'The payment could not be verified. Keep the same transaction hash and try again. Do not send another payment.',
        )
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <details className="rounded-2xl border border-ink-app/10 p-4">
      <summary className={`min-h-11 cursor-pointer py-3 text-sm font-bold ${FOCUS}`}>
        {rail.chainId === 97 ? 'Verify a testnet deposit' : 'Verify a USDT payment'}
      </summary>
      <div className="space-y-4 pt-3">
        <p className="m-0 text-sm leading-relaxed">
          Use this exact token on {creditNetworkLabel(rail)}, chain{' '}
          <span className="font-mono tabular-nums">{rail.chainId}</span>. Confirm any transfer in
          your wallet. This screen does not send funds.
        </p>
        <p className="text-work-ink m-0 text-sm font-semibold">
          {rail.chainId === 97
            ? 'Do not send real BNB or mainnet USDT. Testnet BNB is only for network fees.'
            : 'Send only USDT on BNB Smart Chain. Do not send BNB or tokens from another network. BNB pays the network fee in your wallet.'}
        </p>
        {refreshing ? (
          <p role="status" className="text-muted text-sm">
            Checking payment details. Wait before sending funds.
          </p>
        ) : null}
        <div hidden={refreshing} className="space-y-4">
          {(
            [
              ['Accepted token contract', rail.token],
              ['Receiving treasury', rail.treasury],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-xl bg-surface-sunk p-3">
              <p className="text-muted m-0 text-xs">{label}</p>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
                <button
                  type="button"
                  className={SECONDARY}
                  onClick={() => {
                    if (!navigator.clipboard) {
                      say('Select the address to copy it.')
                      return
                    }
                    navigator.clipboard
                      .writeText(value)
                      .then(() => say(`${label} copied.`))
                      .catch(() =>
                        say('Your browser would not let us copy. Select the address to copy it.'),
                      )
                  }}
                >
                  Copy
                </button>
              </div>
              <a
                className={`inline-flex min-h-11 items-center text-xs font-semibold underline underline-offset-4 ${FOCUS}`}
                href={`${creditExplorer(rail)}/address/${value}`}
                target="_blank"
                rel="noreferrer"
              >
                {rail.chainId === 97 ? 'View on testnet explorer' : 'View on BscScan'}
              </a>
            </div>
          ))}
        </div>
        <form onSubmit={submit} className="space-y-3" aria-busy={busy}>
          <label htmlFor="credit-payment-hash" className="block text-sm font-bold">
            Transaction hash
          </label>
          <input
            ref={input}
            id="credit-payment-hash"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={hash}
            onChange={(event) => setHash(event.target.value)}
            maxLength={68}
            required
            disabled={busy || refreshing}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'credit-payment-error' : 'credit-payment-hint'}
            className={`min-h-11 w-full rounded-xl border border-ink-app/20 bg-surface px-3 py-3 font-mono text-base sm:text-sm ${FOCUS}`}
          />
          <p id="credit-payment-hint" className="text-muted m-0 text-xs leading-relaxed">
            Paste the hash after the transfer is mined. AiKi waits for{' '}
            <span className="font-mono tabular-nums">{points(rail.confirmations)}</span> block
            confirmations{rail.finality === 'finalized' ? ' and network finality' : ''}. The payment
            must come from your signed-in wallet. AiKi checks the network, token, sender, recipient,
            and amount. If it is still confirming, retry the same hash.
          </p>
          {error ? (
            <p
              id="credit-payment-error"
              role="alert"
              className="text-work-ink text-sm leading-relaxed"
            >
              {error}
            </p>
          ) : null}
          {success ? (
            <p role="status" className="text-good-ink text-sm leading-relaxed">
              {success}
            </p>
          ) : null}
          <button type="submit" className={BUTTON} disabled={busy || refreshing}>
            {busy ? 'Checking the payment...' : 'Verify payment and add points'}
          </button>
        </form>
      </div>
    </details>
  )
}
