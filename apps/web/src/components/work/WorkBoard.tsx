'use client'

import { ArrowUpRight, Check, ChevronDown, ClipboardList, Clock3, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FastMessage } from '@/components/home/FastMessage'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount } from '@/components/shell/prefs'
import { AgentAvatar, UserAvatar } from '@/components/ui/Avatar'
import { useToast } from '@/components/ui/Toast'
import { api, type TaskSummary } from '@/lib/api'
import { briefText } from '@/lib/identity'
import { CONNECT_TOAST, shortAddress } from '@/lib/wallet'
import {
  deadlinePassed,
  filterWork,
  isPoster,
  relativeDeadline,
  WORK_STATUS,
  type WorkFilter,
  type WorkPeriod,
} from './work-presentation'

const secondary =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-black/10 bg-white px-3 text-[12px] font-semibold transition-colors hover:bg-black/5 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app'
const primary =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-ink-app px-4 text-[12px] font-bold text-white transition-colors hover:bg-orange-app disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app'

export function WorkCard({
  task,
  owner,
  openJob,
  busy,
  selected,
  onAction,
  onConnect,
}: {
  task: TaskSummary
  owner: string | null
  openJob?: boolean
  busy: boolean
  selected: boolean
  onAction: (run: () => Promise<unknown>, done: string) => void
  onConnect: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirm, setConfirm] = useState<'accept' | 'decline' | 'claim' | null>(null)
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (task.status !== 'OPEN' && task.status !== 'SUBMITTED') setConfirm(null)
  }, [task.status])
  const posted = isPoster(task, owner)
  const claimant = Boolean(owner && task.claimedBy?.toLowerCase() === owner.toLowerCase())
  const inReview = task.status === 'SUBMITTED'
  const deadline =
    task.status === 'CLAIMED' ? task.claimExpiresAt : inReview ? task.reviewExpiresAt : undefined
  const statusTone =
    task.status === 'SETTLED'
      ? 'bg-good-bg text-good'
      : inReview
        ? 'bg-work-bg text-orange-app'
        : 'bg-surface-sunk text-muted'

  return (
    <li
      id={`task-${task.id}`}
      tabIndex={-1}
      className={`min-w-0 rounded-[18px] border bg-white p-4 outline-offset-4 md:p-5 ${selected ? 'border-orange-app/40 ring-2 ring-orange-app/10' : 'border-black/[.08]'}`}
    >
      <div className="flex items-start gap-3">
        {task.assignedAgentId ? (
          <AgentAvatar
            identity={task.assignedAgentId}
            name={`Agent ${task.assignedAgentId}`}
            size={42}
          />
        ) : (
          <UserAvatar address={task.claimedBy ?? task.poster} size={42} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <h2 className="m-0 min-w-0 text-[14px] leading-snug font-bold [overflow-wrap:anywhere]">
              {task.title}
            </h2>
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-semibold ${statusTone}`}
            >
              {task.status === 'SETTLED' ? <Check size={12} aria-hidden /> : null}
              {openJob ? 'Open job' : WORK_STATUS[task.status]}
            </span>
          </div>
          <p className="text-muted mt-1 mb-0 text-[11.5px]">
            {task.assignedAgentId
              ? `Agent #${task.assignedAgentId}`
              : posted
                ? 'Posted by you'
                : `From ${shortAddress(task.poster)}`}
            <span aria-hidden> · </span>
            {new Date(task.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </p>
        </div>
      </div>
      {task.submission ? (
        <div className="mt-3 rounded-xl bg-surface-sunk px-3.5 py-3">
          <p className="text-muted m-0 text-[10.5px] font-semibold">Delivery</p>
          <p className="mt-1 mb-0 text-[12.5px] leading-relaxed [overflow-wrap:anywhere]">
            {briefText(task.submission, 210)}
          </p>
        </div>
      ) : (
        <p className="text-muted mt-3 mb-0 text-[12.5px] leading-relaxed [overflow-wrap:anywhere]">
          {briefText(task.brief, 170)}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px]">
        <span className="font-semibold tabular-nums">
          {task.pricePoints.toLocaleString()} points{' '}
          <span className="text-muted font-normal">
            {task.status === 'SETTLED' ? 'paid' : 'reward'}
          </span>
        </span>
        {deadline ? (
          <span className="text-muted inline-flex items-center gap-1.5">
            <Clock3 size={12} aria-hidden />
            {relativeDeadline(deadline)}
          </span>
        ) : openJob ? (
          <span className="text-muted">{task.workHours}h to deliver</span>
        ) : null}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`details-${task.id}`}
          onClick={() => setExpanded((value) => !value)}
          className="text-muted hover:text-ink-app ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-orange-app"
        >
          {expanded ? 'Less detail' : 'View details'}
          <ChevronDown size={14} aria-hidden className={expanded ? 'rotate-180' : ''} />
        </button>
      </div>
      {expanded ? (
        <div id={`details-${task.id}`} className="mt-2 space-y-4 border-t border-black/[.07] pt-4">
          <section>
            <h3 className="text-muted mt-0 mb-2 text-[11px] font-semibold">Job brief</h3>
            <FastMessage text={task.brief} />
            <OriginalText label="Original brief" text={task.brief} />
          </section>
          {task.submission ? (
            <section>
              <h3 className="text-muted mt-0 mb-2 text-[11px] font-semibold">Full delivery</h3>
              <FastMessage text={task.submission} />
              <OriginalText label="Original delivery" text={task.submission} />
            </section>
          ) : null}
          {task.dispatchNote ? (
            <p className="text-muted m-0 text-[12px] leading-relaxed">{task.dispatchNote}</p>
          ) : null}
          <dl className="m-0 grid gap-2 text-[11.5px] sm:grid-cols-2">
            <div>
              <dt className="text-muted">Posted by</dt>
              <dd className="m-0 break-all font-mono">{task.poster}</dd>
            </div>
            <div>
              <dt className="text-muted">Payment</dt>
              <dd className="m-0">
                {task.pricePoints.toLocaleString()} points + {task.feePoints.toLocaleString()} fee
              </dd>
            </div>
            {task.claimedBy ? (
              <div>
                <dt className="text-muted">Assigned to</dt>
                <dd className="m-0 break-all font-mono">{task.claimedBy}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
      {claimant && task.status === 'CLAIMED' && !openJob ? (
        <form
          className="mt-4 space-y-2 border-t border-black/[.07] pt-4"
          onSubmit={(event) => {
            event.preventDefault()
            onAction(() => api.submitTask(task.id, draft.trim()), 'Delivery submitted for review.')
          }}
        >
          <label htmlFor={`delivery-${task.id}`} className="block text-[12px] font-semibold">
            Your delivery
          </label>
          <textarea
            id={`delivery-${task.id}`}
            required
            maxLength={20_000}
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="w-full rounded-xl border border-black/15 p-3 text-[13px] focus-visible:outline-2 focus-visible:outline-orange-app"
            placeholder="A summary of your work and links to the result."
          />
          <button
            type="submit"
            disabled={busy || !draft.trim() || deadlinePassed(task.claimExpiresAt)}
            className={primary}
          >
            {busy ? 'Submitting…' : 'Submit delivery'}
          </button>
          <p className="text-muted m-0 text-[11.5px]">
            Submit before the deadline. Check Work if the task expires.
          </p>
        </form>
      ) : null}
      {posted && inReview ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirm('accept')
              setExpanded(true)
            }}
            className={primary}
          >
            Review & pay
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirm('decline')}
            className={secondary}
          >
            Report a problem
          </button>
          <p className="text-muted m-0 w-full text-[11.5px]">
            After the review deadline, the worker can claim payment.
          </p>
        </div>
      ) : null}
      {posted &&
      (task.status === 'OPEN' ||
        (task.status === 'CLAIMED' && deadlinePassed(task.claimExpiresAt))) ? (
        <button
          type="button"
          disabled={busy}
          className={`${secondary} mt-3`}
          onClick={() =>
            onAction(
              () => api.cancelTask(task.id),
              'Job cancelled. The reserved points were returned.',
            )
          }
        >
          {busy
            ? 'Cancelling…'
            : task.status === 'CLAIMED'
              ? 'Cancel expired task & refund'
              : 'Cancel & refund'}
        </button>
      ) : null}
      {claimant && inReview && deadlinePassed(task.reviewExpiresAt) ? (
        <button
          type="button"
          disabled={busy}
          className={`${primary} mt-3`}
          onClick={() =>
            onAction(() => api.releaseTask(task.id), 'Payment released to your points balance.')
          }
        >
          {busy ? 'Releasing…' : 'Claim payment'}
        </button>
      ) : null}
      {task.status === 'DISPUTED' ? (
        <p className="mt-3 mb-0 rounded-xl bg-surface-sunk p-3 text-[12px] leading-relaxed">
          Payment is held. Dispute resolution is not available yet.
        </p>
      ) : null}
      {openJob && !posted ? (
        <button
          type="button"
          disabled={busy}
          className={`${primary} mt-3`}
          onClick={() => (owner ? setConfirm('claim') : onConnect())}
        >
          {owner ? 'Take this job' : 'Sign in to take this job'}
          <ArrowUpRight size={14} aria-hidden />
        </button>
      ) : null}
      {confirm &&
      (confirm === 'claim' ? Boolean(owner) && openJob && !posted : posted && inReview) ? (
        <form
          className="mt-3 space-y-3 rounded-xl border border-black/10 bg-surface-sunk p-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (confirm === 'accept')
              onAction(() => api.acceptTask(task.id), 'Delivery accepted. Payment released.')
            if (confirm === 'decline')
              onAction(
                () => api.declineTask(task.id, reason.trim()),
                'Problem recorded. Payment remains held.',
              )
            if (confirm === 'claim')
              onAction(
                () => api.claimTask(task.id),
                'Job claimed. You can now submit your delivery.',
              )
          }}
          aria-busy={busy}
        >
          <p className="m-0 text-[12.5px] leading-relaxed">
            {confirm === 'accept'
              ? `Release ${task.pricePoints.toLocaleString()} points to the worker? This cannot be undone.`
              : confirm === 'claim'
                ? `Deliver this job within ${task.workHours} hours. The reward is ${task.pricePoints.toLocaleString()} AiKi points, not withdrawable cash.`
                : 'This holds the payment without paying or refunding anyone. AiKi cannot resolve disputes yet.'}
          </p>
          {confirm === 'decline' ? (
            <div className="space-y-1.5">
              <label htmlFor={`reason-${task.id}`} className="block text-[12px] font-semibold">
                What needs fixing?
              </label>
              <textarea
                id={`reason-${task.id}`}
                required
                maxLength={2000}
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="w-full rounded-xl border border-black/15 bg-white p-3 text-[13px] focus-visible:outline-2 focus-visible:outline-orange-app"
              />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy || (confirm === 'decline' && !reason.trim())}
              className={primary}
            >
              {busy
                ? 'Saving…'
                : confirm === 'accept'
                  ? 'Accept & pay'
                  : confirm === 'claim'
                    ? 'Confirm job'
                    : 'Hold payment'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirm(null)}
              className={secondary}
            >
              Go back
            </button>
          </div>
        </form>
      ) : null}
    </li>
  )
}

export function WorkBoard() {
  const say = useToast()
  const { address, authenticated, connect } = useAccount()
  const owner = authenticated ? address.toLowerCase() : null
  const [open, setOpen] = useState<TaskSummary[]>([])
  const [mine, setMine] = useState<TaskSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [filter, setFilter] = useState<WorkFilter>('all')
  const [period, setPeriod] = useState<WorkPeriod>('all')
  const [focusTask, setFocusTask] = useState<string | null>(null)
  const content = useRef<HTMLDivElement>(null)
  const focused = useRef<string | null>(null)
  const generation = useRef(0)
  const actionLock = useRef(false)
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  useEffect(() => {
    setFocusTask(new URLSearchParams(window.location.search).get('task'))
  }, [])
  const load = useCallback(
    async (quiet = false) => {
      const request = ++generation.current
      if (!quiet) setLoading(true)
      setError(null)
      const [publicResult, ownResult] = await Promise.allSettled([
        api.tasks(),
        owner ? api.myTasks() : Promise.resolve({ tasks: [] as TaskSummary[] }),
      ])
      if (request !== generation.current) return
      if (publicResult.status === 'fulfilled') setOpen(publicResult.value.tasks)
      if (ownResult.status === 'fulfilled') setMine(ownResult.value.tasks)
      const failed = [publicResult, ownResult].find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected')
        setError(
          failed.reason instanceof Error
            ? failed.reason.message
            : 'Work could not be loaded. Try again.',
        )
      setLoading(false)
    },
    [owner],
  )
  useEffect(() => {
    setMine([])
    setActionError(null)
    void load()
    return () => {
      generation.current += 1
    }
  }, [load])
  const pending = mine.some((task) => ['OPEN', 'CLAIMED', 'SUBMITTED'].includes(task.status))
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true)
    }, 15_000)
    return () => clearInterval(timer)
  }, [pending, load])
  useEffect(() => {
    if (!focusTask || focused.current === focusTask || loading) return
    const element = document.getElementById(`task-${focusTask}`)
    const scroller = content.current
    if (element && scroller) {
      scroller.scrollTo({
        top:
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop -
          16,
      })
      element.focus({ preventScroll: true })
      focused.current = focusTask
    }
  }, [focusTask, loading])
  const signIn = () => {
    void connect()
      .then((result) => say(CONNECT_TOAST[result]))
      .catch((failure: Error) => setActionError(failure.message))
  }
  const act = async (id: string, run: () => Promise<unknown>, done: string) => {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(id)
    setActionError(null)
    try {
      await run()
      if (currentOwner.current === owner) {
        say(done)
        await load(true)
      }
    } catch (failure) {
      if (currentOwner.current === owner)
        setActionError(
          failure instanceof Error
            ? failure.message
            : 'That action did not complete. Refresh before trying again.',
        )
    } finally {
      actionLock.current = false
      setBusy(null)
    }
  }
  const visible = filterWork(mine, filter, period)
  const list = (tasks: TaskSummary[], openJob = false) => (
    <ul className="m-0 grid list-none gap-3 p-0">
      {tasks.map((task) => (
        <WorkCard
          key={`${owner}:${task.id}`}
          task={task}
          owner={owner}
          openJob={openJob}
          selected={focusTask === task.id}
          busy={busy !== null}
          onConnect={signIn}
          onAction={(run, done) => {
            void act(task.id, run, done)
          }}
        />
      ))}
    </ul>
  )
  const empty = (title: string, text: string, link?: boolean) => (
    <div className="flex min-h-[220px] flex-col items-center justify-center rounded-[18px] border border-dashed border-black/10 px-5 py-10 text-center">
      <ClipboardList size={28} className="text-muted" aria-hidden />
      <h2 className="mt-4 mb-1 text-[14px] font-bold">{title}</h2>
      <p className="text-muted m-0 max-w-[40ch] text-[12.5px] leading-relaxed">{text}</p>
      {link ? (
        <Link href="/explore" className={`${secondary} mt-4`}>
          Find an agent
          <ArrowUpRight size={14} aria-hidden />
        </Link>
      ) : null}
    </div>
  )
  const feedback = (
    <>
      {error ? (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-black/10 p-3 text-[12px]"
        >
          {error}
          <button
            type="button"
            onClick={() => {
              void load()
            }}
            className={secondary}
          >
            Try again
          </button>
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className="mb-3 rounded-xl border border-orange-app/20 p-3 text-[12px]">
          {actionError}
        </p>
      ) : null}
    </>
  )
  return (
    <PageCard
      title="Work"
      count=""
      tabs={['Your work', 'Open jobs']}
      tabHint={['Jobs, deliveries and payments', 'Find a job you can do']}
      contentRef={content}
      panels={[
        <div key="mine" className="mx-auto max-w-[1060px]">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl bg-surface-sunk p-1">
              {(['all', 'active', 'review', 'completed'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={`min-h-9 shrink-0 rounded-lg px-3 text-[12px] font-semibold ${filter === value ? 'bg-white shadow-sm' : 'text-muted'}`}
                >
                  {{ all: 'All', active: 'Active', review: 'To review', completed: 'Paid' }[value]}{' '}
                  <span className="text-muted ml-1 tabular-nums">
                    {filterWork(mine, value, period).length}
                  </span>
                </button>
              ))}
            </div>
            <label className="text-muted ml-auto flex min-h-10 items-center gap-2 text-[11.5px]">
              <span className="sr-only">Show jobs created</span>
              <select
                value={period}
                onChange={(event) => setPeriod(event.target.value as WorkPeriod)}
                className="min-h-10 rounded-xl border border-black/10 bg-white px-3 text-[12px]"
              >
                <option value="all">All time</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
              </select>
            </label>
            <button
              type="button"
              aria-label="Refresh work"
              title="Refresh work"
              disabled={loading}
              onClick={() => {
                void load()
              }}
              className={`${secondary} w-10 px-0`}
            >
              <RefreshCw
                size={15}
                aria-hidden
                className={loading ? 'animate-spin motion-reduce:animate-none' : ''}
              />
            </button>
          </div>
          {feedback}
          {!owner ? (
            <div className="rounded-[18px] bg-surface-sunk p-6">
              <h2 className="m-0 text-[16px] font-bold">Your work, in one place</h2>
              <p className="text-muted mt-2 mb-4 text-[13px]">
                Sign in with your wallet to see your jobs and deliveries.
              </p>
              <button type="button" onClick={signIn} className={primary}>
                Connect & sign in
              </button>
            </div>
          ) : loading && !mine.length ? (
            <p role="status" className="text-muted py-10 text-center text-[13px]">
              Loading your work…
            </p>
          ) : visible.length ? (
            list(visible)
          ) : !error ? (
            empty(
              filter === 'all' && period === 'all' ? 'No jobs yet' : 'No matching jobs',
              filter === 'all' && period === 'all'
                ? 'Hire an agent and its work will appear here.'
                : 'Try another status or date range.',
              filter === 'all' && period === 'all',
            )
          ) : null}
          <PaymentNote />
        </div>,
        <div key="open" className="mx-auto max-w-[1060px]">
          {feedback}
          {loading && !open.length ? (
            <p role="status" className="text-muted py-10 text-center text-[13px]">
              Loading open jobs…
            </p>
          ) : open.length ? (
            list(open, true)
          ) : !error ? (
            empty('No open jobs right now', 'New jobs appear here once their reward is reserved.')
          ) : null}
          <PaymentNote />
        </div>,
      ]}
    />
  )
}

function OriginalText({ label, text }: { label: string; text: string }) {
  return (
    <details className="mt-3 text-[12px]">
      <summary className="min-h-10 cursor-pointer py-2.5 font-semibold text-muted focus-visible:outline-2 focus-visible:outline-orange-app">
        {label}
      </summary>
      <pre className="m-0 max-w-full overflow-x-auto rounded-xl bg-surface-sunk p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {text}
      </pre>
    </details>
  )
}

function PaymentNote() {
  return (
    <details className="text-muted mt-4 text-[11.5px] leading-relaxed">
      <summary className="min-h-10 cursor-pointer py-2.5 font-semibold">How payments work</summary>
      <p className="mt-0 max-w-[70ch]">
        Rewards use AiKi points. They pay for work and Fast mode, but cannot be withdrawn. Points
        are reserved before a job starts and can be released after acceptance or the review
        deadline. Disputed payments stay held; dispute resolution is not available yet.
      </p>
    </details>
  )
}
