import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getRewrittenUrl,
  unstable_getResponseFromNextConfig,
} from 'next/experimental/testing/server.js'
import config, { isolatedBuildDirectory, webpack } from './next.config.ts'

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

test('isolated build is explicit and cannot target the shared dev output or arbitrary paths', () => {
  assert.equal(isolatedBuildDirectory(undefined), undefined)
  assert.equal(isolatedBuildDirectory(''), undefined)
  assert.equal(isolatedBuildDirectory('.next-build-qa'), '.next-build-qa')
  for (const path of ['.next', '.', '..', '../build', '/tmp/build', 'dist']) {
    assert.throws(() => isolatedBuildDirectory(path), /AIKI_BUILD_DIR/)
  }
  assert.equal(config.distDir, undefined)
  assert.equal(config.typescript, undefined)
  // The webpack hook is no longer QA-only, so what has to stay QA-only is what
  // it does: an ordinary build keeps its cache.
  const ordinary = webpack({ resolve: {} })
  assert.equal(ordinary.cache, undefined)
})

/**
 * The production build resolves the source this app actually imports.
 *
 * A green typecheck, a green lint and a green test run all passed while the
 * production build could not resolve a module, because none of them use
 * webpack's resolver. The contract package is written for `nodenext`, so a
 * relative import inside it carries the `.js` extension its emitted JavaScript
 * would have, and nothing in this repo ever emits that JavaScript.
 */
test('a .js specifier resolves to the TypeScript beside it', () => {
  const resolve = webpack({ resolve: {} }).resolve
  assert.deepEqual(resolve.extensionAlias['.js'], ['.ts', '.tsx', '.js'])
  assert.deepEqual(resolve.extensionAlias['.mjs'], ['.mts', '.mjs'])
})

test('the alias is added to whatever Next already set, not written over it', () => {
  const resolve = webpack({ resolve: { extensionAlias: { '.cjs': ['.cts'] } } }).resolve
  assert.deepEqual(resolve.extensionAlias['.cjs'], ['.cts'])
  assert.deepEqual(resolve.extensionAlias['.js'], ['.ts', '.tsx', '.js'])
})
