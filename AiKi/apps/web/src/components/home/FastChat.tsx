'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { type AssistantStep, type AssistantTurn, api, type CreditBalance } from '@/lib/api'

/**
 * Fast mode: asking for the thing instead of finding the screen for it.
 *
 * Manual mode is every control laid out; this is the same controls with a model
 * working them. Two things follow from that and shape everything here.
 *
 * The steps are shown, always. A model that quietly created a mandate is not a
 * faster way to use this product, it is a worse one — the whole premise is that
 * you can see what was done on your behalf. Anything that changed something is
 * marked, so "looked at four things" and "created a mandate" never read alike.
 *
 * The price is shown, always, with its arithmetic. A metered product where the
 * meter is invisible is one people stop trusting the first time a number
 * surprises them.
 */

interface Message {
  /** Stable across re-renders: keying on array position re-keys every message
   *  whenever one is inserted, which throws away scroll and selection state. */
  id: string
  role: 'user' | 'assistant'
  content: string
  steps?: AssistantStep[]
  cost?: AssistantTurn['cost']
}

let counter = 0
const nextId = () => `m${++counter}`

/** Plain words for the tools, since the model's names are for the model. */
const TOOL_LABEL: Record<string, string> = {
  search_agents: 'searched the registry',
  agent_passport: 'read an agent’s evidence',
  ecosystem_stats: 'checked what has been measured',
  preview_limits: 'priced your limits',
  my_account: 'looked up your account',
  create_mandate: 'created a mandate',
  hire: 'started a job',
  watch_position: 'put an agent on duty',
  watch_status: 'checked the watch',
  stop_watching: 'stood the agent down',
  job_record: 'read the job record',
  revoke_mandate: 'revoked a mandate',
}

export function FastChat({ opening, onClose }: { opening?: string; onClose?: () => void }) {
  const say = useToast()
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [credits, setCredits] = useState<CreditBalance | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

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
    void loadCredits()
  }, [loadCredits])

  const ask = useCallback(
    async (question: string) => {
      if (!question || busy) return
      setDraft('')
      const asked: Message[] = [...messages, { id: nextId(), role: 'user', content: question }]
      setMessages(asked)
      setBusy(true)
      try {
        const turn = await api.assistant(asked.map((m) => ({ role: m.role, content: m.content })))
        setMessages([
          ...asked,
          {
            id: nextId(),
            role: 'assistant',
            content: turn.reply,
            steps: turn.steps,
            cost: turn.cost,
          },
        ])
        await loadCredits()
      } catch (error) {
        const message = (error as Error).message
        // The API's refusals are written to be acted on — "Fast mode needs at
        // least 200 points and you have 0" — so they are shown, not replaced.
        if (/points|configured/i.test(message)) setUnavailable(message)
        else say(message)
        setMessages(messages)
        setDraft(question)
      } finally {
        setBusy(false)
        requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }))
      }
    },
    [busy, messages, say, loadCredits],
  )

  /*
   * The question that opened this is asked once, on mount. Seeding the box and
   * making somebody press Ask again would be asking them to say it twice.
   *
   * The ref guard rather than an effect dependency on `ask`: `ask` closes over
   * the message list and so changes every turn, and depending on it would
   * re-ask the opening question after every answer.
   */
  const opened = useRef(false)
  useEffect(() => {
    if (!opening || opened.current) return
    opened.current = true
    void ask(opening)
  }, [opening, ask])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-baseline justify-between gap-[10px] px-[4px] pb-[12px]">
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
            <div className="text-faint text-[11.5px]">
              ${credits.worthUsd.toFixed(2)} · {credits.model}
            </div>
          </div>
        ) : null}
      </header>

      {unavailable ? (
        <div className="mx-[4px] mb-[12px] rounded-[14px] border border-[rgb(26_26_25_/_0.12)] px-[14px] py-[11px] text-[12.5px] leading-[1.5]">
          {unavailable}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-[4px]">
        {messages.length === 0 ? (
          <p className="text-faint mt-[8px] mb-0 text-[13px] leading-[1.6] text-pretty">
            Try: “which agents have actually been verified?”, “what would a 50 USDT per action limit
            be worth?”, or “protect my Venus loan and keep the health factor above 1.25”.
          </p>
        ) : null}

        <ol className="m-0 flex list-none flex-col gap-[14px] p-0">
          {messages.map((m) => (
            <li key={m.id} className={m.role === 'user' ? 'self-end' : ''}>
              {m.role === 'user' ? (
                <p className="text-ink-app m-0 max-w-[520px] rounded-[16px] bg-[rgb(26_26_25_/_0.055)] px-[14px] py-[10px] text-[13px] leading-[1.55] whitespace-pre-wrap">
                  {m.content}
                </p>
              ) : (
                <div className="max-w-[620px]">
                  {m.steps?.length ? <Steps steps={m.steps} /> : null}
                  <p className="m-0 text-[13px] leading-[1.6] whitespace-pre-wrap">{m.content}</p>
                  {m.cost ? (
                    <p
                      className="text-faint mt-[8px] mb-0 text-[11.5px] leading-[1.45]"
                      title={m.cost.explanation}
                    >
                      {m.cost.points} points · {m.cost.balance.toLocaleString()} left
                      {m.cost.held > m.cost.points
                        ? ` · ${(m.cost.held - m.cost.points).toLocaleString()} of the ${m.cost.held.toLocaleString()} held went back`
                        : ''}
                    </p>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ol>
        {busy ? <p className="text-faint mt-[14px] mb-0 text-[12.5px]">Working…</p> : null}
        <div ref={endRef} />
      </div>

      <div className="flex items-end gap-[8px] px-[4px] pt-[12px]">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void ask(draft.trim())
            }
            if (e.key === 'Escape' && onClose) onClose()
          }}
          rows={1}
          placeholder="Ask for what you need…"
          className="text-ink-app min-h-[44px] flex-1 resize-none rounded-[14px] border border-[rgb(26_26_25_/_0.14)] bg-transparent px-[14px] py-[12px] text-[13.5px] leading-[1.45] outline-none focus:border-[rgb(26_26_25_/_0.4)]"
        />
        <button
          type="button"
          disabled={busy || !draft.trim()}
          onClick={() => void ask(draft.trim())}
          className="bg-ink-app hover:bg-orange-app h-[44px] flex-none rounded-[14px] border-0 px-[16px] text-[13.5px] font-bold text-white transition-colors disabled:opacity-40"
        >
          Ask
        </button>
      </div>
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
            {s.ok ? '' : ' (refused)'}
          </span>
        </li>
      ))}
    </ul>
  )
}
