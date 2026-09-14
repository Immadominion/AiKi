'use client'

import { useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import type { FundingContinuation } from '@/lib/api'
import { acceptedTokens, swapUrl } from './fast-funding'

/**
 * The address, as a button.
 *
 * Short on purpose. Somebody who has just been told their money cannot be used
 * wants to know what to send and where, and every extra sentence is one more
 * thing between them and doing it.
 */
export function FastFundingAction({ action }: { action: FundingContinuation }) {
  const say = useToast()
  const [copied, setCopied] = useState(false)
  const tokens = acceptedTokens(action.symbols)

  return (
    <section
      aria-label="Fund the agent account"
      className="mt-3 rounded-[14px] border border-[rgb(26_26_25_/_0.14)] px-4 py-3 text-[12.5px] leading-[1.55]"
    >
      <p className="m-0 font-semibold">Send {tokens} here</p>
      <p className="text-muted mt-1 mb-0 font-mono text-[12px] break-all">{action.address}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            navigator.clipboard
              ?.writeText(action.address)
              .then(() => {
                setCopied(true)
                say('Address copied.')
              })
              .catch(() => say('Your browser would not let us copy.'))
          }}
          className="bg-ink-app min-h-10 rounded-[10px] px-3 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app"
        >
          {copied ? 'Copied' : 'Copy address'}
        </button>
        {/*
          BNB cannot be spent by any mandate, and somebody holding only BNB is
          otherwise stuck with no way forward from this screen. The swap is
          their own wallet transaction; this is just the door to it.
        */}
        <a
          href={swapUrl(action.chainId, action.symbols)}
          target="_blank"
          rel="noreferrer"
          className="min-h-10 rounded-[10px] border border-[rgb(26_26_25_/_0.16)] bg-white px-3 leading-10 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app"
        >
          Swap BNB for {action.symbols.includes('USDT') ? 'USDT' : action.symbols[0]}
        </a>
      </div>
      <p className="text-muted mt-2 mb-0">
        Not BNB. No mandate can move it, so an account holding only BNB cannot do anything.
      </p>
    </section>
  )
}
