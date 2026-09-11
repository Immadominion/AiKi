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
  const { scope, authorizationId, chainId, account, manager } = action
  const controller = useMemo(
    () =>
      new FastMandateController(
        { kind: 'sign_mandate', scope, authorizationId, chainId, account, manager },
        owner,
      ),
    [scope, authorizationId, chainId, account, manager, owner],
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
          {state.review.token ? (
            <>
              <p className="m-0">
                BNB {state.review.network.network} ({action.chainId}). Only{' '}
                {state.review.token.symbol}: {state.review.perActionUsdt}{' '}
                {state.review.token.symbol} per action, {state.review.totalUsdt}{' '}
                {state.review.token.symbol} total.
              </p>
              {/*
                The destinations are listed in full rather than counted. They are
                the one rule here no contract holds, so the person reading this
                screen is the last check on them, and a summary would hide the
                address that matters.
              */}
              <p className="mt-1 mb-0 break-all">
                {state.review.token.canSend ? 'May send to' : 'May let these take it'}:{' '}
                {state.review.token.recipients.join(', ')}
              </p>
              {/*
                An approval is not a payment to the named address, it is standing
                permission for that address to take the tokens whenever it likes
                and send them anywhere. It also survives this mandate expiring and
                being revoked, because the allowance lives on the token, not on
                the delegation. Somebody signing this has to be told that.
              */}
              {state.review.token.canApprove ? (
                <p className="mt-1 mb-0">
                  This also lets{' '}
                  {state.review.token.recipients.length === 1 ? 'that address' : 'those addresses'}{' '}
                  take up to {state.review.totalUsdt} {state.review.token.symbol} from the account
                  at any time, and send it anywhere. That permission is stored on the token, so it
                  outlives this mandate expiring or being revoked. Removing it is a separate
                  transaction you send yourself.
                </p>
              ) : null}
              <p className="mt-1 mb-0">
                AiKi holds that list and refuses to relay anything else. No contract checks it.
              </p>
            </>
          ) : (
            <p className="m-0">
              BNB {state.review.network.network} ({action.chainId}). Only Venus USDT repayment:{' '}
              {state.review.perActionUsdt} USDT per action, {state.review.totalUsdt} USDT total.
            </p>
          )}
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
