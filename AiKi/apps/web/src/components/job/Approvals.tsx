'use client'

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

/**
 * The actions waiting on you.
 *
 * This screen is the reason the approval modes on the hire screen were fiction.
 * A person could choose "ask me every time", and nothing asked them: the choice
 * never left the browser, the API had no concept of approval, and the agent
 * acted regardless. A gate with nowhere to answer would have been the same lie
 * wearing a different face, so the two shipped together.
 *
 * Answering does not act. The agent checks on a schedule and picks the answer
 * up on its next check, and every sentence here says so rather than implying
 * the thing has happened.
 */

interface Waiting {
  id: string
  target: string
  selector: string
  asset: string
  amount: string
  reason: string
  status: 'pending' | 'approved' | 'declined' | 'used'
  requestedAt: string
}

/**
 * Base units as a readable amount.
 *
 * Eighteen decimals, on the settlement asset this product uses, and the
 * conversion stays in string arithmetic: a uint256 through Number loses its
 * last digits, and this is the number somebody is agreeing to part with.
 */
function tokens(baseUnits: string, decimals = 18): string {
  const negative = baseUnits.startsWith('-')
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits
    .slice(digits.length - decimals)
    .replace(/0+$/, '')
    .slice(0, 6)
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

export function Approvals({ jobId }: { jobId: string }) {
  const say = useToast()
  const [waiting, setWaiting] = useState<Waiting[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .approvals(jobId)
      .then((r) => setWaiting(r.approvals.filter((a) => a.status === 'pending')))
      // Nothing waiting and no way to ask are different facts, but neither is
      // worth a red box on a screen somebody is watching an agent work on.
      .catch(() => {})
  }, [jobId])

  useEffect(() => {
    load()
    /*
     * Polled, because a request appears when the agent next checks and not in
     * response to anything this page did. Thirty seconds is slower than the
     * runner's own cadence, which is the right way round: a person should never
     * find out about a decision they have to make by refreshing.
     */
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [load])

  if (!waiting.length) return null

  const answer = (id: string, decision: 'approved' | 'declined') => {
    setBusy(id)
    api
      .decideApproval(jobId, id, decision)
      .then(() => {
        setWaiting((w) => w.filter((a) => a.id !== id))
        say(
          decision === 'approved'
            ? 'Approved. It will go through next time the agent checks.'
            : 'Declined. It will not happen, and the agent may ask again later.',
        )
      })
      .catch((error: Error) => say(error.message || 'That did not go through.'))
      .finally(() => setBusy(null))
  }

  return (
    <div className="rounded-[18px] border border-[rgb(255_77_0_/_0.35)] bg-[rgb(255_77_0_/_0.04)] px-[18px] py-[15px]">
      <div className="text-[13.5px] font-bold">
        {waiting.length === 1 ? 'It is waiting for you' : `${waiting.length} things are waiting`}
      </div>
      <p className="text-muted mt-[6px] mb-0 text-[12.5px] leading-[1.5] text-pretty">
        Your mandate says to ask first. Nothing has happened and nothing has been spent.
      </p>

      <ul className="mt-[12px] flex list-none flex-col gap-[10px] p-0">
        {waiting.map((a) => (
          <li
            key={a.id}
            className="rounded-[14px] border border-[rgb(26_26_25_/_0.1)] bg-white px-[13px] py-[11px]"
          >
            <div className="text-[13px] font-bold tabular-nums">{tokens(a.amount)} tokens</div>
            {/* The agent's own words for why, not a paraphrase. A request that
                cannot say why is a dare rather than a question. */}
            <p className="text-muted mt-[4px] mb-0 text-[12.5px] leading-[1.45] text-pretty">
              {a.reason}
            </p>
            <p className="text-faint mt-[4px] mb-0 font-mono text-[11px] break-all">
              {a.selector} on {a.target}
            </p>
            <div className="mt-[10px] flex flex-wrap gap-[8px]">
              <button
                type="button"
                disabled={busy === a.id}
                onClick={() => answer(a.id, 'approved')}
                className="bg-ink-app hover:bg-orange-app h-[32px] rounded-[10px] border-0 px-[14px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy === a.id}
                onClick={() => answer(a.id, 'declined')}
                className="h-[32px] rounded-[10px] border border-[rgb(26_26_25_/_0.16)] bg-white px-[14px] text-[12.5px] font-bold transition-colors hover:border-[rgb(26_26_25_/_0.3)] disabled:opacity-50"
              >
                Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
