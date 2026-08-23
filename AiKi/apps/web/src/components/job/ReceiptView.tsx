'use client'

import { useRouter } from 'next/navigation'
import { PageCard } from '@/components/shell/PageCard'
import { PageSkeleton } from '@/components/ui/Skeleton'
import { StatusPill } from '@/components/ui/StatusPill'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENT_BY_KEY } from '@/lib/agents'
import { route } from '@/lib/routes'
import { useMock } from '@/mock/store'
import { usd } from '@/mock/types'

const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' })

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-[11.5px] leading-[1.6] break-all">{children}</span>
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
  <section className="mb-[22px] last:mb-0">
    <h2 className="mb-[2px] text-[14.5px] font-bold">{title}</h2>
    <p className="text-muted mt-0 mb-[11px] text-[12.5px] leading-[1.5] text-pretty">{note}</p>
    {children}
  </section>
)

const Line = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col items-start gap-1 border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[11px] first:border-t-0 sm:flex-row sm:gap-3">
    <span className="text-muted w-full flex-none text-[12.5px] font-semibold sm:w-[168px]">
      {label}
    </span>
    <span className="min-w-0 flex-1 text-[13px] leading-[1.45] text-pretty">{children}</span>
  </div>
)

export function ReceiptView({ receiptId }: { receiptId: string }) {
  const { state, ready } = useMock()
  const say = useToast()
  const router = useRouter()

  const r = state.receipts.find((x) => x.id === receiptId)

  if (!ready) return <PageSkeleton rows={4} />

  if (!r) {
    return (
      <PageCard
        title="Receipt"
        count=""
        back={{ href: '/activity', label: 'Activity' }}
        tabs={[]}
        tabHint=""
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[24px]">
          <div className="text-[14.5px] font-bold">No receipt with that id.</div>
          <p className="text-muted mt-[6px] mb-0 max-w-[560px] text-[13px] leading-[1.55] text-pretty">
            A receipt is written when a job finishes. If the job is still running, or its authority
            was revoked partway, there is nothing signed to show yet.
          </p>
          <button
            type="button"
            onClick={() => router.push(route('/activity'))}
            className="bg-ink-app hover:bg-orange-app mt-[16px] h-[38px] rounded-xl border-0 px-4 text-[13.5px] font-bold text-white transition-colors"
          >
            Back to activity
          </button>
        </div>
      </PageCard>
    )
  }

  const agent = AGENT_BY_KEY[r.key]
  const total = r.providerCents + r.platformCents + r.networkCents
  const verifyUrl = `https://useaiki.xyz/verify/${r.id}`

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <span
        className="flex size-[52px] flex-none items-center justify-center rounded-[16px] text-[20px] font-extrabold text-white"
        style={{ background: AGENT_BG[r.key] }}
      >
        {agent.initial}
      </span>
      <div className="min-w-0 flex-1 basis-[240px]">
        <div className="flex flex-wrap items-center gap-[10px]">
          <span className="text-[19px] font-extrabold tracking-[-0.02em]">Receipt</span>
          <StatusPill label="Signed" tone="good" />
        </div>
        <p className="text-muted mt-[3px] mb-0 text-[13px] leading-[1.45]">
          {agent.name} · {stamp(r.startedAt)} → {stamp(r.completedAt)}
        </p>
      </div>
      <button
        type="button"
        onClick={() => say(`Verification opens ${verifyUrl}. It does not go through AiKi.`)}
        className="bg-ink-app hover:bg-orange-app h-[38px] w-full flex-none rounded-xl border-0 px-4 text-[13.5px] font-bold text-white transition-colors sm:w-auto"
      >
        Verify this yourself
      </button>
    </div>
  )

  return (
    <PageCard
      title="Receipt"
      count=""
      back={{ href: '/activity', label: 'Activity' }}
      headerSlot={header}
      tabs={[]}
      tabHint=""
    >
      <div className="max-w-[860px]">
        <Section
          title="What it did"
          note="Every action, including the ones that were refused. A receipt listing only what succeeded would be a brochure."
        >
          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
            {r.actions.map((a) => (
              <div
                key={a.at}
                className="flex items-start gap-3 border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[13px] first:border-t-0"
              >
                <span
                  className="mt-[6px] size-[7px] flex-none rounded-full"
                  style={{ background: a.allowed ? 'var(--color-good)' : 'var(--color-work)' }}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className="block text-[13.5px] font-semibold text-pretty"
                    style={{
                      color: a.allowed ? 'var(--color-ink-app)' : 'var(--color-work-ink)',
                    }}
                  >
                    {a.what}
                  </span>
                  <span className="text-muted mt-[4px] flex flex-wrap items-center gap-x-[12px] gap-y-[2px] text-[11.5px]">
                    <span className="tabular-nums">{stamp(a.at)}</span>
                    {a.txHash ? (
                      <Mono>{a.txHash}</Mono>
                    ) : (
                      <span>never signed, never broadcast</span>
                    )}
                    {a.gasCents ? <span>gas {usd(a.gasCents)}</span> : null}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="What it cost"
          note="Split out, because “fees” as one number hides who took what."
        >
          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
            <Line label="The agent">{usd(r.providerCents)}</Line>
            <Line label="AiKi">{usd(r.platformCents)}</Line>
            <Line label="The network">{usd(r.networkCents)} in gas</Line>
            <div className="flex items-baseline justify-between border-t-[1.5px] border-[rgb(26_26_25_/_0.1)] px-4 py-[13px]">
              <span className="text-[13px] font-bold">Total</span>
              <span className="text-[16px] font-extrabold tabular-nums">{usd(total)}</span>
            </div>
          </div>
        </Section>

        <Section
          title="What it was allowed to do"
          note="The hash binds this work to the exact permissions it ran under. Change one limit and the hash changes, so nobody can claim afterwards that you agreed to something else."
        >
          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
            <Line label="Mandate">
              <Mono>{r.mandateHash}</Mono>
            </Line>
            <Line label="Job">{r.jobId}</Line>
            <Line label="Agent identity">ERC-8004 token on BNB Chain · {agent.name}</Line>
          </div>
        </Section>

        <Section title="What came of it" note="The outcome, in the words you would use.">
          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
            <Line label="Result">{r.summary}</Line>
          </div>
        </Section>

        <Section
          title="Check it without us"
          note="Signed with a standard algorithm in a standard format, so verification never has to go through AiKi. Anyone can check this, including someone who thinks we are lying."
        >
          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
            <Line label="Algorithm">ES256 · COSE receipt, SCITT profile</Line>
            <Line label="Signature">
              <Mono>{r.signature}</Mono>
            </Line>
            <Line label="Verify at">
              <span className="font-semibold">{verifyUrl}</span>
            </Line>
          </div>
        </Section>
      </div>
    </PageCard>
  )
}
