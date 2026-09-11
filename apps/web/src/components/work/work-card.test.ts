import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import type { TaskSummary } from '../../lib/api'
import { WorkCard } from './WorkBoard'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
let renderer: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
})
const owner = `0x${'ab'.repeat(20)}`
const worker = `0x${'cd'.repeat(20)}`
const task: TaskSummary = {
  id: 'sample-task',
  poster: owner,
  claimedBy: worker,
  title: 'Position report',
  brief: 'Read the account.',
  submission: 'A real submitted report.',
  kind: 'research',
  pricePoints: 500,
  feePoints: 12,
  totalPoints: 512,
  outlay: '0',
  workHours: 24,
  status: 'SUBMITTED',
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-01T10:01:00Z',
}
function props(changes: Partial<TaskSummary> = {}, wallet: string | null = owner) {
  return {
    task: { ...task, ...changes },
    owner: wallet,
    busy: false,
    selected: false,
    onAction: () => {},
    onConnect: () => {},
  }
}
const buttons = () => renderer?.root.findAllByType('button') ?? []
const button = (label: string) =>
  buttons().find((item) => item.children.some((child) => child === label))

test('expanded delivery keeps raw code and link bytes and provides the original full text', async () => {
  const submission = 'Read [this result](https://example.test/a\u2014b).\n\n```text\nx\u2014y\n```'
  await act(async () => {
    renderer = create(createElement(WorkCard, props({ submission })))
  })
  assert.equal(renderer?.root.findAllByType('pre').length, 0)
  await act(async () => button('View details')?.props.onClick())
  assert.ok(
    renderer?.root
      .findAllByType('a')
      .some(
        (link) =>
          link.props.href === 'https://example.test/a%E2%80%94b' ||
          link.props.href === 'https://example.test/a\u2014b',
      ),
  )
  assert.ok(renderer?.root.findAllByType('code').some((code) => code.children.includes('x\u2014y')))
  assert.ok(renderer?.root.findAllByType('pre').some((pre) => pre.children.includes(submission)))
})

test('review requires a deliberate second confirmation, and only the poster sees payment controls', async () => {
  const calls: unknown[] = []
  await act(async () => {
    renderer = create(
      createElement(WorkCard, {
        ...props(),
        onAction: (...args: unknown[]) => {
          calls.push(args)
        },
      }),
    )
  })
  assert.equal(button('Accept & pay'), undefined)
  await act(async () => button('Review & pay')?.props.onClick())
  assert.equal(calls.length, 0)
  assert.ok(button('Accept & pay'))
  await act(async () => renderer?.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.equal(calls.length, 1)
  await act(async () => renderer?.update(createElement(WorkCard, props({}, worker))))
  assert.equal(button('Review & pay'), undefined)
  assert.equal(button('Accept & pay'), undefined)
})

test('a live status update retains expanded reading state and removes obsolete confirmations', async () => {
  await act(async () => {
    renderer = create(createElement(WorkCard, props()))
  })
  await act(async () => button('Review & pay')?.props.onClick())
  await act(async () => renderer?.update(createElement(WorkCard, props({ status: 'SETTLED' }))))
  assert.ok(button('Less detail'))
  assert.equal(button('Accept & pay'), undefined)
  assert.ok(
    renderer?.root.findAllByType('pre').some((pre) => pre.children.includes(task.submission ?? '')),
  )
})

test('expired commissioned work exposes the existing refund route to its poster', async () => {
  await act(async () => {
    renderer = create(
      createElement(WorkCard, props({ status: 'CLAIMED', claimExpiresAt: '2020-01-01T00:00:00Z' })),
    )
  })
  assert.ok(button('Cancel expired task & refund'))
  await act(async () =>
    renderer?.update(
      createElement(
        WorkCard,
        props({ status: 'CLAIMED', claimExpiresAt: '2020-01-01T00:00:00Z' }, worker),
      ),
    ),
  )
  assert.equal(button('Cancel expired task & refund'), undefined)
  assert.equal(button('Submit delivery')?.props.disabled, true)
})

test('another task in flight locks this card without giving it a false action label', async () => {
  await act(async () => {
    renderer = create(
      createElement(WorkCard, {
        ...props({ status: 'CLAIMED' }, worker),
        locked: true,
        actionError: 'The delivery could not be saved.',
      }),
    )
  })

  assert.equal(button('Submit delivery')?.props.disabled, true)
  assert.equal(button('Submitting…'), undefined)
  const alert = renderer?.root.findByProps({ role: 'alert' })
  assert.ok(JSON.stringify(alert?.children).includes('The delivery could not be saved.'))
})
