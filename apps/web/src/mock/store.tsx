'use client'

import type { ApprovalMode, CapPeriod } from '@aiki/contracts'
import type { ExecutionNetwork } from '@aiki/contracts/guardian'
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { activateGuardianMandate } from '@/components/hire/guardian-activation'
import { mandateConstraints } from '@/components/hire/mandate'
import { WalletPicker } from '@/components/shell/WalletPicker'
import { api as backend } from '@/lib/api'
import {
  type ConnectOutcome,
  connectInjected,
  discoverWallets,
  readInjectedAccount,
  restoreWalletSession,
  selectWallet,
  signIn,
  signMandate,
  signOut,
  type WalletOption,
  walletReadyForRestore,
  watchAccounts,
} from '@/lib/wallet'
import { subscribeWalletSession, walletSession } from '@/lib/wallet-session'
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
 * not fidelity - it is that the flow is genuinely stateful, so hiring an agent
 * with a $40 cap and then watching that exact cap refuse something is something
 * you can do rather than something you have to imagine.
 */
interface MockApi {
  state: MockState
  ready: boolean
  authenticated: boolean
  connectionPhase: 'idle' | 'choosing' | 'connecting' | 'signing'
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
    execution?: ExecutionNetwork
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
  const [authenticated, setAuthenticated] = useState(false)
  const [connectionPhase, setConnectionPhase] = useState<
    'idle' | 'choosing' | 'connecting' | 'signing'
  >('idle')
  const [wallets, setWallets] = useState<WalletOption[]>([])
  const [choosingWallet, setChoosingWallet] = useState(false)
  const walletChoice = useRef<((wallet: WalletOption | null) => void) | null>(null)
  const connectionPromise = useRef<Promise<ConnectOutcome> | null>(null)
  const connectAttempt = useRef(0)
  const requestingConnection = useRef<number | null>(null)
  const bootstrapped = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state

  const commit = useCallback((next: MockState) => {
    const stamped = { ...next, seq: next.seq + 1 }
    stateRef.current = stamped
    setState(stamped)
    write(stamped)
  }, [])

  const patch = useCallback(
    (fn: (s: MockState) => MockState) => commit(fn(stateRef.current)),
    [commit],
  )

  useEffect(() => discoverWallets(setWallets), [])
  useEffect(
    () =>
      subscribeWalletSession(() => {
        setAuthenticated(walletSession().address === stateRef.current.address.toLowerCase())
      }),
    [],
  )

  useEffect(() => {
    if (bootstrapped.current) return
    // An explicit connection owns the account now, even if its prompt is declined.
    if (connectAttempt.current !== 0) {
      bootstrapped.current = true
      setReady(true)
      return
    }
    const saved = read()
    if (saved?.connected && saved.walletKind === 'injected' && !walletReadyForRestore(wallets)) {
      // Keep browsing available while the preferred extension announces itself.
      // Retain the saved connection and retry when discovery updates `wallets`.
      setReady(true)
      return
    }
    let cancelled = false
    const attempt = connectAttempt.current
    const restore = async () => {
      try {
        if (saved?.walletKind === 'simulated' && process.env.NODE_ENV !== 'production') {
          commit(saved)
        } else if (saved?.connected && saved.walletKind === 'injected') {
          const account = await readInjectedAccount()
          if (cancelled || attempt !== connectAttempt.current) return
          if (account) {
            const sameWallet = account.address.toLowerCase() === saved.address.toLowerCase()
            commit({
              ...(sameWallet ? saved : EMPTY),
              ...account,
              connected: true,
              walletKind: 'injected',
            })
            const signedIn = await restoreWalletSession(account.address, account.chainId)
            if (cancelled || attempt !== connectAttempt.current) return
            setAuthenticated(signedIn)
          } else {
            await signOut()
            if (cancelled || attempt !== connectAttempt.current) return
            commit({ ...EMPTY, address: '' })
          }
        } else {
          await signOut()
          if (cancelled || attempt !== connectAttempt.current) return
          commit({ ...EMPTY, address: '' })
        }
      } finally {
        // A superseded account attempt must not leave every private page loading.
        if (!cancelled) {
          bootstrapped.current = true
          setReady(true)
        }
      }
    }
    void restore()
    return () => {
      cancelled = true
    }
  }, [commit, wallets])

  useEffect(() => {
    return watchAccounts(
      (accounts) => {
        const current = stateRef.current
        if (current.walletKind !== 'injected') return
        const address = accounts[0]
        if (address?.toLowerCase() === current.address.toLowerCase()) return
        if (requestingConnection.current !== connectAttempt.current) ++connectAttempt.current
        // Invalidates local credentials immediately, before the logout request settles.
        void signOut()
        setAuthenticated(false)
        commit({
          ...EMPTY,
          connected: Boolean(address),
          walletKind: 'injected',
          address: address ?? '',
          chainId: address ? current.chainId : null,
        })
      },
      (chainId) => {
        const current = stateRef.current
        if (current.walletKind !== 'injected' || current.chainId === chainId) return
        if (requestingConnection.current !== connectAttempt.current) ++connectAttempt.current
        void signOut()
        setAuthenticated(false)
        commit({ ...current, chainId })
      },
    )
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
      authenticated,
      connectionPhase,

      connect: () => {
        if (connectionPromise.current) return connectionPromise.current
        const request = (async (): Promise<ConnectOutcome> => {
          if (walletChoice.current) return 'rejected'
          if (wallets.length) {
            setConnectionPhase('choosing')
            const chosen = await new Promise<WalletOption | null>((resolve) => {
              walletChoice.current = resolve
              setChoosingWallet(true)
            })
            if (!chosen) return 'rejected'
            selectWallet(chosen)
          }
          setConnectionPhase('connecting')
          const attempt = ++connectAttempt.current
          void signOut()
          setAuthenticated(false)
          requestingConnection.current = attempt
          const result = await connectInjected().finally(() => {
            if (requestingConnection.current === attempt) requestingConnection.current = null
          })
          if (attempt !== connectAttempt.current) return 'unsigned'
          if (result.kind === 'connected') {
            patch((s) => ({
              ...(s.address.toLowerCase() === result.address.toLowerCase() ? s : EMPTY),
              connected: true,
              walletKind: 'injected',
              address: result.address,
              chainId: result.chainId,
            }))
            // Reading an address is not proving it. Declining the signature
            // still leaves you connected, just unable to authorize anything.
            setConnectionPhase('signing')
            const proof = await signIn(result.address, result.chainId)
            if (attempt !== connectAttempt.current) return 'unsigned'
            setAuthenticated(proof === 'signed-in')
            setReady(true)
            return proof === 'signed-in' ? ('injected' as const) : ('unsigned' as const)
          }
          if (result.kind === 'no_wallet') {
            commit({ ...EMPTY, address: '' })
            return 'no_wallet' as const
          }
          // A rejection is an answer; nothing changes and nothing pretends.
          return 'rejected' as const
        })()
        const tracked = request.finally(() => {
          if (connectionPromise.current === tracked) {
            connectionPromise.current = null
            setConnectionPhase('idle')
          }
        })
        connectionPromise.current = tracked
        return tracked
      },
      disconnect: () => {
        ++connectAttempt.current
        requestingConnection.current = null
        connectionPromise.current = null
        setConnectionPhase('idle')
        const finishChoice = walletChoice.current
        walletChoice.current = null
        setChoosingWallet(false)
        finishChoice?.(null)
        void signOut()
        setAuthenticated(false)
        commit({ ...EMPTY, address: '' })
      },

      hire: async (input) => {
        const now = new Date().toISOString()
        const expiresAt = new Date(Date.now() + input.days * 86_400_000).toISOString()

        // A real wallet gets a real mandate: the API records it against the
        // address that signed in, and the cap it returns is the one the server
        // enforces. A simulated wallet stays local, and every screen says so.
        let authorizationId: string | undefined
        if (stateRef.current.walletKind === 'injected') {
          if (
            !stateRef.current.connected ||
            walletSession().address !== stateRef.current.address.toLowerCase()
          )
            throw new Error('Sign in with your connected wallet before hiring an agent.')
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
          if (input.key === 'guardian' && !input.execution)
            throw new Error('Verify the execution network before signing a Guardian mandate.')
          const activated = input.execution
            ? await activateGuardianMandate(
                {
                  capCents: input.capCents,
                  perActionCents: input.perActionCents,
                  days: input.days,
                  spends: input.spends,
                  callScope: input.callScope,
                  approval: { mode: input.approval, thresholdCents: input.askAboveCents },
                },
                input.execution,
                stateRef.current.address ?? '',
              )
            : null
          const authorization = activated?.authorization ?? (await backend.authorize(constraints))
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
          if (!activated) {
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
          }

          const job =
            activated?.job ??
            (await backend.createJob(authorization.id, `hire:${authorization.id}`))
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

        if (process.env.NODE_ENV === 'production') {
          throw new Error('Connect a wallet and sign in before hiring an agent.')
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

      seed: (mode) => {
        if (process.env.NODE_ENV === 'production') return
        void signOut()
        setAuthenticated(false)
        commit(mode === 'demo' ? demoState() : mode === 'fresh' ? freshState() : EMPTY)
      },
    }
  }, [state, ready, authenticated, connectionPhase, wallets, patch, commit])

  const finishWalletChoice = (wallet: WalletOption | null) => {
    const resolve = walletChoice.current
    walletChoice.current = null
    setChoosingWallet(false)
    resolve?.(wallet)
  }

  return (
    <Ctx.Provider value={api}>
      {/* Clear private screen state when its wallet or sign-in changes. */}
      <Fragment key={`${state.address}:${state.chainId}:${authenticated}`}>{children}</Fragment>
      {choosingWallet ? (
        <WalletPicker
          wallets={wallets}
          onSelect={finishWalletChoice}
          onClose={() => finishWalletChoice(null)}
        />
      ) : null}
    </Ctx.Provider>
  )
}

const TITLES: Record<string, string> = {
  guardian: 'Protecting your Venus loan',
  sentinel: 'Watching your Venus position',
  lpilot: 'Keeping your BNB / USDT position in range',
  gridly: 'Managing BNB / USDT',
  yieldmax: 'Moving idle USDT to a better rate',
  harbor: 'Moving idle stablecoins',
}
