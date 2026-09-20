'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import type { FundingContinuation } from '@/lib/api'
import { route } from '@/lib/routes'
import { acceptedTokens } from './fast-funding'

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
          This used to open PancakeSwap, which is connected to the reader's own
          wallet and cannot see the account named directly above it. Somebody
          whose BNB is stuck IN this account pressed it and arrived at a swap
          screen for a different balance entirely. What moves this account's
          own money is owner-signed and lives on the wallet page.
        */}
        <Link
          href={route('/settings/wallet')}
          className="min-h-10 rounded-[10px] border border-[rgb(26_26_25_/_0.16)] bg-white px-3 leading-10 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app"
        >
          What is in it
        </Link>
      </div>
      <p className="text-muted mt-2 mb-0">
        Not BNB. No mandate can move native BNB, so an agent cannot spend it whatever limits you
        sign. If this account already holds some, you can convert or withdraw it yourself from the
        wallet page.
      </p>
    </section>
  )
}
