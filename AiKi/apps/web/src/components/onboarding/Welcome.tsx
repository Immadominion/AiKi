'use client'

import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useAccount, useLayoutPref } from '@/components/shell/prefs'
import { AGENT_BG, AGENT_BY_KEY, type AgentKey } from '@/lib/agents'
import { route } from '@/lib/routes'
import { TASKS } from '@/lib/tasks'

const TASK_AGENT: Record<string, AgentKey> = {
  health_factor: 'guardian',
  rebalancing: 'lpilot',
  yield_optimisation: 'yieldmax',
  grid_trading: 'gridly',
}

const STEPS = ['Your wallet', 'What you need', 'How much power', 'Your home'] as const

/**
 * Onboarding.
 *
 * Four steps, and the middle two exist to make one point before anyone spends
 * anything: an agent gets exactly the authority you hand it, and you can see the
 * whole of that authority on one screen. Everything here is reversible, and the
 * copy says so at each step rather than reassuring once at the end.
 */
export function Welcome() {
  const [step, setStep] = useState(0)
  const [task, setTask] = useState<string | null>(null)
  const [cap, setCap] = useState(80)
  const { layout, setLayout } = useLayoutPref()
  const { connect } = useAccount()
  const router = useRouter()

  const chosen = task ? TASKS.find((t) => t.key === task) : null
  const agentKey = task ? TASK_AGENT[task] : null
  const agent = agentKey ? AGENT_BY_KEY[agentKey] : null

  const canAdvance = step !== 1 || Boolean(task)

  const finish = () => {
    router.push(route(layout === 'ask' ? '/' : '/market'))
  }

  return (
    <div className="bg-canvas relative flex min-h-[100dvh] w-full flex-col overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 z-1"
        style={{
          backgroundImage:
            'linear-gradient(rgb(120 118 112 / 0.13) 1px,transparent 1px),linear-gradient(90deg,rgb(120 118 112 / 0.13) 1px,transparent 1px)',
          backgroundSize: 'var(--aiki-grid) var(--aiki-grid)',
          backgroundPosition: 'center center',
        }}
      />
      <div className="pointer-events-none absolute -right-[100px] -bottom-[120px] z-2 h-[320px] w-[340px] rounded-[48%_52%_44%_56%] bg-[radial-gradient(ellipse_at_40%_40%,rgb(255_77_0_/_0.42),rgb(255_90_20_/_0.28)_45%,rgb(255_120_40_/_0)_72%)] blur-[28px] md:-right-[160px] md:-bottom-[190px] md:h-[520px] md:w-[580px]" />

      <header className="relative z-10 flex items-center gap-3 px-4 pt-4 md:px-8 md:pt-6">
        <Image
          src="/aiki-logo.png"
          alt="AiKi"
          width={120}
          height={120}
          className="h-[38px] w-auto"
        />
        <div className="flex-1" />
        <button
          type="button"
          onClick={finish}
          className="h-9 rounded-[12px] border-0 bg-none px-3 text-[13px] font-semibold text-[#767676] hover:bg-[rgb(20_20_20_/_0.05)] hover:text-[#141414]"
        >
          Skip for now
        </button>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-[620px] flex-1 flex-col justify-center px-4 py-8 md:px-0">
        <div className="mb-[22px] flex items-center gap-[6px]">
          {STEPS.map((s, i) => (
            <div key={s} className="flex flex-1 flex-col gap-[6px]">
              <span
                className="block h-[3px] rounded-full transition-colors"
                style={{ background: i <= step ? 'var(--color-orange)' : 'rgb(20 20 20 / 0.09)' }}
              />
              <span
                className="hidden text-[11px] font-semibold sm:block"
                style={{ color: i <= step ? '#141414' : '#A6A6A0' }}
              >
                {s}
              </span>
            </div>
          ))}
        </div>

        {step === 0 ? (
          <>
            <h1 className="mt-0 mb-[7px] text-[clamp(28px,6vw,38px)] leading-[1.06] font-extrabold tracking-[-0.03em] text-balance">
              First, connect the wallet you want watched.
            </h1>
            <p className="text-muted mt-0 mb-[18px] text-[14px] leading-[1.55] text-pretty">
              Connecting shows AiKi what you hold. It grants nothing. No agent can touch anything
              until you sign a separate authority with limits you set yourself.
            </p>

            <div className="rounded-[18px] border border-[rgb(20_20_20_/_0.08)] bg-white p-[18px]">
              {[
                [
                  'AiKi can read',
                  'Your balances and open positions, so it can suggest work worth doing.',
                ],
                [
                  'AiKi cannot move anything',
                  'Not now, and not after. Moving money needs an authority you sign per agent.',
                ],
                [
                  'You can disconnect any time',
                  'Disconnecting stops the reading. Revoking an authority is separate and on-chain.',
                ],
              ].map(([t, b]) => (
                <div
                  key={t}
                  className="flex items-start gap-[11px] border-t border-[rgb(20_20_20_/_0.06)] py-[11px] first:border-t-0 first:pt-0 last:pb-0"
                >
                  <span className="mt-[6px] size-[6px] flex-none rounded-full bg-[#FF4D00]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-bold">{t}</span>
                    <span className="text-muted mt-[3px] block text-[12.5px] leading-[1.5] text-pretty">
                      {b}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <h1 className="mt-0 mb-[7px] text-[clamp(28px,6vw,38px)] leading-[1.06] font-extrabold tracking-[-0.03em] text-balance">
              What do you want done?
            </h1>
            <p className="text-muted mt-0 mb-[18px] text-[14px] leading-[1.55] text-pretty">
              Four kinds of work today. We would rather show you a short list we can defend than a
              long one we cannot.
            </p>

            <div className="flex flex-col gap-[8px]">
              {TASKS.map((t) => {
                const on = task === t.key
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTask(t.key)}
                    className="flex items-center gap-[13px] rounded-[16px] border bg-white px-[15px] py-[13px] text-left transition-colors"
                    style={{
                      borderColor: on ? 'rgb(255 77 0 / 0.5)' : 'rgb(20 20 20 / 0.08)',
                      boxShadow: on ? '0 10px 26px -16px rgb(255 77 0 / 0.5)' : 'none',
                    }}
                  >
                    <span
                      className="flex size-[36px] flex-none items-center justify-center rounded-[12px] text-[14px] font-extrabold text-white"
                      style={{ background: t.bg }}
                    >
                      {t.glyph}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-bold">{t.title}</span>
                      <span className="text-muted mt-px block text-[12.5px] leading-[1.45] text-pretty">
                        {t.sub}
                      </span>
                    </span>
                    <span className="text-muted flex-none text-[11.5px] font-semibold">
                      {t.meta}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        ) : null}

        {step === 2 && agent && agentKey ? (
          <>
            <h1 className="mt-0 mb-[7px] text-[clamp(28px,6vw,38px)] leading-[1.06] font-extrabold tracking-[-0.03em] text-balance">
              Decide what it may spend.
            </h1>
            <p className="text-muted mt-0 mb-[18px] text-[14px] leading-[1.55] text-pretty">
              For &ldquo;{chosen?.title}&rdquo;, {agent.name} has the most evidence behind it. The
              number below is the only one that matters before you sign — a transaction above it is
              refused by the chain, not by us.
            </p>

            <div className="rounded-[18px] border border-[rgb(20_20_20_/_0.08)] bg-white p-[18px]">
              <div className="flex items-center gap-[12px]">
                <span
                  className="flex size-[42px] flex-none items-center justify-center rounded-[14px] text-base font-extrabold text-white"
                  style={{ background: AGENT_BG[agentKey] }}
                >
                  {agent.initial}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-bold">{agent.name}</span>
                  <span className="text-muted mt-px block text-[12.5px]">
                    {agent.evidence} · {agent.price}
                  </span>
                </span>
              </div>

              <div className="mt-[16px] border-t border-[rgb(20_20_20_/_0.07)] pt-[14px]">
                <div className="text-muted text-[12.5px] font-semibold">
                  Most it can spend in one action
                </div>
                <div className="mt-[9px] flex flex-wrap gap-[6px]">
                  {[40, 80, 150].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setCap(v)}
                      className="h-[36px] rounded-[11px] border-0 px-[14px] text-[13px] transition-colors"
                      style={
                        v === cap
                          ? { background: '#141414', color: '#fff', fontWeight: 700 }
                          : {
                              background: 'rgb(20 20 20 / 0.055)',
                              color: '#57574F',
                              fontWeight: 600,
                            }
                      }
                    >
                      ${v}
                    </button>
                  ))}
                </div>
                <p className="text-muted mt-[11px] mb-0 text-[12.5px] leading-[1.5] text-pretty">
                  You will set the monthly cap, the expiry and when it should ask you on the next
                  screen. Every one of them is changeable afterwards, and pausing is always instant
                  and free.
                </p>
              </div>
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <h1 className="mt-0 mb-[7px] text-[clamp(28px,6vw,38px)] leading-[1.06] font-extrabold tracking-[-0.03em] text-balance">
              Last thing — how should AiKi open?
            </h1>
            <p className="text-muted mt-0 mb-[18px] text-[14px] leading-[1.55] text-pretty">
              Both reach everything. This only decides what fills the screen when you arrive, and
              you can change it in the sidebar whenever you like.
            </p>

            <div className="grid gap-[10px] sm:grid-cols-2">
              {(
                [
                  [
                    'ask',
                    'One ask',
                    'A single question fills the screen. Say what you need and AiKi finds who can do it.',
                  ],
                  [
                    'market',
                    'Market',
                    'You land in the agent market and browse. Better if you would rather look before you ask.',
                  ],
                ] as const
              ).map(([k, title, body]) => {
                const on = layout === k
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setLayout(k)}
                    className="rounded-[18px] border bg-white p-[16px] text-left transition-colors"
                    style={{
                      borderColor: on ? 'rgb(255 77 0 / 0.5)' : 'rgb(20 20 20 / 0.08)',
                      boxShadow: on ? '0 10px 26px -16px rgb(255 77 0 / 0.5)' : 'none',
                    }}
                  >
                    <span className="flex items-center gap-[9px]">
                      <span
                        className="flex size-[18px] flex-none items-center justify-center rounded-full border-[1.5px]"
                        style={{ borderColor: on ? '#FF4D00' : 'rgb(20 20 20 / 0.2)' }}
                      >
                        {on ? <span className="size-[8px] rounded-full bg-[#FF4D00]" /> : null}
                      </span>
                      <span className="text-[14.5px] font-bold">{title}</span>
                    </span>
                    <span className="text-muted mt-[8px] block text-[12.5px] leading-[1.5] text-pretty">
                      {body}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        ) : null}

        <div className="mt-[22px] flex items-center gap-[8px]">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="h-[46px] rounded-[14px] border-0 bg-[rgb(20_20_20_/_0.05)] px-[18px] text-[14px] font-bold hover:bg-[rgb(20_20_20_/_0.08)]"
            >
              Back
            </button>
          ) : null}
          <button
            type="button"
            disabled={!canAdvance}
            onClick={() => {
              // Step one is the connect. Everything after it assumes a wallet.
              if (step === 0) connect()
              if (step === STEPS.length - 1) finish()
              else setStep((s) => s + 1)
            }}
            className="h-[46px] flex-1 rounded-[14px] border-0 bg-[linear-gradient(135deg,#FF4D00,#FF7A2E)] px-[18px] text-[14px] font-bold text-white shadow-[0_14px_28px_-14px_rgb(255_77_0_/_0.7)] transition-opacity disabled:opacity-40 disabled:shadow-none"
          >
            {step === 0
              ? 'Connect wallet'
              : step === STEPS.length - 1
                ? layout === 'ask'
                  ? 'Open AiKi'
                  : 'Open the market'
                : 'Continue'}
          </button>
        </div>

        {step === 1 && !task ? (
          <p className="text-muted mt-[10px] mb-0 text-center text-[12px]">
            Pick one to continue. You can hire more than one later.
          </p>
        ) : null}
      </main>
    </div>
  )
}
