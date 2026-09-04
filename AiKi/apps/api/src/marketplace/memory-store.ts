import { randomUUID } from 'node:crypto'
import { hashCanonicalJson } from './canonical-json.js'
import { IdempotencyConflictError, MarketplaceError } from './errors.js'
import type {
  ActorIdentity,
  CommandResult,
  CreateJob,
  CreateOffer,
  Idempotency,
  JobReviewView,
  JobStartView,
  JobSubmissionView,
  JobView,
  JsonValue,
  OfferView,
  Page,
  ProviderView,
  PutProvider,
  ReviewJob,
  SubmitJob,
} from './model.js'
import { encodeCursor, type PageCursor } from './pagination.js'
import { buildJobPreview } from './preview.js'
import { settlementRailFor } from './settlement-rails.js'
import type { MarketplaceStore } from './store.js'

type SavedCommand = { requestHash: string; statusCode: number; body: unknown }

const actorKey = (actor: ActorIdentity): string => `${actor.chainId}:${actor.address}`
const commandKey = (actor: ActorIdentity, operation: string, key: string): string =>
  `${actorKey(actor)}:${operation}:${key}`

const afterCursor = <T extends { createdAt: string; id: string }>(
  items: T[],
  cursor: PageCursor | null,
) =>
  cursor
    ? items.filter(
        (item) =>
          item.createdAt < cursor.createdAt ||
          (item.createdAt === cursor.createdAt && item.id < cursor.id),
      )
    : items

/** A faithful local adapter for route tests and development without Postgres. */
export class InMemoryMarketplaceStore implements MarketplaceStore {
  private readonly actorIds = new Map<string, string>()
  private readonly providers = new Map<string, ProviderView>()
  private readonly offers = new Map<string, OfferView>()
  private readonly jobs = new Map<string, JobView>()
  private readonly submissions = new Map<string, JobSubmissionView>()
  private readonly commands = new Map<string, SavedCommand>()

  private actor(actor: ActorIdentity): string {
    const key = actorKey(actor)
    const existing = this.actorIds.get(key)
    if (existing) return existing
    const id = randomUUID()
    this.actorIds.set(key, id)
    return id
  }

  private run<T>(input: {
    actor: ActorIdentity
    operation: string
    idempotency: Idempotency
    statusCode: number
    execute: (actorId: string) => T
  }): CommandResult<T> {
    const key = commandKey(input.actor, input.operation, input.idempotency.key)
    const previous = this.commands.get(key)
    if (previous) {
      if (previous.requestHash !== input.idempotency.requestHash)
        throw new IdempotencyConflictError()
      return {
        body: structuredClone(previous.body) as T,
        statusCode: previous.statusCode,
        replayed: true,
      }
    }
    const body = input.execute(this.actor(input.actor))
    this.commands.set(key, {
      requestHash: input.idempotency.requestHash,
      statusCode: input.statusCode,
      body: structuredClone(body),
    })
    return { body, statusCode: input.statusCode, replayed: false }
  }

  async putProvider(
    actor: ActorIdentity,
    input: PutProvider,
    idempotency: Idempotency,
  ): Promise<CommandResult<ProviderView>> {
    return this.run({
      actor,
      operation: 'provider.put',
      idempotency,
      statusCode: 200,
      execute: (id) => {
        const previous = this.providers.get(id)
        const now = new Date().toISOString()
        const provider: ProviderView = {
          id,
          actorType: 'HUMAN',
          chainId: actor.chainId,
          controllerAddress: actor.address,
          displayName: input.displayName,
          summary: input.summary,
          availability: input.availability,
          capacity: input.capacity,
          supportedProtocols: input.supportedProtocols,
          profileVersion: String(previous ? BigInt(previous.profileVersion) + 1n : 1n),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        }
        this.providers.set(id, provider)
        return provider
      },
    })
  }

  async getProvider(id: string): Promise<ProviderView | null> {
    return this.providers.get(id) ?? null
  }

  async listProviders(limit: number, cursor: PageCursor | null): Promise<Page<ProviderView>> {
    const all = afterCursor(
      [...this.providers.values()].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      ),
      cursor,
    )
    const items = all.slice(0, limit)
    const last = items.at(-1)
    return {
      items,
      nextCursor:
        all.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    }
  }

  async createOffer(
    actor: ActorIdentity,
    input: CreateOffer,
    idempotency: Idempotency,
  ): Promise<CommandResult<OfferView>> {
    return this.run({
      actor,
      operation: 'offer.create',
      idempotency,
      statusCode: 201,
      execute: (providerId) => {
        const provider = this.providers.get(providerId)
        if (!provider)
          throw new MarketplaceError(
            'PROVIDER_PROFILE_REQUIRED',
            'Create your provider profile before publishing an offer.',
            { statusCode: 409 },
          )
        const id = randomUUID()
        const now = new Date().toISOString()
        const termsHash = hashCanonicalJson({
          providerId,
          version: 1,
          ...input,
        } as unknown as JsonValue)
        const offer: OfferView = {
          id,
          providerId,
          providerName: provider.displayName,
          status: 'ACTIVE',
          visibility: 'PUBLIC',
          version: 1,
          title: input.title,
          summary: input.summary,
          capabilityTags: input.capabilityTags,
          inputSchema: input.inputSchema,
          outputSchema: input.outputSchema,
          evidenceSchema: input.evidenceSchema,
          pricing: {
            model: input.pricingModel,
            chainId: input.settlementChainId,
            token: input.settlementToken,
            decimals: input.settlementDecimals,
            amount: input.amount,
            platformFeeBps: input.platformFeeBps,
          },
          deliverySlaSeconds: input.deliverySlaSeconds,
          reviewSlaSeconds: input.reviewSlaSeconds,
          includedRevisions: input.includedRevisions,
          concurrentCapacity: input.concurrentCapacity,
          dispatch: { method: input.dispatchMethod, endpoint: input.dispatchEndpoint },
          failoverSafe: input.failoverSafe,
          termsHash,
          createdAt: now,
          updatedAt: now,
        }
        this.offers.set(id, offer)
        return offer
      },
    })
  }

  async pauseOffer(
    actor: ActorIdentity,
    offerId: string,
    idempotency: Idempotency,
  ): Promise<CommandResult<OfferView>> {
    return this.run({
      actor,
      operation: 'offer.pause',
      idempotency,
      statusCode: 200,
      execute: (providerId) => {
        const offer = this.offers.get(offerId)
        if (!offer || offer.providerId !== providerId)
          throw new MarketplaceError('OFFER_NOT_FOUND', 'No such offer.', { statusCode: 404 })
        const paused: OfferView = {
          ...offer,
          status: 'PAUSED',
          updatedAt: new Date().toISOString(),
        }
        this.offers.set(offerId, paused)
        return paused
      },
    })
  }

  async createJob(
    actor: ActorIdentity,
    input: CreateJob,
    idempotency: Idempotency,
  ): Promise<CommandResult<JobView>> {
    return this.run({
      actor,
      operation: 'job.create',
      idempotency,
      statusCode: 201,
      execute: (payerId) => {
        const offer = this.offers.get(input.offerId)
        const provider = offer ? this.providers.get(offer.providerId) : null
        if (
          !offer ||
          !provider ||
          offer.status !== 'ACTIVE' ||
          offer.version !== input.offerVersion
        )
          throw new MarketplaceError('OFFER_NOT_FOUND', 'No such offer.', { statusCode: 404 })
        if (payerId === offer.providerId)
          throw new MarketplaceError('SELF_HIRE_FORBIDDEN', 'A provider cannot hire itself.', {
            statusCode: 409,
          })
        const preview = buildJobPreview(offer, input)
        if (!preview.canCreateJob || !preview.settlement.quote)
          throw new MarketplaceError(
            'QUOTE_REQUIRED',
            'Request a quote before creating this job.',
            {
              statusCode: 409,
            },
          )
        if (preview.previewHash !== input.previewHash)
          throw new MarketplaceError(
            'PREVIEW_HASH_MISMATCH',
            'Preview this exact scope before creating the job.',
            { statusCode: 409, details: { currentPreviewHash: preview.previewHash } },
          )
        const rail = settlementRailFor({
          chainId: preview.settlement.chainId,
          token: preview.settlement.token,
          decimals: preview.settlement.decimals,
        })
        const now = new Date()
        const deliveryDeadline = new Date(now.getTime() + offer.deliverySlaSeconds * 1000)
        const reviewDeadline = new Date(deliveryDeadline.getTime() + offer.reviewSlaSeconds * 1000)
        const disputeDeadline = new Date(reviewDeadline.getTime() + 3 * 24 * 60 * 60 * 1000)
        const hardExpiry = new Date(disputeDeadline.getTime() + 7 * 24 * 60 * 60 * 1000)
        const id = randomUUID()
        const agreementId = randomUUID()
        const operationId = randomUUID()
        const logicalKey = `job:${id}:create-escrow:v1`
        const job: JobView = {
          id,
          agreementId,
          previewHash: preview.previewHash,
          title: offer.title,
          workState: 'ASSIGNED',
          settlementState: 'UNFUNDED',
          disputeState: 'NONE',
          payoutState: 'NONE',
          payerActorId: payerId,
          requesterActorId: payerId,
          providerActorId: offer.providerId,
          offer: { id: offer.id, version: offer.version, termsHash: offer.termsHash },
          scope: preview.scope,
          settlement: {
            rail: rail.rail,
            railVersion: rail.version,
            chainId: rail.chainId,
            contract: rail.contract,
            token: rail.token,
            decimals: rail.decimals,
            providerAmount: preview.settlement.quote.providerAmount,
            platformFeeAmount: preview.settlement.quote.platformFeeAmount,
            totalAmount: preview.settlement.quote.totalAmount,
          },
          deadlines: {
            delivery: deliveryDeadline.toISOString(),
            review: reviewDeadline.toISOString(),
            dispute: disputeDeadline.toISOString(),
            hardExpiry: hardExpiry.toISOString(),
          },
          fundingOperation: {
            id: operationId,
            status: 'REQUESTED',
            operationType: 'CREATE_ESCROW',
            logicalKey,
            amount: preview.settlement.quote.totalAmount,
          },
          nextAction: 'CREATE_ESCROW',
          createdAt: now.toISOString(),
        }
        this.jobs.set(id, job)
        return job
      },
    })
  }

  async startJob(
    actor: ActorIdentity,
    jobId: string,
    idempotency: Idempotency,
  ): Promise<CommandResult<JobStartView>> {
    return this.run({
      actor,
      operation: 'job.start',
      idempotency,
      statusCode: 200,
      execute: (providerId) => {
        const job = this.jobs.get(jobId)
        if (!job || job.providerActorId !== providerId)
          throw new MarketplaceError('JOB_NOT_FOUND', 'No such job.', { statusCode: 404 })
        if (job.settlementState !== 'FUNDED')
          throw new MarketplaceError(
            'JOB_NOT_FUNDED',
            'This job cannot start until funding is finalized.',
            { statusCode: 409 },
          )
        if (job.workState !== 'ASSIGNED' && job.workState !== 'IN_PROGRESS')
          throw new MarketplaceError('JOB_NOT_STARTABLE', 'This job cannot be started.', {
            statusCode: 409,
          })
        const now = new Date().toISOString()
        const started: JobView = {
          ...job,
          workState: 'IN_PROGRESS',
          nextAction: 'SUBMIT_WORK',
        }
        this.jobs.set(jobId, started)
        return {
          id: jobId,
          workState: 'IN_PROGRESS',
          settlementState: 'FUNDED',
          providerActorId: providerId,
          nextAction: 'SUBMIT_WORK',
          startedAt: now,
        }
      },
    })
  }

  async submitJob(
    actor: ActorIdentity,
    jobId: string,
    input: SubmitJob,
    idempotency: Idempotency,
  ): Promise<CommandResult<JobSubmissionView>> {
    return this.run({
      actor,
      operation: 'job.submit',
      idempotency,
      statusCode: 200,
      execute: (providerId) => {
        const job = this.jobs.get(jobId)
        if (!job || job.providerActorId !== providerId)
          throw new MarketplaceError('JOB_NOT_FOUND', 'No such job.', { statusCode: 404 })
        if (job.settlementState !== 'FUNDED')
          throw new MarketplaceError(
            'JOB_NOT_FUNDED',
            'This job cannot be submitted until funding is finalized.',
            { statusCode: 409 },
          )
        if (job.workState !== 'IN_PROGRESS')
          throw new MarketplaceError(
            'JOB_NOT_SUBMITTABLE',
            'This job is not ready for submission.',
            {
              statusCode: 409,
            },
          )
        const submissionId = randomUUID()
        const submittedAt = new Date().toISOString()
        const submissionHash = hashCanonicalJson({
          jobId,
          providerActorId: providerId,
          output: input.output,
          evidence: input.evidence,
          artifactUri: input.artifactUri,
          note: input.note,
        } as unknown as JsonValue)
        this.jobs.set(jobId, {
          ...job,
          workState: 'SUBMITTED',
          settlementState: 'DELIVERABLE_SUBMITTED',
          nextAction: 'WAIT_FOR_REVIEW',
        })
        const submission: JobSubmissionView = {
          id: submissionId,
          jobId,
          revisionNumber: 1,
          workState: 'SUBMITTED',
          settlementState: 'DELIVERABLE_SUBMITTED',
          providerActorId: providerId,
          output: input.output,
          evidence: input.evidence,
          artifactUri: input.artifactUri,
          note: input.note,
          submissionHash,
          nextAction: 'WAIT_FOR_REVIEW',
          submittedAt,
        }
        this.submissions.set(jobId, submission)
        return submission
      },
    })
  }

  async reviewJob(
    actor: ActorIdentity,
    jobId: string,
    input: ReviewJob,
    idempotency: Idempotency,
  ): Promise<CommandResult<JobReviewView>> {
    return this.run({
      actor,
      operation: 'job.review',
      idempotency,
      statusCode: 200,
      execute: (reviewerId) => {
        const job = this.jobs.get(jobId)
        const submission = this.submissions.get(jobId)
        if (!job || !submission || job.requesterActorId !== reviewerId)
          throw new MarketplaceError('JOB_NOT_FOUND', 'No such job.', { statusCode: 404 })
        if (job.settlementState !== 'DELIVERABLE_SUBMITTED')
          throw new MarketplaceError(
            'JOB_NOT_SUBMITTED_ONCHAIN',
            'This job cannot be reviewed until the deliverable is finalized on-chain.',
            { statusCode: 409 },
          )
        if (job.workState !== 'SUBMITTED')
          throw new MarketplaceError('JOB_NOT_REVIEWABLE', 'This job is not ready for review.', {
            statusCode: 409,
          })

        const reviewId = randomUUID()
        const reviewedAt = new Date().toISOString()
        const reviewHash = hashCanonicalJson({
          jobId,
          submissionId: submission.id,
          reviewerActorId: reviewerId,
          decision: input.decision,
          note: input.note,
          requiredChanges: input.requiredChanges,
        } as unknown as JsonValue)
        const workState = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'CHANGES_REQUESTED'
        const payoutState = input.decision === 'ACCEPT' ? 'HOLD' : 'NONE'
        const nextAction = input.decision === 'ACCEPT' ? 'RELEASE_PAYMENT' : 'REVISE_WORK'
        this.jobs.set(jobId, {
          ...job,
          workState,
          payoutState,
          nextAction,
        })
        return {
          id: reviewId,
          jobId,
          submissionId: submission.id,
          revisionNumber: submission.revisionNumber,
          reviewerActorId: reviewerId,
          decision: input.decision,
          workState,
          settlementState: 'DELIVERABLE_SUBMITTED',
          payoutState,
          note: input.note,
          requiredChanges: input.requiredChanges,
          reviewHash,
          nextAction,
          reviewedAt,
        }
      },
    })
  }

  async getOffer(id: string): Promise<OfferView | null> {
    const offer = this.offers.get(id)
    return offer?.status === 'ACTIVE' ? offer : null
  }

  async listOffers(limit: number, cursor: PageCursor | null): Promise<Page<OfferView>> {
    const all = afterCursor(
      [...this.offers.values()]
        .filter((offer) => offer.status === 'ACTIVE')
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        ),
      cursor,
    )
    const items = all.slice(0, limit)
    const last = items.at(-1)
    return {
      items,
      nextCursor:
        all.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    }
  }
}
