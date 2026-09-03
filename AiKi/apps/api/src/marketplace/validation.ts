import { parseBaseUnits } from './domain/money.js'
import { MarketplaceError } from './errors.js'
import type {
  CreateJob,
  CreateOffer,
  DispatchMethod,
  JsonObject,
  PricingModel,
  ProviderAvailability,
  PutProvider,
  ReviewDecision,
  ReviewJob,
  SubmitJob,
} from './model.js'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TAG = /^[a-z0-9][a-z0-9:_-]{0,39}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/
const AVAILABILITY = new Set<ProviderAvailability>(['AVAILABLE', 'BUSY', 'OFFLINE', 'PAUSED'])
const PRICING = new Set<PricingModel>(['FIXED', 'HOURLY', 'MILESTONE', 'QUOTE'])
const DISPATCH = new Set<DispatchMethod>(['HTTP', 'MCP', 'MANUAL', 'NONE'])
const REVIEW_DECISIONS = new Set<ReviewDecision>(['ACCEPT', 'REQUEST_CHANGES'])
const PROVIDER_FIELDS = new Set([
  'displayName',
  'summary',
  'availability',
  'capacity',
  'supportedProtocols',
  'geography',
])
const OFFER_FIELDS = new Set([
  'title',
  'summary',
  'capabilityTags',
  'inputSchema',
  'outputSchema',
  'evidenceSchema',
  'pricingModel',
  'settlementChainId',
  'settlementToken',
  'settlementDecimals',
  'amount',
  'deliverySlaSeconds',
  'reviewSlaSeconds',
  'includedRevisions',
  'concurrentCapacity',
  'dispatchMethod',
  'dispatchEndpoint',
  'failoverSafe',
])
const JOB_FIELDS = new Set([
  'offerId',
  'offerVersion',
  'previewHash',
  'brief',
  'requirements',
  'definitionOfDone',
  'evidenceRequirements',
])
const SUBMISSION_FIELDS = new Set(['output', 'evidence', 'artifactUri', 'note'])
const REVIEW_FIELDS = new Set(['decision', 'note', 'requiredChanges'])
const HASH = /^[0-9a-f]{64}$/

const invalid = (field: string, message: string): never => {
  throw new MarketplaceError('INVALID_MARKETPLACE_INPUT', `${field} ${message}.`, {
    details: { field },
  })
}

const boundedText = (value: unknown, field: string, maximum: number): string => {
  if (typeof value !== 'string') return invalid(field, 'must be text')
  const normalized = value.trim()
  if (!normalized) return invalid(field, 'is required')
  if (normalized.length > maximum) return invalid(field, `must be at most ${maximum} characters`)
  return normalized
}

const optionalText = (value: unknown, field: string, maximum: number): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return invalid(field, 'must be text')
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > maximum) return invalid(field, `must be at most ${maximum} characters`)
  return normalized
}

const onlyFields = (input: Record<string, unknown>, allowed: Set<string>): void => {
  const unknown = Object.keys(input).filter((field) => !allowed.has(field))
  if (unknown.length) invalid(unknown[0] ?? 'body', 'is not a supported field')
}

const integer = (value: unknown, field: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return invalid(field, `must be an integer from ${minimum} to ${maximum}`)
  return value as number
}

const object = (value: unknown, field: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid(field, 'must be an object')
  const budget = { nodes: 0 }
  const visit = (entry: unknown, depth: number): void => {
    budget.nodes += 1
    if (depth > 32 || budget.nodes > 10_000)
      invalid(field, 'exceeds the supported JSON complexity limit')
    if (!entry || typeof entry !== 'object') return
    for (const child of Array.isArray(entry) ? entry : Object.values(entry)) visit(child, depth + 1)
  }
  visit(value, 0)
  return value as JsonObject
}

const tags = (value: unknown, field: string, maximum: number): string[] => {
  if (!Array.isArray(value) || value.length > maximum)
    return invalid(field, `must be an array with at most ${maximum} entries`)
  const normalized = value.map((entry) => {
    if (typeof entry !== 'string') return invalid(field, 'must contain only text')
    const tag = entry.trim().toLowerCase()
    if (!TAG.test(tag)) return invalid(field, 'contains an invalid tag')
    return tag
  })
  return [...new Set(normalized)].sort()
}

export function normalizeAddress(value: unknown, field = 'address'): `0x${string}` {
  if (typeof value !== 'string' || !ADDRESS.test(value))
    return invalid(field, 'must be an EVM address')
  return value.toLowerCase() as `0x${string}`
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new MarketplaceError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Send one printable ASCII Idempotency-Key of at most 200 characters.',
      { statusCode: 400 },
    )
  }
  return value
}

export function normalizeProvider(value: unknown): PutProvider {
  const input = object(value, 'body') as Record<string, unknown>
  onlyFields(input, PROVIDER_FIELDS)
  const availability = input.availability ?? 'AVAILABLE'
  if (!AVAILABILITY.has(availability as ProviderAvailability))
    return invalid('availability', 'is not supported')

  return {
    displayName: boundedText(input.displayName, 'displayName', 80),
    summary: boundedText(input.summary, 'summary', 600),
    availability: availability as ProviderAvailability,
    capacity: integer(input.capacity ?? 1, 'capacity', 0, 10000),
    supportedProtocols: tags(input.supportedProtocols ?? [], 'supportedProtocols', 20),
    geography: object(input.geography ?? {}, 'geography'),
  }
}

export function normalizeOffer(value: unknown, platformFeeBps: number): CreateOffer {
  const input = object(value, 'body') as Record<string, unknown>
  onlyFields(input, OFFER_FIELDS)
  const pricingModel = input.pricingModel
  if (!PRICING.has(pricingModel as PricingModel)) return invalid('pricingModel', 'is not supported')
  const dispatchMethod = input.dispatchMethod ?? 'NONE'
  if (!DISPATCH.has(dispatchMethod as DispatchMethod))
    return invalid('dispatchMethod', 'is not supported')

  let amount: string | null = null
  if (pricingModel !== 'QUOTE') {
    if (typeof input.amount !== 'string') return invalid('amount', 'must be a decimal string')
    try {
      amount = parseBaseUnits(input.amount).toString()
    } catch {
      return invalid('amount', 'must be a canonical unsigned decimal string within uint256')
    }
    if (amount === '0') return invalid('amount', 'must be greater than zero')
  } else if (input.amount !== undefined && input.amount !== null) {
    return invalid('amount', 'must be omitted for quote pricing')
  }

  let dispatchEndpoint: string | null = null
  if (dispatchMethod === 'HTTP' || dispatchMethod === 'MCP') {
    if (typeof input.dispatchEndpoint !== 'string')
      return invalid('dispatchEndpoint', 'is required for this dispatch method')
    let endpoint: URL
    try {
      endpoint = new URL(input.dispatchEndpoint)
    } catch {
      return invalid('dispatchEndpoint', 'must be a valid URL')
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      return invalid('dispatchEndpoint', 'must be an HTTP URL without embedded credentials')
    endpoint.hash = ''
    dispatchEndpoint = endpoint.toString()
  } else if (input.dispatchEndpoint !== undefined && input.dispatchEndpoint !== null) {
    return invalid('dispatchEndpoint', 'must be omitted for manual dispatch')
  }

  return {
    title: boundedText(input.title, 'title', 120),
    summary: boundedText(input.summary, 'summary', 1200),
    capabilityTags: tags(input.capabilityTags ?? [], 'capabilityTags', 30),
    inputSchema: object(input.inputSchema ?? {}, 'inputSchema'),
    outputSchema: object(input.outputSchema ?? {}, 'outputSchema'),
    evidenceSchema: object(input.evidenceSchema ?? {}, 'evidenceSchema'),
    pricingModel: pricingModel as PricingModel,
    settlementChainId: integer(input.settlementChainId, 'settlementChainId', 1, 2_147_483_647),
    settlementToken: normalizeAddress(input.settlementToken, 'settlementToken'),
    settlementDecimals: integer(input.settlementDecimals, 'settlementDecimals', 0, 255),
    amount,
    platformFeeBps: integer(platformFeeBps, 'platformFeeBps', 0, 10000),
    deliverySlaSeconds: integer(input.deliverySlaSeconds, 'deliverySlaSeconds', 60, 31_536_000),
    reviewSlaSeconds: integer(input.reviewSlaSeconds, 'reviewSlaSeconds', 60, 2_592_000),
    includedRevisions: integer(input.includedRevisions ?? 0, 'includedRevisions', 0, 100),
    concurrentCapacity: integer(input.concurrentCapacity ?? 1, 'concurrentCapacity', 1, 10000),
    dispatchMethod: dispatchMethod as DispatchMethod,
    dispatchEndpoint,
    failoverSafe: input.failoverSafe === true,
  }
}

export function normalizeCreateJob(value: unknown): CreateJob {
  const input = object(value, 'body') as Record<string, unknown>
  onlyFields(input, JOB_FIELDS)
  if (typeof input.offerId !== 'string') return invalid('offerId', 'is required')
  if (typeof input.previewHash !== 'string' || !HASH.test(input.previewHash))
    return invalid('previewHash', 'must be the hash returned by preview')
  return {
    offerId: input.offerId,
    offerVersion: integer(input.offerVersion, 'offerVersion', 1, 2_147_483_647),
    previewHash: input.previewHash,
    brief: boundedText(input.brief, 'brief', 10_000),
    requirements: object(input.requirements ?? {}, 'requirements'),
    definitionOfDone: boundedText(input.definitionOfDone, 'definitionOfDone', 10_000),
    evidenceRequirements: object(input.evidenceRequirements ?? {}, 'evidenceRequirements'),
  }
}

export function normalizeSubmitJob(value: unknown): SubmitJob {
  const input = object(value, 'body') as Record<string, unknown>
  onlyFields(input, SUBMISSION_FIELDS)

  let artifactUri: string | null = null
  if (input.artifactUri !== undefined && input.artifactUri !== null) {
    if (typeof input.artifactUri !== 'string') return invalid('artifactUri', 'must be a URI')
    let uri: URL
    try {
      uri = new URL(input.artifactUri)
    } catch {
      return invalid('artifactUri', 'must be a valid URI')
    }
    if (!['https:', 'ipfs:'].includes(uri.protocol) || uri.username || uri.password)
      return invalid('artifactUri', 'must be an HTTPS or IPFS URI without credentials')
    uri.hash = ''
    artifactUri = uri.toString()
  }

  return {
    output: object(input.output ?? {}, 'output'),
    evidence: object(input.evidence ?? {}, 'evidence'),
    artifactUri,
    note: optionalText(input.note, 'note', 5000),
  }
}

export function normalizeReviewJob(value: unknown): ReviewJob {
  const input = object(value, 'body') as Record<string, unknown>
  onlyFields(input, REVIEW_FIELDS)
  if (!REVIEW_DECISIONS.has(input.decision as ReviewDecision))
    return invalid('decision', 'must be ACCEPT or REQUEST_CHANGES')
  const decision = input.decision as ReviewDecision
  const requiredChanges =
    input.requiredChanges === undefined || input.requiredChanges === null
      ? null
      : object(input.requiredChanges, 'requiredChanges')
  if (decision === 'REQUEST_CHANGES' && !requiredChanges)
    return invalid('requiredChanges', 'is required when requesting changes')
  if (decision === 'ACCEPT' && requiredChanges)
    return invalid('requiredChanges', 'must be omitted when accepting work')

  return {
    decision,
    note: optionalText(input.note, 'note', 5000),
    requiredChanges,
  }
}
