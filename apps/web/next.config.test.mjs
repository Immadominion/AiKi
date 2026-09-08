import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getRewrittenUrl,
  unstable_getResponseFromNextConfig,
} from 'next/experimental/testing/server.js'
import config from './next.config.ts'

function setProxyTarget(t, target) {
  const previous = process.env.API_PROXY_TARGET
  t.after(() => {
    if (previous === undefined) delete process.env.API_PROXY_TARGET
    else process.env.API_PROXY_TARGET = previous
  })
  if (target === undefined) delete process.env.API_PROXY_TARGET
  else process.env.API_PROXY_TARGET = target
}

test('marketplace and wallet requests reach the same API with their path and query intact', async (t) => {
  setProxyTarget(t, 'https://api.example.test')

  for (const path of [
    '/v1/auth/me',
    '/v2/providers?limit=5',
    '/v2/offers?limit=24&cursor=next-page',
    '/v2/jobs/29cfcd40-112b-43a0-83de-4b09111c5144/submissions',
  ]) {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://www.useaiki.xyz${path}`,
      nextConfig: config,
    })
    assert.equal(getRewrittenUrl(response), `https://api.example.test${path}`)
  }
})

test('an unconfigured API target does not rewrite marketplace requests', async (t) => {
  setProxyTarget(t, undefined)
  const response = await unstable_getResponseFromNextConfig({
    url: 'https://www.useaiki.xyz/v2/providers?limit=5',
    nextConfig: config,
  })
  assert.equal(getRewrittenUrl(response), null)
})
