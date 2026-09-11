import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  LIVENESS_DETAIL,
  LIVENESS_LABEL,
  LivenessBadge,
  livenessPresentation,
} from '../components/ui/LivenessBadge'

test('incomplete connection checks do not invent latency or tool failures', () => {
  const checkedAt = new Date().toISOString()
  assert.equal(LIVENESS_LABEL.DEGRADED, 'Requires review')
  assert.match(LIVENESS_DETAIL.DEGRADED, /connection or identity checks/i)
  assert.doesNotMatch(LIVENESS_DETAIL.DEGRADED, /time out|seconds|slow/i)
  const html = renderToStaticMarkup(
    createElement(LivenessBadge, { state: 'DEGRADED', lastProbeAt: checkedAt }),
  )
  assert.match(html, /Requires review/)
  assert.doesNotMatch(html, /Slow and patchy/)
})

test('identical URL responses describe the observation without calling a provider fake', () => {
  assert.equal(LIVENESS_LABEL.IMPOSTOR_STATIC, 'Identical responses')
  assert.match(LIVENESS_DETAIL.IMPOSTOR_STATIC, /shared endpoint/i)
  assert.doesNotMatch(LIVENESS_DETAIL.IMPOSTOR_STATIC, /not an agent|fake|fraud/i)
  assert.match(LIVENESS_DETAIL.IMPOSTOR_STATIC, /does not establish/i)
})

test('an answering service is not presented as hiring or spending permission', () => {
  assert.match(LIVENESS_DETAIL.LIVE, /answered AiKi’s checks/)
  assert.match(LIVENESS_DETAIL.LIVE, /does not confirm/i)
  assert.match(LIVENESS_DETAIL.LIVE, /permission to use your funds/i)
})

test('local-only services remain distinguishable from missing registration services', () => {
  assert.equal(LIVENESS_LABEL.NOT_REMOTE, 'Local connection')
  assert.match(LIVENESS_DETAIL.NOT_REMOTE, /local/i)
  assert.equal(LIVENESS_LABEL.DECLARED_ONLY, 'No remote service')
})

test('new connection labels still expire without becoming current failures', () => {
  const now = Date.parse('2026-09-11T01:00:00Z')
  const old = new Date(now - 86_400_001).toISOString()
  assert.deepEqual(livenessPresentation('DEGRADED', old, now), {
    label: 'Last known: requires review',
    tone: 'idle',
  })
  assert.deepEqual(livenessPresentation('IMPOSTOR_STATIC', old, now), {
    label: 'Last known: identical responses',
    tone: 'idle',
  })
})
