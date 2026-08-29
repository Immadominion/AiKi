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
 * How a tier may be described out loud.
 *
 * T0 on a test network is still T0 in the type system and is not "the chain
 * refuses this" to a reader, who will take that to be about their own money. The
 * qualifier is part of the sentence, not a footnote under it.
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
    return { word: 'Checking', means: 'Asking what the chain will hold.', weak: true }
  if (state.status === 'unavailable' || tier === null)
    return {
      word: 'AiKi only',
      means: 'We could not reach the enforcement check, so treat this as counted by AiKi.',
      weak: true,
    }
  if (tier === 'T2')
    return {
      word: 'AiKi only',
      means:
        'AiKi refuses to relay it. Holds against a buggy agent, not against a compromised AiKi.',
      weak: true,
    }
  const network = state.enforcement.network
  const onMainnet = network === 'mainnet'
  return {
    word: onMainnet ? 'On-chain' : 'On-chain, testnet',
    means: onMainnet
      ? 'The chain refuses the transaction. Holds even if AiKi and the agent are both compromised.'
      : 'The chain refuses the transaction, on the BNB test network, against contracts nobody has audited yet.',
    // Not a real guarantee about real money until it is on mainnet and audited,
    // so it does not get to look like one.
    weak: !onMainnet || !state.enforcement.audited,
  }
}
