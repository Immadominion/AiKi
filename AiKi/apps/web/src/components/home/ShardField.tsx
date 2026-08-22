'use client'

import { type ShardSpec, shardStyles } from './shards'

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
}: {
  shards: ShardSpec[]
  onPick: (name: string) => void
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-6 hidden lg:block">
      {shards.map((s) => {
        const st = shardStyles(s)
        return (
          <div key={`${s.name}-${s.top}-${s.side}`} style={st.wrap}>
            <span aria-hidden style={st.smear} />
            <button
              type="button"
              onClick={() => onPick(s.name)}
              className="group relative block w-full border-0 bg-none p-0"
              style={st.button}
            >
              <span
                className="flex w-full items-center gap-3 rounded-[20px] border border-[rgb(20_20_20_/_0.06)] bg-white px-4 py-[14px] text-left shadow-[0_26px_54px_-30px_rgb(20_20_20_/_0.4),0_2px_6px_-2px_rgb(20_20_20_/_0.06)] transition-shadow group-hover:shadow-[0_34px_66px_-28px_rgb(20_20_20_/_0.5),0_2px_6px_-2px_rgb(20_20_20_/_0.08)]"
                style={st.card}
              >
                <span
                  className="flex size-10 flex-none items-center justify-center rounded-full text-[15px] font-extrabold text-white"
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
