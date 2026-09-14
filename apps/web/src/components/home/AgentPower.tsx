'use client'

import { type AgentPower, useAgentPower } from '@/components/shell/prefs'

/**
 * How much the agent may do on its own, beside the thing you type.
 *
 * Modelled on the mode control in a coding agent rather than on a settings
 * page: current state visible without opening anything, one press to change,
 * and it sits where the decision is made. A choice buried two screens away is a
 * choice nobody makes, and this one decides whether money moves without being
 * asked about.
 *
 * Three words each, because the label is read in passing.
 */
export const POWER_LABEL: Record<AgentPower, string> = {
  every: 'Asks me first',
  over: 'Asks above a limit',
  never: 'Acts on its own',
}

const POWER_DETAIL: Record<AgentPower, string> = {
  every: 'Nothing moves until you answer',
  over: 'Acts below the amount you set, asks above it',
  never: 'Spends inside the caps without asking',
}

export function AgentPowerControl({ className = '' }: { className?: string }) {
  const { power, ready, cycle } = useAgentPower()
  // Storage is client-only, so show nothing rather than flash the wrong answer.
  if (!ready) return null
  return (
    <button
      type="button"
      onClick={cycle}
      title={POWER_DETAIL[power]}
      aria-label={`Agent power: ${POWER_LABEL[power]}. ${POWER_DETAIL[power]}. Press to change.`}
      className={`inline-flex min-h-8 items-center gap-2 rounded-full border border-[rgb(26_26_25_/_0.14)] bg-white px-3 text-[12px] font-semibold hover:border-[rgb(26_26_25_/_0.3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app ${className}`}
    >
      <span
        aria-hidden
        className="size-[7px] rounded-full"
        style={{
          background:
            power === 'never'
              ? 'var(--color-orange)'
              : power === 'over'
                ? 'rgb(26 26 25 / 0.45)'
                : 'rgb(26 26 25 / 0.2)',
        }}
      />
      {POWER_LABEL[power]}
    </button>
  )
}
