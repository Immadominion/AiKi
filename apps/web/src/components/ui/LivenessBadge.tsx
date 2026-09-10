import type { LivenessState } from '@aiki/contracts'
import { probeFreshness } from '@aiki/contracts/probe-freshness'
import type { Tone } from './StatusPill'
import { StatusPill } from './StatusPill'

/**
 * Liveness in plain language.
 *
 * Seven answers to "is it online", and the difference between them is the most
 * valuable thing we know - so none of them reaches a user as an enum. The one
 * that matters most is IMPOSTOR_STATIC: an endpoint returning 200 with the same
 * bytes whatever you ask it. A third of the BSC registry does this, and every
 * other explorer shows those agents as healthy.
 */
export const LIVENESS_LABEL: Record<LivenessState, string> = {
  LIVE: 'Answering',
  DEGRADED: 'Slow and patchy',
  UNREACHABLE: 'Not answering',
  IMPOSTOR_STATIC: 'Not a real agent',
  PLACEHOLDER_URL: 'Address is not real',
  NOT_REMOTE: 'Cannot be called',
  DECLARED_ONLY: 'Nothing to call',
  UNPROBED: 'Not tested yet',
}

export const LIVENESS_DETAIL: Record<LivenessState, string> = {
  LIVE: 'It answers, and it answers differently depending on what you ask.',
  DEGRADED: 'It answers, but some probes time out or take seconds to come back.',
  UNREACHABLE: 'Nothing answered at the address it published.',
  IMPOSTOR_STATIC:
    'It returns the same bytes whatever you ask it, including for positions that do not exist. It is a page, not an agent.',
  PLACEHOLDER_URL: 'The address it registered is a placeholder like localhost or example.com.',
  NOT_REMOTE: 'It declared a local transport. There is nothing to call over the network.',
  DECLARED_ONLY: 'It registered an identity but published no endpoint at all.',
  UNPROBED: 'We have not run our own checks against this one yet.',
}

const TONE: Record<LivenessState, Tone> = {
  LIVE: 'good',
  DEGRADED: 'warn',
  UNREACHABLE: 'warn',
  IMPOSTOR_STATIC: 'work',
  PLACEHOLDER_URL: 'work',
  NOT_REMOTE: 'idle',
  DECLARED_ONLY: 'idle',
  UNPROBED: 'idle',
}

export function livenessPresentation(
  state: LivenessState,
  lastProbeAt: string | null | undefined,
  nowMs = Date.now(),
): { label: string; tone: Tone } {
  if (state === 'UNPROBED') return { label: LIVENESS_LABEL.UNPROBED, tone: 'idle' }
  const freshness = probeFreshness(lastProbeAt ?? null, nowMs)
  if (freshness.state === 'NO_DATA' || freshness.ageMs === null)
    return { label: 'Check needed', tone: 'idle' }
  if (freshness.state !== 'LIVE')
    return { label: `Last known: ${LIVENESS_LABEL[state].toLowerCase()}`, tone: 'idle' }
  return { label: LIVENESS_LABEL[state], tone: TONE[state] }
}

export function LivenessBadge({
  state,
  lastProbeAt,
}: {
  state: LivenessState
  lastProbeAt: string | null
}) {
  const presentation = livenessPresentation(state, lastProbeAt)
  return <StatusPill {...presentation} wrap />
}
