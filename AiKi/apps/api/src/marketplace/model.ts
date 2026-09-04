export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type ActorIdentity = Readonly<{
  chainId: number
  address: `0x${string}`
}>

export type Idempotency = Readonly<{
  key: string
  requestHash: string
}>

export type CommandResult<T> = Readonly<{
  body: T
  statusCode: number
  replayed: boolean
}>

export type ProviderAvailability = 'AVAILABLE' | 'BUSY' | 'OFFLINE' | 'PAUSED'

export type ProviderView = Readonly<{
  id: string
  actorType: 'HUMAN' | 'AGENT'
  chainId: number
  controllerAddress: `0x${string}`
  displayName: string
  summary: string
  availability: ProviderAvailability
  capacity: number
  supportedProtocols: string[]
  profileVersion: string
  createdAt: string
  updatedAt: string
}>

export type PutProvider = Readonly<{
  displayName: string
  summary: string
  availability: ProviderAvailability
  capacity: number
  supportedProtocols: string[]
  geography: JsonObject
}>

export type PricingModel = 'FIXED' | 'HOURLY' | 'MILESTONE' | 'QUOTE'
export type DispatchMethod = 'HTTP' | 'MCP' | 'MANUAL' | 'NONE'

export type CreateOffer = Readonly<{
  title: string
  summary: string
  capabilityTags: string[]
  inputSchema: JsonObject
  outputSchema: JsonObject
  evidenceSchema: JsonObject
  pricingModel: PricingModel
  settlementChainId: number
  settlementToken: `0x${string}`
  settlementDecimals: number
  amount: string | null
  platformFeeBps: number
  deliverySlaSeconds: number
  reviewSlaSeconds: number
  includedRevisions: number
  concurrentCapacity: number
  dispatchMethod: DispatchMethod
  dispatchEndpoint: string | null
  failoverSafe: boolean
}>

export type CreateJob = Readonly<{
  offerId: string
  offerVersion: number
  previewHash: string
  brief: string
  requirements: JsonObject
  definitionOfDone: string
  evidenceRequirements: JsonObject
}>

export type SubmitJob = Readonly<{
  output: JsonObject
  evidence: JsonObject
  artifactUri: string | null
  note: string | null
}>

export type ReviewDecision = 'ACCEPT' | 'REQUEST_CHANGES'

export type ReviewJob = Readonly<{
  decision: ReviewDecision
  note: string | null
  requiredChanges: JsonObject | null
}>

export type OfferView = Readonly<{
  id: string
  providerId: string
  providerName: string
  status: 'ACTIVE' | 'PAUSED'
  visibility: 'PUBLIC'
  version: number
  title: string
  summary: string
  capabilityTags: string[]
  inputSchema: JsonObject
  outputSchema: JsonObject
  evidenceSchema: JsonObject
  pricing: {
    model: PricingModel
    chainId: number
    token: `0x${string}`
    decimals: number
    amount: string | null
    platformFeeBps: number
  }
  deliverySlaSeconds: number
  reviewSlaSeconds: number
  includedRevisions: number
  concurrentCapacity: number
  dispatch: {
    method: DispatchMethod
    endpoint: string | null
  }
  failoverSafe: boolean
  termsHash: string
  createdAt: string
  updatedAt: string
}>

export type Page<T> = Readonly<{
  items: T[]
  nextCursor: string | null
}>

export type JobView = Readonly<{
  id: string
  agreementId: string
  previewHash: string
  title: string
  workState: 'ASSIGNED' | 'IN_PROGRESS' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'ACCEPTED'
  settlementState: 'UNFUNDED' | 'FUNDING_SUBMITTED' | 'FUNDED' | 'DELIVERABLE_SUBMITTED'
  disputeState: 'NONE'
  payoutState: 'NONE' | 'HOLD'
  payerActorId: string
  requesterActorId: string
  providerActorId: string
  offer: {
    id: string
    version: number
    termsHash: string
  }
  scope: {
    brief: string
    requirements: JsonObject
    definitionOfDone: string
    evidenceRequirements: JsonObject
  }
  settlement: {
    rail: 'BNB_APEX_ERC8183'
    railVersion: string
    chainId: number
    contract: `0x${string}`
    token: `0x${string}`
    decimals: number
    providerAmount: string
    platformFeeAmount: string
    totalAmount: string
  }
  deadlines: {
    delivery: string
    review: string
    dispute: string
    hardExpiry: string
  }
  fundingOperation: {
    id: string
    status: 'REQUESTED'
    operationType: 'CREATE_ESCROW'
    logicalKey: string
    amount: string
  }
  nextAction:
    | 'CREATE_ESCROW'
    | 'WAIT_FOR_FUNDING'
    | 'START_WORK'
    | 'SUBMIT_WORK'
    | 'WAIT_FOR_ONCHAIN_SUBMISSION'
    | 'WAIT_FOR_REVIEW'
    | 'REVISE_WORK'
    | 'RELEASE_PAYMENT'
  createdAt: string
}>

export type JobStartView = Readonly<{
  id: string
  workState: 'IN_PROGRESS'
  settlementState: 'FUNDED'
  providerActorId: string
  nextAction: 'SUBMIT_WORK'
  startedAt: string
}>

export type JobSubmissionView = Readonly<{
  id: string
  jobId: string
  revisionNumber: number
  workState: 'SUBMITTED'
  settlementState: 'FUNDED' | 'DELIVERABLE_SUBMITTED'
  providerActorId: string
  output: JsonObject
  evidence: JsonObject
  artifactUri: string | null
  note: string | null
  submissionHash: string
  nextAction: 'WAIT_FOR_ONCHAIN_SUBMISSION' | 'WAIT_FOR_REVIEW'
  submittedAt: string
}>

export type JobReviewView = Readonly<{
  id: string
  jobId: string
  submissionId: string
  revisionNumber: number
  reviewerActorId: string
  decision: ReviewDecision
  workState: 'CHANGES_REQUESTED' | 'ACCEPTED'
  settlementState: 'DELIVERABLE_SUBMITTED'
  payoutState: 'NONE' | 'HOLD'
  note: string | null
  requiredChanges: JsonObject | null
  reviewHash: string
  nextAction: 'REVISE_WORK' | 'RELEASE_PAYMENT'
  reviewedAt: string
}>
