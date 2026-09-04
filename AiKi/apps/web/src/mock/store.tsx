'use client'

import type { ApprovalMode, CapPeriod } from '@aiki/contracts'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { mandateConstraints } from '@/components/hire/mandate'
import type { AgentKey } from '@/lib/agents'
import { api as backend } from '@/lib/api'
import { DETAILS } from '@/lib/detail'
import {
  type ConnectOutcome,
  connectInjected,
  signIn,
  signMandate,
  signOut,
  watchAccounts,
} from '@/lib/wallet'
import { buildReceipt, runStep } from './script'
import { demoState, freshState } from './seed'
import type { ListingKey } from './types'
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
  connect: () => Promise<ConnectOutcome>
  disconnect: () => void
  hire: (input: {
    key: ListingKey
    perActionCents: number
    capCents: number
    period: CapPeriod
    days: number
    approval: ApprovalMode
    /** Where "ask me over an amount" starts asking. Ignored by the other modes. */
    askAboveCents: number
    /** What this job is called in your list. */
    title: string
    /** What was hired, so every later screen reads it instead of a fixture. */
    name: string
    initial: string
    bg: string
    /**
     * What the agent may move, supplied by the caller.
     *
     * This was read out of the example table, so hiring anything not in that
     * table was impossible: there was no row to read the permission from.
     */
    spends: { asset: `0x${string}`; symbol: string; decimals: number }[]
    callScope?:
      | {
          contracts: `0x${string}`[]
          selectors: string[]
          label: string
        }
      | undefined
    /**
     * The job id, and who ends up holding the limits. `signed` means the chain
     * refuses anything past them; `counted` means AiKi does. A hire is real
     * either way and the difference has to reach the person, so it is returned
     * rather than swallowed.
     */
  }) => Promise<{ jobId: string; mandate: 'signed' | 'counted' }>
  advance: (jobId: string) => void
  approve: (jobId: string) => void
  decline: (jobId: string) => void
  pause: (key: ListingKey) => void
  resume: (key: ListingKey) => void
  revoke: (key: ListingKey) => Promise<void>
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
    const setHire = (s: MockState, key: ListingKey, fn: (h: Hire) => Hire): MockState => ({
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
        connectInjected().then(async (result) => {
          if (result.kind === 'connected') {
            patch((s) => ({
              ...s,
              connected: true,
              walletKind: 'injected',
              address: result.address,
              chainId: result.chainId,
            }))
            // Reading an address is not proving it. Declining the signature
            // still leaves you connected, just unable to authorize anything.
            const proof = await signIn(result.address, result.chainId)
            return proof === 'signed-in' ? ('injected' as const) : ('unsigned' as const)
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
      disconnect: () => {
        void signOut()
        patch((s) => ({ ...s, connected: false, chainId: null }))
      },

      hire: async (input) => {
        const now = new Date().toISOString()
        const expiresAt = new Date(Date.now() + input.days * 86_400_000).toISOString()

        // A real wallet gets a real mandate: the API records it against the
        // address that signed in, and the cap it returns is the one the server
        // enforces. A simulated wallet stays local, and every screen says so.
        let authorizationId: string | undefined
        if (stateRef.current.walletKind === 'injected') {
          // Built by the same function the builder previews, so what was shown
          // and what is created cannot drift apart.
          const constraints = mandateConstraints({
            capCents: input.capCents,
            perActionCents: input.perActionCents,
            days: input.days,
            spends: input.spends,
            callScope: input.callScope,
            // Sent with the mandate, which it was not before: the choice lived
            // in this browser and the agent acted regardless of it.
            approval: { mode: input.approval, thresholdCents: input.askAboveCents },
          })
          // No silent fallback to a local mandate: a limit the server never
          // heard of is not a limit, and pretending otherwise is the one thing
          // this product cannot do.
          const authorization = await backend.authorize(constraints)
          authorizationId = authorization.id

          /*
           * Turn the mandate into authority the chain holds.
           *
           * A connected production wallet is not hired until the delegation is
           * accepted. Continuing after a declined or invalid signature creates a
           * job that cannot act, then lets the local demo runner invent progress
           * for it. Throwing here keeps the job list aligned with what the agent
           * can actually do.
           */
          const existing = await backend.account()
          const account = existing.address ?? (await backend.createAccount()).address
          const prep = await backend.prepareDelegation(authorization.id, account)
          const signature = await signMandate(stateRef.current.address ?? '', {
            domain: prep.domain,
            types: prep.types,
            primaryType: prep.primaryType,
            message: prep.message,
          })
          if (signature === 'declined') throw new Error('The mandate signature was declined.')
          await backend.fileDelegation(authorization.id, { ...prep.unsigned, signature })

          const job = await backend.createJob(authorization.id, `hire:${authorization.id}`)
          const hire: Hire = {
            key: input.key,
            name: input.name,
            initial: input.initial,
            bg: input.bg,
            hiredAt: now,
            status: 'working',
            mandate: {
              perActionCents: input.perActionCents,
              capCents: input.capCents,
              period: input.period,
              expiresAt,
              approval: input.approval,
            },
            spentCents: 0,
            jobId: job.id,
            authorizationId,
          }
          const remoteJob: Job = {
            id: job.id,
            key: input.key,
            title: TITLES[input.key] ?? input.title,
            status: 'RUNNING',
            step: 0,
            createdAt: now,
            updatedAt: now,
            blockedOnce: false,
          }
          patch((s) => ({
            ...s,
            connected: true,
            hires: [...s.hires.filter((h) => h.key !== input.key), hire],
            jobs: [...s.jobs.filter((j) => j.key !== input.key), remoteJob],
          }))
          return { jobId: job.id, mandate: 'signed' as const }
        }

        const jobId = nextId('job')
        const hire: Hire = {
          key: input.key,
          name: input.name,
          initial: input.initial,
          bg: input.bg,
          hiredAt: now,
          status: 'working',
          mandate: {
            perActionCents: input.perActionCents,
            capCents: input.capCents,
            period: input.period,
            expiresAt,
            approval: input.approval,
          },
          spentCents: 0,
          jobId,
        }
        const job: Job = {
          id: jobId,
          key: input.key,
          title: TITLES[input.key] ?? input.title,
          status: 'RUNNING',
          step: 0,
          createdAt: now,
          updatedAt: now,
          blockedOnce: false,
        }
        patch((s) => ({
          ...s,
          connected: true,
          hires: [...s.hires.filter((h) => h.key !== input.key), hire],
          jobs: [...s.jobs.filter((j) => j.key !== input.key), job],
        }))
        // A simulated wallet signs nothing, so nothing is on chain and saying
        // otherwise here would be the one lie this product cannot tell.
        return { jobId, mandate: 'counted' as const }
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

      revoke: async (key) => {
        // A mandate the server knows about is withdrawn at the server. Filtering
        // an array in this browser while telling someone their authority is gone
        // is the one lie in this product that could cost them money.
        const hire = stateRef.current.hires.find((h) => h.key === key)
        if (hire?.authorizationId) await backend.revokeAuthorization(hire.authorizationId)

        const now = new Date().toISOString()
        patch((s) => ({
          ...s,
          hires: s.hires.filter((h) => h.key !== key),
          jobs: s.jobs.filter((j) => j.key !== key),
          events: [
            {
              id: nextId('evt'),
              at: now,
              key,
              jobId: hire?.jobId ?? '',
              where: 'AiKi',
              what: 'You withdrew its authority. AiKi will not relay for it again.',
              costCents: 0,
              result: 'Done' as const,
            },
            ...s.events,
          ],
        }))
      },

      seed: (mode) =>
        commit(mode === 'demo' ? demoState() : mode === 'fresh' ? freshState() : EMPTY),
    }
  }, [state, ready, patch, commit])

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

const TITLES: Record<string, string> = {
  guardian: 'Protecting your Venus loan',
  sentinel: 'Watching your Venus position',
  lpilot: 'Keeping your BNB / USDT position in range',
  gridly: 'Managing BNB / USDT',
  yieldmax: 'Moving idle USDT to a better rate',
  harbor: 'Moving idle stablecoins',
}
