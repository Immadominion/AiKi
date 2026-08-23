'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useLayoutPref, useTour } from '@/components/shell/prefs'
import { route } from '@/lib/routes'
import { type Beat, Spotlight } from './Spotlight'

/**
 * The first thirty seconds.
 *
 * Three beats, each pointing at something already on screen. No screen of its
 * own, because a screen between someone and the product is a toll booth.
 *
 * The mode choice is the last beat on purpose. Asking someone to pick between
 * "Fast" and "Manual" before they have seen either is asking them to guess;
 * asking after they have looked at Fast mode for twenty seconds is asking them
 * to decide. Same question, and only one of them can be answered.
 */
export function FirstRun() {
  const { seen, finish } = useTour('fast')
  const { setLayout } = useLayoutPref()
  const router = useRouter()
  const [armed, setArmed] = useState(false)

  // Let the page settle before lifting anything out of it. Measuring during the
  // first paint gets you the position of something that has not arrived yet.
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), 650)
    return () => clearTimeout(id)
  }, [])

  if (seen || !armed) return null

  const beats: Beat[] = [
    {
      target: 'field',
      title: 'Say what you need done',
      body: 'Plain words. AiKi reads it, works out what kind of job it is, and shows only the agents that can actually do it, with the evidence behind each one.',
      place: 'below',
    },
    {
      target: 'history',
      title: 'Everything you ask is kept',
      body: 'Each one with what came of it, and each one you can pick back up. Including the asks no agent could take, because those are how we know what to build next.',
      place: 'right',
    },
    {
      target: 'manual-mode',
      title: 'Two ways to use AiKi',
      body: 'This is Fast mode. One question, and AiKi finds who can do it. Manual mode gives you the whole market to browse and pick from yourself. This is the control, so you can change your mind whenever you like.',
      place: 'right',
      actions: (next) => (
        <>
          <button
            type="button"
            onClick={() => {
              // Hand straight over. Manual mode explains itself on arrival.
              setLayout('manual')
              finish()
              router.push(route('/market'))
            }}
            className="h-[38px] flex-1 rounded-[12px] border border-[rgb(20_20_20_/_0.1)] bg-white px-[12px] text-[13px] font-bold text-[#141414] hover:border-[rgb(20_20_20_/_0.2)]"
          >
            Use Manual
          </button>
          <button
            type="button"
            onClick={() => {
              setLayout('fast')
              next()
            }}
            className="h-[38px] flex-1 rounded-[12px] border-0 bg-[linear-gradient(135deg,#FF4D00,#FF7A2E)] px-[12px] text-[13px] font-bold text-white shadow-[0_10px_22px_-12px_rgb(255_77_0_/_0.8)]"
          >
            Stay in Fast
          </button>
        </>
      ),
    },
  ]

  return <Spotlight beats={beats} onDone={finish} />
}
