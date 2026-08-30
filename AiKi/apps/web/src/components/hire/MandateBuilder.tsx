'use client'

import type { CapPeriod } from '@aiki/contracts'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { PageCard } from '@/components/shell/PageCard'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENT_BY_KEY, type AgentKey } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'
import { jobHref } from '@/lib/routes'
import { useMock } from '@/mock/store'
import { mandateConstraints } from './mandate'
import { enforcementNote, limitFor, tierWording, useMandatePreview } from './useMandatePreview'

const PER_ACTION = [40, 80, 150] as const
const RENEWING = [120, 250, 500] as const
const DAYS = [30, 90, 365] as const

const PERIOD_LABEL: Record<CapPeriod, string> = {
  per_transaction: 'in one action',
  per_month: 'a month',
  per_year: 'a year',
  total: 'in total, ever',
}

const APPROVALS = [
  {
    key: 'automatic',
    label: 'Just do it',
    note: 'It acts inside these limits without asking. You are told after.',
  },
  {
    key: 'notify',
    label: 'Tell me each time',
    note: 'It acts, and you get a notification as it happens.',
  },
  {
    key: 'approve_above_threshold',
    label: 'Ask me over an amount',
    note: 'Small actions go through. Anything larger waits for you.',
  },
  {
    key: 'approve_every',
    label: 'Ask me every time',
    note: 'Nothing happens without you. Slower, and it may miss fast moves.',
  },
] as const

type Approval = (typeof APPROVALS)[number]['key']

/** A limit control. Its enforcement badge sits with it, not in a summary elsewhere. */
function Control({
  title,
  note,
  badge,
  children,
}: {
  title: string
  note: string
  badge: { word: string; weak: boolean; means: string; caveat?: string | undefined }
  children: React.ReactNode
}) {
  return (
    <div className="border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[15px] first:border-t-0">
      <div className="flex items-start gap-[11px]">
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-bold">{title}</span>
          <span className="text-muted mt-[2px] block text-[12.5px] leading-[1.5] text-pretty">
            {note}
          </span>
        </span>
        <span
          className="flex-none rounded-full px-[9px] py-[3px] text-[11px] font-bold"
          style={
            badge.weak
              ? { background: 'var(--color-warn-bg)', color: 'var(--color-warn-ink)' }
              : { background: 'rgb(26 26 25 / 0.05)', color: 'var(--color-muted)' }
          }
        >
          {badge.word}
        </span>
      </div>

      <div className="mt-[11px]">{children}</div>

      <div className="text-faint mt-[9px] text-[11.5px] leading-[1.45] text-pretty">
        {badge.means}
      </div>

      {badge.caveat ? (
        <div className="bg-warn-bg mt-[9px] flex items-start gap-[9px] rounded-[13px] px-3 py-[10px]">
          <span className="bg-warn mt-px flex size-[17px] flex-none items-center justify-center rounded-[6px] text-[10px] font-extrabold text-white">
            !
          </span>
          <span className="text-[12px] leading-[1.5] text-[#6B5A34]">{badge.caveat}</span>
        </div>
      ) : null}
    </div>
  )
}

function Choice<T extends string | number>({
  options,
  value,
  onChange,
  format,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  format: (v: T) => string
}) {
  return (
    <div className="flex flex-wrap gap-[6px]">
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          onClick={() => onChange(o)}
          className="h-[34px] rounded-[11px] border-0 px-[13px] text-[13px] transition-colors"
          style={
            o === value
              ? { background: 'var(--color-ink-app)', color: '#fff', fontWeight: 700 }
              : { background: 'rgb(26 26 25 / 0.055)', color: 'var(--color-body)', fontWeight: 600 }
          }
        >
          {format(o)}
        </button>
      ))}
    </div>
  )
}

export function MandateBuilder({ agentKey }: { agentKey: AgentKey }) {
  const row = AGENT_BY_KEY[agentKey]
  const d = DETAILS[agentKey]
  const say = useToast()
  const router = useRouter()
  const { hire } = useMock()

  const [perAction, setPerAction] = useState<number>(80)
  const [budget, setBudget] = useState<number>(250)
  const [period, setPeriod] = useState<CapPeriod>('per_month')
  const [days, setDays] = useState<number>(90)
  const [approval, setApproval] = useState<Approval>('approve_above_threshold')

  const spends = d.capabilities.some((c) => c.permissions.some((p) => p.startsWith('spend_')))

  /*
   * Every tier on this screen now comes from the API, which derives it against
   * its deployed enforcer set and overwrites the tier we sent. It used to come
   * from lib/detail.ts, a fixture file, which was harmless while nothing was
   * deployed and became a claim about enforcement the moment something was.
   *
   * The constraints previewed are built by the same function the hire sends, so
   * what is shown and what is created cannot drift apart.
   */
  const constraints = useMemo(
    () =>
      mandateConstraints({
        capCents: budget,
        perActionCents: spends ? perAction : 0,
        days,
        // From the agent, not from the person hiring: what it may move is a
        // description of the agent, and widening it is not a user's choice.
        spends: d.spends,
      }),
    [budget, perAction, days, spends, d.spends],
  )
  const preview = useMandatePreview(constraints)

  const perActionLimit = limitFor(preview, 'per_action_cap')
  const budgetLimit = limitFor(preview, 'session_total_cap')
  const expiryLimit = limitFor(preview, 'expiry')

  const perActionBadge = tierWording(preview, perActionLimit?.tier ?? null)
  const budgetBadge = tierWording(preview, budgetLimit?.tier ?? null)
  const expiryBadge = tierWording(preview, expiryLimit?.tier ?? null)
  // What the agent may call is now part of the mandate, so this badge is derived
  // like the others rather than asserted. It was the last one left hardcoded, and
  // it was understating: the chain does hold this list.
  const touchBadge = tierWording(preview, limitFor(preview, 'contract_allowlist')?.tier ?? null)
  // The allowlist is not one of the constraints this mandate sends at all, which
  // is exactly why the caps below can only ever be counted by AiKi. Saying so is
  // the point; inventing a tier for a limit we never send would not be.
  const overall = tierWording(preview, preview.status === 'ready' ? preview.enforcement.tier : null)
  const note = enforcementNote(preview)

  const stopsOn = new Date(Date.now() + days * 86_400_000)

  /*
   * This list said "only touches the contracts listed on its passport", directly
   * under a badge saying the mandate does not tell the chain which contracts the
   * agent may call. Both cannot be true, and the badge is the one derived from
   * what is actually sent. A summary that flatters the mandate is worse than no
   * summary, because it is read as the plain-language version of the badges.
   */
  const summary = [
    spends ? `At most $${perAction} in one action` : 'Cannot spend anything at all',
    spends ? `At most $${budget} ${PERIOD_LABEL[period]}` : null,
    `Stops on ${stopsOn.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`,
    APPROVALS.find((a) => a.key === approval)?.label,
  ].filter(Boolean) as string[]

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <span
        className="flex size-[52px] flex-none items-center justify-center rounded-[16px] text-[20px] font-extrabold text-white"
        style={{ background: AGENT_BG[agentKey] }}
      >
        {row.initial}
      </span>
      <div className="min-w-0 flex-1 basis-[240px]">
        <span className="block text-[19px] font-extrabold tracking-[-0.02em]">
          Give {row.name} exactly enough power
        </span>
        <p className="text-muted mt-[3px] mb-0 max-w-[620px] text-[13px] leading-[1.45] text-pretty">
          Nothing here is a suggestion to the agent. Each limit below is a rule, and the badge
          beside it says who holds that rule.
        </p>
      </div>
      <span className="w-full flex-none text-left sm:w-auto sm:text-right">
        <span className="block text-[15px] font-extrabold tabular-nums">{row.price}</span>
        <span className="text-muted mt-px block text-[11.5px] font-medium">{d.priceModel}</span>
      </span>
    </div>
  )

  return (
    <PageCard
      title={`Hire ${row.name}`}
      count=""
      back={{ href: `/agent/${agentKey}`, label: row.name }}
      headerSlot={header}
      tabs={[]}
      tabHint=""
    >
      <div className="grid gap-[18px] xl:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
          <Control
            title="What it may touch"
            note={`Set by what ${row.name} can do. It cannot be widened, by you or by the agent.`}
            badge={{
              word: touchBadge.word,
              weak: touchBadge.weak,
              means: touchBadge.means,
            }}
          >
            <div className="flex flex-wrap gap-[6px]">
              {d.capabilities
                .flatMap((c) => c.permissions)
                .map((p) => (
                  <span
                    key={p}
                    className="text-muted rounded-full bg-[rgb(26_26_25_/_0.05)] px-[9px] py-[4px] font-mono text-[11px] font-semibold"
                  >
                    {p}
                  </span>
                ))}
            </div>
          </Control>

          {spends ? (
            <>
              <Control
                title="Most it can spend in one action"
                note="A single transaction larger than this is refused."
                badge={{
                  word: perActionBadge.word,
                  weak: perActionBadge.weak,
                  means: perActionBadge.means,
                }}
              >
                <Choice
                  options={PER_ACTION}
                  value={perAction}
                  onChange={setPerAction}
                  format={(v) => `$${v}`}
                />
              </Control>

              <Control
                title="Most it can spend altogether"
                /*
                 * Both branches say the same thing on purpose, because today
                 * both behave the same way. Nothing resets a cap: the constraint
                 * carries no period, evaluatePolicy has no reset, and
                 * SessionTotalCapEnforcer counts for the life of the mandate.
                 * Telling somebody their cap refills next month and then
                 * stopping their agent forever is the kind of surprise this
                 * product exists to not produce.
                 */
                note={
                  period === 'total'
                    ? 'A lifetime cap. It does not refill, so when it is gone the agent stops.'
                    : 'Nothing refills a cap yet, so this behaves as a total: when it is gone the agent stops until you raise it.'
                }
                badge={{
                  word: budgetBadge.word,
                  weak: budgetBadge.weak,
                  means: budgetBadge.means,
                }}
              >
                <Choice
                  options={RENEWING}
                  value={budget}
                  onChange={setBudget}
                  format={(v) => `$${v}`}
                />
                <div className="mt-[9px]">
                  <Choice
                    options={['per_month', 'per_year', 'total'] as const}
                    value={period}
                    onChange={setPeriod}
                    format={(v) =>
                      v === 'per_month' ? 'a month' : v === 'per_year' ? 'a year' : 'in total, ever'
                    }
                  />
                </div>
              </Control>
            </>
          ) : (
            <div className="border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[15px]">
              <div className="text-[13.5px] font-bold">It cannot spend</div>
              <div className="text-muted mt-[2px] text-[12.5px] leading-[1.5]">
                {row.name} is never issued a session key, so there is no spending limit to set. That
                is the strongest limit on this page.
              </div>
            </div>
          )}

          <Control
            title="When it stops"
            note="The authority expires on its own. You never have to remember to revoke it."
            badge={{
              word: expiryBadge.word,
              weak: expiryBadge.weak,
              means: expiryBadge.means,
            }}
          >
            <Choice
              options={DAYS}
              value={days}
              onChange={setDays}
              format={(v) => (v === 365 ? 'a year' : `${v} days`)}
            />
            <div className="text-muted mt-[9px] text-[12.5px] font-semibold">
              Stops on{' '}
              {stopsOn.toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </div>
          </Control>

          <Control
            title="When it should ask you"
            note="Approval is a speed choice, not a safety one. The limits above hold either way."
            badge={{
              word: 'AiKi',
              weak: false,
              means: 'AiKi holds the action and asks you before relaying it.',
              // Kept, because it changes what someone should expect: this is the
              // one control whose failure mode is a delay rather than a refusal.
              caveat:
                'Approval prompts are delivered by AiKi. If AiKi is down, the action waits rather than proceeding.',
            }}
          >
            <div className="flex flex-col gap-[6px]">
              {APPROVALS.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => setApproval(a.key)}
                  className="flex items-start gap-[10px] rounded-[13px] border-0 px-3 py-[10px] text-left transition-colors"
                  style={{
                    background: approval === a.key ? 'rgb(26 26 25 / 0.055)' : 'transparent',
                  }}
                >
                  <span
                    className="mt-[3px] flex size-[15px] flex-none items-center justify-center rounded-full border-[1.5px]"
                    style={{
                      borderColor:
                        approval === a.key ? 'var(--color-ink-app)' : 'rgb(26 26 25 / 0.2)',
                    }}
                  >
                    {approval === a.key ? (
                      <span className="bg-ink-app size-[7px] rounded-full" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">{a.label}</span>
                    <span className="text-muted mt-px block text-[12px] leading-[1.45] text-pretty">
                      {a.note}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </Control>
        </div>

        {/* The summary leads with the weakest link, because that is the honest
            headline — an average would let three strong limits hide a soft one. */}
        <div className="xl:sticky xl:top-0 xl:self-start">
          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] p-[18px]">
            <div className="text-muted text-[12.5px] font-semibold">
              Weakest link in this mandate
            </div>
            <div className="mt-[6px] flex items-baseline gap-[9px]">
              <span
                className="text-[26px] font-extrabold tracking-[-0.02em]"
                style={{
                  color: overall.weak ? 'var(--color-warn-ink)' : 'var(--color-ink-app)',
                }}
              >
                {overall.word}
              </span>
              <span className="text-faint text-[12px] font-semibold">holds it</span>
            </div>
            <p className="text-muted mt-[8px] mb-0 text-[12.5px] leading-[1.5] text-pretty">
              {overall.means}
            </p>
            {note ? (
              <p className="text-faint mt-[8px] mb-0 text-[12px] leading-[1.5] text-pretty">
                {note}
              </p>
            ) : null}

            <div className="mt-[16px] border-t border-[rgb(26_26_25_/_0.07)] pt-[14px]">
              <div className="text-muted text-[12.5px] font-semibold">What you are granting</div>
              <ul className="mt-[9px] mb-0 flex list-none flex-col gap-[7px] p-0">
                {summary.map((line) => (
                  <li key={line} className="flex items-start gap-[9px] text-[13px] leading-[1.45]">
                    <span className="bg-orange-app mt-[6px] size-[5px] flex-none rounded-full" />
                    <span className="text-pretty">{line}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-[16px] flex items-baseline justify-between border-t border-[rgb(26_26_25_/_0.07)] pt-[14px]">
              <span className="text-muted text-[12.5px] font-semibold">Charged</span>
              <span className="text-[14px] font-extrabold tabular-nums">{row.price}</span>
            </div>

            <button
              type="button"
              onClick={() => {
                // The limits you just set are the ones the job runs under, so
                // the refusal you are about to see happens at YOUR number.
                void hire({
                  key: agentKey,
                  perActionCents: spends ? perAction * 100 : 0,
                  capCents: budget * 100,
                  period,
                  days,
                  approval,
                })
                  .then(({ jobId, mandate }) => {
                    // Which of the two happened is the difference between a
                    // limit a contract refuses to exceed and one AiKi counts, so
                    // it is said rather than assumed.
                    say(
                      mandate === 'signed'
                        ? `${row.name} is hired. The chain holds your limits.`
                        : `${row.name} is hired. AiKi holds your limits.`,
                    )
                    router.push(jobHref(jobId))
                  })
                  .catch(() => {
                    // Recording the mandate is what makes it a mandate. If that
                    // failed, saying "hired" would be the lie the whole product
                    // exists to avoid.
                    say('Could not record that mandate, so nothing was hired. Try again.')
                  })
              }}
              className="bg-ink-app hover:bg-orange-app mt-[16px] h-[42px] w-full rounded-xl border-0 text-[13.5px] font-bold text-white transition-colors"
            >
              Sign and hire {row.name}
            </button>
            <p className="text-faint mt-[10px] mb-0 text-[11.5px] leading-[1.45] text-pretty">
              One signature. Pausing afterwards is instant and free; revoking sends a transaction
              and costs gas.
            </p>
          </div>
        </div>
      </div>
    </PageCard>
  )
}
