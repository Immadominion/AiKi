'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { taskPrice, taskRejectedBeforeCharge } from '@/components/hire/agent-task'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount } from '@/components/shell/prefs'
import { UserAvatar } from '@/components/ui/Avatar'
import { api, type Seller } from '@/lib/api'
import {
  buildPersonTask,
  type PersonTaskAttempt,
  type PersonTaskPricing,
  personAttemptKey,
  personTaskAttempt,
} from './person-task'

const FIELD =
  'mt-2 min-h-11 w-full rounded-xl border border-black/15 bg-white px-3 py-3 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-orange-app'
const BUTTON =
  'min-h-11 rounded-xl px-4 text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app disabled:opacity-40'

export function PersonHire({
  seller,
  pricing,
  onBack,
}: {
  seller: Seller
  pricing: PersonTaskPricing
  onBack: () => void
}) {
  const account = useAccount()
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [kind, setKind] = useState(seller.kinds[0] ?? '')
  const [offer, setOffer] = useState(
    String(Math.max(seller.ratePoints, pricing.minimumPricePoints)),
  )
  const [workHours, setWorkHours] = useState(24)
  const [consent, setConsent] = useState(false)
  const [balance, setBalance] = useState<number | null>(null)
  const [balanceError, setBalanceError] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PersonTaskAttempt | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const lock = useRef(false)
  const active = useRef(true)
  const errorPanel = useRef<HTMLDivElement>(null)
  const storageKey = personAttemptKey(account.address, seller.address)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    if (problem) errorPanel.current?.focus()
  }, [problem])
  useEffect(() => {
    if (!account.authenticated) return
    try {
      const stored = JSON.parse(
        sessionStorage.getItem(storageKey) ?? 'null',
      ) as PersonTaskAttempt | null
      if (
        stored &&
        typeof stored.key === 'string' &&
        stored.request?.hirePerson?.toLowerCase() === seller.address.toLowerCase() &&
        typeof stored.request.title === 'string' &&
        typeof stored.request.brief === 'string'
      ) {
        setPending(stored)
        setTitle(stored.request.title)
        setBrief(stored.request.brief)
        setKind(stored.request.kind)
        setOffer(String(stored.request.pricePoints))
        setWorkHours(stored.request.workHours ?? 24)
        setProblem(
          'An earlier request may already have been funded. Check that same request before making another.',
        )
      }
    } catch {
      /* No saved request on this device. */
    }
  }, [storageKey, seller.address, account.authenticated])
  const loadBalance = useCallback(async () => {
    if (!account.authenticated) return
    setBalanceError(false)
    try {
      const result = await api.credits()
      if (active.current) setBalance(result.balance)
    } catch {
      if (active.current) {
        setBalance(null)
        setBalanceError(true)
      }
    }
  }, [account.authenticated])
  useEffect(() => {
    void loadBalance()
  }, [loadBalance])
  let price: ReturnType<typeof taskPrice> | null = null
  try {
    price = taskPrice(offer, pricing.minimumPricePoints, pricing.feeBasisPoints)
  } catch {
    /* incomplete offer */
  }

  const submit = async () => {
    if (lock.current || !account.authenticated) return
    setProblem(null)
    let attempt = pending
    try {
      lock.current = true
      setBusy(true)
      if (!attempt) {
        if (!consent) throw new Error('Review the total and confirm the points hold first.')
        if (!price || balance === null)
          throw new Error('Check your offer and refresh your balance first.')
        if (price.total > balance)
          throw new Error(
            `This needs ${price.total.toLocaleString()} points. You have ${balance.toLocaleString()}.`,
          )
        const current = await api.seller(seller.address)
        const request = buildPersonTask(
          { title, brief, kind, offer, workHours },
          current,
          account.address,
          pricing,
        )
        attempt = personTaskAttempt(null, request, () => crypto.randomUUID())
        if (!active.current) return
        setPending(attempt)
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(attempt))
        } catch {
          /* Keep the in-memory key. */
        }
      }
      const task = await api.postTask(attempt.request, attempt.key)
      try {
        sessionStorage.removeItem(storageKey)
      } catch {
        /* optional browser storage */
      }
      if (!active.current) return
      setCreated(task.id)
      setPending(null)
      void loadBalance()
    } catch (failure) {
      if (!active.current) return
      if (taskRejectedBeforeCharge(failure)) {
        setPending(null)
        try {
          sessionStorage.removeItem(storageKey)
        } catch {
          /* optional browser storage */
        }
      }
      setProblem((failure as Error).message)
    } finally {
      lock.current = false
      if (active.current) setBusy(false)
    }
  }

  return (
    <PageCard title="Request work" count="" tabs={[]} tabHint="">
      <button type="button" onClick={onBack} className={`${BUTTON} mb-3 -ml-4 text-muted`}>
        ← Back to People
      </button>
      {created ? (
        <section className="max-w-xl rounded-2xl bg-surface-sunk p-6">
          <h2 className="mt-0 text-lg font-bold">Your request is in Work.</h2>
          <p className="text-[13px] leading-relaxed text-muted">
            {seller.name} can see your brief. Follow the task, review the result, and release
            payment when you accept it.
          </p>
          <Link
            href={`/work?task=${encodeURIComponent(created)}`}
            className={`${BUTTON} inline-flex items-center bg-ink-app text-white`}
          >
            Open your work
          </Link>
        </section>
      ) : (
        <form
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0">
              <div className="mb-5 flex items-center gap-3">
                <UserAvatar address={seller.address} size={48} />
                <div>
                  <h2 className="m-0 text-[17px] font-bold">{seller.name}</h2>
                  <p className="mt-1 mb-0 text-[12px] text-muted">
                    {seller.record.delivered} completed · Suggested offer{' '}
                    {seller.ratePoints.toLocaleString()} points
                  </p>
                </div>
              </div>
              <fieldset disabled={busy || Boolean(pending)} className="m-0 grid gap-4 border-0 p-0">
                <label className="text-[13px] font-semibold">
                  Task title
                  <input
                    required
                    maxLength={120}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    className={FIELD}
                    placeholder="Review the onboarding copy"
                  />
                </label>
                <label className="text-[13px] font-semibold">
                  Your brief
                  <textarea
                    required
                    maxLength={2000}
                    rows={6}
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                    className={FIELD}
                    placeholder="Describe what you need and what a finished result should include."
                  />
                  <span className="mt-1 block text-[12px] font-normal text-muted">
                    Include what they need to begin. Do not include private keys or passwords.
                  </span>
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-[13px] font-semibold">
                    Work type
                    <select
                      value={kind}
                      onChange={(event) => setKind(event.target.value)}
                      className={FIELD}
                    >
                      {seller.kinds.map((value) => (
                        <option key={value} value={value}>
                          {value[0]?.toUpperCase()}
                          {value.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[13px] font-semibold">
                    Delivery time
                    <select
                      value={workHours}
                      onChange={(event) => setWorkHours(Number(event.target.value))}
                      className={FIELD}
                    >
                      {[
                        [24, '1 day'],
                        [48, '2 days'],
                        [72, '3 days'],
                        [168, '1 week'],
                        [336, '2 weeks'],
                      ].map(([hours, label]) => (
                        <option key={hours} value={hours}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="text-[13px] font-semibold">
                  Your offer in points
                  <input
                    required
                    inputMode="numeric"
                    pattern="[0-9]+"
                    value={offer}
                    onChange={(event) => {
                      setOffer(event.target.value)
                      setConsent(false)
                    }}
                    className={FIELD}
                  />
                  <span className="mt-1 block text-[12px] font-normal text-muted">
                    Choose your offer. This is not a wallet token payment.
                  </span>
                </label>
              </fieldset>
            </div>
            <aside className="self-start rounded-2xl bg-surface-sunk p-5">
              <h3 className="mt-0 mb-4 text-[14px] font-bold">Before you send</h3>
              <dl className="m-0 space-y-3 text-[13px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Your offer</dt>
                  <dd className="m-0 font-semibold tabular-nums">
                    {price ? `${price.offer.toLocaleString()} pts` : 'Enter an offer'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">AiKi fee ({pricing.feeBasisPoints / 100}%)</dt>
                  <dd className="m-0 font-semibold tabular-nums">
                    {price ? `${price.fee.toLocaleString()} pts` : 'Not calculated'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 border-t border-black/10 pt-3">
                  <dt className="font-semibold">Held now</dt>
                  <dd className="m-0 font-bold tabular-nums">
                    {price ? `${price.total.toLocaleString()} pts` : 'Not calculated'}
                  </dd>
                </div>
              </dl>
              <p className="mt-4 mb-1 text-[12px] text-muted">
                {balance !== null
                  ? `Your balance: ${balance.toLocaleString()} points`
                  : account.authenticated
                    ? balanceError
                      ? 'Balance unavailable.'
                      : 'Loading your balance…'
                    : 'Sign in to see your balance.'}
              </p>
              {balanceError ? (
                <button
                  type="button"
                  onClick={() => void loadBalance()}
                  className="min-h-10 text-[12px] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-orange-app"
                >
                  Refresh balance
                </button>
              ) : null}
              <p className="mt-4 text-[12px] leading-relaxed text-muted">
                Points are held for this task. Review the submitted work before accepting and
                releasing payment. AiKi points cannot currently be withdrawn.
              </p>
              {!pending ? (
                <label className="my-4 flex items-start gap-3 text-[12px] leading-relaxed">
                  <input
                    type="checkbox"
                    required
                    checked={consent}
                    onChange={(event) => setConsent(event.target.checked)}
                    className="mt-1 size-4 shrink-0 accent-[var(--color-orange-app)]"
                  />
                  I have reviewed the offer, fee, and points hold.
                </label>
              ) : (
                <p className="my-4 text-[12px] leading-relaxed">
                  This keeps the original request and payment key. Check Work before starting a
                  different request.
                </p>
              )}
              {account.authenticated ? (
                <button
                  type="submit"
                  disabled={
                    busy ||
                    (!pending && (!price || balance === null || !consent || price.total > balance))
                  }
                  className={`${BUTTON} w-full bg-ink-app text-white`}
                >
                  {busy
                    ? 'Checking request…'
                    : pending
                      ? 'Check existing request'
                      : 'Confirm and hold points'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    void account.connect().catch((error: Error) => setProblem(error.message))
                  }
                  className={`${BUTTON} w-full bg-ink-app text-white`}
                >
                  Sign in with your wallet
                </button>
              )}
              <Link
                href="/work"
                className="mt-3 inline-flex min-h-10 items-center text-[12px] underline underline-offset-4"
              >
                View your work
              </Link>
            </aside>
          </div>
          {problem ? (
            <div
              ref={errorPanel}
              tabIndex={-1}
              role="alert"
              className="mt-5 rounded-xl border border-black/15 p-4 text-[13px] focus-visible:outline-2 focus-visible:outline-orange-app"
            >
              {problem}
            </div>
          ) : null}
        </form>
      )}
    </PageCard>
  )
}
