'use client'

import { ScanIcon, XIcon } from '@animateicons/react/lucide'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { FirstRun } from '@/components/onboarding/FirstRun'
import { useAccount } from '@/components/shell/prefs'
import { IconButton } from '@/components/ui/AnimatedIcon'
import { useToast } from '@/components/ui/Toast'
import { useEscapeLayer } from '@/lib/escape'
import { route } from '@/lib/routes'
import { FastCore, FastDecor } from './FastCore'
import { HoverNav } from './HoverNav'
import { PANEL, SCREEN } from './shards'

/**
 * Fast mode inside the app panel, and the full-screen mode it expands into.
 *
 * Panelled is the default: the shell already carries the status, the account and
 * the way back to everything else, so the panel is only the question. It drops
 * the grid and the glows for the same reason. The tray behind it already has a
 * grid, and warm light bleeding off the corner of a card reads as a rendering
 * fault rather than as atmosphere.
 *
 * Full screen puts both back, because there it is the whole atmosphere and there
 * is nothing else on the screen for it to fight with.
 *
 * Both states are ONE element tree with one container whose className changes.
 * An earlier version returned early for full screen, which put FastDecor where
 * FastCore had been; React reconciles children by position, so the whole subtree
 * was torn down and rebuilt on every toggle and anything typed in the field was
 * destroyed. The `{full && …}` holes below keep every child at a fixed index.
 */
export function AskPanel() {
  const { connected, connect } = useAccount()
  const say = useToast()
  const [full, setFull] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F is a single letter, so it has to yield to anything that takes text.
      // Toggling the screen out from under someone mid-sentence is the kind of
      // shortcut people disable the whole app over.
      const el = document.activeElement
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)

      if (!typing && e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setFull((f) => !f)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Escape goes through the shared stack, so it only leaves full screen when
  // nothing is layered on top of it.
  useEscapeLayer(full, () => setFull(false))

  // The overlay covers the shell but is still a descendant of it, so the sidebar
  // and top bar keep their tab stops unless they are explicitly taken out. Left
  // alone, tabbing inside full screen walked straight into chrome nobody can see.
  useEffect(() => {
    if (!full) return
    const chrome = [...document.querySelectorAll('[data-shell-chrome]')]
    for (const el of chrome) el.toggleAttribute('inert', true)
    return () => {
      for (const el of chrome) el.removeAttribute('inert')
    }
  }, [full])

  return (
    <div
      className={
        full
          ? 'bg-canvas fixed inset-0 z-100 overflow-hidden'
          : 'bg-canvas relative flex min-h-0 flex-1 overflow-hidden rounded-[22px]'
      }
      style={full ? undefined : { containerType: 'inline-size' }}
    >
      {full && <FastDecor />}

      <FastCore
        frame={full ? SCREEN : PANEL}
        connected={connected}
        footer={
          connected ? null : (
            <button
              type="button"
              onClick={() => {
                connect()
                say('Connected. AiKi can read your balances; it still cannot move anything.')
              }}
              className="mt-[14px] border-0 bg-none text-[12.5px] font-medium text-[#767676] hover:text-[#141414]"
            >
              New here?{' '}
              <span className="font-bold underline underline-offset-[3px]">Connect a wallet</span>
            </button>
          )
        }
      />

      {full && <HoverNav />}

      <div
        className={`absolute z-47 flex items-center ${
          full ? 'top-3 right-3 md:top-5 md:right-6' : 'top-3 right-3'
        }`}
      >
        <IconButton
          icon={full ? XIcon : ScanIcon}
          label={full ? 'Exit full screen' : 'Full screen'}
          tooltip={full ? 'Exit full screen (Esc)' : 'Full screen (F)'}
          ariaKeyShortcuts={full ? 'Escape F' : 'F'}
          tone="warm"
          size={15}
          className={
            full
              ? 'size-[34px] bg-white/80 shadow-[0_2px_10px_-4px_rgb(20_20_20_/_0.25)] backdrop-blur'
              : 'size-[34px]'
          }
          onClick={() => setFull((f) => !f)}
        />
      </div>

      {/* Lifted clear of the History pill on narrow screens, the same way the
          standalone home does it. */}
      <div
        className={`pointer-events-none absolute inset-x-4 bottom-[54px] z-25 flex justify-center text-center ${
          full
            ? 'md:inset-x-auto md:right-6 md:bottom-[18px] md:justify-end md:text-right'
            : 'md:bottom-[14px]'
        }`}
      >
        <Link
          href={route('/docs/how-we-test')}
          className="pointer-events-auto text-[12.5px] font-medium text-[#767676] hover:text-[#141414]"
        >
          Every agent here is tested by AiKi itself.{' '}
          <span className="font-bold underline underline-offset-[3px]">how we test</span>
        </Link>
      </div>

      <FirstRun />
    </div>
  )
}
