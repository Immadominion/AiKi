import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageBlocks, messageInlines, safeMessageHref } from './fast-message.ts'

test('formats agent names, code, lists and links without showing Markdown markers', () => {
  const parts = messageInlines(
    'Use **Venus Guardian** with `read_position`. [Open agent](/registry/315943)',
  )
  assert.equal(parts.find((part) => part.kind === 'strong')?.text, 'Venus Guardian')
  assert.equal(parts.find((part) => part.kind === 'code')?.text, 'read_position')
  assert.equal(parts.find((part) => part.kind === 'link')?.href, '/registry/315943')
  const blocks = messageBlocks(
    '## What it does\n\n- Reads your loan\n- Returns a report\n\n1. Review\n2. Hire',
  )
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['heading', 'list', 'list'],
  )
  assert.equal(blocks[1].ordered, false)
  assert.equal(blocks[2].ordered, true)
})

test('untrusted content cannot become an executable link or trigger image requests', () => {
  for (const href of [
    'javascript:alert(1)',
    'data:text/html,hello',
    '//evil.test',
    '/\\evil.test',
    'https://user:password@evil.test',
    'https://evil.test\n',
  ])
    assert.equal(safeMessageHref(href), undefined)
  const image = messageInlines('![Remote image](https://tracker.test/pixel.png)')
  assert.deepEqual(image, [{ kind: 'text', text: 'Remote image', offset: 0 }])
  assert.equal(messageInlines('<script>alert(1)</script>')[0].kind, 'text')
  assert.equal(messageInlines('[Unsafe](javascript:alert)')[0].kind, 'text')
})

test('keeps real external citations and converts AiKi links to local navigation', () => {
  assert.equal(safeMessageHref('https://www.useaiki.xyz/registry/315943'), '/registry/315943')
  assert.equal(safeMessageHref('https://useaiki.xyz/work'), '/work')
  assert.equal(
    safeMessageHref('https://bscscan.com/address/0x123'),
    'https://bscscan.com/address/0x123',
  )
})

test('code fences remain inert text and do not create links', () => {
  assert.deepEqual(messageBlocks('```html\n<img src="https://tracker.test">\n```'), [
    { kind: 'code', text: '<img src="https://tracker.test">', offset: 0 },
  ])
})
