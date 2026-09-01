'use client'

import { useRouter } from 'next/navigation'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount, useModeNavigation } from '@/components/shell/prefs'
import { useToast } from '@/components/ui/Toast'
import { route } from '@/lib/routes'
import { CONNECT_TOAST } from '@/lib/wallet'

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
  id,
  title,
  note,
  children,
}: {
  id: string
  title: string
  note: string
  children: React.ReactNode
}) => (
  <section id={id} className="mb-[26px] scroll-mt-4 last:mb-0">
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
  const { connected, connect, disconnect, address, walletKind } = useAccount()

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <div className="min-w-0 flex-1 basis-[240px]">
        <span className="block text-[19px] font-extrabold tracking-[-0.02em]">Settings</span>
        <p className="text-muted mt-[3px] mb-0 max-w-[620px] text-[13px] leading-[1.45] text-pretty">
          What AiKi is connected to, what it tells you about, and what it keeps. Anything that could
          move money lives on the agent it belongs to, not here.
        </p>
      </div>
    </div>
  )

  return (
    <PageCard title="Settings" count="" headerSlot={header} tabs={[]} tabHint="">
      <div className="max-w-[860px]">
        <Section
          id="wallet"
          title="Wallet"
          note="Connecting lets AiKi read. It never grants the ability to move anything. That only comes from an authority you sign per agent, with limits you set."
        >
          <Row
            title={connected ? 'Connected wallet' : 'No wallet connected'}
            body={
              connected
                ? walletKind === 'simulated'
                  ? `${address} · a simulated wallet, not a real connection`
                  : address
                : 'AiKi cannot see any balances or positions right now.'
            }
            action="Copy"
            onAction={() => {
              navigator.clipboard
                ?.writeText(address)
                .then(() => say('Address copied.'))
                .catch(() => say('Your browser would not let us copy.'))
            }}
          />
          <Row
            title="Network"
            body="BNB Smart Chain · chain 56. Agents are ERC-8004 identities on this chain and nowhere else."
          />
          <Row
            title={connected ? 'Disconnect' : 'Connect'}
            body={
              connected
                ? 'Stops AiKi reading your balances. Authorities already signed stay on the chain until you revoke them. Disconnecting is not revoking, and pretending otherwise would be dangerous.'
                : 'Lets AiKi read your balances and positions so it can suggest work worth doing. It grants nothing on its own.'
            }
            action={connected ? 'Disconnect' : 'Connect'}
            onAction={() => {
              if (connected) {
                disconnect()
                say('Disconnected. Revoke each authority from Limits, which is a separate thing.')
              } else {
                void connect().then((outcome) => say(CONNECT_TOAST[outcome]))
              }
            }}
          />
        </Section>

        {/*
         * Rewritten to describe what exists.
         *
         * This section used to promise that AiKi would interrupt you, that an
         * approval carried a deadline, and that approval requests were the one
         * thing we would not let you silence. There was no notification system,
         * no deadline, and until the approval gate shipped, no approvals: three
         * sentences of comfort about machinery that was not there, on the
         * screen where somebody decides how much to trust this.
         *
         * There is still no push channel. Saying where things appear is worth
         * less than a notification and is at least true.
         */}
        <Section
          id="notifications"
          title="What reaches you, and where"
          note="AiKi does not send you anything yet: no email, no push, no phone. Everything below appears in the app, and this section says where, so nothing here reads as a promise to reach you somewhere else."
        >
          <Row
            title="Actions waiting for you"
            body="When your mandate says to ask first, the agent stops and the request appears on that job's page. It stays there until you answer, and the agent will not act until you do. Nothing expires and nothing is lost, but nothing chases you either."
          />
          <Row
            title="Blocked actions"
            body="An agent tried something outside your limits and was refused. It appears in the job's event stream, which is append-only, so a refusal cannot be quietly dropped later."
          />
          <Row
            title="Routine activity"
            body="Checks that found nothing to do, and actions well inside your limits. Same stream, same page, no interruption."
          />
        </Section>

        <Section
          id="mode"
          title="Mode"
          note="Choose the active home. Switching opens it now and keeps it as the default next time."
        >
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
          id="api"
          title="Evidence API"
          note="The measurements behind every number on this site, served raw. Not a summary of our opinion, but the probe results, counts and intervals themselves, so anyone can recompute a score and disagree with us in public."
        >
          <Row
            title="Not open yet"
            body="It goes out once the numbers it would serve are stable enough that changing them would be a breaking change rather than a bug fix."
            action="How we test"
            onAction={() => router.push(route('/docs/how-we-test'))}
          />
        </Section>

        <Section
          id="data"
          title="What we keep"
          note="Written down because a settings page that never mentions this is hiding it."
        >
          <Row
            title="In this browser"
            body="Your mode, whether the sidebar is collapsed, and which agents you saved. None of it leaves the device."
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
          <Row
            title="Kept by AiKi"
            body="Every ask, including ones no agent could take, because those are how we know what to build next. And every action an agent took for you, because a receipt nobody kept is not a receipt."
          />
        </Section>
      </div>
    </PageCard>
  )
}
