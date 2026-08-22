import type { EnforcementTier } from '@aiki/contracts'
import type { EnforcementLine } from '@/lib/detail'

/**
 * Where each limit is actually held.
 *
 * Drawn against the obvious instinct: the STRONG tier is quiet and the WEAK tier
 * is loud. Chrome removed the padlock after finding only ~11% of users understood
 * it — positive trust badges get ignored, negative ones change behaviour. So a
 * chain-enforced limit gets no decoration at all, and one held by a promise gets
 * a full callout saying what would break it.
 */
const TIER_NOTE: Record<EnforcementTier, string> = {
  T0: 'The chain rejects the call. Holds even if both AiKi and the agent are compromised.',
  T1: 'A signer refuses the call. Holds if the agent is compromised, not if the signer is.',
  T2: 'AiKi checks before relaying. Holds against a buggy agent, not against a compromised AiKi.',
  T3: 'Noticed afterwards. Nothing stops it happening.',
}

export function EnforcementList({ lines }: { lines: EnforcementLine[] }) {
  return (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
      {lines.map((l, i) => {
        const weak = l.tier !== 'T0' || !l.verified
        return (
          <div
            key={l.label}
            className={`px-4 py-[14px] ${i > 0 ? 'border-t border-[rgb(26_26_25_/_0.06)]' : ''}`}
          >
            <div className="flex items-start gap-[11px]">
              <span className="min-w-0 flex-1 text-[13.5px] leading-[1.45] font-semibold text-pretty">
                {l.label}
              </span>
              <span
                className="flex-none rounded-full px-[9px] py-[3px] text-[11px] font-bold"
                style={
                  weak
                    ? { background: 'var(--color-warn-bg)', color: 'var(--color-warn-ink)' }
                    : { background: 'rgb(26 26 25 / 0.05)', color: 'var(--color-muted)' }
                }
              >
                {l.tier === 'T0' && l.verified
                  ? 'On-chain'
                  : l.tier === 'T1'
                    ? 'A signer'
                    : l.tier === 'T2'
                      ? 'AiKi only'
                      : 'After the fact'}
              </span>
            </div>

            <div className="text-muted mt-[5px] text-[12px] leading-[1.5] text-pretty">
              {TIER_NOTE[l.tier]} <span className="text-faint">· {l.enforcedBy}</span>
            </div>

            {(l.caveat || !l.verified) && (
              <div className="bg-warn-bg mt-[10px] flex items-start gap-[9px] rounded-[13px] px-[12px] py-[10px]">
                <span className="bg-warn mt-px flex size-[17px] flex-none items-center justify-center rounded-[6px] text-[10px] font-extrabold text-white">
                  !
                </span>
                <span className="text-[12px] leading-[1.5] text-[#6B5A34]">
                  {!l.verified && (
                    <b className="font-bold">We have not read the enforcing code. </b>
                  )}
                  {l.caveat}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
