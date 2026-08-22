'use client'

import { useCallback, useEffect, useState } from 'react'

export type HomeLayout = 'ask' | 'market'

const KEY = 'aiki.home-layout'

/**
 * Which home the user lands on — the single question, or the market.
 *
 * Persisted per browser rather than per session so the choice survives a reload,
 * and read defensively: private windows and blocked site data both make storage
 * throw, and the app has to render correctly with no stored value at all.
 */
export function useLayoutPref() {
  const [layout, setState] = useState<HomeLayout>('ask')

  useEffect(() => {
    try {
      const stored = localStorage.getItem(KEY)
      if (stored === 'ask' || stored === 'market') setState(stored)
    } catch {
      /* no stored value is a valid state */
    }
  }, [])

  const setLayout = useCallback((next: HomeLayout) => {
    setState(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      /* preference is a convenience, never a requirement */
    }
  }, [])

  return { layout, setLayout }
}
