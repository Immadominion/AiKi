'use client'

import type { ProjectedPassport } from '@aiki/contracts'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { paletteFor } from '@/components/home/live-shards'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount } from '@/components/shell/prefs'
import { useToast } from '@/components/ui/Toast'
import { type AgentTaskSupport, api } from '@/lib/api'
import { CONNECT_TOAST } from '@/lib/wallet'
import {
  buildAgentTask,
  TASK_TYPES,
  type TaskAttempt,
  taskAttempt,
  taskPrice,
  taskRejectedBeforeCharge,
} from './agent-task'

const FIELD =
  'mt-2 min-h-11 w-full rounded-xl border border-black/15 bg-white px-3 py-3 text-base leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600 sm:text-sm'
const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600'
const HOURS = [
  [1, 'Within 1 hour'],
  [6, 'Within 6 hours'],
  [24, 'Within 1 day'],
  [48, 'Within 2 days'],
  [72, 'Within 3 days'],
  [168, 'Within 1 week'],
] as const

export function AgentTaskForm({
  passport,
  support,
}: {
  passport: ProjectedPassport
  support: AgentTaskSupport
}) {
  const router = useRouter()
  const say = useToast()
  const { connected, authenticated, address, connect } = useAccount()
  const kinds = TASK_TYPES.filter(
    ([value]) => !support.kinds?.length || support.kinds.includes(value),
  )
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [kind, setKind] = useState<string>(kinds[0]?.[0] ?? 'research')
  const [offer, setOffer] = useState('')
  const [workHours, setWorkHours] = useState(24)
  const [includeWallet, setIncludeWallet] = useState(false)
  const [walletAddress, setWalletAddress] = useState(address)
  const [balance, setBalance] = useState<number | null>(null)
  const [balanceError, setBalanceError] = useState(false)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const inFlight = useRef(false)
  const retry = useRef<TaskAttempt | null>(null)
  const errorPanel = useRef<HTMLDivElement>(null)
  const name = passport.name ?? `Agent ${passport.agentId}`

  const loadBalance = useCallback(async () => {
    if (!authenticated) return
    setBalanceError(false)
    try {
      const credits = await api.credits()
      setBalance(credits.balance)
    } catch {
      setBalance(null)
      setBalanceError(true)
    }
  }, [authenticated])

  useEffect(() => {
    void loadBalance()
  }, [loadBalance])
  useEffect(() => {
    if (problem) errorPanel.current?.focus()
  }, [problem])

  let price: ReturnType<typeof taskPrice> | null = null
  try {
    price = taskPrice(offer, support.minimumPricePoints, support.feeBasisPoints)
  } catch {
    /* The form is still being filled in. */
  }
  const notEnough = balance !== null && price !== null && price.total > balance
  const descriptionLimit = includeWallet ? 1_920 : 2_000

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlight.current || !authenticated || !support.available) return
    setProblem(null)
    setPriceError(null)
    const storageKey = `aiki.task-attempt:${address.toLowerCase()}:${passport.agentId}`
    try {
      const priced = taskPrice(offer, support.minimumPricePoints, support.feeBasisPoints)
      if (balance === null) throw new Error('Refresh your balance before sending this request.')
      if (priced.total > balance)
        throw new Error(
          `This request needs ${priced.total.toLocaleString()} points. Your balance is ${balance.toLocaleString()}.`,
        )
      const request = buildAgentTask({
        agentId: passport.agentId,
        title,
        brief,
        kind,
        pricePoints: priced.offer,
        workHours,
        ...(includeWallet ? { walletAddress } : {}),
      })
      inFlight.current = true
      setBusy(true)
      // Store only a digest and random operation key, never the private brief.
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(request)),
      )
      const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('')
      let previous = retry.current
      try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
        if (
          stored &&
          typeof stored === 'object' &&
          'fingerprint' in stored &&
          'key' in stored &&
          typeof stored.fingerprint === 'string' &&
          typeof stored.key === 'string'
        )
          previous = { fingerprint: stored.fingerprint, key: stored.key }
      } catch {
        /* The in-memory key still protects retries when storage is unavailable. */
      }
      const attempt = taskAttempt(previous, fingerprint, () => crypto.randomUUID())
      retry.current = attempt
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(attempt))
      } catch {
        /* Continue with the in-memory key. */
      }
      const task = await api.postTask(request, attempt.key)
      try {
        sessionStorage.removeItem(storageKey)
      } catch {
        /* The server still deduplicates this key. */
      }
      say(
        task.submission
          ? 'Your request was delivered. Review the result in Work.'
          : 'Your request is in Work. Follow its delivery there.',
      )
      router.push(`/work?task=${encodeURIComponent(task.id)}`)
    } catch (error) {
      if (taskRejectedBeforeCharge(error)) {
        retry.current = null
        try {
          sessionStorage.removeItem(storageKey)
        } catch {
          /* The in-memory attempt has still been cleared. */
        }
        void loadBalance()
      }
      setProblem(
        error instanceof Error
          ? error.message
          : 'We could not confirm this request. Try the same request again, or check Work.',
      )
      inFlight.current = false
      setBusy(false)
    }
  }

  const header = (
    <div className="flex items-start gap-4">
      <span
        aria-hidden="true"
        className="flex size-12 shrink-0 items-center justify-center rounded-2xl text-xl font-extrabold text-white"
        style={{ background: paletteFor(passport.agentId).bg }}
      >
        {name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0">
        <h1 className="m-0 text-xl font-extrabold tracking-tight">Request work from {name}</h1>
        <p className="text-muted mt-1 mb-0 max-w-prose text-sm leading-relaxed">
          Send a clear request. Review what comes back before releasing payment.
        </p>
      </div>
    </div>
  )

  return (
    <PageCard
      title={`Hire ${name}`}
      count=""
      tabs={[]}
      tabHint=""
      headerSlot={header}
      back={{ href: `/registry/${passport.agentId}`, label: name }}
    >
      {!authenticated ? (
        <section className="max-w-xl rounded-2xl border border-black/10 p-6">
          <h2 className="m-0 text-base font-bold">
            {connected ? 'Sign in to request work' : 'Connect your wallet to get started'}
          </h2>
          <p className="text-muted mt-2 text-sm leading-relaxed">
            Your request and result stay with your account. Signing in does not move funds or grant
            the agent access to your wallet.
          </p>
          <button
            type="button"
            disabled={signingIn}
            onClick={async () => {
              setSigningIn(true)
              try {
                say(CONNECT_TOAST[await connect()])
              } finally {
                setSigningIn(false)
              }
            }}
            className={`bg-ink-app min-h-11 rounded-xl px-5 text-sm font-bold text-white disabled:opacity-50 ${FOCUS}`}
          >
            {signingIn ? 'Connecting…' : connected ? 'Sign in' : 'Connect wallet'}
          </button>
        </section>
      ) : (
        <form
          onSubmit={submit}
          aria-busy={busy}
          className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]"
        >
          <fieldset
            disabled={busy}
            className="m-0 min-w-0 space-y-5 rounded-2xl border border-black/10 p-5"
          >
            <legend className="sr-only">Your request</legend>
            <div>
              <label htmlFor="task-title" className="text-sm font-bold">
                Give the job a name <span className="text-muted font-normal">(required)</span>
              </label>
              <input
                id="task-title"
                name="title"
                type="text"
                required
                maxLength={120}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                autoComplete="off"
                placeholder="Check my lending position"
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="task-brief" className="text-sm font-bold">
                What should the agent deliver?{' '}
                <span className="text-muted font-normal">(required)</span>
              </label>
              <textarea
                id="task-brief"
                name="brief"
                required
                rows={5}
                maxLength={descriptionLimit}
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                aria-describedby="task-brief-hint"
                placeholder="Describe the work, any useful context, and what a good result looks like."
                className={`${FIELD} resize-y`}
              />
              <div
                id="task-brief-hint"
                className="text-muted mt-2 flex items-start justify-between gap-4 text-xs leading-relaxed"
              >
                <span>
                  {support.inputHint ?? 'Include the details the agent needs to do this job.'}
                </span>
                <span className="shrink-0 tabular-nums">
                  {brief.length}/{descriptionLimit}
                </span>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="task-kind" className="text-sm font-bold">
                  Type of work
                </label>
                <select
                  id="task-kind"
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                  className={FIELD}
                >
                  {kinds.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="task-deadline" className="text-sm font-bold">
                  Time to deliver
                </label>
                <select
                  id="task-deadline"
                  value={workHours}
                  onChange={(event) => setWorkHours(Number(event.target.value))}
                  className={FIELD}
                >
                  {HOURS.map(([hours, label]) => (
                    <option key={hours} value={hours}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="rounded-xl bg-black/3 p-4">
              <label
                htmlFor="task-include-wallet"
                className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold"
              >
                <input
                  id="task-include-wallet"
                  type="checkbox"
                  checked={includeWallet}
                  onChange={(event) => setIncludeWallet(event.target.checked)}
                  className={`size-4 accent-orange-600 ${FOCUS}`}
                />
                Include a wallet address for the agent to read
              </label>
              {includeWallet ? (
                <div className="mt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="task-wallet" className="text-sm font-bold">
                      Public wallet address
                    </label>
                    <button
                      type="button"
                      onClick={() => setWalletAddress(address)}
                      className={`min-h-10 rounded-lg px-2 text-xs font-semibold underline underline-offset-4 ${FOCUS}`}
                    >
                      Use connected wallet
                    </button>
                  </div>
                  <input
                    id="task-wallet"
                    type="text"
                    required
                    pattern="0x[0-9a-fA-F]{40}"
                    value={walletAddress}
                    onChange={(event) => setWalletAddress(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="task-wallet-hint"
                    className={`${FIELD} font-mono`}
                  />
                  <p id="task-wallet-hint" className="text-muted mt-2 mb-0 text-xs leading-relaxed">
                    This shares a public address in the brief. It grants no spending permission.
                  </p>
                </div>
              ) : null}
            </div>
          </fieldset>

          <aside className="min-w-0 rounded-2xl border border-black/10 p-5 lg:sticky lg:top-0">
            <h2 className="m-0 text-base font-bold">Agree on the cost</h2>
            <p className="text-muted mt-2 text-xs leading-relaxed">
              You choose the offer. The agent can accept or decline it.
            </p>
            <label htmlFor="task-offer" className="mt-5 block text-sm font-bold">
              Your offer in points
            </label>
            <input
              id="task-offer"
              type="text"
              required
              inputMode="numeric"
              pattern="[0-9]+"
              value={offer}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => {
                setOffer(event.target.value)
                setPriceError(null)
              }}
              onBlur={() => {
                if (!offer) return
                try {
                  taskPrice(offer, support.minimumPricePoints, support.feeBasisPoints)
                  setPriceError(null)
                } catch (error) {
                  setPriceError((error as Error).message)
                }
              }}
              placeholder="For example, 1000"
              maxLength={16}
              aria-invalid={Boolean(priceError)}
              aria-describedby="task-offer-hint task-offer-error"
              className={`${FIELD} font-mono`}
            />
            <p id="task-offer-hint" className="text-muted mt-2 mb-0 text-xs">
              Minimum {support.minimumPricePoints.toLocaleString()} points.
            </p>
            <p
              id="task-offer-error"
              className="mt-2 mb-0 text-xs text-red-700"
              role={priceError ? 'alert' : undefined}
            >
              {priceError}
            </p>

            <dl className="my-5 space-y-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted">Your offer</dt>
                <dd className="m-0 font-semibold tabular-nums">
                  {price ? price.offer.toLocaleString() : 'Not set'}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted">AiKi fee ({support.feeBasisPoints / 100}%)</dt>
                <dd className="m-0 font-semibold tabular-nums">
                  {price ? price.fee.toLocaleString() : 'Not set'}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-black/10 pt-4">
                <dt className="font-bold">Total held</dt>
                <dd className="m-0 text-lg font-extrabold tabular-nums">
                  {price ? `${price.total.toLocaleString()} points` : 'Choose an offer'}
                </dd>
              </div>
            </dl>

            <div className="rounded-xl bg-black/3 p-3 text-xs leading-relaxed">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">Available balance</span>
                <span className="font-bold tabular-nums">
                  {balance === null
                    ? balanceError
                      ? 'Unavailable'
                      : 'Loading…'
                    : `${balance.toLocaleString()} points`}
                </span>
              </div>
              {balanceError || notEnough ? (
                <button
                  type="button"
                  onClick={() => void loadBalance()}
                  className={`mt-2 min-h-10 rounded-lg px-2 font-semibold underline underline-offset-4 ${FOCUS}`}
                >
                  Refresh balance
                </button>
              ) : null}
              {notEnough ? (
                <p className="mt-2 mb-0 text-red-700">
                  Your balance is below this total. Choose a smaller offer or add points before
                  continuing.
                </p>
              ) : null}
            </div>

            {problem ? (
              <div
                ref={errorPanel}
                tabIndex={-1}
                role="alert"
                className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm leading-relaxed text-red-800"
              >
                <p className="m-0">{problem}</p>
                <Link
                  href="/work"
                  className={`mt-2 inline-flex min-h-10 items-center rounded-lg font-semibold underline underline-offset-4 ${FOCUS}`}
                >
                  Check Work
                </Link>
              </div>
            ) : null}

            <button
              type="submit"
              disabled={busy || !price || balance === null || notEnough}
              className={`bg-ink-app hover:bg-orange-app mt-5 min-h-12 w-full rounded-xl px-4 py-3 text-sm font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS}`}
            >
              {busy
                ? 'Sending your request…'
                : price
                  ? `Request work for ${price.total.toLocaleString()} points`
                  : 'Set your offer to continue'}
            </button>
            <p className="text-muted mt-3 mb-0 text-xs leading-relaxed">
              The total is held when you send this request. Review the delivery in Work before
              releasing payment. Points are used inside AiKi and cannot be withdrawn.
            </p>
          </aside>
        </form>
      )}
    </PageCard>
  )
}
