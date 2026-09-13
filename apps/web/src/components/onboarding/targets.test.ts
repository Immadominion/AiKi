import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * Every beat points at something that is on the screen.
 *
 * A coach mark whose target is missing does not fail, it floats: the card is
 * rendered over a fully blurred page, pointing at nothing, which is exactly
 * what the comment in Spotlight says it never does. The walkthrough's second
 * beat had been doing that, because no element carried `data-tour="history"`.
 *
 * Static because that is the only kind of check that catches it. A renamed
 * element type-checks, lints and passes every test while quietly turning one
 * beat of onboarding into a blurred screen.
 */

const root = new URL('../../', import.meta.url)

function sources(directory: URL): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const at = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) out.push(...sources(at))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.'))
      out.push(readFileSync(at, 'utf8'))
  }
  return out
}

test('every tour target is defined by something that renders', () => {
  const files = sources(root)
  const defined = new Set<string>()
  const wanted = new Map<string, number>()
  for (const source of files) {
    /*
     * Both spellings. A target set conditionally reads
     * `data-tour={first ? 'manual-evidence' : undefined}`, and a pattern that
     * only understood the literal form reported two live targets as missing.
     */
    for (const match of source.matchAll(/data-tour=(?:"([a-z-]+)"|\{([^}]*)\})/g)) {
      if (match[1]) defined.add(match[1])
      for (const inner of (match[2] ?? '').matchAll(/'([a-z-]+)'/g)) defined.add(inner[1] ?? '')
    }
    // Only inside a beat list, so the word `target` elsewhere is not counted.
    for (const match of source.matchAll(/target:\s*'([a-z-]+)'/g))
      wanted.set(match[1] ?? '', (wanted.get(match[1] ?? '') ?? 0) + 1)
  }
  assert.ok(wanted.size >= 4, `Expected beats to check, found ${wanted.size}.`)
  for (const target of wanted.keys())
    assert.ok(defined.has(target), `A beat points at "${target}" and nothing renders it.`)
})
