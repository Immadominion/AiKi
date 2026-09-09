'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useToast } from '@/components/ui/Toast'
import { ApiError, api, type Watch } from '@/lib/api'
import { venusGuardianFor } from '@/lib/venus'
import { subscribeWalletSession, walletSession } from '@/lib/wallet-session'

/**
 * Putting an agent on duty, and seeing that it stayed there.
 *
 * Everything else on this page is about an action somebody asked for. This is
 * the part where nobody asks: the agent looks at the position on its own clock
 * and acts when it has to. That is the difference between hiring one and
 * operating one, so the panel's job is to make "it is watching, and here is when
 * it last looked" as legible as "it did something".
 *
 * A quiet watch is the normal case and the good case. It is reported as such
 * rather than as an absence, because a screen that only speaks when money moves
 * leaves you unable to tell a healthy position from a stopped agent.
 */

/*
 * The Venus market this deployment can watch. The API refuses anything else, so
 * naming it here keeps the person from having to paste addresses to hire an
 * agent for the only thing it currently does.
 */
const LINES = [
  { value: '1.15', label: '1.15', hint: 'Later trigger.' },
  { value: '1.25', label: '1.25', hint: 'Middle trigger.' },
  { value: '1.50', label: '1.50', hint: 'Earlier trigger.' },
]

const ago = (iso: string) => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min ago`
  return `${Math.round(minutes / 60)}h ago`
}

export function WatchPanel({ jobId }: { jobId: string }) {
  const session = useSyncExternalStore(
    subscribeWalletSession,
    () => `${walletSession().revision}:${walletSession().address ?? ''}`,
    () => '',
  )
  return <WatchPanelForJob key={`${jobId}:${session}`} jobId={jobId} />
}

function WatchPanelForJob({ jobId }: { jobId: string }) {
  const say = useToast()
  const [watch, setWatch] = useState<Watch | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [line, setLine] = useState('1.25')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const requestId = useRef(0)
  const actionPending = useRef(false)

  const load = useCallback(async () => {
    if (actionPending.current) return
    const current = ++requestId.current
    setRefreshing(true)
    try {
      const next = await api.watch(jobId)
      if (current !== requestId.current) return
      setWatch(next)
      setError(null)
    } catch (cause) {
      if (current !== requestId.current) return
      if (cause instanceof ApiError && cause.status === 404 && cause.code === 'WATCH_NOT_FOUND') {
        setWatch(null)
        setError(null)
      } else {
        // Keep the last known watch. A failed refresh does not stop the runner.
        setError(cause instanceof Error ? cause.message : 'Watch status could not be loaded.')
      }
    } finally {
      if (current === requestId.current) {
        setLoaded(true)
        setRefreshing(false)
      }
    }
  }, [jobId])

  useEffect(() => {
    void load()
    return () => {
      ++requestId.current
    }
  }, [load])

  // While an agent is on duty the interesting thing is that the clock is still
  // ticking, so the panel keeps up with it rather than waiting to be reloaded.
  useEffect(() => {
    if (watch?.status !== 'active') return
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [watch?.status, load])

  if (!loaded)
    return (
      <p role="status" className="text-muted mt-[18px] text-[13px]">
        Loading watch status…
      </p>
    )

  const start = async () => {
    if (actionPending.current || error || watch) return
    actionPending.current = true
    const current = ++requestId.current
    setBusy(true)
    try {
      const account = await api.account()
      if (current !== requestId.current) return
      if (!account.address) {
        say('You need a mandate account before an agent can watch a position.')
        return
      }
      const guardian = venusGuardianFor(account.chainId)
      const next = await api.startWatch(jobId, {
        account: account.address,
        chainId: guardian.chainId,
        minimumHealthFactor: line,
        asset: guardian.asset,
        market: guardian.market,
      })
      if (current !== requestId.current) return
      setWatch(next)
      setError(null)
      say(`Watch started. Repayment trigger: health factor ${line}.`)
    } catch (error) {
      // The API's refusals say why in a sentence - an unsigned mandate, no
      // spending limit - and those are the sentences worth showing.
      if (current === requestId.current) say((error as Error).message)
    } finally {
      actionPending.current = false
      if (current === requestId.current) setBusy(false)
    }
  }

  const stop = async () => {
    if (actionPending.current) return
    actionPending.current = true
    const current = ++requestId.current
    setBusy(true)
    try {
      const next = await api.stopWatch(jobId)
      if (current !== requestId.current) return
      setWatch(next)
      setError(null)
      say('Watch stopped. An already submitted transaction may still complete.')
    } catch (error) {
      if (current === requestId.current) say((error as Error).message)
    } finally {
      actionPending.current = false
      if (current === requestId.current) setBusy(false)
    }
  }

  const onDuty = watch?.status === 'active'
  const stopped = watch?.status === 'stopped'

  return (
    <div className="mt-[18px] rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[16px]">
      <div className="flex flex-wrap items-baseline justify-between gap-[10px]">
        <div>
          <div className="flex items-center gap-[8px]">
            <span
              className="size-[7px] flex-none rounded-full"
              style={{
                background:
                  onDuty && !error && watch.lastCheckedAt
                    ? 'var(--color-good)'
                    : 'var(--color-faint)',
              }}
            />
            <div className="text-[14.5px] font-bold">
              {error
                ? 'Watch status unavailable'
                : onDuty
                  ? 'Watch scheduled'
                  : stopped
                    ? 'Watch stopped'
                    : 'Put this agent on duty'}
            </div>
          </div>
          <p className="text-muted mt-[4px] mb-0 max-w-[560px] text-[12.5px] leading-[1.5] text-pretty">
            {error
              ? watch
                ? 'Last known state shown. A connection failure does not stop an active watch.'
                : 'Check the status before starting a watch.'
              : onDuty
                ? `Watching your Venus USDT position on ${watch?.chainId === 56 ? 'BNB Chain' : 'BNB testnet'}. Repayment is attempted below ${watch?.minimumHealthFactor}, within your limits.`
                : stopped
                  ? 'This watch is no longer scheduled. Set up a new job and review its permissions to watch again.'
                  : 'Watch your Venus USDT position and allow repayments within your signed limits. Uses your mandate account’s network.'}
          </p>
        </div>
        {onDuty ? (
          <button
            type="button"
            disabled={busy}
            onClick={stop}
            className="text-ink-app min-h-[44px] flex-none rounded-xl border-0 bg-[rgb(26_26_25_/_0.055)] px-[13px] text-[13px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] disabled:opacity-50"
          >
            {busy ? 'Standing down…' : 'Stand down'}
          </button>
        ) : !error && !stopped ? (
          <button
            type="button"
            disabled={busy}
            onClick={start}
            className="bg-ink-app hover:bg-orange-app min-h-[44px] flex-none rounded-xl border-0 px-[13px] text-[13px] font-bold text-white transition-colors disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Start watching'}
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="mt-[12px] flex flex-wrap items-center justify-between gap-[10px]">
          <p role="alert" className="text-muted m-0 text-[12.5px]">
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing || busy}
            className="text-ink-app min-h-[44px] rounded-xl border border-[rgb(26_26_25_/_0.12)] px-[13px] text-[13px] font-bold disabled:opacity-50"
          >
            {refreshing ? 'Checking…' : 'Try again'}
          </button>
        </div>
      ) : null}

      {onDuty ? (
        <dl className="mt-[14px] mb-0 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-[12px]">
          <Fact
            label="Last pass"
            value={watch?.lastCheckedAt ? ago(watch.lastCheckedAt) : 'No pass recorded'}
          />
          <Fact
            label="Last acted"
            value={watch?.lastActedAt ? ago(watch.lastActedAt) : 'No repayment recorded'}
          />
          <Fact label="Repayment trigger" value={`${watch?.minimumHealthFactor} health factor`} />
        </dl>
      ) : !error && !stopped ? (
        <fieldset className="mt-[14px] mb-0 border-0 p-0">
          <legend className="text-faint mb-[8px] p-0 text-[11px] font-bold tracking-[0.06em] uppercase">
            Repayment trigger
          </legend>
          <div className="flex flex-wrap gap-[8px]">
            {LINES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setLine(option.value)}
                aria-pressed={line === option.value}
                className={`rounded-xl border px-[13px] py-[8px] text-left text-[13px] transition-colors ${
                  line === option.value
                    ? 'border-transparent bg-[rgb(26_26_25_/_0.075)] font-bold'
                    : 'border-[rgb(26_26_25_/_0.12)] hover:border-[rgb(26_26_25_/_0.28)]'
                }`}
              >
                <span className="block font-mono">{option.label}</span>
                <span className="text-faint block text-[11.5px]">{option.hint}</span>
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}

      {watch?.lastReason ? (
        <p className="text-muted mt-[12px] mb-0 text-[12.5px] leading-[1.5] text-pretty">
          {/* The agent's own words for what it decided last time. A watch that
              never acts still has to be able to account for itself. */}
          <span className="text-faint">Last pass:</span> {watch.lastReason}
        </p>
      ) : null}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-faint text-[11px] font-bold tracking-[0.06em] uppercase">{label}</dt>
      <dd className="mt-[3px] ml-0 text-[13px] font-semibold">{value}</dd>
    </div>
  )
}
