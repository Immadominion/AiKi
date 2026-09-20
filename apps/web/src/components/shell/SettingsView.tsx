'use client'

import { useRouter } from 'next/navigation'
import { PageCard } from '@/components/shell/PageCard'
import { useModeNavigation } from '@/components/shell/prefs'
import { useToast } from '@/components/ui/Toast'
import { route } from '@/lib/routes'

const Row = ({
  title,
  body,
  action,
  onAction,
}: {
  title: string
  body: string
  action?: string
  onAction?: () => void
}) => (
  <div className="flex flex-wrap items-start gap-[12px] border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[14px] first:border-t-0">
    <span className="min-w-0 flex-1 basis-[260px]">
      <span className="block text-[13.5px] font-bold">{title}</span>
      <span className="text-muted mt-[3px] block text-[12.5px] leading-[1.5] text-pretty">
        {body}
      </span>
    </span>
    {action ? (
      <button
        type="button"
        onClick={onAction}
        className="text-ink-app h-[34px] flex-none rounded-[11px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
      >
        {action}
      </button>
    ) : null}
  </div>
)

const Section = ({
  title,
  note,
  children,
}: {
  title: string
  note: string
  children: React.ReactNode
}) => (
  <section className="mb-[26px] last:mb-0">
    <h2 className="mb-[3px] text-[15px] font-bold">{title}</h2>
    <p className="text-muted mt-0 mb-[12px] max-w-[660px] text-[12.5px] leading-[1.55] text-pretty">
      {note}
    </p>
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">{children}</div>
  </section>
)

export function SettingsView() {
  const say = useToast()
  const router = useRouter()
  const { layout, switchMode } = useModeNavigation()

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <div className="min-w-0 flex-1 basis-[240px]">
        <span className="block text-[19px] font-extrabold tracking-[-0.02em]">Settings</span>
        <p className="text-muted mt-[3px] mb-0 max-w-[620px] text-[13px] leading-[1.45] text-pretty">
          How AiKi behaves and what it keeps. Money lives in Wallet.
        </p>
      </div>
    </div>
  )

  return (
    <PageCard title="Settings" count="" headerSlot={header} tabs={[]} tabHint="">
      <div className="max-w-[720px] pb-6">
        <Section title="Mode" note="Your home screen.">
          <div className="flex flex-wrap items-center gap-[12px] px-4 py-[14px]">
            <span className="min-w-0 flex-1 basis-[260px]">
              <span className="block text-[13.5px] font-bold">Current mode</span>
              <span className="text-muted mt-[3px] block text-[12.5px] leading-[1.5]">
                {layout === 'fast'
                  ? 'Fast. One question fills the screen.'
                  : 'Manual. You browse the market and pick.'}
              </span>
            </span>
            <div className="flex flex-none gap-[3px] rounded-[12px] bg-[rgb(26_26_25_/_0.05)] p-[3px]">
              {(['fast', 'manual'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => switchMode(k)}
                  className="h-[31px] rounded-[9px] border-0 px-[14px] text-[12.5px]"
                  style={
                    layout === k
                      ? { background: '#fff', color: 'var(--color-ink-app)', fontWeight: 700 }
                      : {
                          background: 'transparent',
                          color: 'var(--color-muted-2)',
                          fontWeight: 600,
                        }
                  }
                >
                  {k === 'fast' ? 'Fast' : 'Manual'}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section
          title="What reaches you, and where"
          note="No email, no push, no phone. Everything appears in the app. Here is where."
        >
          <Row
            title="Actions waiting for you"
            body="On the job’s page. It waits for you, and nothing expires."
          />
          <Row title="Blocked actions" body="In the job’s event stream, which cannot be edited." />
          <Row title="Routine activity" body="Same stream. No interruption." />
        </Section>

        <Section
          title="Evidence API"
          note="Every measurement behind every number here, raw, so anyone can recompute a score and disagree in public."
        >
          <Row
            title="Not open yet"
            body="Opens when the numbers stop moving."
            action="How we test"
            onAction={() => router.push(route('/docs/how-we-test'))}
          />
        </Section>

        <Section
          title="What we keep"
          note="Written down, because not saying it would be hiding it."
        >
          <Row
            title="In this browser"
            body="Mode, sidebar, saved agents. Never leaves this device."
            action="Clear"
            onAction={() => {
              try {
                localStorage.clear()
                say('Cleared. Reload to see the defaults.')
              } catch {
                say('Your browser would not let us clear it.')
              }
            }}
          />
          <Row title="Kept by AiKi" body="Every ask, and every action an agent took for you." />
        </Section>
      </div>
    </PageCard>
  )
}
