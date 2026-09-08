import { expect, it } from 'vitest'
import { stoppedReply } from './outcomes.js'

it('preserves an actual task, held cost and submitted result after the model stops', () => {
  const reply = stoppedReply('budget', [
    {
      tool: 'hire_agent',
      mutating: true,
      ok: true,
      body: {
        id: 'task-123',
        status: 'SUBMITTED',
        heldPoints: 512,
        pricePoints: 500,
        feePoints: 12,
        submission: 'No Venus debt was found.',
        dispatchNote: 'Answered straight away.',
      },
    },
  ])
  expect(reply).toContain('task-123')
  expect(reply).toContain('ready for your review')
  expect(reply).toContain('512 points held (500 for the provider + 12 AiKi fee)')
  expect(reply).toContain('No Venus debt was found.')
  expect(reply).toContain('[Open your work](/work)')
  expect(reply).not.toContain('Ask me to continue')
})

it('does not turn a task with a refused endpoint into a delivered result', () => {
  const reply = stoppedReply('rounds', [
    {
      tool: 'hire_agent',
      mutating: true,
      ok: true,
      body: {
        id: 'task-waiting',
        status: 'CLAIMED',
        dispatchNote: 'Answered 405 rather than taking the work.',
      },
    },
  ])
  expect(reply).toContain('assigned, awaiting delivery')
  expect(reply).toContain('Answered 405')
  expect(reply).not.toContain('ready for your review')
  expect(reply).not.toContain('payment released')
})

it('reports a failed request without inventing a task or echoing credentials and executable markup', () => {
  const reply = stoppedReply('budget', [
    {
      tool: 'hire_agent',
      mutating: true,
      ok: false,
      body: {
        error: { message: '[Pay me](javascript:alert) was refused' },
        secret: 'not-for-the-response',
      },
    },
  ])
  expect(reply).toContain('was not confirmed')
  expect(reply).not.toContain('Task `')
  expect(reply).not.toContain('not-for-the-response')
  expect(reply).not.toContain('[Pay me]')
})

it('keeps summaries bounded and prioritizes successful actions over large discovery responses', () => {
  const reply = stoppedReply('budget', [
    {
      tool: 'hire_agent',
      mutating: true,
      ok: true,
      body: { id: 'task-kept', status: 'SUBMITTED', submission: 'x'.repeat(50_000) },
    },
    ...Array.from({ length: 50 }, () => ({
      tool: 'search_agents',
      mutating: false,
      ok: true,
      body: { results: [] },
    })),
  ])
  expect(reply).toContain('task-kept')
  expect(reply).toContain('47 other tool results')
  expect(reply.length).toBeLessThan(2_000)
})

it('keeps a confirmed task ahead of later failures and stays below the next message size limit', () => {
  const reply = stoppedReply('rounds', [
    {
      tool: 'hire_agent',
      mutating: true,
      ok: true,
      body: { id: 'already-created', status: 'CLAIMED' },
    },
    ...Array.from({ length: 40 }, () => ({
      tool: 'hire_agent',
      mutating: true,
      ok: false,
      body: { error: { message: 'x'.repeat(20_000) } },
    })),
    ...Array.from({ length: 20 }, () => ({
      tool: 'my_tasks',
      mutating: false,
      ok: true,
      body: {
        tasks: Array.from({ length: 20 }, (_, index) => ({
          id: `task-${index}`,
          status: 'SUBMITTED',
          submission: 'y'.repeat(20_000),
          dispatchNote: 'z'.repeat(20_000),
        })),
      },
    })),
  ])
  expect(reply).toContain('already-created')
  expect(reply.length).toBeLessThan(4_000)
  expect(reply).toContain('/work')
})
