import type { LivenessState } from '@aiki/contracts'
import { probeFreshness } from '@aiki/contracts/probe-freshness'
import type { Tone } from './StatusPill'
import { StatusPill } from './StatusPill'

/**
 * Liveness in plain language.
 *
 * Describe the check, not the provider's entire business. A shared server can
 * return identical metadata for different registered identities. Missing
 * identity proof, authentication and latency can all need review; none alone
 * proves that an agent is fake or cannot work through another integration.
 */
export const LIVENESS_LABEL: Record<LivenessState, string> = {
  LIVE: 'Answering',
  DEGRADED: 'Requires review',
  UNREACHABLE: 'Not answering',
  IMPOSTOR_STATIC: 'Identical responses',
  PLACEHOLDER_URL: 'Placeholder address',
  NOT_REMOTE: 'Local connection',
  DECLARED_ONLY: 'No remote service',
  UNPROBED: 'Not tested yet',
}

export const LIVENESS_DETAIL: Record<LivenessState, string> = {
  LIVE: 'The published service answered AiKi’s checks. This does not confirm support for every job or permission to use your funds.',
  DEGRADED:
    'The service responded, but some connection or identity checks remain incomplete. Open the agent for details.',
  UNREACHABLE: 'AiKi could not complete a connection check at the published address.',
  IMPOSTOR_STATIC:
    'The checked URLs returned identical responses. That may be static metadata or a shared endpoint; it does not establish whether the provider’s other services work.',
  PLACEHOLDER_URL: 'The address it registered is a placeholder like localhost or example.com.',
  NOT_REMOTE: 'It declared a local transport, not a remote service AiKi can connect to.',
  DECLARED_ONLY: 'This registration has no remote service AiKi can check.',
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
