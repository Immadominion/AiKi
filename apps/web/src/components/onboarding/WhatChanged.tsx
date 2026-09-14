'use client'

import { useEffect, useState } from 'react'
import { useRelease, useTour } from '@/components/shell/prefs'
import { releaseAudience } from './release'
import { type Beat, Spotlight } from './Spotlight'

/**
 * One thing, said once, to the people it is news for.
 *
 * Until this shipped, an agent on AiKi could find work, buy it and report on
 * it, and could not touch money. Fast mode said so in those words. That was
 * true, people believed it, and it is not true any more: an agent can hold its
 * own funded account and move tokens out of it under a mandate. Somebody who
 * formed the old belief will not go looking for the new capability, because as
 * far as they know it does not exist.
 *
 * A new account is told nothing. It has no stale belief to correct, and the
 * product it is being shown is simply the product. Announcing a change to
 * somebody who was not there for the old version is noise that makes the thing
 * sound newer than it is, so the release is marked read on their behalf.
 *
 * Deliberately not a banner. A permanent strip on the surface somebody works on
 * is chrome, and this has one thing to say and no reason to keep saying it.
 */
export const RELEASE = 'agent-spending'

export function WhatChanged() {
  const tour = useTour('fast')
  const release = useRelease(RELEASE)
  const [armed, setArmed] = useState(false)

  // Same settle as the first-run tour: measuring during the first paint gets the
  // position of something that has not arrived yet.
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), 650)
    return () => clearTimeout(id)
  }, [])

  const { acknowledge } = release
  const audience = releaseAudience({
    tourReady: tour.ready,
    tourDone: tour.done,
    releaseReady: release.ready,
    releasePending: release.pending,
    armed,
  })
  useEffect(() => {
    if (audience === 'new-account') acknowledge()
  }, [audience, acknowledge])

  if (audience !== 'tell') return null

  const beats: Beat[] = [
    {
      target: 'field',
      title: 'An agent can spend now',
      body: 'It can hold its own account and spend from it, inside limits you sign once. You choose whether it asks you first. Ask here to set one up.',
      place: 'below',
    },
  ]

  return <Spotlight beats={beats} onDone={acknowledge} />
}
