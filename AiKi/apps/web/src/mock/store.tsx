'use client'

import type { ApprovalMode, CapPeriod } from '@aiki/contracts'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentKey } from '@/lib/agents'
import { connectInjected, watchAccounts } from '@/lib/wallet'
import { buildReceipt, runStep } from './script'
import { demoState, freshState } from './seed'
import { EMPTY, type Hire, type Job, MOCK_VERSION, type MockState } from './types'

const KEY = 'aiki.mock.v1'

/**
 * The local mock backend.
 *
 * Everything the app would ask apps/api for lives here instead, in one place,
 * behind actions shaped like the API calls that will replace them. The point is
 * not fidelity — it is that the flow is genuinely stateful, so hiring an agent
 * with a $40 cap and then watching that exact cap refuse something is something
 * you can do rather than something you have to imagine.
 */
interface MockApi {
  state: MockState
  ready: boolean
  connect: () => Promise<'injected' | 'simulated' | 'rejected'>
  disconnect: () => void
  hire: (input: {
    key: AgentKey
    perActionCents: number
    capCents: number
    period: CapPeriod
    days: number
    approval: ApprovalMode
  }) => string
  advance: (jobId: string) => void
  approve: (jobId: string) => void
  decline: (jobId: string) => void
  pause: (key: AgentKey) => void
  resume: (key: AgentKey) => void
  revoke: (key: AgentKey) => void
  seed: (mode: 'demo' | 'fresh' | 'empty') => void
}

const Ctx = createContext<MockApi | null>(null)

export function useMock(): MockApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('useMock must be used inside <MockProvider>')
  return api
}

const read = (): MockState | null => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as MockState
    // A shape change should reset rather than crash a screen halfway down.
    return parsed?.version === MOCK_VERSION ? parsed : null
  } catch {
    return null
  }
}

const write = (s: MockState) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* a mock that cannot persist is still a working mock */
  }
}

let counter = 0
const nextId = (prefix: string) =>
  `${prefix}_${(++counter).toString().padStart(2, '0')}${Date.now().toString(36).slice(-3)}`

export function MockProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MockState>(EMPTY)
  const [ready, setReady] = useState(false)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    setState(read() ?? EMPTY)
    setReady(true)
  }, [])

  const commit = useCallback((next: MockState) => {
    const stamped = { ...next, seq: next.seq + 1 }
    setState(stamped)
    write(stamped)
  }, [])

  const patch = useCallback(
    (fn: (s: MockState) => MockState) => commit(fn(stateRef.current)),
    [commit],
  )

  useEffect(() => {
    return watchAccounts((accounts) => {
      const current = stateRef.current
      if (!current.connected || current.walletKind !== 'injected') return
      const address = accounts[0]
      commit(address ? { ...current, address } : { ...current, connected: false, chainId: null })
    })
  }, [commit])

  const api = useMemo<MockApi>(() => {
    const setHire = (s: MockState, key: AgentKey, fn: (h: Hire) => Hire): MockState => ({
      ...s,
      hires: s.hires.map((h) => (h.key === key ? fn(h) : h)),
    })
    const setJob = (s: MockState, id: string, fn: (j: Job) => Job): MockState => ({
      ...s,
      jobs: s.jobs.map((j) => (j.id === id ? fn(j) : j)),
    })

    return {
      state,
      ready,

      connect: () =>
        connectInjected().then((result) => {
          if (result.kind === 'connected') {
            patch((s) => ({
              ...s,
              connected: true,
              walletKind: 'injected',
              address: result.address,
              chainId: result.chainId,
            }))
            return 'injected' as const
          }
          if (result.kind === 'no_wallet') {
            // No extension: the demo stays walkable, and every surface that
            // shows the address labels it simulated.
            patch((s) => ({
              ...s,
              connected: true,
              walletKind: 'simulated',
              address: EMPTY.address,
              chainId: null,
            }))
            return 'simulated' as const
          }
          // A rejection is an answer; nothing changes and nothing pretends.
          return 'rejected' as const
        }),
      disconnect: () => patch((s) => ({ ...s, connected: false, chainId: null })),

      hire: (input) => {
        const jobId = nextId('job')
        const now = new Date().toISOString()
        const hire: Hire = {
          key: input.key,
          hiredAt: now,
          status: 'working',
          mandate: {
            perActionCents: input.perActionCents,
            capCents: input.capCents,
            period: input.period,
            expiresAt: new Date(Date.now() + input.days * 86_400_000).toISOString(),
            approval: input.approval,
          },
          spentCents: 0,
          jobId,
        }
        const job: Job = {
          id: jobId,
          key: input.key,
          title: TITLES[input.key],
          status: 'RUNNING',
          step: 0,
          createdAt: now,
          updatedAt: now,
          blockedOnce: false,
        }
        patch((s) => ({
          ...s,
          connected: true,
          // Re-hiring replaces the old authority rather than stacking two.
          hires: [...s.hires.filter((h) => h.key !== input.key), hire],
          jobs: [...s.jobs.filter((j) => j.key !== input.key), job],
        }))
        return jobId
      },

      advance: (jobId) =>
        patch((s) => {
          const job = s.jobs.find((j) => j.id === jobId)
          const hire = job ? s.hires.find((h) => h.key === job.key) : undefined
          if (!job || !hire) return s
          if (job.status !== 'RUNNING') return s

          const result = runStep(job, hire)
          if (!result) return setJob(s, jobId, (j) => ({ ...j, status: 'DONE' }))

          const now = new Date().toISOString()
          const events = result.events.map((e, i) => ({
            ...e,
            id: nextId('e'),
            at: new Date(Date.now() + i).toISOString(),
          }))
          const blocked = events.some((e) => e.result === 'Blocked')

          let next: MockState = {
            ...s,
            events: [...s.events, ...events],
          }

          if (result.spendCents) {
            next = setHire(next, job.key, (h) => ({
              ...h,
              spentCents: h.spentCents + (result.spendCents ?? 0),
            }))
          }

          next = setJob(next, jobId, (j) => ({
            ...j,
            step: j.step + 1,
            updatedAt: now,
            blockedOnce: j.blockedOnce || blocked,
            ...(result.approval
              ? {
                  status: 'WAITING' as const,
                  approval: {
                    ...result.approval,
                    id: nextId('apr'),
                    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                  },
                }
              : {}),
            ...(result.done ? { status: 'DONE' as const } : {}),
          }))

          if (result.done) {
            const finished = next.jobs.find((j) => j.id === jobId)
            if (finished) {
              const receipt = buildReceipt(finished, hire, next.events)
              next = {
                ...next,
                receipts: [...next.receipts.filter((r) => r.jobId !== jobId), receipt],
                jobs: next.jobs.map((j) => (j.id === jobId ? { ...j, receiptId: receipt.id } : j)),
              }
            }
          }

          return next
        }),

      approve: (jobId) =>
        patch((s) =>
          setJob(s, jobId, (j) => {
            const { approval: _dropped, ...rest } = j
            return { ...rest, status: 'RUNNING' as const }
          }),
        ),

      decline: (jobId) =>
        patch((s) => {
          const job = s.jobs.find((j) => j.id === jobId)
          if (!job) return s
          const declined = {
            id: nextId('e'),
            at: new Date().toISOString(),
            key: job.key,
            where: 'AiKi',
            what: 'You said no. Nothing was signed and nothing was spent.',
            costCents: 0,
            result: 'Blocked' as const,
            jobId,
          }
          return setJob({ ...s, events: [...s.events, declined] }, jobId, (j) => {
            const { approval: _dropped, ...rest } = j
            return { ...rest, status: 'DONE' as const }
          })
        }),

      pause: (key) =>
        patch((s) => {
          const withHire = setHire(s, key, (h) => ({ ...h, status: 'paused' }))
          const hire = s.hires.find((h) => h.key === key)
          return hire
            ? setJob(withHire, hire.jobId, (j) =>
                j.status === 'DONE' ? j : { ...j, status: 'PAUSED' },
              )
            : withHire
        }),

      resume: (key) =>
        patch((s) => {
          const withHire = setHire(s, key, (h) => ({ ...h, status: 'working' }))
          const hire = s.hires.find((h) => h.key === key)
          return hire
            ? setJob(withHire, hire.jobId, (j) =>
                j.status === 'PAUSED' ? { ...j, status: 'RUNNING' } : j,
              )
            : withHire
        }),

      revoke: (key) =>
        patch((s) => {
          const hire = s.hires.find((h) => h.key === key)
          const revoked = {
            id: nextId('e'),
            at: new Date().toISOString(),
            key,
            where: 'BNB Chain',
            what: 'You revoked its authority on chain. It cannot act again without a new signature.',
            costCents: 4,
            result: 'Done' as const,
          }
          return {
            ...s,
            events: [...s.events, revoked],
            hires: s.hires.filter((h) => h.key !== key),
            jobs: hire ? s.jobs.filter((j) => j.id !== hire.jobId) : s.jobs,
          }
        }),

      seed: (mode) =>
        commit(mode === 'demo' ? demoState() : mode === 'fresh' ? freshState() : EMPTY),
    }
  }, [state, ready, patch, commit])

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

const TITLES: Record<AgentKey, string> = {
  guardian: 'Protecting your Venus loan',
  sentinel: 'Watching your Venus position',
  lpilot: 'Keeping your BNB / USDT position in range',
  gridly: 'Managing BNB / USDT',
  yieldmax: 'Moving idle USDT to a better rate',
  harbor: 'Moving idle stablecoins',
}
