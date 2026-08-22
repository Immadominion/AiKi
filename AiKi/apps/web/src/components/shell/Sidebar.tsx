'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { usePalette } from '@/components/shell/CommandPalette'
import { useToast } from '@/components/ui/Toast'
import { route } from '@/lib/routes'
import { useLayoutPref, useSidebar } from './prefs'

interface Item {
  label: string
  glyph: string
  href?: string
  count?: number
  tag?: string
}

const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: 'General',
    items: [
      { label: 'Home', glyph: '⌂', href: '/' },
      { label: 'Explore', glyph: '⌕', href: '/explore' },
      { label: 'My agents', glyph: '▣', href: '/agents', count: 2 },
    ],
  },
  {
    label: 'Oversight',
    items: [
      { label: 'Activity', glyph: '≡', href: '/activity', count: 1 },
      { label: 'Limits', glyph: '⊘' },
      { label: 'Saved', glyph: '♡' },
    ],
  },
  {
    label: 'Settings',
    items: [
      { label: 'How we test', glyph: '⌗', href: '/how-we-test' },
      { label: 'Wallet', glyph: '▤' },
      { label: 'Notifications', glyph: '◔' },
      { label: 'Evidence API', glyph: '⌗', tag: 'Beta' },
    ],
  },
]

export function Sidebar({ userName = 'Dominion' }: { userName?: string }) {
  const path = usePathname()
  const say = useToast()
  const openPalette = usePalette()
  const { layout, setLayout } = useLayoutPref()
  const { collapsed, toggle } = useSidebar()

  return (
    <div
      className="flex min-h-0 flex-none flex-col px-1 pt-[6px] pb-1 transition-[width] duration-150"
      style={{ width: collapsed ? 60 : 'clamp(196px,19vw,252px)' }}
    >
      <div
        className={`flex items-center pr-2 pl-[6px] ${collapsed ? 'justify-center' : 'justify-between'}`}
      >
        {collapsed ? null : (
          <div className="flex items-center gap-[9px]">
            <Image
              src="/aiki-logo.png"
              alt=""
              width={68}
              height={68}
              className="size-[34px] object-contain"
            />
            <span className="text-[19px] font-extrabold tracking-[-0.02em]">AiKi</span>
          </div>
        )}
        <button
          type="button"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggle}
          className="flex size-7 flex-none items-center justify-center rounded-lg border-0 bg-none hover:bg-[rgb(26_26_25_/_0.06)]"
        >
          <span className="relative block h-[14px] w-[15px] rounded-[4px] border-[1.7px] border-[#6B6B66]">
            <span
              className="absolute inset-y-0 w-[5px] bg-[#6B6B66]"
              style={
                collapsed
                  ? { right: 0, borderRadius: '0 2px 2px 0' }
                  : { left: 0, borderRadius: '2px 0 0 2px' }
              }
            />
          </span>
        </button>
      </div>

      <button
        type="button"
        title="Search — ⌘K"
        onClick={openPalette}
        className={`mt-4 flex h-[42px] items-center gap-[10px] rounded-[14px] border-0 bg-[rgb(26_26_25_/_0.055)] text-left hover:bg-[rgb(26_26_25_/_0.085)] ${
          collapsed ? 'justify-center px-0' : 'pr-[10px] pl-[13px]'
        }`}
      >
        <span className="relative size-[15px] flex-none rounded-full border-[1.8px] border-[#6B6B66]">
          <span className="absolute -right-[5px] -bottom-1 h-[1.8px] w-[6px] rotate-45 rounded-[2px] bg-[#6B6B66]" />
        </span>
        {collapsed ? null : (
          <>
            <span className="text-muted flex-1 text-[14px] font-medium">Search…</span>
            <span className="text-muted flex-none rounded-[7px] bg-white px-[6px] py-1 text-[11px] font-semibold">
              ⌘K
            </span>
          </>
        )}
      </button>

      <div className="mt-5 flex-1 overflow-y-auto overflow-x-hidden pr-[2px]">
        {GROUPS.map((g) => (
          <div key={g.label} className="mb-[22px]">
            {collapsed ? (
              <div className="mx-auto mb-[9px] h-px w-[26px] bg-[rgb(26_26_25_/_0.09)]" />
            ) : (
              <div className="text-muted-3 px-2 pb-2 text-[12px] font-semibold">{g.label}</div>
            )}
            <div className="flex flex-col gap-[2px]">
              {g.items.map((item) => {
                const on = item.href === path
                const inner = (
                  <>
                    <span
                      className="flex w-[19px] flex-none items-center justify-center text-[14px] font-semibold"
                      style={{ color: on ? 'var(--color-ink-app)' : 'var(--color-muted)' }}
                    >
                      {item.glyph}
                    </span>
                    {collapsed ? null : (
                      <>
                        <span
                          className="flex-1 truncate text-[14.5px]"
                          style={{
                            fontWeight: on ? 700 : 500,
                            color: on ? 'var(--color-ink-app)' : 'var(--color-body)',
                          }}
                        >
                          {item.label}
                        </span>
                        {item.count ? (
                          <span className="bg-orange-app flex h-[21px] min-w-[21px] flex-none items-center justify-center rounded-full px-[6px] text-[11.5px] font-bold text-white">
                            {item.count}
                          </span>
                        ) : null}
                        {item.tag ? (
                          <span className="flex-none rounded-full bg-[#E8EEFF] px-2 py-[3px] text-[11px] font-bold text-[#3B6BE0]">
                            {item.tag}
                          </span>
                        ) : null}
                      </>
                    )}
                    {/* Collapsed, a count has nowhere to sit beside the label, so
                        it becomes a dot on the icon rather than disappearing. */}
                    {collapsed && item.count ? (
                      <span className="bg-orange-app absolute top-[7px] right-[7px] size-[7px] rounded-full" />
                    ) : null}
                  </>
                )
                const cls = `relative flex h-[42px] w-full items-center gap-3 rounded-[13px] border-0 text-left transition-colors ${
                  collapsed ? 'justify-center px-0' : 'px-[11px]'
                }`
                const style = on
                  ? { background: '#fff', boxShadow: '0 1px 2px rgb(26 26 25 / 0.09)' }
                  : undefined

                return item.href ? (
                  <Link
                    key={item.label}
                    href={route(item.href)}
                    title={collapsed ? item.label : undefined}
                    className={`${cls} ${on ? '' : 'hover:bg-[rgb(26_26_25_/_0.055)]'}`}
                    style={style}
                  >
                    {inner}
                  </Link>
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    title={collapsed ? item.label : undefined}
                    onClick={() => say(`${item.label} comes later in the journey.`)}
                    className={`${cls} bg-transparent hover:bg-[rgb(26_26_25_/_0.055)]`}
                  >
                    {inner}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* The layout choice lives here and nowhere else — it is a preference, not
          a navigation control, and putting it in the chrome would make it feel
          like one. Collapsed, it becomes a single toggle rather than vanishing. */}
      {collapsed ? (
        <button
          type="button"
          title={layout === 'ask' ? 'Home: one ask' : 'Home: market'}
          onClick={() => setLayout(layout === 'ask' ? 'market' : 'ask')}
          className="mx-auto mt-2 flex size-[42px] flex-none items-center justify-center rounded-[13px] border-0 bg-white text-[13px] font-bold shadow-[0_1px_2px_rgb(26_26_25_/_0.05)]"
        >
          {layout === 'ask' ? '◍' : '▤'}
        </button>
      ) : (
        <div className="mx-1 mt-2 flex-none rounded-[18px] bg-white px-3 pt-3 pb-[13px] shadow-[0_1px_2px_rgb(26_26_25_/_0.05)]">
          <div className="text-muted text-[12px] font-semibold">Home layout</div>
          <div className="mt-[9px] flex gap-[3px] rounded-[12px] bg-[rgb(26_26_25_/_0.05)] p-[3px]">
            {(['ask', 'market'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setLayout(k)}
                className="h-[31px] flex-1 rounded-[9px] border-0 text-[12.5px] whitespace-nowrap"
                style={
                  layout === k
                    ? {
                        background: '#fff',
                        color: 'var(--color-ink-app)',
                        fontWeight: 700,
                        boxShadow: '0 1px 2px rgb(26 26 25 / 0.1)',
                      }
                    : { background: 'transparent', color: 'var(--color-muted-2)', fontWeight: 600 }
                }
              >
                {k === 'ask' ? 'One ask' : 'Market'}
              </button>
            ))}
          </div>
          <div className="text-muted mt-2 text-[11.5px] leading-[1.45]">
            {layout === 'ask'
              ? 'A single question fills the screen. Chosen during onboarding.'
              : 'You land in the agent market. Chosen during onboarding.'}
          </div>
        </div>
      )}

      <button
        type="button"
        title={collapsed ? `${userName} · 0x7f4a…3a91` : undefined}
        onClick={() => say('Wallet & account settings come later in the journey.')}
        className={`mt-[6px] flex flex-none items-center gap-[11px] rounded-2xl border-0 bg-none py-[9px] text-left hover:bg-[rgb(26_26_25_/_0.055)] ${
          collapsed ? 'justify-center px-0' : 'px-[10px]'
        }`}
      >
        <span
          className="flex size-9 flex-none items-center justify-center rounded-xl text-[14px] font-extrabold text-white"
          style={{ background: 'var(--agent-account)' }}
        >
          D
        </span>
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-bold">{userName}</span>
              <span className="text-muted mt-px block text-[11.5px]">0x7f4a…3a91</span>
            </span>
            <span className="text-muted flex-none text-[13px]">⌄</span>
          </>
        )}
      </button>
    </div>
  )
}
