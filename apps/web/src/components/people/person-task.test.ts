import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Seller } from '../../lib/api'
import { taskPrice } from '../hire/agent-task'
import {
  buildPersonTask,
  personAttemptKey,
  personTaskAttempt,
  validatePersonListing,
} from './person-task'

const owner = `0x${'ab'.repeat(20)}`
const seller: Seller = {
  address: `0x${'cd'.repeat(20)}`,
  name: 'Writer',
  blurb: 'Clear copy',
  kinds: ['writing'],
  ratePoints: 500,
  available: true,
  updatedAt: '',
  record: { delivered: 0, disputed: 0, earnedPoints: 0 },
}
const pricing = { minimumPricePoints: 10, feeBasisPoints: 250 }
const draft = {
  title: ' Write onboarding ',
  brief: ' Explain the first steps. ',
  kind: 'writing',
  offer: '500',
  workHours: 24,
}

test('a person commission names the actual wallet and exact reviewed points offer', () => {
  assert.deepEqual(buildPersonTask(draft, seller, owner, pricing), {
    title: 'Write onboarding',
    brief: 'Explain the first steps.',
    kind: 'writing',
    pricePoints: 500,
    workHours: 24,
    hirePerson: seller.address,
  })
  assert.deepEqual(taskPrice(draft.offer, pricing.minimumPricePoints, pricing.feeBasisPoints), {
    offer: 500,
    fee: 12,
    total: 512,
  })
})
test('rejects self hire, paused listing and work the provider does not offer', () => {
  assert.throws(
    () => buildPersonTask(draft, seller, seller.address.toUpperCase(), pricing),
    /own listing/,
  )
  assert.throws(
    () => buildPersonTask(draft, { ...seller, available: false }, owner, pricing),
    /not taking/,
  )
  assert.throws(() => buildPersonTask({ ...draft, kind: 'code' }, seller, owner, pricing), /offers/)
})
test('invalid and unsafe prices, oversized briefs and deadlines cannot reach the task API', () => {
  for (const offer of ['-1', '5', '1.5', 'NaN', String(Number.MAX_SAFE_INTEGER)])
    assert.throws(() => buildPersonTask({ ...draft, offer }, seller, owner, pricing))
  assert.throws(() =>
    buildPersonTask({ ...draft, brief: 'x'.repeat(2001) }, seller, owner, pricing),
  )
  assert.throws(() => buildPersonTask({ ...draft, workHours: Number.NaN }, seller, owner, pricing))
})
test('pending commission retries retain the exact key and body, never silently fund changed work', () => {
  const request = buildPersonTask(draft, seller, owner, pricing)
  const attempt = personTaskAttempt(null, request, () => 'same-request')
  assert.equal(
    personTaskAttempt(attempt, request, () => 'wrong-new-key'),
    attempt,
  )
  assert.throws(
    () => personTaskAttempt(attempt, { ...request, pricePoints: 600 }, () => 'wrong-new-key'),
    /earlier request/,
  )
  assert.equal(
    personAttemptKey(owner, seller.address),
    personAttemptKey(owner.toUpperCase(), seller.address.toUpperCase()),
  )
  assert.notEqual(personAttemptKey(owner, seller.address), personAttemptKey(seller.address, owner))
})
test('listing editing preserves paused availability and validates complete whole-point input', () => {
  const input = {
    name: ' Writer ',
    blurb: ' Clear copy ',
    kinds: ['writing'],
    rate: '0',
    available: false,
  }
  assert.deepEqual(validatePersonListing(input), {
    name: 'Writer',
    blurb: 'Clear copy',
    kinds: ['writing'],
    ratePoints: 0,
    available: false,
  })
  for (const rate of ['-1', '2.5', 'NaN', '9007199254740992'])
    assert.throws(() => validatePersonListing({ ...input, rate }))
  assert.throws(() => validatePersonListing({ ...input, kinds: [] }))
})
