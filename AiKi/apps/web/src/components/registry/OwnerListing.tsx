'use client'

import { useEffect, useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

/**
 * The seller's side of the marketplace, for the one person who owns this agent.
 *
 * Everything else on this page is something AiKi went and found. This is the
 * only place the other party acts, and until it existed an agent was quotable
 * only if its registration file carried a price. That means editing a JSON
 * document at a URL you control: four agents on the whole chain had done it,
 * so sixteen thousand listings had four things anybody could buy.
 *
 * It renders for nobody else. Not disabled for other visitors, absent, because
 * a control you cannot use is an advertisement for a permission you do not have.
 */
export function OwnerListing({ agentId, owner }: { agentId: string; owner: string | null }) {
  const say = useToast()
  const [isOwner, setIsOwner] = useState(false)
  const [amount, setAmount] = useState('0.10')
  const [busy, setBusy] = useState(false)
  const [listed, setListed] = useState<string | null>(null)
  /**
   * Whether the agent's own registration already names a price.
   *
   * Asked rather than guessed. A resolved registration file is not the same
   * fact as a priced one, and telling an owner their public price wins when
   * they have not got one would be a confident wrong sentence.
   */
  const [publishesOwnPrice, setPublishesOwnPrice] = useState(false)

  useEffect(() => {
    if (!owner) return
    let cancelled = false
    api
      .me()
      .then((me) => {
        if (!cancelled) setIsOwner(me.address.toLowerCase() === owner.toLowerCase())
      })
      // Not signed in is the common case and is not a failure worth saying.
      .catch(() => {})
    api
      .quote(agentId)
      .then((q) => {
        if (!cancelled) setPublishesOwnPrice(q.priceSource === 'registration')
      })
      // No quote means nothing prices it, which is the case this panel is for.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [owner, agentId])

  if (!isOwner) return null

  return (
    <div className="rounded-[18px] border border-[rgb(255_77_0_/_0.35)] bg-[rgb(255_77_0_/_0.04)] px-[18px] py-[15px]">
      <div className="text-[13.5px] font-bold">You own this agent</div>
      <p className="text-muted mt-[6px] mb-0 text-[12.5px] leading-[1.5] text-pretty">
        The registry records this token as yours, so you can set what AiKi quotes for it.
        {publishesOwnPrice
          ? ' Your registration file already publishes a price, and that one wins: it is public, and a price you set here privately must not quietly override what everybody else can read.'
          : ' Nothing you publish names a price today, so nobody can hire it. A price here fixes that without editing your registration file.'}
      </p>

      {listed ? (
        <p className="mt-[12px] mb-0 text-[12.5px] font-semibold">
          Listed at {listed}. Recorded as your stated price, not as something AiKi measured.
        </p>
      ) : (
        <div className="mt-[12px] flex flex-wrap items-center gap-[8px]">
          <label className="text-muted text-[12.5px] font-semibold" htmlFor="listing-price">
            Price per run
          </label>
          <input
            id="listing-price"
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            className="h-[34px] w-[110px] rounded-[10px] border border-[rgb(26_26_25_/_0.14)] bg-white px-[10px] text-[13px] font-semibold tabular-nums"
          />
          <span className="text-muted text-[12.5px] font-semibold">U</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              /*
               * Typed in whole tokens and sent in base units, because that is
               * what the chain counts in and the settlement asset carries
               * eighteen decimals. Doing this conversion in the reader's head
               * is how a ten cent price becomes a hundred million billion.
               */
              const tokens = Number(amount)
              if (!Number.isFinite(tokens) || tokens < 0) {
                say('That is not a price. Use a number of U, like 0.10.')
                return
              }
              const baseUnits = BigInt(Math.round(tokens * 1e6)) * 10n ** 12n
              setBusy(true)
              api
                .listAgent(agentId, baseUnits.toString())
                .then(() => {
                  setListed(`${tokens.toFixed(3)} U`)
                  say('Listed. AiKi will quote this when your registration names no price.')
                })
                .catch((error: Error) => say(error.message || 'That did not go through.'))
                .finally(() => setBusy(false))
            }}
            className="bg-ink-app hover:bg-orange-app h-[34px] rounded-[10px] border-0 px-[14px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-50"
          >
            {busy ? 'Listing…' : 'List it'}
          </button>
        </div>
      )}
    </div>
  )
}
