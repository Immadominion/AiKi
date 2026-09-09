'use client'

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { MandateContinuation } from '@/lib/api'
import { subscribeWalletSession } from '@/lib/wallet-session'
import { FastMandateController } from './fast-mandate'

export function FastMandateAction({
  action,
  owner,
}: {
  action: MandateContinuation
  owner: string
}) {
  const { authorizationId, chainId, account, manager } = action
  const controller = useMemo(
    () =>
      new FastMandateController(
        { kind: 'sign_mandate', authorizationId, chainId, account, manager },
        owner,
      ),
    [authorizationId, chainId, account, manager, owner],
  )
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  useEffect(() => {
    const stop = subscribeWalletSession(controller.invalidate)
    return () => {
      stop()
      controller.dispose()
    }
  }, [controller])
  const busy = state.phase === 'loading' || state.phase === 'signing'
  return (
    <section
      aria-label="Mandate signing"
      className="mt-3 rounded-[14px] border border-[rgb(26_26_25_/_0.14)] px-4 py-3 text-[12.5px] leading-[1.55]"
    >
      <p className="m-0 font-semibold">
        {state.phase === 'signed'
          ? 'Signature accepted by AiKi'
          : state.phase === 'blocked'
            ? 'Mandate unavailable for signing'
            : state.phase === 'review' || state.phase === 'signing'
              ? 'Wallet signature required'
              : 'Review saved mandate'}
      </p>
      <p className="mt-1 mb-0 text-muted">
        Mandate <span className="break-all">{action.authorizationId}</span>. Signing does not start
        a job or watch, move funds, or make another paid Fast request.
      </p>
      {state.review ? (
        <div className="mt-2">
          <p className="m-0">
            BNB {state.review.network.network} ({action.chainId}). Only Venus USDT repayment:{' '}
            {state.review.perActionUsdt} USDT per action, {state.review.totalUsdt} USDT total.
          </p>
          <p className="mt-1 mb-0">
            Expires {state.review.expiresAt}. The total cap does not refill.
          </p>
          <p className="mt-1 mb-0 break-all">Spending account: {action.account}</p>
          {!state.review.network.audited ? (
            <p className="mt-1 mb-0">These enforcer contracts have not been audited.</p>
          ) : null}
        </div>
      ) : null}
      {state.error ? (
        <p role="alert" className="mt-2 mb-0">
          {state.error}
        </p>
      ) : null}
      {state.phase !== 'signed' && state.phase !== 'blocked' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void (state.phase === 'review' ? controller.sign() : controller.review())}
          className="mt-2 min-h-10 rounded-[10px] bg-ink-app px-3 font-semibold text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app"
        >
          {state.phase === 'loading'
            ? 'Checking mandate…'
            : state.phase === 'signing'
              ? 'Waiting for wallet…'
              : state.phase === 'review'
                ? 'Sign this mandate in wallet'
                : state.phase === 'uncertain'
                  ? 'Check this mandate'
                  : 'Review and sign'}
        </button>
      ) : null}
    </section>
  )
}
