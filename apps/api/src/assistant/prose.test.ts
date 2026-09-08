import { expect, it } from 'vitest'
import { readableAssistantProse, SYSTEM } from './run.js'

it('replaces em dash punctuation in prose without changing code or link destinations', () => {
  const dash = '\u2014'
  const input = `Done${dash}review it.\n\n**A result ${dash} ready**\n\n\`value${dash}key\` and \`\`literal \` ${dash} key\`\`\n[Read${dash}more](/work?label=x${dash}y)\nhttps://example.test/x${dash}y\n\n\`\`\`ts\nconst value = 'x${dash}y'\n\`\`\`\n\n~~~text\nx${dash}y\n~~~\n\nNext${dash}open Work.`
  const result = readableAssistantProse(input)
  expect(result).toContain('Done - review it.')
  expect(result).toContain('**A result - ready**')
  expect(result).toContain(`[Read - more](/work?label=x${dash}y)`)
  expect(result).toContain(`\`value${dash}key\``)
  expect(result).toContain(`\`\`literal \` ${dash} key\`\``)
  expect(result).toContain(`https://example.test/x${dash}y`)
  expect(result).toContain(`const value = 'x${dash}y'`)
  expect(result).toContain(`~~~text\nx${dash}y\n~~~`)
  expect(result).toContain('Next - open Work.')
})

it('leaves an unfinished code fence unchanged and documents the actual task route', () => {
  const text = '```text\nkeep\u2014this'
  expect(readableAssistantProse(text)).toBe(text)
  expect(SYSTEM).toContain('/work?task=ID')
  expect(SYSTEM).toContain('There is no /work/ID route')
})

it('preserves balanced parentheses inside link destinations and cleans only following prose', () => {
  const link = '[Read](/work?label=a(b)\u2014c)'
  expect(readableAssistantProse(link)).toBe(link)
  expect(readableAssistantProse(`${link} then\u2014review.`)).toBe(`${link} then - review.`)
  const nested = '[Read](/work?label=a(b(c))\u2014d)'
  expect(readableAssistantProse(nested)).toBe(nested)
  const unfinished = '[Read](/work?label=a(b)\u2014c'
  expect(readableAssistantProse(unfinished)).toBe(unfinished)
})
