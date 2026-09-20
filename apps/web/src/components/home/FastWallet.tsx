'use client'

import type { AccountPosture, PostureState } from '@aiki/contracts'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { route } from '@/lib/routes'

/**
 * What the agent can actually spend, on the screen where you ask it to spend.
 *
 * Two things were wrong with the first version of this. It only counted
 * spendable tokens, so an account holding a dollar of BNB read "empty" and its
 * owner went looking for money they already had. And when the balance was
 * unusable it said so without saying what to do, so the only way to reach the
 * fix was to doubt the readout and ask the assistant about it in words.
 *
 * Now it reports the state, the money, and the way out of the state, in that
 * order, and the way out is the thing you press. Still one line: a running
 * readout on the surface somebody works on is chrome, and this has one job.
 */
export function FastWallet() {
  const [posture, setPosture] = useState<AccountPosture | null>(null)

  useEffect(() => {
    let live = true
    api
      .account()
      .then((account) => {
        if (live) setPosture(account.posture ?? null)
      })
      .catch(() => {
        if (live) setPosture(null)
      })
    return () => {
      live = false
    }
  }, [])

  if (!posture) return null

  const tone = TONE[posture.state]
  return (
    <Link
      href={route('/wallet')}
      title={posture.detail}
      className="hover:text-ink-app inline-flex min-h-10 items-center gap-[5px] text-[11.5px] transition-colors focus-visible:outline-2 focus-visible:outline-orange-app"
    >
      <span className="text-faint">Agent wallet</span>
      <span className="font-bold tabular-nums" style={{ color: tone }}>
        {posture.headline}
      </span>
      {/* The fix rides with the problem. Naming a dead end without the way out
          is half an answer, and it is the half nobody can act on. */}
      {posture.fix ? (
        <span className="text-muted underline underline-offset-[3px]">
          {FIX_LABEL[posture.fix.kind]}
        </span>
      ) : null}
    </Link>
  )
}

/**
 * Money in the wrong form is not a neutral fact, so it is not drawn as one.
 *
 * `stranded` and `dust` are warnings: there is value in the account and it
 * cannot do the thing somebody is on this screen to do. `empty` is plain,
 * because nothing is wrong with a new account, and `unreadable` is plain
 * because it is a statement about us and not about them.
 */
const TONE: Record<PostureState, string> = {
  no_account: 'var(--color-muted)',
  unreadable: 'var(--color-muted)',
  empty: 'var(--color-muted)',
  stranded: '#C2410C',
  dust: '#C2410C',
  ready: 'var(--color-ink-app)',
}

const FIX_LABEL: Record<AccountPosture['fix'] extends null ? never : string, string> = {
  create: 'Create it',
  fund: 'Add funds',
  convert: 'Unstick it',
  top_up: 'Top up',
}
