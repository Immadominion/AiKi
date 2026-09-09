import { expect, it } from 'vitest'
import { stoppedReply } from './outcomes.js'

// Regression: a budget-stopped real Chrome turn hid the external read result.
// Found during production QA on 2026-09-09. No second model call is needed.
it('preserves an external read result without inventing a Work task', () => {
  const reply = stoppedReply('budget', [
    {
      tool: 'read_external_agent',
      mutating: false,
      ok: true,
      body: {
        agentId: '43129',
        status: 'completed',
        content: [{ type: 'text', text: 'CORE liquidity: 0. Shortfall: 0.' }],
        secret: 'must-not-appear',
      },
    },
  ])
  expect(reply).toContain('CORE liquidity: 0. Shortfall: 0.')
  expect(reply).toContain('Provider response')
  expect(reply).not.toContain('Open your work')
  expect(reply).not.toContain('must-not-appear')
})

it('shows an external provider refusal as a refusal, not a successful report', () => {
  const reply = stoppedReply('budget', [
    {
      tool: 'read_external_agent',
      mutating: false,
      ok: false,
      body: {
        agentId: '43129',
        status: 'provider_error',
        content: [{ type: 'text', text: 'The requested pool is unavailable.' }],
      },
    },
  ])
  expect(reply).toContain('The requested pool is unavailable.')
  expect(reply).toContain('did not complete')
  expect(reply).not.toContain('returned successfully')
})

it('bounds and neutralizes provider markup and only selects text content', () => {
  const reply = stoppedReply('budget', [
    {
      tool: 'read_external_agent',
      mutating: false,
      ok: true,
      body: {
        agentId: '[x](javascript:alert)',
        status: 'completed',
        content: [
          {
            type: 'text',
            text: `[Click](javascript:alert) <script>bad</script> ${'x'.repeat(30_000)}`,
          },
          { type: 'resource', text: 'do-not-print-this-resource' },
        ],
      },
    },
  ])
  expect(reply.length).toBeLessThan(2_000)
  expect(reply).not.toContain('[Click]')
  expect(reply).not.toContain('<script>')
  expect(reply).not.toContain('do-not-print-this-resource')
  expect(reply).not.toContain('/catalog/')
})

it('preserves actionable API errors without printing unrelated fields', () => {
  const reply = stoppedReply('budget', [
    {
      tool: 'read_external_agent',
      mutating: false,
      ok: false,
      body: {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Sign in with your wallet before running this read.',
        },
        secret: 'never-print',
      },
    },
  ])
  expect(reply).toContain('Sign in with your wallet before running this read.')
  expect(reply).toContain('did not complete')
  expect(reply).not.toContain('never-print')
})

it('still directs a turn with real task mutations to Work', () => {
  const reply = stoppedReply('budget', [
    {
      tool: 'read_external_agent',
      mutating: false,
      ok: true,
      body: { status: 'completed', content: [{ type: 'text', text: 'A read.' }] },
    },
    {
      tool: 'hire_agent',
      mutating: true,
      ok: true,
      body: { id: 'task-1', status: 'CLAIMED' },
    },
  ])
  expect(reply).toContain('Open your work')
})
