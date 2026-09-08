import { beforeEach, expect, it, vi } from 'vitest'

const create = vi.fn()
const runTool = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create }
  },
}))
vi.mock('./tools.js', () => ({
  TOOLS: [],
  MUTATING: new Set(['hire_agent']),
  runTool: (...args: unknown[]) => runTool(...args),
}))

const { runAssistant } = await import('./run.js')

beforeEach(() => {
  create.mockReset()
  runTool.mockReset()
})

const input = {
  apiKey: 'test',
  model: 'claude-sonnet-5',
  ctx: { baseUrl: 'http://localhost', cookie: 'test' },
  messages: [
    {
      role: 'user' as const,
      content: 'The 512 point total is approved. Hire the agent for a read-only report.',
    },
  ],
}
const toolRound = (name: string) => ({
  content: [{ type: 'tool_use', id: `call-${name}`, name, input: {} }],
  usage: { input_tokens: 4_000, output_tokens: 900 },
})

it('returns the task created in the last affordable round without another model call or another hire', async () => {
  create.mockResolvedValue(toolRound('hire_agent'))
  runTool.mockResolvedValue({
    ok: true,
    body: {
      id: 'task-from-api',
      status: 'SUBMITTED',
      heldPoints: 512,
      submission: 'No borrowed balance.',
    },
  })
  const turn = await runAssistant({ ...input, budgetPoints: 500 })
  expect(turn.stoppedBy).toBe('budget')
  expect(turn.reply).toContain('task-from-api')
  expect(turn.reply).toContain('No borrowed balance.')
  expect(turn.reply).toContain('/work')
  expect(turn.points).toBeLessThanOrEqual(500)
  expect(create).toHaveBeenCalledTimes(1)
  expect(runTool).toHaveBeenCalledTimes(1)
})

it('preserves the confirmed hire when later read calls reach the round ceiling', async () => {
  create.mockResolvedValueOnce(toolRound('hire_agent')).mockResolvedValue(toolRound('my_tasks'))
  runTool.mockImplementation(async (_ctx: unknown, tool: string) =>
    tool === 'hire_agent'
      ? { ok: true, body: { id: 'task-round-limit', status: 'CLAIMED', heldPoints: 512 } }
      : { ok: true, body: { tasks: [] } },
  )
  const turn = await runAssistant(input)
  expect(turn.stoppedBy).toBe('rounds')
  expect(turn.reply).toContain('task-round-limit')
  expect(turn.reply).toContain('awaiting delivery')
  expect(create).toHaveBeenCalledTimes(8)
  expect(runTool.mock.calls.filter((call) => call[1] === 'hire_agent')).toHaveLength(1)
})
