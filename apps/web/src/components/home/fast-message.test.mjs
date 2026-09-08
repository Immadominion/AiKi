import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FastMessage } from './FastMessage.tsx'
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

test('renders the exact bold task link as nested parts with the real Work route', () => {
  const id = '4c1b7f72-26eb-4d16-811d-e418986d8071'
  const parts = messageInlines(`**[Venus position health-factor report](/work/${id})**`)
  assert.equal(parts[0].kind, 'strong')
  assert.equal(parts[0].children[0].kind, 'link')
  assert.equal(parts[0].children[0].text, 'Venus position health-factor report')
  assert.equal(parts[0].children[0].href, `/work?task=${id}`)
  const inverse = messageInlines(`[**Open report**](/work?task=${id})`)
  assert.equal(inverse[0].kind, 'link')
  assert.equal(inverse[0].children[0].kind, 'strong')
})

test('normalizes only known AiKi task paths, preserving query data and external destinations', () => {
  const id = '4c1b7f72-26eb-4d16-811d-e418986d8071'
  assert.equal(safeMessageHref(`/work/${id}`), `/work?task=${id}`)
  assert.equal(
    safeMessageHref(`https://useaiki.xyz/work/${id}?source=fast#details`),
    `/work?source=fast&task=${id}#details`,
  )
  assert.equal(safeMessageHref(`https://other.test/work/${id}`), `https://other.test/work/${id}`)
  assert.equal(safeMessageHref('/work/not-a-task'), '/work/not-a-task')
  assert.equal(safeMessageHref(`//evil.test/work/${id}`), undefined)
  assert.equal(messageInlines('**[Bad](javascript:alert)**')[0].children[0].kind, 'text')
})

test('renders nested links into safe HTML and keeps code punctuation unchanged', () => {
  const id = '4c1b7f72-26eb-4d16-811d-e418986d8071'
  const html = renderToStaticMarkup(
    createElement(FastMessage, {
      text: `**[Venus position health-factor report](/work/${id})**\n\nReady\u2014open it. \`x\u2014y\`\n\n\`\`\`text\nx\u2014y\n\`\`\``,
    }),
  )
  assert.match(html, new RegExp(`<strong><a[^>]+href="/work\\?task=${id}"`))
  assert.ok(!html.includes('**['))
  assert.ok(html.includes('Ready - open it.'))
  assert.ok(html.includes('x\u2014y'))
  const reverse = renderToStaticMarkup(
    createElement(FastMessage, { text: '[**Read report**](/work)' }),
  )
  assert.match(reverse, /<a[^>]*><strong>/)
  const unsafe = renderToStaticMarkup(
    createElement(FastMessage, { text: '**[No](javascript:alert)**' }),
  )
  assert.ok(!unsafe.includes('<a'))
})

test('preserves bare URL bytes while normalizing surrounding prose punctuation', () => {
  const text = 'Read\u2014https://example.test/x\u2014y then review\u2014done.'
  const parts = messageInlines(text)
  assert.equal(
    parts.map((part) => part.text).join(''),
    'Read - https://example.test/x\u2014y then review - done.',
  )
  const html = renderToStaticMarkup(createElement(FastMessage, { text }))
  assert.ok(html.includes('https://example.test/x\u2014y'))
})

test('preserves variable-backtick code spans and tilde-fenced code byte for byte', () => {
  const inline = '``literal ` x\u2014y``'
  assert.deepEqual(messageInlines(inline), [
    { kind: 'code', text: 'literal ` x\u2014y', offset: 0 },
  ])
  const fenced = '~~~text\nx\u2014y\n~~~'
  assert.deepEqual(messageBlocks(fenced), [{ kind: 'code', text: 'x\u2014y', offset: 0 }])
  const html = renderToStaticMarkup(createElement(FastMessage, { text: `${inline}\n\n${fenced}` }))
  assert.ok(html.includes('literal ` x\u2014y'))
  assert.match(html, /<pre[^>]*><code>x\u2014y<\/code><\/pre>/)
  assert.deepEqual(messageBlocks('````text\n```\nx\u2014y\n````'), [
    { kind: 'code', text: '```\nx\u2014y', offset: 0 },
  ])
})
