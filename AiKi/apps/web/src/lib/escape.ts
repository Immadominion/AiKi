'use client'

import { useEffect, useRef } from 'react'

/**
 * One Escape, one layer.
 *
 * Every dismissable surface used to bind its own window keydown listener, so a
 * single press fired all of them at once: closing History also dropped you out
 * of full screen, and the command palette took full screen down with it. Three
 * listeners with no precedence is three bugs waiting to be reported separately.
 *
 * Layers register while they are open and unregister when they close, so the
 * stack is ordered by what is actually on top. Escape runs the topmost handler
 * and nothing else.
 */
type Handler = () => void

const stack: Handler[] = []
let bound = false

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  const top = stack.at(-1)
  if (!top) return
  // Capture phase plus stopPropagation, so a layer below cannot also react to
  // the same press through its own listener.
  e.stopPropagation()
  top()
}

function ensureBound() {
  if (bound) return
  window.addEventListener('keydown', onKeyDown, true)
  bound = true
}

export function useEscapeLayer(active: boolean, onEscape: Handler) {
  // The handler is read through a ref so a caller passing an inline arrow does
  // not churn the stack on every render.
  const latest = useRef(onEscape)
  latest.current = onEscape

  useEffect(() => {
    if (!active) return
    const handler = () => latest.current()
    stack.push(handler)
    ensureBound()
    return () => {
      const i = stack.lastIndexOf(handler)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [active])
}
