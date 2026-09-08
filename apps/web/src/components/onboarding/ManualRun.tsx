'use client'

import { useEffect, useState } from 'react'
import { useModeNavigation, useTour } from '@/components/shell/prefs'
import { type Beat, Spotlight } from './Spotlight'

/**
 * Manual mode's own walkthrough.
 *
 * Fast mode consolidates everything into one question; Manual mode spreads it
 * across a market, a sidebar and a set of tables. Those are different products
 * to learn, so a tour of one is no help with the other.
 *
 * Only runs for someone who has actually chosen Manual. Nobody who is happy in
 * Fast mode gets interrupted for visiting the market once.
 */
export function ManualRun() {
  const { layout, switchMode } = useModeNavigation()
  const { seen, finish } = useTour('manual')
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setArmed(true), 700)
    return () => clearTimeout(id)
  }, [])

  if (layout !== 'manual' || seen || !armed) return null

  const beats: Beat[] = [
    {
      target: 'manual-nav',
      title: 'Everything has a place',
      body: 'Explore is the whole market. My agents is what is working for you right now. Activity is every single thing they did, including what your limits refused.',
      place: 'right',
    },
    {
      target: 'manual-evidence',
      title: 'Bars are checks, not stars',
      body: 'Each bar is one batch of tests AiKi ran against that agent itself. Empty bars mean we have not measured enough yet, which is different from measuring something bad.',
      place: 'right',
    },
    {
      target: 'manual-mode',
      title: 'You are in Manual mode',
      body: 'Browse the market and pick yourself. Fast mode asks you one question instead and finds the agent for you. Switch here whenever you want the other one.',
      place: 'right',
      actions: (next) => (
        <>
          <button
            type="button"
            onClick={() => {
              finish()
              switchMode('fast')
            }}
            className="h-[38px] flex-1 rounded-[12px] border border-[rgb(26_26_25_/_0.12)] bg-white px-[12px] text-[13px] font-bold text-[#1A1A19] hover:border-[rgb(26_26_25_/_0.24)]"
          >
            Try Fast
          </button>
          <button
            type="button"
            onClick={next}
            className="h-[38px] flex-1 rounded-[12px] border-0 bg-[linear-gradient(135deg,#FF5A00,#FF9147)] px-[12px] text-[13px] font-bold text-white shadow-[0_10px_22px_-12px_rgb(255_90_0_/_0.8)]"
          >
            Stay in Manual
          </button>
        </>
      ),
    },
  ]

  return <Spotlight beats={beats} onDone={finish} />
}
