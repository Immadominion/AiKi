import type { Seller, TaskRequest } from '../../lib/api'
import { TASK_TYPES, taskPrice } from '../hire/agent-task'

export interface PersonTaskDraft {
  title: string
  brief: string
  kind: string
  offer: string
  workHours: number
}
export interface PersonTaskPricing {
  minimumPricePoints: number
  feeBasisPoints: number
}

export function buildPersonTask(
  draft: PersonTaskDraft,
  seller: Seller,
  owner: string,
  pricing: PersonTaskPricing,
): TaskRequest {
  if (!/^0x[0-9a-f]{40}$/i.test(seller.address)) throw new Error('Choose a listed person.')
  if (seller.address.toLowerCase() === owner.toLowerCase())
    throw new Error('You cannot hire your own listing.')
  if (!seller.available) throw new Error('This person is not taking new work right now.')
  const title = draft.title.trim()
  const brief = draft.brief.trim()
  if (!title || title.length > 120) throw new Error('Add a title of up to 120 characters.')
  if (!brief || brief.length > 2000) throw new Error('Describe the work in up to 2,000 characters.')
  if (!seller.kinds.includes(draft.kind) || !TASK_TYPES.some(([kind]) => kind === draft.kind))
    throw new Error('Choose a type of work this person offers.')
  if (!Number.isInteger(draft.workHours) || draft.workHours < 1 || draft.workHours > 720)
    throw new Error('Choose a delivery time between 1 hour and 30 days.')
  const price = taskPrice(draft.offer, pricing.minimumPricePoints, pricing.feeBasisPoints)
  return {
    title,
    brief,
    kind: draft.kind,
    pricePoints: price.offer,
    workHours: draft.workHours,
    hirePerson: seller.address.toLowerCase(),
  }
}

export interface PersonTaskAttempt {
  key: string
  request: TaskRequest
}
export const personAttemptKey = (owner: string, seller: string) =>
  `aiki.person-task.v1:${owner.toLowerCase()}:${seller.toLowerCase()}`
export function personTaskAttempt(
  previous: PersonTaskAttempt | null,
  request: TaskRequest,
  key: () => string,
): PersonTaskAttempt {
  if (previous) {
    if (JSON.stringify(previous.request) !== JSON.stringify(request))
      throw new Error('Check the earlier request before changing this offer.')
    return previous
  }
  return { key: key(), request }
}

export function validatePersonListing(input: {
  name: string
  blurb: string
  kinds: string[]
  rate: string
  available: boolean
}) {
  if (!input.name.trim() || input.name.trim().length > 60)
    throw new Error('Add a name of up to 60 characters.')
  if (!input.blurb.trim() || input.blurb.trim().length > 400)
    throw new Error('Describe your work in up to 400 characters.')
  if (
    !input.kinds.length ||
    input.kinds.some((value) => !TASK_TYPES.some(([kind]) => kind === value))
  )
    throw new Error('Choose at least one type of work.')
  const { offer } = taskPrice(input.rate, 0, 0)
  return {
    name: input.name.trim(),
    blurb: input.blurb.trim(),
    kinds: input.kinds,
    ratePoints: offer,
    available: input.available,
  }
}
