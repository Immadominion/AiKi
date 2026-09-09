import { readFileSync } from 'node:fs'
import * as publicSdk from '@aiki/sdk'
import { expect, it } from 'vitest'
import * as implementation from './index.js'

it('resolves the example package import through exports without a self-dependency', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest.name).toBe('@aiki/sdk')
  expect(manifest.exports['.']).toBe('./src/index.ts')
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ])
    expect(manifest[field]?.[manifest.name]).toBeUndefined()
  expect(publicSdk.handle).toBe(implementation.handle)
  expect(publicSdk.serve).toBe(implementation.serve)
  expect(publicSdk.serviceEndpoint).toBe(implementation.serviceEndpoint)
})
