'use client'

import { useEffect, useState } from 'react'
import { api, type Enforcement } from '@/lib/api'

/**
 * What the chain would actually hold, asked while the limits are being chosen.
 *
 * The builder used to derive every tier from `lib/detail.ts`, which is a fixture
 * file. That was fine when nothing was deployed and every answer was T2 anyway,
 * and it stops being fine the moment some of those limits are really held by a
 * contract: a badge computed from a fixture is a claim about enforcement that
 * nothing checked.
 *
 * So the verdict comes from the API, which derives it from its deployed enforcer
 * set and overwrites whatever tier we sent. Until it answers the state is
 * `asking`, which is not `T2` and must not render as one. Saying "AiKi counts
 * this" before we know is the same failure as the coverage block asserting the
 * evidence API was unreachable before it had been asked.
 */
export type PreviewState =
  | { status: 'asking' }
  | { status: 'ready'; enforcement: Enforcement }
  | { status: 'unavailable' }

export function useMandatePreview(constraints: unknown[]): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'asking' })
  // The constraints are rebuilt on every keystroke of a slider, so the effect is
  // keyed on their content rather than the array identity, and a slow answer for
  // limits the user has already moved past is discarded rather than rendered.
  const key = JSON.stringify(constraints)

  useEffect(() => {
    let alive = true
    setState({ status: 'asking' })
    api.previewMandate(JSON.parse(key)).then(
      (enforcement) => alive && setState({ status: 'ready', enforcement }),
      () => alive && setState({ status: 'unavailable' }),
    )
    return () => {
      alive = false
    }
  }, [key])

  return state
}

/** The limit for one constraint kind, or null while we do not know. */
export const limitFor = (state: PreviewState, kind: string) =>
  state.status === 'ready' ? (state.enforcement.limits.find((l) => l.kind === kind) ?? null) : null

/**
 * How a rule is described to the person setting it.
 *
 * Every badge on this screen answers one question: WHO holds this rule. That is
 * the useful thing and it is the only thing the badge should say. An earlier
 * version of this turned the hire screen into a list of AiKi's own gaps -- three
 * amber warnings, an internal compiler reason printed twice, and a badge reading
 * "Not sent", which describes our plumbing and means nothing to somebody deciding
 * whether to trust an agent. Not overstating what is enforced does not mean
 * leading with what is not.
 *
 * So: AiKi holding a rule is a normal, good state and reads as one. It is real
 * protection -- a cap AiKi refuses to relay past stops a buggy or misbehaving
 * agent, which is what most people are actually worried about. Amber is kept for
 * something genuinely wrong, and there is nothing wrong here.
 *
 * The network caveat is true and it is said once, in the summary, rather than
 * stapled to every badge. Repeating a caveat is not more honest than saying it
 * clearly.
 */
export function tierWording(
  state: PreviewState,
  tier: 'T0' | 'T2' | null,
): {
  word: string
  means: string
  weak: boolean
} {
  if (state.status === 'asking')
    return { word: 'Checking', means: 'Working out who holds this rule.', weak: false }
  if (state.status === 'unavailable' || tier === null)
    return {
      word: 'AiKi',
      means: 'AiKi refuses to relay anything past this limit.',
      weak: false,
    }
  if (tier === 'T2')
    return {
      word: 'AiKi',
      means:
        'AiKi refuses to relay anything past this limit. It stops a buggy or misbehaving agent.',
      weak: false,
    }
  return {
    word: 'On-chain',
    means: 'The chain itself refuses the transaction, so this holds even against AiKi.',
    weak: false,
  }
}

/**
 * The one place the network and the audit are named.
 *
 * Hard rule 6 is that nothing may claim an enforcer that does not exist, and
 * these do exist -- on a test network, unaudited. That belongs in the summary
 * where somebody reads it once while deciding, not repeated beside every control
 * where it becomes noise people learn to skip.
 */
export function enforcementNote(state: PreviewState): string | null {
  if (state.status !== 'ready') return null
  const { network, audited, limits } = state.enforcement
  if (!limits.some((l) => l.tier === 'T0')) return null
  if (network === 'mainnet' && audited) return null
  const where = network === 'mainnet' ? 'BNB Chain' : 'the BNB test network'
  return `The on-chain rules above are held by AiKi contracts on ${where}, which have not been audited yet.`
}
