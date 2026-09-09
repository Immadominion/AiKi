'use client'

import { useEffect, useRef, useState } from 'react'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount } from '@/components/shell/prefs'
import { UserAvatar } from '@/components/ui/Avatar'
import { useToast } from '@/components/ui/Toast'
import { ApiError, api, type Seller } from '@/lib/api'
import { CONNECT_TOAST } from '@/lib/wallet'
import { PersonHire } from './PersonHire'
import { type PersonTaskPricing, validatePersonListing } from './person-task'

const FIELD =
  'mt-2 min-h-11 w-full rounded-xl border border-black/15 bg-white px-3 py-3 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-orange-app'
const BUTTON =
  'min-h-11 rounded-xl px-4 text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app disabled:opacity-40'
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export function People() {
  const account = useAccount()
  const say = useToast()
  const connecting = useRef(false)
  const [connectBusy, setConnectBusy] = useState(false)
  const [people, setPeople] = useState<Seller[]>([])
  const [kinds, setKinds] = useState<Record<string, string>>({})
  const [pricing, setPricing] = useState<PersonTaskPricing | null>(null)
  const [mine, setMine] = useState<Seller | null>(null)
  const [listingLoading, setListingLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [hiring, setHiring] = useState<Seller | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [listingProblem, setListingProblem] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [filter, setFilter] = useState('all')
  const [notice, setNotice] = useState<string | null>(null)
  const signIn = async () => {
    if (connecting.current) return
    connecting.current = true
    setConnectBusy(true)
    try {
      say(CONNECT_TOAST[await account.connect()])
    } catch (error) {
      say(error instanceof Error ? error.message : 'Sign-in did not complete. Try again.')
    } finally {
      connecting.current = false
      setConnectBusy(false)
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries the two reads.
  useEffect(() => {
    let active = true
    setLoading(true)
    setProblem(null)
    setListingProblem(null)
    setMine(null)
    setListingLoading(account.authenticated)
    api
      .sellers()
      .then((result) => {
        if (!active) return
        setPeople(result.sellers)
        setKinds(result.kinds)
        setPricing({
          minimumPricePoints: result.minimumPricePoints,
          feeBasisPoints: result.feeBasisPoints,
        })
      })
      .catch((error: Error) => {
        if (active) setProblem(error.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    if (account.authenticated)
      api
        .seller(account.address)
        .then((seller) => {
          if (active) setMine(seller)
        })
        .catch((error: Error) => {
          if (active && !(error instanceof ApiError && error.status === 404))
            setListingProblem(error.message)
        })
        .finally(() => {
          if (active) setListingLoading(false)
        })
    return () => {
      active = false
    }
  }, [account.authenticated, account.address, revision])

  const visible = people.filter((seller) => filter === 'all' || seller.kinds.includes(filter))
  if (hiring && pricing)
    return <PersonHire seller={hiring} pricing={pricing} onBack={() => setHiring(null)} />

  return (
    <PageCard
      title="People"
      count={loading ? '' : String(visible.length)}
      tabs={[]}
      tabHint=""
      primary={
        listingLoading
          ? undefined
          : account.authenticated
            ? mine
              ? 'Edit your listing'
              : 'Offer your skills'
            : connectBusy
              ? 'Signing in…'
              : 'Sign in to offer your skills'
      }
      onPrimary={() => {
        if (!account.authenticated) void signIn()
        else setEditing((value) => !value)
      }}
    >
      <p className="mt-0 mb-5 max-w-[65ch] text-[13.5px] leading-relaxed text-muted">
        Good work sometimes needs a person. Find someone, send a brief, and follow the work in AiKi.
      </p>
      {notice ? (
        <p role="status" className="mb-4 text-[13px]">
          {notice}
        </p>
      ) : null}
      {listingProblem ? (
        <p role="alert" className="text-[13px] text-warn">
          Your listing could not be loaded: {listingProblem}
        </p>
      ) : null}
      {account.authenticated && (mine || editing) ? (
        <section className="mb-6 rounded-2xl bg-surface-sunk p-4 md:p-5" aria-label="Your listing">
          {editing ? (
            <ListingForm
              key={mine?.updatedAt ?? 'new'}
              listing={mine}
              kinds={kinds}
              onCancel={() => setEditing(false)}
              onSaved={(saved) => {
                setMine(saved)
                setEditing(false)
                setNotice(
                  saved.available
                    ? 'Your listing is available for work.'
                    : 'Your listing is paused. Your work record is kept.',
                )
                setRevision((value) => value + 1)
              }}
            />
          ) : mine ? (
            <div className="flex flex-wrap items-center gap-3">
              <UserAvatar address={account.address} size={40} />
              <div className="min-w-0 flex-1">
                <h2 className="m-0 text-[14px] font-semibold">Your listing</h2>
                <p className="mt-1 mb-0 text-[12px] text-muted">
                  {mine.name} · {mine.available ? 'Available for work' : 'Not taking work'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className={`${BUTTON} bg-white`}
              >
                Edit listing
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-bold">Available for work</h2>
        <label className="flex items-center gap-2 text-[12px] text-muted">
          Work type
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="min-h-10 max-w-full rounded-xl border border-black/10 bg-white px-3 text-[13px] text-ink-app focus-visible:outline-2 focus-visible:outline-orange-app"
          >
            <option value="all">All types</option>
            {Object.keys(kinds).map((kind) => (
              <option key={kind} value={kind}>
                {kind[0]?.toUpperCase()}
                {kind.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading ? (
        <div role="status" className="grid gap-3 md:grid-cols-2">
          <p className="sr-only">Loading people…</p>
          {['first', 'second'].map((key) => (
            <div
              key={key}
              className="h-44 rounded-2xl bg-black/5 motion-safe:animate-pulse"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : problem ? (
        <div role="alert" className="rounded-2xl border border-black/10 p-5">
          <p className="mt-0 text-[13px]">{problem}</p>
          <button
            type="button"
            className={`${BUTTON} bg-ink-app text-white`}
            onClick={() => setRevision((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : visible.length ? (
        <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((seller) => (
            <li
              key={seller.address}
              className="flex min-w-0 flex-col rounded-2xl border border-black/10 p-4"
            >
              <div className="flex items-center gap-3">
                <UserAvatar address={seller.address} size={44} />
                <div className="min-w-0">
                  <h3 className="m-0 text-[14px] font-bold [overflow-wrap:anywhere]">
                    {seller.name}
                  </h3>
                  <span title={seller.address} className="text-[12px] text-muted">
                    {short(seller.address)}
                  </span>
                </div>
              </div>
              <p className="mt-3 mb-3 text-[13px] leading-relaxed text-muted [overflow-wrap:anywhere]">
                {seller.blurb}
              </p>
              <div className="mb-4 flex flex-wrap gap-1.5">
                {seller.kinds.map((kind) => (
                  <span
                    key={kind}
                    className="rounded-full bg-black/5 px-2.5 py-1 text-[12px] capitalize"
                  >
                    {kind}
                  </span>
                ))}
              </div>
              <div className="mt-auto">
                <p className="mb-3 text-[12px] text-muted">
                  {seller.record.delivered.toLocaleString()} completed
                  {seller.record.disputed ? ` · ${seller.record.disputed} disputed` : ''}
                </p>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <span className="block text-[12px] text-muted">Suggested offer</span>
                    <span className="text-[14px] font-bold tabular-nums">
                      {seller.ratePoints.toLocaleString()} points
                    </span>
                  </div>
                  <PersonRequestAction
                    ownListing={seller.address.toLowerCase() === account.address.toLowerCase()}
                    authenticated={account.authenticated}
                    connecting={connectBusy}
                    onSignIn={() => void signIn()}
                    onRequest={() => setHiring(seller)}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <section className="rounded-2xl border border-black/10 p-6">
          <h3 className="mt-0 mb-2 text-[15px] font-semibold">
            {filter === 'all' ? 'No one is available yet.' : 'No one offers this work yet.'}
          </h3>
          <p className="m-0 text-[13px] leading-relaxed text-muted">
            {filter === 'all'
              ? 'Have a skill to offer? Add your listing and people can send you work here.'
              : 'Choose another work type or check back later.'}
          </p>
        </section>
      )}
      <p className="mt-5 mb-0 max-w-[70ch] text-[12px] leading-relaxed text-muted">
        Profiles are written by their owners. Completed work is counted from AiKi tasks. Payments
        use AiKi points, which cannot currently be withdrawn.
      </p>
    </PageCard>
  )
}

export function PersonRequestAction({
  ownListing,
  authenticated,
  connecting,
  onSignIn,
  onRequest,
}: {
  ownListing: boolean
  authenticated: boolean
  connecting: boolean
  onSignIn: () => void
  onRequest: () => void
}) {
  return (
    <button
      type="button"
      disabled={ownListing || connecting}
      onClick={authenticated ? onRequest : onSignIn}
      className={`${BUTTON} bg-ink-app text-white hover:bg-orange-app`}
    >
      {ownListing
        ? 'Your listing'
        : connecting
          ? 'Signing in…'
          : authenticated
            ? 'Request work'
            : 'Sign in to request work'}
    </button>
  )
}

function ListingForm({
  listing,
  kinds,
  onCancel,
  onSaved,
}: {
  listing: Seller | null
  kinds: Record<string, string>
  onCancel: () => void
  onSaved: (seller: Seller) => void
}) {
  const [name, setName] = useState(listing?.name ?? '')
  const [blurb, setBlurb] = useState(listing?.blurb ?? '')
  const [takes, setTakes] = useState(listing?.kinds ?? [])
  const [rate, setRate] = useState(String(listing?.ratePoints ?? 500))
  const [available, setAvailable] = useState(listing?.available ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  return (
    <form
      className="max-w-2xl"
      aria-busy={busy}
      onSubmit={async (event) => {
        event.preventDefault()
        if (inFlight.current) return
        setError(null)
        try {
          const input = validatePersonListing({ name, blurb, kinds: takes, rate, available })
          inFlight.current = true
          setBusy(true)
          onSaved(await api.putSeller(input))
        } catch (failure) {
          setError((failure as Error).message)
        } finally {
          inFlight.current = false
          setBusy(false)
        }
      }}
    >
      <h2 className="mt-0 mb-4 text-[15px] font-semibold">
        {listing ? 'Edit your listing' : 'Offer your skills'}
      </h2>
      <fieldset disabled={busy} className="m-0 grid gap-4 border-0 p-0">
        <label className="text-[13px] font-semibold">
          Name
          <input
            required
            maxLength={60}
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={FIELD}
          />
        </label>
        <label className="text-[13px] font-semibold">
          What you do
          <textarea
            required
            maxLength={400}
            rows={3}
            value={blurb}
            onChange={(event) => setBlurb(event.target.value)}
            className={FIELD}
          />
        </label>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2 text-[13px] font-semibold">Types of work</legend>
          <div className="flex flex-wrap gap-2">
            {Object.entries(kinds).map(([kind, description]) => (
              <label
                key={kind}
                title={description}
                className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-white px-3 text-[13px] capitalize"
              >
                <input
                  type="checkbox"
                  checked={takes.includes(kind)}
                  onChange={(event) =>
                    setTakes((old) =>
                      event.target.checked ? [...old, kind] : old.filter((value) => value !== kind),
                    )
                  }
                  className="accent-[var(--color-orange-app)]"
                />
                {kind}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-[13px] font-semibold">
          Suggested offer in points
          <input
            required
            inputMode="numeric"
            pattern="[0-9]+"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            className={FIELD}
          />
          <span className="mt-1 block text-[12px] font-normal text-muted">
            A starting point for offers, not an automatic charge.
          </span>
        </label>
        <label className="flex min-h-11 items-center gap-3 text-[13px] font-semibold">
          <input
            type="checkbox"
            checked={available}
            onChange={(event) => setAvailable(event.target.checked)}
            className="size-4 accent-[var(--color-orange-app)]"
          />
          Available for new work
        </label>
      </fieldset>
      {error ? (
        <p role="alert" className="text-[13px]">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className={`${BUTTON} bg-ink-app text-white`}>
          {busy ? 'Saving…' : 'Save listing'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={`${BUTTON} bg-white`}>
          Cancel
        </button>
      </div>
    </form>
  )
}
