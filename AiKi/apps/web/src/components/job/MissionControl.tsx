'use client'

import type { JobEvent } from '@aiki/contracts'
import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { PageCard } from '@/components/shell/PageCard'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SpendMeter } from '@/components/ui/SpendMeter'
import { StatusPill } from '@/components/ui/StatusPill'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENT_BY_KEY } from '@/lib/agents'
import { JOB, JOB_EVENTS } from '@/lib/job'
import { receiptHref } from '@/lib/routes'
import { EventStream } from './EventStream'

type Approval = Extract<JobEvent, { type: 'approval_required' }>

export function MissionControl() {
  const row = AGENT_BY_KEY[JOB.agentKey]
  const say = useToast()
  const router = useRouter()

  const [approval, setApproval] = useState<Approval | null>(null)
  const [paused, setPaused] = useState(false)
  const [revoking, setRevoking] = useState(false)

  const onApproval = useCallback((e: Approval) => setApproval(e), [])

  const header = (
    <div className="flex flex-wrap items-start gap-[14px]">
      <span
        className="flex size-[52px] flex-none items-center justify-center rounded-[16px] text-[20px] font-extrabold text-white"
        style={{ background: AGENT_BG[JOB.agentKey] }}
      >
        {row.initial}
      </span>
      <div className="min-w-0 flex-1 basis-[240px]">
        <div className="flex items-center gap-[10px]">
          <span className="text-[19px] font-extrabold tracking-[-0.02em]">
            {row.name} is working
          </span>
          <StatusPill
            label={paused ? 'Paused by you' : 'Running'}
            tone={paused ? 'idle' : 'work'}
          />
        </div>
        <p className="text-muted mt-[3px] mb-0 text-[13px] leading-[1.45]">
          {JOB.title} · {JOB.jobId}
        </p>
      </div>
      <div className="flex w-full flex-none gap-[6px] sm:w-auto">
        <button
          type="button"
          onClick={() => {
            setPaused((p) => !p)
            say(paused ? `${row.name} resumed.` : `${row.name} is paused. It stops within seconds.`)
          }}
          className="text-ink-app h-[42px] flex-1 rounded-xl border-0 bg-[rgb(26_26_25_/_0.055)] px-4 text-[13.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)] sm:h-[38px] sm:flex-none"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={() =>
            say('Revoking sends a transaction. It costs gas, and it cannot be undone.')
          }
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
      {/* An approval blocks the top of the page rather than sitting in a toast.
          It has a deadline, and a missed deadline is a missed action. */}
      {approval ? (
        <div className="mb-[18px] rounded-[18px] border-[1.5px] border-[var(--color-warn)] bg-[var(--color-warn-bg)] px-[18px] py-4">
          <div className="flex flex-wrap items-start gap-3">
            <span className="bg-warn mt-px flex size-[22px] flex-none items-center justify-center rounded-[8px] text-[12px] font-extrabold text-white">
              ?
            </span>
            <div className="min-w-0 flex-1 basis-[240px]">
              <div className="text-[14px] font-bold text-[#6B5A34]">{approval.prompt}</div>
              <div className="mt-[4px] text-[12.5px] text-[#6B5A34]">
                ${approval.amount.displayUsd} · expires{' '}
                {new Date(approval.expiresAt).toLocaleTimeString('en-GB', {
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
                  setApproval(null)
                  say('Declined. Nothing was spent.')
                }}
                className="text-ink-app h-10 flex-1 rounded-[11px] border-0 bg-white px-[14px] text-[13px] font-bold sm:h-9 sm:flex-none"
              >
                No
              </button>
              <button
                type="button"
                onClick={() => {
                  setApproval(null)
                  say('Approved. Guardian is repaying now.')
                }}
                className="bg-ink-app h-10 flex-1 rounded-[11px] border-0 px-[14px] text-[13px] font-bold text-white sm:h-9 sm:flex-none"
              >
                Go ahead
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${row.name}?`}
          body="This sends a transaction that removes the authority from the chain. It costs gas, it cannot be undone, and this job stops where it is."
          alternative="If you only want it to stop for now, pause instead — instant, free, and reversible."
          alternativeLabel="Pause instead"
          confirmLabel="Revoke on chain"
          onCancel={() => setRevoking(false)}
          onAlternative={() => {
            setRevoking(false)
            setPaused(true)
            say(`${row.name} paused. It stops within seconds.`)
          }}
          onConfirm={() => {
            setRevoking(false)
            say(`Sign the transaction to revoke ${row.name}.`)
          }}
        />
      ) : null}

      <div className="grid gap-[18px] xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[14px]">
          <div className="mb-[6px] flex items-baseline gap-[9px]">
            <span className="text-[14.5px] font-bold">Everything it did</span>
            <span className="text-muted text-[12.5px] font-semibold">
              as it happened, nothing summarised away
            </span>
          </div>
          <EventStream events={JOB_EVENTS} onApproval={onApproval} />
        </div>

        <div className="flex flex-col gap-[14px] xl:sticky xl:top-0 xl:self-start">
          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] p-[18px]">
            <div className="text-muted text-[12.5px] font-semibold">Spent this month</div>
            <div className="mt-[10px]">
              <SpendMeter value={JOB.spent.value} cap={JOB.spent.cap} pct={JOB.spent.pct} hot />
            </div>
            <div className="text-muted mt-[14px] border-t border-[rgb(26_26_25_/_0.07)] pt-[12px] text-[12.5px] leading-[1.5] text-pretty">
              Renewing cap. It refills on the 1st, and the chain holds it — not us.
            </div>
          </div>

          <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] p-[18px]">
            <div className="text-muted text-[12.5px] font-semibold">What happens next</div>
            <p className="mt-[7px] mb-0 text-[13.5px] leading-[1.45] font-semibold text-pretty">
              {paused ? 'Nothing. You paused it.' : JOB.nextTrigger}
            </p>
            <div className="text-muted mt-[12px] border-t border-[rgb(26_26_25_/_0.07)] pt-[12px] text-[12.5px] leading-[1.5]">
              Never more than {JOB.perAction} in one action. Stops for good on {JOB.stopsOn}.
            </div>
          </div>

          <button
            type="button"
            onClick={() => router.push(receiptHref(JOB.receiptId))}
            className="text-ink-app h-[42px] rounded-xl border border-[rgb(26_26_25_/_0.08)] bg-none text-[13.5px] font-bold hover:bg-[rgb(26_26_25_/_0.04)]"
          >
            Open the receipt →
          </button>
        </div>
      </div>
    </PageCard>
  )
}
