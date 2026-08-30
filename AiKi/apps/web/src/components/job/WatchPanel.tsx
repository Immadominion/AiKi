'use client'

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { api, type Watch } from '@/lib/api'

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
const VENUS_TESTNET = {
  chainId: 97,
  asset: '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c',
  market: '0xb7526572FFE56AB9D7489838Bf2E18e3323b441A',
  label: 'USDT on Venus',
}

const LINES = [
  { value: '1.15', label: '1.15', hint: 'Acts late, spends least.' },
  { value: '1.25', label: '1.25', hint: 'A common margin.' },
  { value: '1.50', label: '1.50', hint: 'Acts early, keeps more room.' },
]

const ago = (iso: string) => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min ago`
  return `${Math.round(minutes / 60)}h ago`
}

export function WatchPanel({ jobId }: { jobId: string }) {
  const say = useToast()
  const [watch, setWatch] = useState<Watch | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [line, setLine] = useState('1.25')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setWatch(await api.watch(jobId))
    } catch {
      // A job nobody has put a watch on answers 404, which is an ordinary
      // answer and not a failure.
      setWatch(null)
    } finally {
      setLoaded(true)
    }
  }, [jobId])

  useEffect(() => {
    void load()
  }, [load])

  // While an agent is on duty the interesting thing is that the clock is still
  // ticking, so the panel keeps up with it rather than waiting to be reloaded.
  useEffect(() => {
    if (watch?.status !== 'active') return
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [watch?.status, load])

  if (!loaded) return null

  const start = async () => {
    setBusy(true)
    try {
      const account = await api.account()
      if (!account.address) {
        say('You need a mandate account before an agent can watch a position.')
        return
      }
      setWatch(
        await api.startWatch(jobId, {
          account: account.address,
          chainId: VENUS_TESTNET.chainId,
          minimumHealthFactor: line,
          asset: VENUS_TESTNET.asset,
          market: VENUS_TESTNET.market,
        }),
      )
      say(`On duty. It will keep your health factor at or above ${line}.`)
    } catch (error) {
      // The API's refusals say why in a sentence — an unsigned mandate, no
      // spending limit — and those are the sentences worth showing.
      say((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      setWatch(await api.stopWatch(jobId))
      say('Stood down. Nothing will act on its own from here.')
    } catch (error) {
      say((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onDuty = watch?.status === 'active'

  return (
    <div className="mt-[18px] rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[16px]">
      <div className="flex flex-wrap items-baseline justify-between gap-[10px]">
        <div>
          <div className="flex items-center gap-[8px]">
            <span
              className="size-[7px] flex-none rounded-full"
              style={{ background: onDuty ? 'var(--color-good)' : 'var(--color-faint)' }}
            />
            <div className="text-[14.5px] font-bold">
              {onDuty ? 'Standing watch' : 'Put this agent on duty'}
            </div>
          </div>
          <p className="text-muted mt-[4px] mb-0 max-w-[560px] text-[12.5px] leading-[1.5] text-pretty">
            {onDuty
              ? `Checking your ${VENUS_TESTNET.label} position on its own, and repaying under this mandate’s limits if the health factor falls below ${watch?.minimumHealthFactor}.`
              : `It will check your ${VENUS_TESTNET.label} position on a timer and repay under this mandate’s limits, without waiting for you.`}
          </p>
        </div>
        {onDuty ? (
          <button
            type="button"
            disabled={busy}
            onClick={stop}
            className="text-ink-app h-[34px] flex-none rounded-xl border-0 bg-[rgb(26_26_25_/_0.055)] px-[13px] text-[13px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] disabled:opacity-50"
          >
            {busy ? 'Standing down…' : 'Stand down'}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={start}
            className="bg-ink-app hover:bg-orange-app h-[34px] flex-none rounded-xl border-0 px-[13px] text-[13px] font-bold text-white transition-colors disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Start watching'}
          </button>
        )}
      </div>

      {onDuty ? (
        <dl className="mt-[14px] mb-0 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-[12px]">
          <Fact
            label="Last looked"
            value={watch?.lastCheckedAt ? ago(watch.lastCheckedAt) : 'Any moment now'}
          />
          <Fact
            label="Last acted"
            value={watch?.lastActedAt ? ago(watch.lastActedAt) : 'Not needed yet'}
          />
          <Fact label="Defending" value={`${watch?.minimumHealthFactor} health factor`} />
        </dl>
      ) : (
        <fieldset className="mt-[14px] mb-0 border-0 p-0">
          <legend className="text-faint mb-[8px] p-0 text-[11px] font-bold tracking-[0.06em] uppercase">
            The line it defends
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
      )}

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
