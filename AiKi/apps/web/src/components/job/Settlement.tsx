'use client'

import { useEffect, useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

/**
 * Where the money for this job actually is.
 *
 * The marketplace could quote and it could run an agent, and between those two
 * nothing changed hands: of the twelve job states the contract defines, FUNDED
 * and SETTLED were reached by no code path. This is the panel that moves it,
 * and it states each leg rather than summarising them, because the whole point
 * of a fee that was quoted before the work is that it is the same number after.
 */

type Phase = 'reading' | 'unpriced' | 'quoted' | 'funded' | 'settled'

const money = (m: { amount: string; asset: string; decimals: number } | undefined) =>
  m ? `${(Number(m.amount) / 10 ** m.decimals).toFixed(3)} ${m.asset}` : ''

export function Settlement({ jobId, agentId }: { jobId: string; agentId: string }) {
  const say = useToast()
  const [phase, setPhase] = useState<Phase>('reading')
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof api.quote>> | null>(null)
  const [legs, setLegs] = useState<{ paidToAgent: number; fee: number; paidTo: string } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .quote(agentId)
      .then((q) => {
        if (!cancelled) {
          setQuote(q)
          setPhase('quoted')
        }
      })
      .catch(() => {
        // A refused quote is an answer. Almost nothing in this registry
        // publishes a price, and a blank that reads as free is worse.
        if (!cancelled) setPhase('unpriced')
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  if (phase === 'reading') return <Shell>Reading what this agent charges…</Shell>

  if (phase === 'unpriced')
    return (
      <Shell>
        This agent publishes no price in its registration, so there is nothing to charge and nothing
        to settle. AiKi will not invent a number to put here.
      </Shell>
    )

  const total = money(quote?.total)

  return (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[15px]">
      <div className="text-[13.5px] font-bold">Money</div>

      <div className="mt-[10px] grid gap-[7px] text-[13px]">
        <Row label="The agent charges" value={money(quote?.price)} />
        <Row
          label={`AiKi keeps (${(quote?.feeBasisPoints ?? 0) / 100}%)`}
          value={money(quote?.platformFee)}
        />
        <Row label="You pay" value={total} strong />
      </div>

      {phase === 'settled' && legs ? (
        <p className="text-muted mt-[12px] mb-0 text-[12.5px] leading-[1.5] text-pretty">
          Settled. {legs.paidToAgent} points went to {legs.paidTo.slice(0, 10)}…, the address the
          registry records as this agent's owner, and {legs.fee} stayed with AiKi. That is the fee
          quoted above, not a second number.
        </p>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            const step =
              phase === 'quoted'
                ? api.fundJob(jobId, agentId).then((r) => {
                    setPhase('funded')
                    say(
                      `Funded. ${r.held} points held; nothing reaches the agent until the work is in.`,
                    )
                  })
                : api.settleJob(jobId, agentId).then((r) => {
                    setLegs({ paidToAgent: r.paidToAgent, fee: r.fee, paidTo: r.paidTo })
                    setPhase('settled')
                    say(r.alreadySettled ? 'Already settled; nobody was paid twice.' : 'Paid.')
                  })
            void step
              .catch((error: Error) => {
                // Named, because "something went wrong" on a payment screen is
                // the least useful sentence available.
                say(error.message || 'That did not go through, and nothing moved.')
              })
              .finally(() => setBusy(false))
          }}
          className="bg-ink-app hover:bg-orange-app mt-[14px] h-[38px] w-full rounded-xl border-0 text-[13px] font-bold text-white transition-colors disabled:opacity-50"
        >
          {busy ? 'Working…' : phase === 'quoted' ? `Fund this job · ${total}` : 'Release payment'}
        </button>
      )}

      <p className="text-faint mt-[10px] mb-0 text-[11.5px] leading-[1.45] text-pretty">
        {phase === 'funded'
          ? 'Held, not sent. The agent is paid when you release it.'
          : 'Settled in points, which is a ledger you can add up. The same three legs on chain through ERC-8183 escrow is the next step and does not change the numbers.'}
      </p>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className={`tabular-nums ${strong ? 'text-[15px] font-extrabold' : 'font-semibold'}`}>
        {value}
      </span>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[15px]">
      <div className="text-[13.5px] font-bold">Money</div>
      <p className="text-muted mt-[8px] mb-0 text-[12.5px] leading-[1.5] text-pretty">{children}</p>
    </div>
  )
}
