'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { subscribeWalletSession, walletSession } from '@/lib/wallet-session'

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

export function actionResultMessage(out: Awaited<ReturnType<typeof api.runAction>>) {
  if (out.chain?.status === 'unconfirmed' && out.policy.rule === 'execution_pending')
    return 'An action is already in progress. Wait for its recorded result; do not send it again.'
  if (out.chain?.status === 'unconfirmed')
    return 'Confirmation is pending. The spending limit remains held. Do not repeat this action.'
  if (!out.policy.allow) return `Refused: ${out.policy.reason}`
  if (!out.chain) return 'Allowed by AiKi. No on-chain transaction was submitted.'
  return out.chain.status === 'landed'
    ? 'Allowed, and it landed.'
    : 'The chain refused it. Nothing moved.'
}

export function OnChainRecord({ jobId }: { jobId: string }) {
  const session = useSyncExternalStore(
    subscribeWalletSession,
    () => `${walletSession().revision}:${walletSession().address ?? ''}`,
    () => '',
  )
  return <OnChainRecordForJob key={`${jobId}:${session}`} jobId={jobId} />
}

function OnChainRecordForJob({ jobId }: { jobId: string }) {
  const say = useToast()
  const [events, setEvents] = useState<Event[] | null>(null)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [running, setRunning] = useState(false)
  const [execution, setExecution] = useState<Awaited<ReturnType<typeof api.job>>['execution']>()
  const requestId = useRef(0)
  const mounted = useRef(false)
  const actionPending = useRef(false)

  const load = useCallback(async () => {
    const current = ++requestId.current
    setRefreshing(true)
    try {
      const job = await api.job(jobId)
      if (!mounted.current || current !== requestId.current) return
      setEvents(job.events)
      setExecution(job.execution)
      setError(false)
    } catch {
      if (!mounted.current || current !== requestId.current) return
      // A failed refresh is not proof that a pending transaction disappeared.
      setError(true)
    } finally {
      if (mounted.current && current === requestId.current) setRefreshing(false)
    }
  }, [jobId])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      ++requestId.current
    }
  }, [load])

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
          disabled={running || refreshing || error || events === null || Boolean(execution)}
          onClick={async () => {
            if (actionPending.current || refreshing || error || events === null || execution) return
            actionPending.current = true
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
              if (mounted.current) say(actionResultMessage(out))
            } catch {
              if (mounted.current)
                say('The action result could not be confirmed. Checking its recorded status.')
            } finally {
              if (mounted.current) {
                await load()
                if (mounted.current) setRunning(false)
              }
              actionPending.current = false
            }
          }}
          className="text-ink-app min-h-10 flex-none rounded-xl border-0 bg-[rgb(26_26_25_/_0.055)] px-[13px] text-[13px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
        >
          {running ? 'Trying…' : 'Try an over-limit action'}
        </button>
      </div>

      {execution ? (
        <div role="status" className="mt-3 rounded-xl bg-surface-sunk p-3 text-sm leading-relaxed">
          <p className="m-0 font-semibold">
            {execution.state === 'UNCONFIRMED' ? 'Execution needs review' : 'Execution in progress'}
          </p>
          <p className="mt-1 mb-0">
            {execution.state === 'UNCONFIRMED'
              ? 'Confirmation is unresolved. The spending limit is held and further actions are blocked. Do not send this action again.'
              : 'An action is being prepared or awaiting confirmation. Other actions will wait until it finishes. Do not send it again.'}
          </p>
          {execution.transactionHash ? (
            <p className="mt-2 mb-0 break-all font-mono text-xs">{execution.transactionHash}</p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 mb-0 text-sm text-muted">
          The record could not be refreshed.
          {events !== null ? ' Last known status is shown.' : ''} Check its status before attempting
          another action.
        </p>
      ) : null}
      {execution || error ? (
        <button
          type="button"
          disabled={refreshing || running}
          onClick={() => void load()}
          className="mt-2 inline-flex min-h-10 items-center font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : error ? 'Try again' : 'Refresh status'}
        </button>
      ) : null}

      {events === null && !error ? (
        <p className="text-faint mt-[12px] mb-0 text-[12.5px]">Reading the record…</p>
      ) : events === null ? null : events.length === 0 ? (
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
