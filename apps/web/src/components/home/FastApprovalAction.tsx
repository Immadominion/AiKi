'use client'

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ApprovalContinuation } from '@/lib/api'
import { FastApprovalController } from './fast-approval'

/**
 * The agent stopped and asked. This is where the answer goes.
 *
 * It renders what the API says is waiting, not what the step that produced it
 * said, and it never claims the money has moved: approving records an answer,
 * and the send has to be asked for again.
 */
export function FastApprovalAction({ action }: { action: ApprovalContinuation }) {
  const { jobId, approvalId, chainId } = action
  const controller = useMemo(
    () => new FastApprovalController({ kind: 'answer_approval', jobId, approvalId, chainId }),
    [jobId, approvalId, chainId],
  )
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  useEffect(() => {
    void controller.load()
    return () => controller.dispose()
  }, [controller])

  const busy = state.phase === 'loading' || state.phase === 'answering'
  const amount = state.waiting
    ? `${state.waiting.amount} ${state.waiting.symbol ?? 'base units'}`
    : ''

  return (
    <section
      aria-label="Action waiting for you"
      className="mt-3 rounded-[14px] border border-[rgb(255_77_0_/_0.35)] bg-[rgb(255_77_0_/_0.04)] px-4 py-3 text-[12.5px] leading-[1.55]"
    >
      <p className="m-0 font-semibold">
        {state.phase === 'approved'
          ? 'Approved'
          : state.phase === 'declined'
            ? 'Declined'
            : state.phase === 'gone'
              ? 'Already answered'
              : 'It is waiting for you'}
      </p>
      {state.phase === 'approved' ? (
        <p className="mt-1 mb-0">
          Nothing has moved yet. Tell the agent to go ahead and it will send this one.
        </p>
      ) : state.phase === 'declined' ? (
        <p className="mt-1 mb-0">
          This will not happen. The agent may ask again for a different amount.
        </p>
      ) : state.phase === 'gone' ? (
        <p className="mt-1 mb-0">This was answered already. Nothing further is waiting here.</p>
      ) : (
        <p className="mt-1 mb-0">
          Your mandate says to ask first. Nothing has happened and nothing has been spent.
        </p>
      )}
      {state.waiting && state.phase !== 'gone' ? (
        <div className="mt-2">
          <p className="m-0 font-semibold tabular-nums">{amount}</p>
          {/* The agent's own words. A request that cannot say why is a dare. */}
          <p className="text-muted mt-1 mb-0">{state.waiting.reason}</p>
          {state.waiting.recipient ? (
            <p className="mt-1 mb-0 font-mono text-[11.5px] break-all">
              to {state.waiting.recipient}
            </p>
          ) : null}
          {/* Without a symbol the scale is unknown, so the address is shown
              rather than a figure rendered at a guessed number of decimals. */}
          {state.waiting.symbol ? null : (
            <p className="text-faint mt-1 mb-0 font-mono text-[11px] break-all">
              of {state.waiting.asset}
            </p>
          )}
        </div>
      ) : null}
      {state.error ? (
        <p role="alert" className="mt-2 mb-0">
          {state.error}
        </p>
      ) : null}
      {state.phase === 'waiting' || state.phase === 'answering' ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void controller.answer('approved')}
            className="bg-ink-app min-h-10 rounded-[10px] px-3 font-semibold text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app"
          >
            Approve this one
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void controller.answer('declined')}
            className="min-h-10 rounded-[10px] border border-[rgb(26_26_25_/_0.16)] bg-white px-3 font-semibold disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app"
          >
            Decline
          </button>
        </div>
      ) : null}
      {state.phase === 'idle' && state.error ? (
        <button
          type="button"
          onClick={() => void controller.load()}
          className="mt-2 min-h-10 rounded-[10px] border border-[rgb(26_26_25_/_0.16)] bg-white px-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app"
        >
          Check again
        </button>
      ) : null}
    </section>
  )
}
