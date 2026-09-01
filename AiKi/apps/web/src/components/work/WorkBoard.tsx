'use client'

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { api, type TaskSummary } from '@/lib/api'

/**
 * Work somebody posted, that anybody can do.
 *
 * The other half of a marketplace that until now could only sell one thing:
 * a listed agent at its published price. Nothing on that path can express an
 * agent paying a person, because a person has no listing, no URL that answers a
 * probe and no on-chain identity, and because the thing being bought does not
 * exist until somebody writes it down.
 *
 * The money is taken from the poster before a task appears here. That is the
 * one property this screen is built around and the reason it is worth doing
 * work you find on it: a poster cannot read what you handed in and then decide
 * not to pay, because they no longer hold the money and cannot take it back
 * once you have claimed.
 */

const STATE_WORD: Record<TaskSummary['status'], string> = {
  OPEN: 'Waiting for somebody',
  CLAIMED: 'Being worked on',
  SUBMITTED: 'Handed in, waiting on the poster',
  SETTLED: 'Paid',
  CANCELLED: 'Taken back',
  DISPUTED: 'Disagreed',
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

const passed = (at?: string) => Boolean(at && Date.parse(at) < Date.now())

/** "in 4 hours", "3 days ago". Coarse on purpose: an exact minute is false precision. */
function when(at?: string): string {
  if (!at) return ''
  const ms = Date.parse(at) - Date.now()
  const hours = Math.round(Math.abs(ms) / 3_600_000)
  const size =
    hours < 48 ? `${hours || 1} hour${hours === 1 ? '' : 's'}` : `${Math.round(hours / 24)} days`
  return ms > 0 ? `in ${size}` : `${size} ago`
}

function Money({ points }: { points: number }) {
  // Points, because that is what a balance is counted in and what a person is
  // actually paid. Rendering a dollar figure here would be a second opinion
  // about a number the ledger has already settled.
  return <span className="font-bold tabular-nums">{points.toLocaleString()} points</span>
}

export function WorkBoard() {
  const say = useToast()
  const [open, setOpen] = useState<TaskSummary[]>([])
  const [mine, setMine] = useState<TaskSummary[]>([])
  const [kinds, setKinds] = useState<Record<string, string>>({})
  const [me, setMe] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    api
      .tasks()
      .then((r) => {
        setOpen(r.tasks)
        setKinds(r.kinds)
      })
      .catch(() => {})
    api
      .myTasks()
      .then((r) => setMine(r.tasks))
      // Not signed in is the common case here and is not a failure worth saying.
      .catch(() => {})
    api
      .me()
      .then((m) => setMe(m.address.toLowerCase()))
      .catch(() => {})
  }, [])

  useEffect(load, [load])

  const act = (id: string, run: () => Promise<unknown>, done: string) => {
    setBusy(id)
    run()
      .then(() => {
        say(done)
        load()
      })
      .catch((error: Error) => say(error.message || 'That did not go through.'))
      .finally(() => setBusy(null))
  }

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-[22px] px-[18px] py-[26px]">
      <header>
        <h1 className="m-0 text-[22px] font-bold">Work</h1>
        <p className="text-muted mt-[6px] mb-0 max-w-[62ch] text-[13.5px] leading-[1.55] text-pretty">
          Things somebody wants done and has already paid for. The money is held before a task
          appears here, so it is there whether or not the poster changes their mind, and they cannot
          take it back once you have claimed it. Anybody can claim: a person, or an agent acting for
          one.
        </p>
        {/* Said here, on the screen where somebody decides whether the work is
            worth their time, rather than left to be discovered after they have
            done it. */}
        <p className="text-faint mt-[8px] mb-0 max-w-[62ch] text-[12.5px] leading-[1.5]">
          You are paid in points, which buy work and Fast mode turns inside AiKi. There is no way to
          withdraw them yet.
        </p>
      </header>

      {mine.length ? (
        <section>
          <h2 className="m-0 text-[15px] font-bold">Yours</h2>
          <ul className="mt-[10px] flex list-none flex-col gap-[10px] p-0">
            {mine.map((t) => {
              const posted = t.poster === me
              return (
                <li
                  key={t.id}
                  className="rounded-[16px] border border-[rgb(26_26_25_/_0.1)] bg-white px-[16px] py-[13px]"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
                    <span className="text-[14px] font-bold">{t.title}</span>
                    <span className="text-muted text-[12px] font-semibold">
                      {posted ? 'you posted' : 'you claimed'} · {STATE_WORD[t.status]}
                    </span>
                  </div>
                  <p className="text-muted mt-[5px] mb-0 text-[12.5px] leading-[1.5] text-pretty">
                    {t.brief}
                  </p>

                  {t.submission ? (
                    <div className="mt-[10px] rounded-[12px] bg-[rgb(26_26_25_/_0.04)] px-[12px] py-[10px]">
                      <div className="text-muted text-[11.5px] font-bold">What was handed in</div>
                      <p className="mt-[4px] mb-0 text-[12.5px] leading-[1.5] whitespace-pre-wrap">
                        {t.submission}
                      </p>
                    </div>
                  ) : null}

                  {/* The person doing it hands work in. Once, so the poster is not
                      reading something that can change under them. */}
                  {!posted && t.status === 'CLAIMED' ? (
                    <div className="mt-[10px] flex flex-col gap-[8px]">
                      <textarea
                        value={draft[t.id] ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, [t.id]: e.target.value }))}
                        rows={4}
                        placeholder="What you did, or what you produced."
                        className="w-full rounded-[12px] border border-[rgb(26_26_25_/_0.14)] bg-white px-[11px] py-[9px] text-[13px] leading-[1.5]"
                      />
                      <button
                        type="button"
                        disabled={busy === t.id || !(draft[t.id] ?? '').trim()}
                        onClick={() =>
                          act(
                            t.id,
                            () => api.submitTask(t.id, draft[t.id] ?? ''),
                            'Handed in. The poster decides next.',
                          )
                        }
                        className="bg-ink-app hover:bg-orange-app h-[34px] self-start rounded-[10px] border-0 px-[15px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-50"
                      >
                        Hand it in
                      </button>
                    </div>
                  ) : null}

                  {/* The poster decides. Accepting pays and cannot be undone; declining
                      pays nobody and refunds nobody, and says so rather than implying
                      somebody will arbitrate. */}
                  {posted && t.status === 'SUBMITTED' ? (
                    <div className="mt-[10px] flex flex-wrap gap-[8px]">
                      <button
                        type="button"
                        disabled={busy === t.id}
                        onClick={() =>
                          act(
                            t.id,
                            () => api.acceptTask(t.id),
                            `Paid. ${t.pricePoints.toLocaleString()} points went to whoever did it.`,
                          )
                        }
                        className="bg-ink-app hover:bg-orange-app h-[34px] rounded-[10px] border-0 px-[15px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-50"
                      >
                        Accept and pay <Money points={t.pricePoints} />
                      </button>
                      <button
                        type="button"
                        disabled={busy === t.id}
                        onClick={() =>
                          act(
                            t.id,
                            () => api.declineTask(t.id, 'Not what was asked for.'),
                            'Declined. Nobody is paid and nobody is refunded: the money stays held while this stands.',
                          )
                        }
                        className="h-[34px] rounded-[10px] border border-[rgb(26_26_25_/_0.16)] bg-white px-[15px] text-[12.5px] font-bold transition-colors hover:border-[rgb(26_26_25_/_0.3)] disabled:opacity-50"
                      >
                        Not what I asked for
                      </button>
                    </div>
                  ) : null}

                  {posted && t.status === 'OPEN' ? (
                    <button
                      type="button"
                      disabled={busy === t.id}
                      onClick={() =>
                        act(t.id, () => api.cancelTask(t.id), 'Taken back, and the money with it.')
                      }
                      className="mt-[10px] h-[32px] rounded-[10px] border border-[rgb(26_26_25_/_0.16)] bg-white px-[13px] text-[12.5px] font-bold transition-colors hover:border-[rgb(26_26_25_/_0.3)] disabled:opacity-50"
                    >
                      Take it back
                    </button>
                  ) : null}

                  {/* The clock, on whichever side it is running. Somebody has to
                      be able to see how long they have without reading docs. */}
                  {!posted && t.status === 'CLAIMED' && t.claimExpiresAt ? (
                    <p className="text-faint mt-[7px] mb-0 text-[11.5px] font-semibold">
                      {passed(t.claimExpiresAt)
                        ? 'Your time ran out, so this is back on the board for somebody else.'
                        : `Hand it in ${when(t.claimExpiresAt)} or it goes back on the board.`}
                    </p>
                  ) : null}
                  {posted && t.status === 'SUBMITTED' && t.reviewExpiresAt ? (
                    <p className="text-faint mt-[7px] mb-0 text-[11.5px] font-semibold">
                      {passed(t.reviewExpiresAt)
                        ? 'You did not answer in time, so they can take the payment.'
                        : `Answer ${when(t.reviewExpiresAt)}, or they can take the payment.`}
                    </p>
                  ) : null}

                  {/* Nobody's finished work is held hostage by silence. */}
                  {!posted && t.status === 'SUBMITTED' && passed(t.reviewExpiresAt) ? (
                    <button
                      type="button"
                      disabled={busy === t.id}
                      onClick={() =>
                        act(
                          t.id,
                          () => api.releaseTask(t.id),
                          `Paid. ${t.pricePoints.toLocaleString()} points are yours.`,
                        )
                      }
                      className="bg-ink-app hover:bg-orange-app mt-[10px] h-[34px] rounded-[10px] border-0 px-[15px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-50"
                    >
                      Take the payment
                    </button>
                  ) : !posted && t.status === 'SUBMITTED' ? (
                    <p className="text-faint mt-[7px] mb-0 text-[11.5px] font-semibold">
                      Waiting on the poster. If they say nothing by {when(t.reviewExpiresAt)}, you
                      can take the payment yourself.
                    </p>
                  ) : null}

                  {t.status === 'DISPUTED' ? (
                    <p className="text-muted mt-[9px] mb-0 text-[12px] leading-[1.5]">
                      The money stays in escrow against this task. AiKi does not resolve disputes
                      yet, and will not pretend to.
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="m-0 text-[15px] font-bold">Open</h2>
        {open.length ? (
          <ul className="mt-[10px] flex list-none flex-col gap-[10px] p-0">
            {open.map((t) => (
              <li
                key={t.id}
                className="rounded-[16px] border border-[rgb(26_26_25_/_0.1)] bg-white px-[16px] py-[13px]"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
                  <span className="text-[14px] font-bold">{t.title}</span>
                  <Money points={t.pricePoints} />
                </div>
                <p className="text-muted mt-[5px] mb-0 text-[12.5px] leading-[1.5] text-pretty">
                  {t.brief}
                </p>
                <div className="text-faint mt-[7px] text-[11.5px] font-semibold">
                  {kinds[t.kind] ?? t.kind} · posted by {short(t.poster)} · {t.workHours}h to do it
                  {t.status === 'CLAIMED' ? ' · the last claimant ran out of time' : ''}
                </div>
                <button
                  type="button"
                  disabled={busy === t.id || t.poster === me}
                  onClick={() =>
                    act(t.id, () => api.claimTask(t.id), 'Yours. Hand it in when it is done.')
                  }
                  className="bg-ink-app hover:bg-orange-app mt-[10px] h-[34px] rounded-[10px] border-0 px-[15px] text-[12.5px] font-bold text-white transition-colors disabled:opacity-50"
                >
                  {t.poster === me ? 'You posted this' : 'Claim it'}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted mt-[10px] mb-0 text-[13px] leading-[1.55]">
            Nothing is open right now. Work appears here the moment somebody funds it, including
            when an agent posts it on behalf of the person it works for.
          </p>
        )}
      </section>
    </div>
  )
}
