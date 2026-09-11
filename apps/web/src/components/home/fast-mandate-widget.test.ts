import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FastMandateAction } from './FastMandateAction'

test('History renders only a review control, never a signing prompt or automatic action', () => {
  const markup = renderToStaticMarkup(
    createElement(FastMandateAction, {
      owner: `0x${'11'.repeat(20)}`,
      action: {
        kind: 'sign_mandate',
        scope: 'venus_repay',
        authorizationId: '12345678-1234-4123-8123-123456789012',
        chainId: 56,
        account: `0x${'22'.repeat(20)}`,
        manager: `0x${'33'.repeat(20)}`,
      },
    }),
  )
  assert.match(markup, /Review and sign/)
  assert.doesNotMatch(markup, /Sign this mandate in wallet/)
  assert.match(markup, /does not start a job or watch/)
  assert.doesNotMatch(markup, /href=/)
})
