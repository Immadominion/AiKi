import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * Every relative import in the contract package names a file that is there.
 *
 * The package ships TypeScript source and this app transpiles it, so a
 * specifier naming a file nobody wrote fails the production build and nothing
 * else: not the typecheck, which reads the same specifier through a different
 * resolver, and not any test, which never runs webpack. That is how one reached
 * production.
 */
test('every relative import in the contract package points at a file that is there', () => {
  const directory = new URL('../../../../packages/contracts/src/', import.meta.url)
  const present = new Set(readdirSync(directory))
  let checked = 0
  for (const file of present) {
    if (!file.endsWith('.ts')) continue
    const source = readFileSync(new URL(file, directory), 'utf8')
    for (const match of source.matchAll(/from '(\.\/[^']+)'/g)) {
      const specifier = match[1] ?? ''
      const named = specifier.slice(2).replace(/\.js$/, '.ts')
      assert.ok(
        present.has(named) || present.has(named.replace(/\.ts$/, '')),
        `${file} imports ${specifier}, and ${named} is not in the package.`,
      )
      checked++
    }
  }
  // A regex that silently stopped matching would pass this test by checking
  // nothing at all.
  assert.ok(checked > 5, `Expected relative imports to check, found ${checked}.`)
})
