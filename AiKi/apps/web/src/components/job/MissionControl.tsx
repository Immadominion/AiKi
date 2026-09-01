'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { OnChainRecord } from '@/components/job/OnChainRecord'
import { Settlement } from '@/components/job/Settlement'
import { WatchPanel } from '@/components/job/WatchPanel'
import { PageCard } from '@/components/shell/PageCard'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { PageSkeleton } from '@/components/ui/Skeleton'
import { SpendMeter } from '@/components/ui/SpendMeter'
import { StatusPill, type Tone } from '@/components/ui/StatusPill'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENT_BY_KEY, agentRow } from '@/lib/agents'
import { hiredRows } from '@/lib/present'
import { receiptHref, route } from '@/lib/routes'
import { useMock } from '@/mock/store'
import { usd } from '@/mock/types'
import { EventStream } from './EventStream'

const STATUS: Record<string, { label: string; tone: Tone }> = {
  RUNNING: { label: 'Working', tone: 'work' },
  WAITING: { label: 'Waiting on you', tone: 'warn' },
  PAUSED: { label: 'Paused by you', tone: 'idle' },
  DONE: { label: 'Finished', tone: 'good' },
}

export function MissionControl({ jobId }: { jobId: string }) {
  const { state, ready, advance, approve, decline, pause, resume, revoke } = useMock()
  const say = useToast()
  const router = useRouter()
  const [revoking, setRevoking] = useState(false)

  const job = state.jobs.find((j) => j.id === jobId)
  const hire = job ? state.hires.find((h) => h.key === job.key) : undefined

  /**
   * The job runs itself while you watch.
   *
   * Only while RUNNING — it stops dead at an approval and stays stopped, which
   * is the behaviour that matters: if you do nothing, nothing happens.
   */
  useEffect(() => {
    if (job?.status !== 'RUNNING') return
    const id = setTimeout(() => advance(job.id), 1400)
    return () => clearTimeout(id)
  }, [job, advance])

  if (!ready) return <PageSkeleton rows={5} />

  if (!job || !hire) {
    return (
      <PageCard
        title="Mission control"
        count=""
        back={{ href: '/agents', label: 'My agents' }}
        tabs={[]}
        tabHint=""
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[24px]">
          <div className="text-[14.5px] font-bold">This job is not running any more.</div>
          <p className="text-muted mt-[6px] mb-0 max-w-[560px] text-[13px] leading-[1.55] text-pretty">
            It either finished, or the authority behind it was revoked. Either way nothing is acting
            on your behalf under it now.
          </p>
          <button
            type="button"
            onClick={() => router.push(route('/activity'))}
            className="bg-ink-app hover:bg-orange-app mt-[16px] h-[38px] rounded-xl border-0 px-4 text-[13.5px] font-bold text-white transition-colors"
          >
            See what it did
          </button>
        </div>
      </PageCard>
    )
  }

  const agent = agentRow(job.key)
  const row = hiredRows([hire], state.jobs).at(0)
  const status = STATUS[job.status] ?? STATUS.RUNNING
  const events = state.events.filter((e) => e.jobId === job.id)
  const paused = job.status === 'PAUSED'

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <span
        className="flex size-[52px] flex-none items-center justify-center rounded-[16px] text-[20px] font-extrabold text-white"
        style={{ background: AGENT_BG[job.key] }}
      >
        {agent.initial}
      </span>
      <div className="min-w-0 flex-1 basis-[240px]">
        <div className="flex flex-wrap items-center gap-[10px]">
          <span className="text-[19px] font-extrabold tracking-[-0.02em]">
            {agent.name} {job.status === 'DONE' ? 'is done' : 'is working'}
          </span>
          <StatusPill label={status?.label ?? 'Working'} tone={status?.tone ?? 'work'} />
        </div>
        <p className="text-muted mt-[3px] mb-0 text-[13px] leading-[1.45]">
          {job.title} · {job.id}
        </p>
      </div>
      <div className="flex w-full flex-none gap-[6px] sm:w-auto">
        <button
          type="button"
          disabled={job.status === 'DONE'}
          onClick={() => {
            if (paused) {
              resume(job.key)
              say(`${agent.name} resumed under the same limits.`)
            } else {
              pause(job.key)
              say(`${agent.name} paused. It stops within seconds and it costs nothing.`)
            }
          }}
          className="text-ink-app h-[42px] flex-1 rounded-xl border-0 bg-[rgb(26_26_25_/_0.055)] px-4 text-[13.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] disabled:opacity-40 sm:h-[38px] sm:flex-none"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={() => setRevoking(true)}
          className="bg-ink-app hover:bg-orange-app h-[42px] flex-1 rounded-xl border-0 px-4 text-[13.5px] font-bold text-white transition-colors sm:h-[38px] sm:flex-none"
        >
          Revoke
        </button>
      </div>
    </div>
  )

  return (
    <PageCard
      title="Mission control"
      count=""
      back={{ href: '/agents', label: 'My agents' }}
      headerSlot={header}
      tabs={[]}
      tabHint=""
    >
      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${agent.name}?`}
          body="This withdraws the authority at AiKi. It cannot be undone and this job stops where it is. It does not yet send a transaction: the enforcer contracts are written and tested but not deployed."
          alternative="If you only want it to stop for now, pause instead. That is instant, free, and reversible."
          alternativeLabel="Pause instead"
          confirmLabel="Withdraw authority"
          onCancel={() => setRevoking(false)}
          onAlternative={() => {
            setRevoking(false)
            pause(job.key)
            say(`${agent.name} paused. It stops within seconds.`)
          }}
          onConfirm={() => {
            setRevoking(false)
            revoke(job.key)
            say(`${agent.name} withdrawn. AiKi will not relay for it again.`)
            router.push(route('/agents'))
          }}
        />
      ) : null}

      {/* An approval blocks the top of the page rather than sitting in a toast.
          It has a deadline, and a missed deadline is a missed action. */}
      {job.approval ? (
        <div className="mb-[18px] rounded-[18px] border-[1.5px] border-[var(--color-warn)] bg-[var(--color-warn-bg)] px-[18px] py-4">
          <div className="flex flex-wrap items-start gap-3">
            <span className="bg-warn mt-px flex size-[22px] flex-none items-center justify-center rounded-[8px] text-[12px] font-extrabold text-white">
              ?
            </span>
            <div className="min-w-0 flex-1 basis-[240px]">
              <div className="text-[14px] font-bold text-[#6B5A34]">{job.approval.prompt}</div>
              <div className="mt-[4px] text-[12.5px] text-[#6B5A34]">
                {usd(job.approval.amountCents)} · expires{' '}
                {new Date(job.approval.expiresAt).toLocaleTimeString('en-GB', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                . If you do nothing, it does nothing.
              </div>
            </div>
            <div className="flex w-full flex-none gap-[6px] sm:w-auto">
              <button
                type="button"
                onClick={() => {
                  decline(job.id)
                  say('Declined. Nothing was signed and nothing was spent.')
                }}
                className="text-ink-app h-10 flex-1 rounded-[11px] border-0 bg-white px-[14px] text-[13px] font-bold sm:h-9 sm:flex-none"
              >
                No
              </button>
              <button
                type="button"
                onClick={() => {
                  approve(job.id)
                  say(`Approved. ${agent.name} is acting now.`)
                }}
                className="bg-ink-app h-10 flex-1 rounded-[11px] border-0 px-[14px] text-[13px] font-bold text-white sm:h-9 sm:flex-none"
              >
                Go ahead
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-[18px] xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[14px]">
          <div className="mb-[6px] flex flex-wrap items-baseline gap-[9px]">
            <span className="text-[14.5px] font-bold">Everything it did</span>
            <span className="text-muted text-[12.5px] font-semibold">
              as it happened, nothing summarised away
            </span>
          </div>
          <EventStream events={events} live={job.status === 'RUNNING'} />
          <WatchPanel jobId={job.id} />
          <OnChainRecord jobId={job.id} />
        </div>

        <div className="flex flex-col gap-[14px] xl:sticky xl:top-0 xl:self-start">
          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] p-[18px]">
            <div className="text-muted text-[12.5px] font-semibold">Spent against your cap</div>
            <div className="mt-[10px]">
              <SpendMeter
                value={row?.spent ?? usd(0)}
                cap={row?.cap ?? usd(hire.mandate.capCents)}
                pct={row?.pct ?? '0%'}
                hot={row?.hot ?? false}
              />
            </div>
            <div className="text-muted mt-[14px] border-t border-[rgb(26_26_25_/_0.07)] pt-[12px] text-[12.5px] leading-[1.5] text-pretty">
              {/* Not "a renewing cap, held by the chain": nothing renews it, and
                  claiming the chain holds a reset it cannot express is the one
                  kind of claim this product may not make. */}
              A cap for the life of this mandate. It does not refill, so when it is gone the agent
              stops until you raise it.
            </div>
          </div>

          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] p-[18px]">
            <div className="text-muted text-[12.5px] font-semibold">What happens next</div>
            <p className="mt-[7px] mb-0 text-[13.5px] leading-[1.45] font-semibold text-pretty">
              {paused
                ? 'Nothing. You paused it.'
                : job.status === 'DONE'
                  ? 'Nothing more on this job. It finished.'
                  : job.approval
                    ? 'It is waiting for your answer above.'
                    : 'Working through the next step.'}
            </p>
            <div className="text-muted mt-[12px] border-t border-[rgb(26_26_25_/_0.07)] pt-[12px] text-[12.5px] leading-[1.5]">
              Never more than {usd(hire.mandate.perActionCents)} in one action. Stops for good on{' '}
              {new Date(hire.mandate.expiresAt).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
              .
            </div>
          </div>

          <Settlement jobId={job.id} agentId={job.key} />

          {job.receiptId ? (
            <button
              type="button"
              onClick={() => router.push(receiptHref(job.receiptId as string))}
              className="bg-ink-app hover:bg-orange-app h-[42px] rounded-xl border-0 text-[13.5px] font-bold text-white transition-colors"
            >
              Open the receipt →
            </button>
          ) : (
            <div className="text-faint rounded-[18px] border border-dashed border-[rgb(26_26_25_/_0.12)] px-[18px] py-[14px] text-[12.5px] leading-[1.5] text-pretty">
              A signed receipt appears here when this job finishes. It will include the action your
              limits refused.
            </div>
          )}
        </div>
      </div>
    </PageCard>
  )
}
