'use client'

import { type Frame, SCREEN, type ShardSpec, shardStyles } from './shards'

/**
 * The floating agent cards either side of the hero.
 *
 * Decorative in composition but not in content — each one is a real agent with a
 * real last-known state, and clicking it goes to that agent. The field is hidden
 * below 1024px, where there is no room either side of the hero for it to exist.
 */
export function ShardField({
  shards,
  onPick,
  frame = SCREEN,
  hideBelow = 'lg',
}: {
  shards: ShardSpec[]
  onPick: (shard: ShardSpec) => void
  /** Which box the cluster is measured against. */
  frame?: Frame
  hideBelow?: 'lg' | 'xl'
}) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 z-6 hidden ${hideBelow === 'lg' ? 'lg:block' : 'xl:block'}`}
    >
      {shards.map((s) => {
        const st = shardStyles(s, frame)
        return (
          <div key={`${s.name}-${s.top}-${s.side}`} className="group" style={st.wrap}>
            <span
              aria-hidden
              className="transition-opacity duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:opacity-70"
              style={st.smear}
            />
            <button
              type="button"
              onClick={() => onPick(s)}
              className="relative block w-full border-0 bg-none p-0"
              style={st.button}
            >
              {/* A card you can click should answer when you reach for it. The
                  lift is on the inner span so the warp transform on the wrapper
                  is left alone, and the mask edge brightens at the same time so
                  the whole shard reads as coming forward rather than just
                  growing. */}
              <span
                className="flex w-full items-center gap-3 rounded-[20px] border border-[rgb(20_20_20_/_0.06)] bg-white px-4 py-[14px] text-left shadow-[0_26px_54px_-30px_rgb(20_20_20_/_0.4),0_2px_6px_-2px_rgb(20_20_20_/_0.06)] group-hover:[--shard-mid:1] group-hover:[--shard-near:1] group-hover:-translate-y-[3px] group-hover:scale-[1.022] group-hover:border-[rgb(255_77_0_/_0.18)] group-hover:shadow-[0_38px_72px_-26px_rgb(20_20_20_/_0.42),0_0_0_1px_rgb(255_77_0_/_0.06),0_2px_8px_-2px_rgb(255_77_0_/_0.18)] group-active:scale-[0.995] group-active:duration-150"
                style={st.card}
              >
                <span
                  className="flex size-10 flex-none items-center justify-center rounded-full text-[15px] font-extrabold text-white transition-[box-shadow,transform] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]"
                  style={{ background: s.bg, boxShadow: `0 8px 18px -8px ${s.glow}` }}
                >
                  {s.initial}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-bold tracking-[-0.012em]">
                    {s.name}
                  </span>
                  <span className="mt-[2px] block text-[11.5px] leading-[1.35] font-medium text-pretty text-[#8A8A8A]">
                    {s.capability}
                  </span>
                  <span className="mt-[7px] flex items-start gap-[6px]">
                    <span
                      className="mt-[5px] size-[5px] flex-none rounded-full"
                      style={{ background: s.stateDot }}
                    />
                    <span
                      className="text-[11px] leading-[1.35] font-semibold text-pretty"
                      style={{ color: s.stateColor }}
                    >
                      {s.state}
                    </span>
                  </span>
                </span>
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
