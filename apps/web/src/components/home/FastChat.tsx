'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AiKiActivity } from '@/components/ui/AiKiActivity'
import { type AssistantStep, api, type CreditBalance } from '@/lib/api'
import { FastMandateAction } from './FastMandateAction'
import { FastMessage } from './FastMessage'
import {
  addPointsHref,
  errorNeedsPoints,
  FastPointsRecovery,
  fastCostSummary,
  messageNeedsPoints,
} from './FastPoints'
import { FastConversationController } from './fast-conversation'
import { fastToolAgentHref } from './fast-links'
import { mandateContinuations } from './fast-mandate'

/**
 * Fast mode: asking for the thing instead of finding the screen for it.
 *
 * Manual mode is every control laid out; this is the same controls with a model
 * working them. Two things follow from that and shape everything here.
 *
 * The steps are shown, always. A model that quietly created a mandate is not a
 * faster way to use this product, it is a worse one - the whole premise is that
 * you can see what was done on your behalf. Anything that changed something is
 * marked, so "looked at four things" and "created a mandate" never read alike.
 *
 * The price is shown, always, with its arithmetic. A metered product where the
 * meter is invisible is one people stop trusting the first time a number
 * surprises them.
 */

/** Plain words for the tools, since the model's names are for the model. */
const TOOL_LABEL: Record<string, string> = {
  search_agents: 'searched the registry',
  catalog_agents: 'searched agent listings',
  catalog_agent: 'opened an agent profile',
  catalog_capabilities: 'checked the available services',
  read_external_agent: 'asked the external agent',
  agent_passport: 'opened an agent profile',
  agent_task_support: 'checked whether the agent accepts tasks',
  ecosystem_stats: 'checked what has been measured',
  preview_limits: 'priced your limits',
  my_account: 'looked up your account',
  create_mandate: 'created a mandate',
  create_action_mandate: 'created a spending mandate',
  send_token: 'sent tokens',
  create_spending_mandate: 'set your work budget',
  hire: 'started a job',
  hire_agent: 'created a task for the agent',
  my_tasks: 'checked your work',
  open_tasks: 'looked for available work',
  post_task: 'posted your task',
  accept_task: 'accepted the work and released payment',
  decline_task: 'marked the work as disputed',
  find_people: 'looked for people',
  hire_person: 'sent your brief to the provider',
  claim_task: 'claimed the task',
  submit_task: 'submitted the work',
  release_task: 'released payment',
  watch_position: 'put an agent on duty',
  watch_status: 'checked the watch',
  stop_watching: 'stood the agent down',
  job_record: 'read the job record',
  revoke_mandate: 'revoked a mandate',
}

export function FastChat({
  id,
  owner,
  opening,
  create = false,
  onClose,
  onChanged,
}: {
  id: string
  owner: string
  opening?: string
  create?: boolean
  onClose?: () => void
  onChanged?: () => void
}) {
  const controller = useMemo(() => {
    let storage: Storage | undefined
    try {
      storage = window.sessionStorage
    } catch {
      /* server render or blocked storage */
    }
    return new FastConversationController(
      id,
      owner,
      {
        create: api.createConversation,
        load: api.conversation,
        ask: api.assistant,
      },
      storage,
    )
  }, [id, owner])
  const { messages, draft, busy, loading, error, errorCode, pending } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const [credits, setCredits] = useState<CreditBalance | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastMessage = messages.at(-1)
  const refusalInHistory =
    !pending && lastMessage?.content === error && messageNeedsPoints(lastMessage)
  const needsPoints = !pending && Boolean(error && errorNeedsPoints(errorCode, error))

  const loadCredits = useCallback(async () => {
    try {
      setCredits(await api.credits())
    } catch {
      // Not signed in, or this deployment has no Fast mode. Either way the
      // header simply says nothing rather than showing a broken number.
      setCredits(null)
    }
  }, [])

  useEffect(() => {
    void controller.initialize(create, opening)
    return controller.dispose
  }, [controller, create, opening])
  useEffect(() => {
    if (messages.length) onChanged?.()
    void loadCredits()
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' })
  }, [messages, onChanged, loadCredits])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-baseline justify-between gap-[10px] px-[4px] pb-[12px]">
        <div>
          <div className="text-[14.5px] font-bold">Fast mode</div>
          <p className="text-muted mt-[3px] mb-0 max-w-[520px] text-[12.5px] leading-[1.5] text-pretty">
            Ask for the thing. It works the same controls as the rest of the app, as you, and shows
            you every one it touches.
          </p>
        </div>
        {credits ? (
          <div className="text-right">
            <div className="text-[13px] font-bold tabular-nums">
              {credits.balance.toLocaleString()} points
            </div>
            <div className="text-faint text-[11.5px]">{credits.model}</div>
            <a
              href={addPointsHref(id)}
              className="inline-flex min-h-10 items-center text-[11.5px] text-muted underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-orange-app"
            >
              Points and limits
            </a>
          </div>
        ) : null}
      </header>

      {error && !refusalInHistory ? (
        <div
          role="alert"
          id="fast-chat-error"
          className="mx-[4px] mb-[12px] rounded-[14px] border border-[rgb(26_26_25_/_0.12)] px-[14px] py-[11px] text-[12.5px] leading-[1.5]"
        >
          <p className="m-0">{error}</p>
          {needsPoints ? <FastPointsRecovery id={id} /> : null}
          {pending ? (
            <p className="mt-1 mb-0 text-muted">
              Check reply retrieves this same request. It does not submit a new one.
            </p>
          ) : !needsPoints ? (
            <button
              type="button"
              onClick={() => void controller.initialize(create)}
              className="mt-1 min-h-10 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-orange-app"
            >
              Reload conversation
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[4px] pb-2"
      >
        {loading ? (
          <AiKiActivity label="Opening your conversation" elapsed={false} compact />
        ) : null}
        {!loading && messages.length === 0 && !pending ? (
          <p className="text-faint mt-[8px] mb-0 text-[13px] leading-[1.6] text-pretty">
            Say what you need done. Find an agent, compare options, or follow your work here.
          </p>
        ) : null}

        <ol className="m-0 flex list-none flex-col gap-[14px] p-0">
          {messages.map((m) => (
            <li key={m.id} className={m.role === 'user' ? 'self-end' : ''}>
              {m.role === 'user' ? (
                <p className="text-ink-app m-0 max-w-[520px] rounded-[16px] bg-[rgb(26_26_25_/_0.055)] px-[14px] py-[10px] text-[13px] leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {m.content}
                </p>
              ) : (
                <div className="max-w-[620px]">
                  {m.steps?.length ? <Steps steps={m.steps} /> : null}
                  <FastMessage text={m.content} />
                  {messageNeedsPoints(m) ? <FastPointsRecovery id={id} /> : null}
                  {mandateContinuations(m.steps).map((action) => (
                    <FastMandateAction key={action.authorizationId} action={action} owner={owner} />
                  ))}
                  {m.steps?.some(
                    (step) =>
                      step.ok && ['hire_agent', 'post_task', 'my_tasks'].includes(step.tool),
                  ) ? (
                    <a
                      href="/work"
                      className="mt-3 inline-block text-[12.5px] font-semibold underline underline-offset-4"
                    >
                      Open your work →
                    </a>
                  ) : null}
                  {m.cost ? (
                    <p
                      className="text-muted mt-[8px] mb-0 text-[11.5px] leading-[1.45]"
                      title={m.cost.explanation}
                    >
                      {fastCostSummary(m.cost)}
                    </p>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ol>
        {pending ? (
          <div className="mt-4 flex flex-col items-end gap-2">
            <p className="m-0 max-w-[520px] rounded-[16px] bg-[rgb(26_26_25_/_0.055)] px-[14px] py-[10px] text-[13px] leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere]">
              {pending.messages.at(-1)?.content}
            </p>
            {busy ? (
              <AiKiActivity
                label="AiKi is working"
                detail="This request stays attached to this conversation."
                compact
              />
            ) : (
              <p role="status" className="text-muted m-0 text-[12px]">
                Reply still pending. Check this same request when you are ready.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <form
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault()
          void controller.send()
        }}
        className="shrink-0 px-[4px] pt-[12px]"
      >
        <label htmlFor={`fast-message-${id}`} className="mb-2 block text-[12px] font-semibold">
          Your message
        </label>
        <div className="flex items-end gap-[8px]">
          <textarea
            id={`fast-message-${id}`}
            aria-describedby={error && !refusalInHistory ? 'fast-chat-error' : undefined}
            value={draft}
            readOnly={Boolean(pending)}
            disabled={loading}
            onChange={(e) => controller.setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void controller.send()
              }
              if (e.key === 'Escape' && onClose) onClose()
            }}
            rows={1}
            placeholder="Ask for what you need…"
            maxLength={6000}
            className="text-ink-app min-h-[44px] min-w-0 flex-1 resize-none rounded-[14px] border border-[rgb(26_26_25_/_0.14)] bg-transparent px-[14px] py-[12px] text-[13.5px] leading-[1.45] focus-visible:outline-2 focus-visible:outline-orange-app"
          />
          <button
            type="submit"
            disabled={loading || busy || (!pending && !draft.trim())}
            className="bg-ink-app hover:bg-orange-app h-[44px] flex-none rounded-[14px] border-0 px-[16px] text-[13.5px] font-bold text-white transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app disabled:opacity-40 motion-reduce:transition-none"
          >
            {busy ? 'Working' : pending ? 'Check reply' : 'Ask'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Steps({ steps }: { steps: AssistantStep[] }) {
  /*
   * A step's identity is what it did, not where it sits. The same tool can be
   * called twice in one turn with different arguments, so the arguments are part
   * of the key, and an identical repeat is disambiguated by how many came before.
   */
  const seen = new Map<string, number>()
  const keyed = steps.map((step) => {
    const base = `${step.tool}:${JSON.stringify(step.input)}`
    const nth = (seen.get(base) ?? 0) + 1
    seen.set(base, nth)
    return { step, key: `${base}#${nth}` }
  })

  return (
    <ul className="mb-[8px] flex list-none flex-col gap-[4px] p-0">
      {keyed.map(({ step: s, key }) => (
        <li key={key} className="text-faint flex items-center gap-[7px] text-[11.5px]">
          <span
            className="size-[6px] flex-none rounded-full"
            style={{
              // Anything that changed something is marked. "Looked at four
              // things" and "created a mandate" must never read alike.
              background: !s.ok
                ? 'var(--color-warn)'
                : s.mutating
                  ? 'var(--color-good)'
                  : 'var(--color-faint)',
            }}
          />
          <span>
            {TOOL_LABEL[s.tool] ?? s.tool}
            {s.ok ? '' : ' (did not complete)'}
          </span>
          {s.ok && fastToolAgentHref(s.tool, s.input.agent_id) ? (
            <a
              href={fastToolAgentHref(s.tool, s.input.agent_id)}
              className="underline underline-offset-2"
            >
              View agent
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
