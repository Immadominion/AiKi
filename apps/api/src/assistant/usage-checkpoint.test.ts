import { beforeEach, expect, it, vi } from 'vitest'

const create = vi.fn()
const countTokens = vi.fn()
const tool = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create, countTokens }
  },
}))
vi.mock('./tools.js', () => ({
  TOOLS: [],
  MUTATING: new Set(['hire_agent']),
  runTool: (...args: unknown[]) => tool(...args),
}))
const { runAssistant, SYSTEM } = await import('./run.js')
const { AssistantRunFailure } = await import('./usage.js')
const input = {
  apiKey: 'test',
  model: 'claude-sonnet-5',
  ctx: { baseUrl: 'http://localhost', cookie: 'test', turnId: 'turn-one' },
  messages: [{ role: 'user' as const, content: 'Read my account.' }],
  budgetPoints: 2000,
}
beforeEach(() => {
  create.mockReset()
  countTokens.mockReset()
  tool.mockReset()
  countTokens.mockResolvedValue({ input_tokens: 4000 })
})

it('counts the actual system, tools and conversation before each paid request', async () => {
  countTokens.mockResolvedValue({ input_tokens: 100000 })
  const result = await runAssistant(input)
  expect(countTokens).toHaveBeenCalledWith(
    expect.objectContaining({ system: SYSTEM, tools: [], messages: input.messages }),
  )
  expect(result.stoppedBy).toBe('budget')
  expect(result.points).toBe(0)
  expect(create).not.toHaveBeenCalled()
})

it('checkpoints known usage before executing a tool and carries it through tool failures', async () => {
  create.mockResolvedValue({
    content: [{ type: 'tool_use', id: 'call-one', name: 'hire_agent', input: {} }],
    usage: { input_tokens: 1000, output_tokens: 50 },
  })
  const checkpoint = vi.fn(async () => {})
  tool.mockImplementation(async (context) => {
    expect(checkpoint).toHaveBeenCalledWith({ inputTokens: 1000, outputTokens: 50 }, 49)
    expect(context).toMatchObject({ turnId: 'turn-one', toolCallId: 'call-one' })
    throw new Error('Tool reply was not JSON')
  })
  try {
    await runAssistant({ ...input, onUsage: checkpoint })
    throw new Error('Expected failure')
  } catch (error) {
    expect(error).toBeInstanceOf(AssistantRunFailure)
    expect(error).toMatchObject({
      uncertain: false,
      turn: { points: 49, usage: { inputTokens: 1000, outputTokens: 50 } },
    })
  }
})

it('distinguishes a rejected provider call from a lost response that may have been billed', async () => {
  create.mockRejectedValueOnce(Object.assign(new Error('Bad request'), { status: 400 }))
  await expect(runAssistant(input)).rejects.toMatchObject({ uncertain: false, turn: { points: 0 } })
  create.mockRejectedValueOnce(new Error('Connection closed'))
  await expect(runAssistant(input)).rejects.toMatchObject({ uncertain: true, turn: { points: 0 } })
})
