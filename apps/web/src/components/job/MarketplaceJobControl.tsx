'use client'

import { PageCard } from '@/components/shell/PageCard'
import { StatusPill, type Tone } from '@/components/ui/StatusPill'
import type { MarketplaceJob } from '@/lib/api'

const short = (value: string) =>
  value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value

const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

const tokenAmount = (baseUnits: string, decimals: number): string => {
  const negative = baseUnits.startsWith('-')
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits
    .slice(digits.length - decimals)
    .replace(/0+$/, '')
    .slice(0, 6)
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

const titleCase = (value: string) =>
  value
    .split('_')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ')

const actionCopy: Record<MarketplaceJob['nextAction'], string> = {
  CREATE_ESCROW: 'Create escrow',
  WAIT_FOR_FUNDING: 'Waiting for funding',
  START_WORK: 'Provider can start',
  SUBMIT_WORK: 'Provider can submit',
  WAIT_FOR_ONCHAIN_SUBMISSION: 'Waiting for on-chain submit',
  WAIT_FOR_REVIEW: 'Ready for review',
  REVISE_WORK: 'Needs changes',
  RELEASE_PAYMENT: 'Release payment',
  VIEW_RECEIPT: 'View receipt',
}

const statusTone = (job: MarketplaceJob): Tone => {
  if (job.settlementState === 'RELEASED') return 'good'
  if (
    job.settlementState === 'FUNDING_SUBMITTED' ||
    job.settlementState === 'RELEASE_SUBMITTED' ||
    job.nextAction === 'WAIT_FOR_ONCHAIN_SUBMISSION'
  )
    return 'warn'
  if (job.workState === 'IN_PROGRESS' || job.workState === 'SUBMITTED') return 'work'
  return 'idle'
}

const steps = [
  { key: 'CREATE_ESCROW', label: 'Escrow' },
  { key: 'FUNDED', label: 'Funded' },
  { key: 'SUBMITTED', label: 'Work in' },
  { key: 'DELIVERABLE_SUBMITTED', label: 'On-chain' },
  { key: 'ACCEPTED', label: 'Accepted' },
  { key: 'RELEASED', label: 'Paid' },
] as const

const stepDone = (job: MarketplaceJob, key: (typeof steps)[number]['key']) => {
  switch (key) {
    case 'CREATE_ESCROW':
      return job.fundingOperation.status !== 'REQUESTED'
    case 'FUNDED':
      return [
        'FUNDED',
        'DELIVERABLE_SUBMITTED',
        'RELEASE_SUBMITTED',
        'RELEASED',
        'REFUND_SUBMITTED',
        'REFUNDED',
      ].includes(job.settlementState)
    case 'SUBMITTED':
      return ['SUBMITTED', 'CHANGES_REQUESTED', 'ACCEPTED'].includes(job.workState)
    case 'DELIVERABLE_SUBMITTED':
      return ['DELIVERABLE_SUBMITTED', 'RELEASE_SUBMITTED', 'RELEASED'].includes(
        job.settlementState,
      )
    case 'ACCEPTED':
      return job.workState === 'ACCEPTED'
    case 'RELEASED':
      return job.settlementState === 'RELEASED'
  }
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[16px] border border-[rgb(26_26_25_/_0.08)] bg-white px-[14px] py-[12px]">
      <div className="text-faint text-[11px] font-bold tracking-[0.06em] uppercase">{label}</div>
      <div className="mt-[5px] min-w-0 text-[13px] leading-[1.45] font-semibold break-words">
        {children}
      </div>
    </div>
  )
}

function JsonBlock({ value }: { value: Record<string, unknown> }) {
  return (
    <pre className="mt-[8px] max-h-[190px] overflow-auto rounded-[14px] bg-[rgb(26_26_25_/_0.045)] p-[12px] text-[11.5px] leading-[1.55] whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function MarketplaceJobControl({ job }: { job: MarketplaceJob }) {
  const total = tokenAmount(job.settlement.totalAmount, job.settlement.decimals)
  const provider = tokenAmount(job.settlement.providerAmount, job.settlement.decimals)
  const fee = tokenAmount(job.settlement.platformFeeAmount, job.settlement.decimals)

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <span className="flex size-[52px] flex-none items-center justify-center rounded-[16px] bg-[linear-gradient(135deg,#ff5a00,#a855f7_55%,#3b82f6)] text-[20px] font-black text-white">
        Ai
      </span>
      <div className="min-w-0 flex-1 basis-[260px]">
        <div className="flex flex-wrap items-center gap-[10px]">
          <span className="text-[19px] font-extrabold tracking-[-0.02em]">{job.title}</span>
          <StatusPill label={actionCopy[job.nextAction]} tone={statusTone(job)} />
        </div>
        <p className="text-muted mt-[3px] mb-0 text-[13px] leading-[1.45]">
          Job {short(job.id)} · Agreement {short(job.agreementId)}
        </p>
      </div>
    </div>
  )

  return (
    <PageCard
      title="Job"
      count=""
      back={{ href: '/work', label: 'Work' }}
      headerSlot={header}
      tabs={[]}
      tabHint=""
    >
      <div className="grid gap-[16px] xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="rounded-[20px] border border-[rgb(26_26_25_/_0.08)] bg-[rgb(26_26_25_/_0.025)] p-[16px]">
          <div className="flex flex-wrap items-center justify-between gap-[10px]">
            <div>
              <h2 className="m-0 text-[15px] font-extrabold">Lifecycle</h2>
              <p className="text-muted mt-[4px] mb-0 text-[12.5px]">
                What the job can do next, based on stored chain evidence.
              </p>
            </div>
            <span className="rounded-full bg-white px-[11px] py-[6px] text-[12px] font-bold shadow-[0_1px_2px_rgb(26_26_25_/_0.07)]">
              {titleCase(job.settlementState)}
            </span>
          </div>

          <ol className="mt-[18px] grid list-none gap-[10px] p-0 md:grid-cols-6">
            {steps.map((step, index) => {
              const done = stepDone(job, step.key)
              return (
                <li key={step.key} className="relative">
                  <div
                    className={`rounded-[16px] border px-[12px] py-[11px] ${
                      done
                        ? 'border-transparent bg-[rgb(26_26_25_/_0.88)] text-white'
                        : 'border-[rgb(26_26_25_/_0.08)] bg-white text-[var(--color-muted)]'
                    }`}
                  >
                    <div className="text-[11px] font-bold tabular-nums opacity-70">
                      {String(index + 1).padStart(2, '0')}
                    </div>
                    <div className="mt-[3px] text-[12.5px] font-extrabold">{step.label}</div>
                  </div>
                </li>
              )
            })}
          </ol>
        </section>

        <aside className="rounded-[20px] border border-[rgb(26_26_25_/_0.08)] p-[16px]">
          <h2 className="m-0 text-[15px] font-extrabold">Money</h2>
          <div className="mt-[12px] grid gap-[9px]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted text-[12.5px] font-semibold">Provider</span>
              <span className="font-mono text-[13px]">{provider}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted text-[12.5px] font-semibold">AiKi fee</span>
              <span className="font-mono text-[13px]">{fee}</span>
            </div>
            <div className="mt-[2px] flex items-baseline justify-between gap-3 border-t border-[rgb(26_26_25_/_0.08)] pt-[10px]">
              <span className="text-[13px] font-extrabold">Total escrow</span>
              <span className="font-mono text-[15px] font-extrabold">{total}</span>
            </div>
          </div>
          <p className="text-faint mt-[10px] mb-0 text-[11.5px] leading-[1.45]">
            Token {short(job.settlement.token)} on chain {job.settlement.chainId}
          </p>
        </aside>

        <section className="grid gap-[12px] md:grid-cols-2 xl:col-span-2">
          <Fact label="Work state">{titleCase(job.workState)}</Fact>
          <Fact label="Payout state">{titleCase(job.payoutState)}</Fact>
          <Fact label="Funding operation">
            {titleCase(job.fundingOperation.status)} · {short(job.fundingOperation.id)}
          </Fact>
          <Fact label="Rail">
            {job.settlement.rail} v{job.settlement.railVersion}
          </Fact>
        </section>

        <section className="rounded-[20px] border border-[rgb(26_26_25_/_0.08)] p-[16px] xl:col-span-2">
          <h2 className="m-0 text-[15px] font-extrabold">Scope</h2>
          <p className="text-muted mt-[6px] mb-0 text-[13px] leading-[1.55] text-pretty">
            {job.scope.brief}
          </p>
          <div className="mt-[14px] grid gap-[12px] md:grid-cols-2">
            <div>
              <div className="text-[12.5px] font-bold">Requirements</div>
              <JsonBlock value={job.scope.requirements} />
            </div>
            <div>
              <div className="text-[12.5px] font-bold">Evidence</div>
              <JsonBlock value={job.scope.evidenceRequirements} />
            </div>
          </div>
          <div className="mt-[14px] rounded-[16px] bg-[rgb(26_26_25_/_0.045)] px-[14px] py-[12px]">
            <div className="text-faint text-[11px] font-bold tracking-[0.06em] uppercase">
              Done means
            </div>
            <p className="mt-[5px] mb-0 text-[13px] leading-[1.5] text-pretty">
              {job.scope.definitionOfDone}
            </p>
          </div>
        </section>

        <section className="grid gap-[12px] md:grid-cols-4 xl:col-span-2">
          <Fact label="Delivery">{stamp(job.deadlines.delivery)}</Fact>
          <Fact label="Review">{stamp(job.deadlines.review)}</Fact>
          <Fact label="Dispute">{stamp(job.deadlines.dispute)}</Fact>
          <Fact label="Hard expiry">{stamp(job.deadlines.hardExpiry)}</Fact>
        </section>
      </div>
    </PageCard>
  )
}
