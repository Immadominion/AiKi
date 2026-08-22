'use client'

import { PageCard } from '@/components/shell/PageCard'
import { StatusPill } from '@/components/ui/StatusPill'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENT_BY_KEY } from '@/lib/agents'
import { RECEIPT } from '@/lib/receipt'

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
  <div className="flex items-start gap-3 border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[11px] first:border-t-0">
    <span className="text-muted w-[168px] flex-none text-[12.5px] font-semibold">{label}</span>
    <span className="min-w-0 flex-1 text-[13px] leading-[1.45] text-pretty">{children}</span>
  </div>
)

export function ReceiptView() {
  const r = RECEIPT
  const row = AGENT_BY_KEY.guardian
  const say = useToast()

  const header = (
    <div className="flex items-start gap-[14px]">
      <span
        className="flex size-[52px] flex-none items-center justify-center rounded-[16px] text-[20px] font-extrabold text-white"
        style={{ background: AGENT_BG.guardian }}
      >
        {row.initial}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[10px]">
          <span className="text-[19px] font-extrabold tracking-[-0.02em]">Receipt</span>
          <StatusPill label="Signed" tone="good" />
        </div>
        <p className="text-muted mt-[3px] mb-0 text-[13px] leading-[1.45]">
          {r.agent.name} {r.agentVersion} · {stamp(r.startedAt)} → {stamp(r.completedAt)}
        </p>
      </div>
      <button
        type="button"
        onClick={() =>
          say(`Verification opens ${r.signature.verifyUrl} — it does not go through AiKi.`)
        }
        className="bg-ink-app hover:bg-orange-app h-[38px] flex-none rounded-xl border-0 px-4 text-[13.5px] font-bold text-white transition-colors"
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
          note="Every action, including the one that was refused. A receipt listing only what succeeded would be a brochure."
        >
          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
            {r.actions.map((a) => (
              <div
                key={a.at}
                className="flex items-start gap-3 border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[13px] first:border-t-0"
              >
                <span
                  className="mt-[6px] size-[7px] flex-none rounded-full"
                  style={{
                    background:
                      a.policyDecision === 'deny' ? 'var(--color-work)' : 'var(--color-good)',
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className="block text-[13.5px] font-semibold text-pretty"
                    style={{
                      color:
                        a.policyDecision === 'deny'
                          ? 'var(--color-work-ink)'
                          : 'var(--color-ink-app)',
                    }}
                  >
                    {a.type}
                  </span>
                  <span className="text-muted mt-[4px] flex flex-wrap items-center gap-x-[12px] gap-y-[2px] text-[11.5px]">
                    <span className="tabular-nums">{stamp(a.at)}</span>
                    {a.txHash ? (
                      <Mono>{a.txHash}</Mono>
                    ) : (
                      <span>never signed, never broadcast</span>
                    )}
                    {a.gas ? <span>gas ${a.gas.displayUsd}</span> : null}
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
            <Line label="The agent">
              ${r.cost.provider.displayUsd} · {r.cost.provider.asset}
            </Line>
            <Line label="AiKi">
              ${r.cost.platform.displayUsd} · {r.cost.platform.asset}
            </Line>
            <Line label="The network">
              ${r.cost.network.displayUsd} · {r.cost.network.asset} gas
            </Line>
            <div className="flex items-baseline justify-between border-t-[1.5px] border-[rgb(26_26_25_/_0.1)] px-4 py-[13px]">
              <span className="text-[13px] font-bold">Total</span>
              <span className="text-[16px] font-extrabold tabular-nums">
                ${r.cost.total.displayUsd}
              </span>
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
            <Line label="Authorisation">{r.authorizationId}</Line>
            <Line label="Agent identity">
              ERC-8004 token {r.agent.agentId} on BNB Chain · <Mono>{r.agent.registry}</Mono>
            </Line>
            <Line label="Agent version">{r.agentVersion}</Line>
          </div>
        </Section>

        {r.output ? (
          <Section
            title="What came of it"
            note="The outcome, and the hash of the record behind it."
          >
            <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
              <Line label="Result">{r.output.summary}</Line>
              <Line label="Evidence">
                <Mono>{r.output.artifactHash}</Mono>
              </Line>
              {r.evaluation ? (
                <Line label="Checked by">
                  {r.evaluation.evaluator} {r.evaluation.evaluatorVersion} — {r.evaluation.status}
                </Line>
              ) : null}
              {r.settlement ? (
                <Line label="Paid">
                  ${r.settlement.amount.displayUsd}, {r.settlement.status} ·{' '}
                  <Mono>{r.settlement.txHash}</Mono>
                </Line>
              ) : null}
            </div>
          </Section>
        ) : null}

        <Section
          title="Check it without us"
          note="Signed with a standard algorithm in a standard format, so verification never has to go through AiKi. Anyone can check this, including someone who thinks we are lying."
        >
          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
            <Line label="Algorithm">{r.signature.alg} · COSE receipt, SCITT profile</Line>
            <Line label="Signature">
              <Mono>{r.signature.value}</Mono>
            </Line>
            <Line label="Verify at">
              <span className="font-semibold">{r.signature.verifyUrl}</span>
            </Line>
          </div>
        </Section>
      </div>
    </PageCard>
  )
}
