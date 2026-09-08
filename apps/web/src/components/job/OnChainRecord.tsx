'use client'

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

/**
 * What actually happened, as opposed to what the page is showing you.
 *
 * The rest of mission control walks a job through its steps so the shape of the
 * product is legible before any agent is doing real work. That is honest as an
 * illustration and it is not evidence, so anything the API genuinely recorded
 * belongs somewhere it cannot be confused with the walkthrough.
 *
 * Every verdict is shown, refusals included. A log of only what worked would be
 * the brochure this product exists to be the opposite of.
 */

interface Event {
  type: string
  at: string
  detail: string
}

const TONE: Record<string, { dot: string; label: string }> = {
  policy: { dot: 'var(--color-warn)', label: 'Mandate' },
  spend: { dot: 'var(--color-good)', label: 'Spend' },
  status: { dot: 'var(--color-faint)', label: 'Status' },
}

export function OnChainRecord({ jobId }: { jobId: string }) {
  const say = useToast()
  const [events, setEvents] = useState<Event[] | null>(null)
  const [missing, setMissing] = useState(false)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    try {
      const job = await api.job(jobId)
      setEvents(job.events)
      setMissing(false)
    } catch {
      // A job the API never heard of is a simulated one. Saying so beats an
      // empty panel that looks like nothing has happened yet.
      setMissing(true)
    }
  }, [jobId])

  useEffect(() => {
    void load()
  }, [load])

  if (missing) return null

  return (
    <div className="mt-[18px] rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[16px]">
      <div className="flex flex-wrap items-baseline justify-between gap-[10px]">
        <div>
          <div className="text-[14.5px] font-bold">What AiKi recorded</div>
          <p className="text-muted mt-[4px] mb-0 max-w-[560px] text-[12.5px] leading-[1.5] text-pretty">
            Every verdict on this job, including the refusals. Anything the chain answered is marked
            as such.
          </p>
        </div>
        <button
          type="button"
          disabled={running}
          onClick={async () => {
            setRunning(true)
            try {
              /*
               * A deliberately over-cap action, because the useful thing to see
               * is the refusal. It is the one behaviour nobody can check by
               * reading a screen: whether the limit is real.
               */
              const out = await api.runAction(jobId, {
                target: '0x55d398326f99059ff775485246999027b3197955',
                selector: '0xa9059cbb',
                asset: '0x55d398326f99059ff775485246999027b3197955',
                amount: '1000000000000000000000000',
                callData: '0x',
              })
              say(
                out.policy.allow
                  ? out.chain && out.chain.status !== 'landed'
                    ? 'The chain refused it. Nothing moved.'
                    : 'Allowed, and it landed.'
                  : `Refused: ${out.policy.reason}`,
              )
              await load()
            } catch {
              say('Could not attempt that action.')
            } finally {
              setRunning(false)
            }
          }}
          className="text-ink-app h-[34px] flex-none rounded-xl border-0 bg-[rgb(26_26_25_/_0.055)] px-[13px] text-[13px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] disabled:opacity-50"
        >
          {running ? 'Trying…' : 'Try an over-limit action'}
        </button>
      </div>

      {events === null ? (
        <p className="text-faint mt-[12px] mb-0 text-[12.5px]">Reading the record…</p>
      ) : events.length === 0 ? (
        <p className="text-faint mt-[12px] mb-0 text-[12.5px]">
          Nothing has been attempted under this mandate yet.
        </p>
      ) : (
        <ul className="mt-[12px] mb-0 flex list-none flex-col gap-[8px] p-0">
          {events.map((event) => {
            const tone = TONE[event.type] ?? TONE.status
            return (
              <li key={`${event.at}-${event.detail}`} className="flex items-start gap-[9px]">
                <span
                  className="mt-[6px] size-[7px] flex-none rounded-full"
                  style={{ background: tone?.dot }}
                />
                <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5]">
                  <span className="text-faint font-mono text-[11px]">{event.at.slice(11, 19)}</span>{' '}
                  <span className="font-semibold">{tone?.label}</span>{' '}
                  {/* Wrapped rather than truncated: a revert reason cut in half
                      is the half that does not say why. */}
                  <span className="text-muted break-words">{event.detail}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
