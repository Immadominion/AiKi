import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FastChatHeader } from './FastChatHeader'

function render(fullScreen: boolean) {
  return renderToStaticMarkup(
    createElement(
      FastChatHeader,
      { fullScreen },
      createElement('button', { type: 'button' }, 'Back'),
      createElement('button', { type: 'button' }, 'History'),
    ),
  )
}

test('panel conversation reserves the fullscreen hit target and a gap without moving Back', () => {
  const markup = render(false)
  assert.match(markup, /\bpr-12\b/)
  assert.doesNotMatch(markup, /\bpl-12\b/)
  assert.match(markup, /flex-wrap/)
  assert.match(
    markup,
    /<button type="button">Back<\/button><button type="button">History<\/button>/,
  )
})

test('fullscreen conversation clears both corner controls at mobile and desktop breakpoints', () => {
  const markup = render(true)
  for (const clearance of ['pr-12', 'pl-12', 'md:pr-14', 'md:pl-16'])
    assert.ok(markup.includes(clearance), `Missing ${clearance} corner clearance`)
  assert.match(
    markup,
    /<button type="button">Back<\/button><button type="button">History<\/button>/,
  )
})
