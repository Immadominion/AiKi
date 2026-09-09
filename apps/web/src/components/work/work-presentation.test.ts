import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskSummary } from '@/lib/api'
import {
  deadlinePassed,
  filterWork,
  isPoster,
  relativeDeadline,
  WORK_STATUS,
} from './work-presentation'

const now = Date.parse('2026-09-09T12:00:00Z')
const task = (id: string, status: TaskSummary['status'], days = 0): TaskSummary => ({
  id,
  status,
  poster: '0xAbC',
  title: 'Position report',
  brief: 'Read one position.',
  kind: 'analysis',
  pricePoints: 100,
  feePoints: 2,
  totalPoints: 102,
  outlay: '102',
  workHours: 24,
  createdAt: new Date(now - days * 86_400_000).toISOString(),
  updatedAt: new Date(now).toISOString(),
})
const tasks = [
  task('1', 'OPEN'),
  task('2', 'CLAIMED'),
  task('3', 'SUBMITTED'),
  task('4', 'SETTLED', 10),
  task('5', 'DISPUTED'),
  task('6', 'CANCELLED', 40),
]
test('every Work status remains reachable and actual status/date filters combine', () => {
  assert.equal(filterWork(tasks, 'all', 'all', now).length, 6)
  assert.deepEqual(
    filterWork(tasks, 'active', 'all', now).map((t) => t.id),
    ['1', '2'],
  )
  assert.deepEqual(
    filterWork(tasks, 'review', '7', now).map((t) => t.id),
    ['3'],
  )
  assert.equal(filterWork(tasks, 'completed', '7', now).length, 0)
  assert.deepEqual(
    filterWork(tasks, 'completed', '30', now).map((t) => t.id),
    ['4'],
  )
  assert.equal(Object.keys(WORK_STATUS).length, 6)
})
test('actions use wallet ownership, independent of address case', () => {
  const work = task('owner', 'OPEN')
  assert.equal(isPoster(work, '0xabc'), true)
  assert.equal(isPoster(work, null), false)
  assert.equal(isPoster(work, '0xdef'), false)
})
test('deadline boundaries and missing deadlines are unambiguous', () => {
  assert.equal(deadlinePassed(undefined, now), false)
  assert.equal(deadlinePassed('bad date', now), false)
  assert.equal(deadlinePassed(new Date(now).toISOString(), now), true)
  assert.equal(relativeDeadline(new Date(now + 60_000).toISOString(), now), '1m left')
  assert.equal(relativeDeadline(new Date(now + 3_600_000).toISOString(), now), '1h left')
  assert.equal(relativeDeadline(undefined, now), 'No deadline')
})
