'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

const ToastCtx = createContext<(msg: string) => void>(() => {})

/** `say()` from anywhere below the provider. Same 3.2s dwell as the reference. */
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({
  children,
  bottom = 26,
}: {
  children: React.ReactNode
  bottom?: number
}) {
  const [msg, setMsg] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const say = useCallback((next: string) => {
    clearTimeout(timer.current)
    setMsg(next)
    timer.current = setTimeout(() => setMsg(''), 3200)
  }, [])

  const value = useMemo(() => say, [say])

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed left-1/2 z-95 -translate-x-1/2"
        style={{ bottom }}
      >
        {msg ? (
          <div className="animate-rise bg-ink-app max-w-[520px] rounded-[14px] px-[18px] py-3 text-center text-[13px] font-medium text-white shadow-[0_20px_46px_-16px_rgb(26_26_25_/_0.5)]">
            {msg}
          </div>
        ) : null}
      </div>
    </ToastCtx.Provider>
  )
}
