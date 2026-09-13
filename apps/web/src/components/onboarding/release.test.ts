import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releaseAudience } from './release'

/**
 * Who gets told that agents can spend now.
 *
 * Both failures are silent. Told to a new account it is an interruption about
 * something they never knew was missing; missed for a returning one it never
 * reaches anybody, because somebody who believes the product cannot touch money
 * does not go looking for the part that can.
 */

const returning = {
  tourReady: true,
  tourDone: true,
  releaseReady: true,
  releasePending: true,
  armed: true,
}

test('tells somebody who has been here before and has not been told', () => {
  assert.equal(releaseAudience(returning), 'tell')
})

test('says nothing twice', () => {
  assert.equal(releaseAudience({ ...returning, releasePending: false }), 'told')
})

test('marks it read for a new account rather than announcing it', () => {
  // Nothing changed for somebody who was not here for the old version, and
  // calling it a change makes the product sound newer than it is.
  assert.equal(releaseAudience({ ...returning, tourDone: false }), 'new-account')
})

test('does that before the settle, not after it', () => {
  /*
   * The window this closes: a new account finishes the walkthrough during the
   * settle, `tourDone` flips to true, and the change is announced to somebody
   * who was told about it thirty seconds ago.
   */
  assert.equal(releaseAudience({ ...returning, tourDone: false, armed: false }), 'new-account')
})

test('shows nothing at all until both answers are actually read', () => {
  // Storage is client-only, so the first render knows neither. Guessing here
  // either flashes a coach mark at somebody who has seen it, or marks a release
  // read for somebody who has not.
  for (const unknown of [{ tourReady: false }, { releaseReady: false }])
    assert.equal(releaseAudience({ ...returning, ...unknown }), 'wait')
})

test('waits for the page to settle before pointing at anything', () => {
  // A coach mark measures its target, and the target is not there on the first
  // paint. This is the only case where waiting is about layout rather than data.
  assert.equal(releaseAudience({ ...returning, armed: false }), 'wait')
})
