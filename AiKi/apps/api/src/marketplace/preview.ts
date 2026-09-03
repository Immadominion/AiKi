import { hashCanonicalJson } from './canonical-json.js'
import { MarketplaceError } from './errors.js'
import type { JsonObject, JsonValue, OfferView } from './model.js'
import { type Quote, quoteExactAmount } from './quote.js'

export type PreviewJobInput = Readonly<{
  offerId: string
  offerVersion: number
  brief: string
  requirements: JsonObject
  definitionOfDone: string
  evidenceRequirements: JsonObject
}>

export type JobPreview = Readonly<{
  previewHash: string
  offer: {
    id: string
    version: number
    termsHash: string
    providerId: string
    providerName: string
    title: string
  }
  scope: {
    brief: string
    requirements: JsonObject
    definitionOfDone: string
    evidenceRequirements: JsonObject
  }
  settlement: {
    chainId: number
    token: `0x${string}`
    decimals: number
    pricingModel: OfferView['pricing']['model']
    quote: Quote | null
  }
  deliverySlaSeconds: number
  reviewSlaSeconds: number
  includedRevisions: number
  canCreateJob: boolean
  nextAction: 'CREATE_JOB' | 'REQUEST_QUOTE'
}>

const object = (value: unknown, field: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MarketplaceError('INVALID_JOB_PREVIEW', `${field} must be an object.`, {
      details: { field },
    })
  const budget = { nodes: 0 }
  const visit = (entry: unknown, depth: number): void => {
    budget.nodes += 1
    if (depth > 32 || budget.nodes > 10_000)
      throw new MarketplaceError(
        'INVALID_JOB_PREVIEW',
        `${field} exceeds the supported JSON complexity limit.`,
        { details: { field } },
      )
    if (!entry || typeof entry !== 'object') return
    for (const child of Array.isArray(entry) ? entry : Object.values(entry)) visit(child, depth + 1)
  }
  visit(value, 0)
  return value as JsonObject
}

export function normalizePreviewJob(value: unknown): PreviewJobInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MarketplaceError('INVALID_JOB_PREVIEW', 'The preview body must be an object.')
  const input = value as Record<string, unknown>
  const allowed = new Set([
    'offerId',
    'offerVersion',
    'brief',
    'requirements',
    'definitionOfDone',
    'evidenceRequirements',
  ])
  const unknown = Object.keys(input).find((field) => !allowed.has(field))
  if (unknown)
    throw new MarketplaceError('INVALID_JOB_PREVIEW', `${unknown} is not a supported field.`, {
      details: { field: unknown },
    })
  if (typeof input.offerId !== 'string')
    throw new MarketplaceError('INVALID_JOB_PREVIEW', 'offerId is required.')
  if (!Number.isSafeInteger(input.offerVersion) || (input.offerVersion as number) < 1)
    throw new MarketplaceError('INVALID_JOB_PREVIEW', 'offerVersion must be a positive integer.')
  if (typeof input.brief !== 'string' || !input.brief.trim())
    throw new MarketplaceError('INVALID_JOB_PREVIEW', 'brief is required.')
  const brief = input.brief.trim()
  if (brief.length > 10_000)
    throw new MarketplaceError('INVALID_JOB_PREVIEW', 'brief must be at most 10000 characters.')
  if (typeof input.definitionOfDone !== 'string' || !input.definitionOfDone.trim())
    throw new MarketplaceError('INVALID_JOB_PREVIEW', 'definitionOfDone is required.')
  const definitionOfDone = input.definitionOfDone.trim()
  if (definitionOfDone.length > 10_000)
    throw new MarketplaceError(
      'INVALID_JOB_PREVIEW',
      'definitionOfDone must be at most 10000 characters.',
    )
  return {
    offerId: input.offerId,
    offerVersion: input.offerVersion as number,
    brief,
    requirements: object(input.requirements ?? {}, 'requirements'),
    definitionOfDone,
    evidenceRequirements: object(input.evidenceRequirements ?? {}, 'evidenceRequirements'),
  }
}

export function buildJobPreview(offer: OfferView, input: PreviewJobInput): JobPreview {
  if (offer.id !== input.offerId || offer.version !== input.offerVersion)
    throw new MarketplaceError(
      'OFFER_VERSION_CHANGED',
      'That offer has changed. Review its current terms before hiring.',
      { statusCode: 409, details: { currentVersion: String(offer.version) } },
    )

  const quote =
    offer.pricing.model === 'QUOTE' || offer.pricing.amount === null
      ? null
      : quoteExactAmount(offer.pricing.amount, offer.pricing.platformFeeBps)
  const hashInput = {
    offer: {
      id: offer.id,
      version: offer.version,
      termsHash: offer.termsHash,
    },
    scope: {
      brief: input.brief,
      requirements: input.requirements,
      definitionOfDone: input.definitionOfDone,
      evidenceRequirements: input.evidenceRequirements,
    },
    settlement: {
      chainId: offer.pricing.chainId,
      token: offer.pricing.token,
      decimals: offer.pricing.decimals,
      quote,
    },
  }

  return {
    previewHash: hashCanonicalJson(hashInput as unknown as JsonValue),
    offer: {
      id: offer.id,
      version: offer.version,
      termsHash: offer.termsHash,
      providerId: offer.providerId,
      providerName: offer.providerName,
      title: offer.title,
    },
    scope: hashInput.scope,
    settlement: {
      chainId: offer.pricing.chainId,
      token: offer.pricing.token,
      decimals: offer.pricing.decimals,
      pricingModel: offer.pricing.model,
      quote,
    },
    deliverySlaSeconds: offer.deliverySlaSeconds,
    reviewSlaSeconds: offer.reviewSlaSeconds,
    includedRevisions: offer.includedRevisions,
    canCreateJob: quote !== null,
    nextAction: quote ? 'CREATE_JOB' : 'REQUEST_QUOTE',
  }
}
