/**
 * Who a change is news for.
 *
 * Pulled out of the component because it is the whole decision, and because
 * getting it wrong is quiet in both directions. Told to the wrong person it is
 * an interruption about something they never knew was missing. Not told to the
 * right one, it never reaches anybody at all, and both look like a screen that
 * simply did not appear.
 */
export type ReleaseAudience =
  /** Nothing is known yet. Show nothing rather than guess and correct it. */
  | 'wait'
  /**
   * Somebody who has not been through the walkthrough, so they hold no belief
   * about the old version. Mark it read on their behalf and say nothing: this
   * is not a change to them, it is the product.
   */
  | 'new-account'
  /** Been here before, has not been told. */
  | 'tell'
  /** Told, or being told on some other visit. */
  | 'told'

export function releaseAudience(input: {
  tourReady: boolean
  tourDone: boolean
  releaseReady: boolean
  releasePending: boolean
  /** False until the page has settled, because a coach mark measures a target. */
  armed: boolean
}): ReleaseAudience {
  if (!input.tourReady || !input.releaseReady) return 'wait'
  /*
   * Decided before `armed`, so a new account is marked read immediately rather
   * than after the settle. Waiting would leave a window in which finishing the
   * walkthrough flips `tourDone` to true and the change gets announced to
   * somebody who was told about it thirty seconds ago.
   */
  if (!input.tourDone) return 'new-account'
  if (!input.releasePending) return 'told'
  return input.armed ? 'tell' : 'wait'
}
