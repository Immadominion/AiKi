'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Per-browser preferences.
 *
 * Read defensively and written the same way: a private window, cleared site data
 * or a browser set to block storage all make these throw, and the app has to
 * render correctly with no stored value at all. None of this is data worth
 * keeping — it is convenience, and convenience that breaks the page is not.
 */
function usePersisted<T extends string>(key: string, fallback: T, valid: readonly T[]) {
  const [value, setValue] = useState<T>(fallback)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored && (valid as readonly string[]).includes(stored)) setValue(stored as T)
    } catch {
      /* no stored value is a valid state */
    }
  }, [key, valid])

  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, next)
      } catch {
        /* a preference is never a requirement */
      }
    },
    [key],
  )

  return [value, set] as const
}

export type HomeLayout = 'ask' | 'market'
const LAYOUTS = ['ask', 'market'] as const

export function useLayoutPref() {
  const [layout, setLayout] = usePersisted<HomeLayout>('aiki.home-layout', 'ask', LAYOUTS)
  return { layout, setLayout }
}

const SIDEBAR = ['open', 'closed'] as const

export function useSidebar() {
  const [state, setState] = usePersisted<'open' | 'closed'>('aiki.sidebar', 'open', SIDEBAR)
  const collapsed = state === 'closed'
  return { collapsed, toggle: () => setState(collapsed ? 'open' : 'closed') }
}
