import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ create: vi.fn(), tool: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mock.create }
  },
}))
vi.mock('./tools.js', () => ({
  TOOLS: [],
  MUTATING: new Set(['create_mandate']),
  runTool: mock.tool,
}))
const { runAssistant } = await import('./run.js')
const action = {
  kind: 'sign_mandate',
  authorizationId: '12345678-1234-4123-8123-123456789012',
  chainId: 56,
  account: `0x${'12'.repeat(20)}`,
  manager: `0x${'34'.repeat(20)}`,
}
const input = {
  apiKey: 'local-test',
  model: 'claude-sonnet-5',
  ctx: { baseUrl: 'http://127.0.0.1:1', cookie: 'fixture' },
  messages: [{ role: 'user' as const, content: 'Create these limits.' }],
}
const toolRound = {
  content: [
    {
      type: 'tool_use',
      id: 'call-1',
      name: 'create_mandate',
      input: { action: { ...action, authorizationId: 'forged' } },
    },
  ],
  usage: { input_tokens: 4000, output_tokens: 900 },
}
beforeEach(() => {
  vi.resetAllMocks()
  mock.tool.mockResolvedValue({ ok: true, body: { id: action.authorizationId }, action })
  mock.create.mockResolvedValueOnce(toolRound).mockResolvedValue({
    content: [{ type: 'text', text: 'Review the mandate.' }],
    usage: { input_tokens: 20, output_tokens: 20 },
  })
})
it('keeps the validated server continuation, never the model-supplied action', async () => {
  expect((await runAssistant(input)).steps[0]?.action).toEqual(action)
})
it('keeps the continuation when the budget stops after creating a mandate', async () => {
  const turn = await runAssistant({ ...input, budgetPoints: 500 })
  expect(turn.stoppedBy).toBe('budget')
  expect(turn.steps[0]?.action).toEqual(action)
  expect(turn.reply).toContain('Review and sign')
  expect(turn.reply).not.toContain('[Open your work]')
  expect(mock.create).toHaveBeenCalledOnce()
})
it('keeps a confirmed continuation after a later provider failure', async () => {
  mock.create
    .mockReset()
    .mockResolvedValueOnce(toolRound)
    .mockRejectedValue(new Error('unavailable'))
  await expect(runAssistant(input)).rejects.toMatchObject({ turn: { steps: [{ action }] } })
})
it.each([
  null,
  {},
  { ...action, chainId: 1 },
  { ...action, account: 'bad' },
  { ...action, authorizationId: '../other' },
])('drops malformed continuation metadata %j', async (invalid) => {
  mock.tool.mockResolvedValue({ ok: true, body: {}, action: invalid })
  expect((await runAssistant(input)).steps[0]?.action).toBeUndefined()
})
it('never offers signing after a refused request', async () => {
  mock.tool.mockResolvedValue({ ok: false, body: {}, action })
  expect((await runAssistant(input)).steps[0]?.action).toBeUndefined()
})
