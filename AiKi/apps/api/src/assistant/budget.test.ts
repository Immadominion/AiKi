import { expect, it, vi } from 'vitest'

/*
 * A turn stops when the money held for it would run out.
 *
 * Not "is charged what it came to afterwards", which is what this did before:
 * the route gated on 200 points, ran to completion, and charged whatever the
 * turn cost clamped to whatever was left. Production turns cost 402, 263 and
 * 711 points against that gate, and every shortfall was forgiven in silence.
 *
 * The provider is mocked into an endless tool-calling loop, which is the shape
 * of the expensive case: a model that keeps working and never answers.
 */

const create = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create }
  },
}))
vi.mock('./tools.js', () => ({
  TOOLS: [],
  MUTATING: new Set<string>(),
  runTool: async () => ({ ok: true, body: { rows: 'x'.repeat(4_000) } }),
}))

const { runAssistant } = await import('./run.js')

const toolRound = {
  content: [{ type: 'tool_use', id: 'call-1', name: 'search', input: { q: 'venus' } }],
  usage: { input_tokens: 4_000, output_tokens: 900 },
}

it('stops before it costs more than was held for it', async () => {
  create.mockReset()
  create.mockResolvedValue(toolRound)

  const turn = await runAssistant({
    apiKey: 'k',
    model: 'claude-sonnet-5',
    ctx: { baseUrl: 'http://localhost', cookie: 'x' },
    messages: [{ role: 'user', content: 'find me a liquidation agent' }],
    budgetPoints: 400,
  })

  expect(turn.stoppedBy).toBe('budget')
  expect(turn.points).toBeLessThanOrEqual(400)
  // It says so rather than returning a shorter answer as though that were all
  // there was: somebody who paid for an answer is owed the reason it stopped.
  expect(turn.reply).toMatch(/cost more than the points held/i)
  expect(turn.truncated).toBe(true)
})

it('does not stop a turn that fits', async () => {
  create.mockReset()
  create.mockResolvedValue({
    content: [{ type: 'text', text: '315943 answered 102 probes.' }],
    usage: { input_tokens: 4_000, output_tokens: 300 },
  })

  const turn = await runAssistant({
    apiKey: 'k',
    model: 'claude-sonnet-5',
    ctx: { baseUrl: 'http://localhost', cookie: 'x' },
    messages: [{ role: 'user', content: 'how many probes has 315943 answered' }],
    budgetPoints: 2_000,
  })

  expect(turn.stoppedBy).toBeUndefined()
  expect(turn.truncated).toBe(false)
  expect(turn.reply).toContain('315943')
})

it('runs unbudgeted when nobody set a budget', async () => {
  // The parameter is optional and the scheduler calls this without one. An
  // absent budget must mean no ceiling, never a ceiling of zero.
  create.mockReset()
  create.mockResolvedValue({
    content: [{ type: 'text', text: 'done' }],
    usage: { input_tokens: 1_000, output_tokens: 100 },
  })

  const turn = await runAssistant({
    apiKey: 'k',
    model: 'claude-sonnet-5',
    ctx: { baseUrl: 'http://localhost', cookie: 'x' },
    messages: [{ role: 'user', content: 'hello' }],
  })
  expect(turn.stoppedBy).toBeUndefined()
  expect(turn.reply).toBe('done')
})
