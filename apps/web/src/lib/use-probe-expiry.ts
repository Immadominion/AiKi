'use client'

import { PROBE_FRESHNESS_MAX_AGE_MS } from '@aiki/contracts/probe-freshness'
import { useEffect, useState } from 'react'

/** Re-evaluate retained evidence at its next expiry, including after a background tab resumes. */
export function useProbeExpiry(timestamps: readonly (string | null | undefined)[]): void {
  const key = JSON.stringify(timestamps)
  const [revision, setRevision] = useState(0)
  const renderedAt = Date.now()
  useEffect(() => {
    if (typeof document === 'undefined') return
    const refresh = () => setRevision(revision + 1)
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') refresh()
    }
    const now = Date.now()
    const expires = (JSON.parse(key) as (string | null)[])
      .filter((value): value is string => value !== null)
      .map((value) => Date.parse(value) + PROBE_FRESHNESS_MAX_AGE_MS + 1)
      .filter((value) => Number.isFinite(value) && value > renderedAt)
    const timer = expires.length
      ? // A cutoff crossed between render and effect setup still needs a repaint.
        setTimeout(refresh, Math.max(0, Math.min(2_147_483_647, Math.min(...expires) - now)))
      : null
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [key, revision, renderedAt])
}
