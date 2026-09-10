import type { ReactNode } from 'react'

/** Keep conversation controls clear of the panel's floating corner controls. */
export function FastChatHeader({
  fullScreen,
  children,
}: {
  fullScreen: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={`mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2 pr-12 ${
        fullScreen ? 'pl-12 md:pr-14 md:pl-16' : ''
      }`}
    >
      {children}
    </div>
  )
}
