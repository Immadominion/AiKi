import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { hashCanonicalJson } from './canonical-json.js'
import { CommandInProgressError, IdempotencyConflictError, MarketplaceError } from './errors.js'
import type {
  ActorIdentity,
  CommandResult,
  CreateOffer,
  Idempotency,
  JsonObject,
  JsonValue,
  OfferView,
  Page,
  ProviderAvailability,
  ProviderView,
  PutProvider,
} from './model.js'
import { encodeCursor, type PageCursor } from './pagination.js'

type QuerySql = postgres.Sql | postgres.TransactionSql

type ActorRow = {
  id: string
  actor_type: 'HUMAN' | 'AGENT'
  chain_id: string | number
  controller_address: `0x${string}`
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'
}

type ProviderRow = Omit<ActorRow, 'status'> & {
  display_name: string
  summary: string
  availability: ProviderAvailability
  capacity: number
  supported_protocols: string[]
  profile_version: string | number
  created_at: Date | string
  updated_at: Date | string
}

type OfferRow = {
  id: string
  provider_actor_id: string
  provider_name: string
  status: 'ACTIVE' | 'PAUSED'
  visibility: 'PUBLIC'
  version: number
  title: string
  summary: string
  capability_tags: string[]
  input_schema: JsonObject
  output_schema: JsonObject
  evidence_schema: JsonObject
  pricing_model: OfferView['pricing']['model']
  settlement_chain_id: string | number
  settlement_token: `0x${string}`
  settlement_decimals: number
  amount: string | null
  platform_fee_bps: number
  delivery_sla_seconds: number
  review_sla_seconds: number
  included_revisions: number
  concurrent_capacity: number
  dispatch_method: OfferView['dispatch']['method']
  dispatch_endpoint: string | null
  failover_safe: boolean
  terms_hash: string
  created_at: Date | string
  updated_at: Date | string
}

type IdempotencyRow = {
  request_hash: string
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
  response_status: number | null
  response_body: unknown
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()

const safeInteger = (value: number | string, field: string): number => {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`${field} is outside JavaScript's safe range.`)
  return number
}

const providerView = (row: ProviderRow): ProviderView => ({
  id: row.id,
  actorType: row.actor_type,
  chainId: safeInteger(row.chain_id, 'chain_id'),
  controllerAddress: row.controller_address,
  displayName: row.display_name,
  summary: row.summary,
  availability: row.availability,
  capacity: row.capacity,
  supportedProtocols: row.supported_protocols,
  profileVersion: String(row.profile_version),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
})

const offerView = (row: OfferRow): OfferView => ({
  id: row.id,
  providerId: row.provider_actor_id,
  providerName: row.provider_name,
  status: row.status,
  visibility: row.visibility,
  version: row.version,
  title: row.title,
  summary: row.summary,
  capabilityTags: row.capability_tags,
  inputSchema: row.input_schema,
  outputSchema: row.output_schema,
  evidenceSchema: row.evidence_schema,
  pricing: {
    model: row.pricing_model,
    chainId: safeInteger(row.settlement_chain_id, 'settlement_chain_id'),
    token: row.settlement_token,
    decimals: row.settlement_decimals,
    amount: row.amount,
    platformFeeBps: row.platform_fee_bps,
  },
  deliverySlaSeconds: row.delivery_sla_seconds,
  reviewSlaSeconds: row.review_sla_seconds,
  includedRevisions: row.included_revisions,
  concurrentCapacity: row.concurrent_capacity,
  dispatch: { method: row.dispatch_method, endpoint: row.dispatch_endpoint },
  failoverSafe: row.failover_safe,
  termsHash: row.terms_hash,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
})

async function readProvider(sql: QuerySql, actorId: string): Promise<ProviderView> {
  const rows = await sql<ProviderRow[]>`
    SELECT
      a.id,
      a.actor_type,
      a.chain_id,
      a.controller_address,
      p.display_name,
      p.summary,
      p.availability,
      p.capacity,
      p.supported_protocols,
      p.profile_version,
      p.created_at,
      p.updated_at
    FROM provider_profiles p
    JOIN actors a ON a.id = p.actor_id
    WHERE p.actor_id = ${actorId}
  `
  const row = rows[0]
  if (!row) throw new Error(`Provider ${actorId} disappeared inside its transaction.`)
  return providerView(row)
}

async function readOffer(sql: QuerySql, offerId: string): Promise<OfferView> {
  const rows = await sql<OfferRow[]>`
    SELECT
      o.id,
      o.provider_actor_id,
      p.display_name AS provider_name,
      o.status,
      o.visibility,
      v.version,
      v.title,
      v.summary,
      v.capability_tags,
      v.input_schema,
      v.output_schema,
      v.evidence_schema,
      v.pricing_model,
      v.settlement_chain_id,
      v.settlement_token,
      v.settlement_decimals,
      v.amount,
      v.platform_fee_bps,
      v.delivery_sla_seconds,
      v.review_sla_seconds,
      v.included_revisions,
      v.concurrent_capacity,
      v.dispatch_method,
      v.dispatch_endpoint,
      v.failover_safe,
      v.terms_hash,
      o.created_at,
      o.updated_at
    FROM offers o
    JOIN offer_versions v ON v.offer_id = o.id AND v.version = o.current_version
    JOIN provider_profiles p ON p.actor_id = o.provider_actor_id
    WHERE o.id = ${offerId}
  `
  const row = rows[0]
  if (!row) throw new Error(`Offer ${offerId} disappeared inside its transaction.`)
  return offerView(row)
}

export interface MarketplaceStore {
  putProvider(
    actor: ActorIdentity,
    input: PutProvider,
    idempotency: Idempotency,
  ): Promise<CommandResult<ProviderView>>
  getProvider(id: string): Promise<ProviderView | null>
  listProviders(limit: number, cursor: PageCursor | null): Promise<Page<ProviderView>>
  createOffer(
    actor: ActorIdentity,
    input: CreateOffer,
    idempotency: Idempotency,
  ): Promise<CommandResult<OfferView>>
  pauseOffer(
    actor: ActorIdentity,
    offerId: string,
    idempotency: Idempotency,
  ): Promise<CommandResult<OfferView>>
  getOffer(id: string): Promise<OfferView | null>
  listOffers(limit: number, cursor: PageCursor | null): Promise<Page<OfferView>>
}

export class PostgresMarketplaceStore implements MarketplaceStore {
  private readonly sql: postgres.Sql

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 10 })
  }

  async close(): Promise<void> {
    await this.sql.end()
  }

  private async actor(tx: postgres.TransactionSql, identity: ActorIdentity): Promise<ActorRow> {
    const rows = await tx<ActorRow[]>`
      INSERT INTO actors (id, actor_type, chain_id, controller_address)
      VALUES (${randomUUID()}, 'HUMAN', ${identity.chainId}, ${identity.address})
      ON CONFLICT (chain_id, controller_address) WHERE actor_type = 'HUMAN'
      DO UPDATE SET controller_address = EXCLUDED.controller_address
      RETURNING id, actor_type, chain_id, controller_address, status
    `
    const actor = rows[0]
    if (!actor) throw new Error('Could not resolve the authenticated marketplace actor.')
    if (actor.status !== 'ACTIVE')
      throw new MarketplaceError('ACTOR_SUSPENDED', 'This marketplace account is not active.', {
        statusCode: 403,
      })
    return actor
  }

  private async command<T>(input: {
    actor: ActorIdentity
    operation: string
    idempotency: Idempotency
    statusCode: number
    run: (tx: postgres.TransactionSql, actor: ActorRow) => Promise<T>
  }): Promise<CommandResult<T>> {
    return this.sql.begin(async (tx) => {
      const actor = await this.actor(tx, input.actor)
      const id = randomUUID()
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO idempotency_records (
          id, actor_id, operation, idempotency_key, request_hash, expires_at
        )
        VALUES (
          ${id}, ${actor.id}, ${input.operation}, ${input.idempotency.key},
          ${input.idempotency.requestHash}, now() + interval '90 days'
        )
        ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING
        RETURNING id
      `
      const rows = await tx<IdempotencyRow[]>`
        SELECT request_hash, status, response_status, response_body
        FROM idempotency_records
        WHERE actor_id = ${actor.id}
          AND operation = ${input.operation}
          AND idempotency_key = ${input.idempotency.key}
        FOR UPDATE
      `
      const record = rows[0]
      if (!record) throw new Error('The idempotency record disappeared inside its transaction.')
      if (record.request_hash !== input.idempotency.requestHash)
        throw new IdempotencyConflictError()

      if (!inserted.length) {
        if (
          record.status === 'COMPLETED' &&
          record.response_status !== null &&
          record.response_body !== null
        ) {
          return {
            body: record.response_body as T,
            statusCode: record.response_status,
            replayed: true,
          }
        }
        throw new CommandInProgressError()
      }

      const body = await input.run(tx, actor)
      await tx`
        UPDATE idempotency_records
        SET status = 'COMPLETED',
            response_status = ${input.statusCode},
            response_body = ${tx.json(body as never)},
            updated_at = now()
        WHERE id = ${id}
      `
      return { body, statusCode: input.statusCode, replayed: false }
    })
  }

  async putProvider(
    actor: ActorIdentity,
    input: PutProvider,
    idempotency: Idempotency,
  ): Promise<CommandResult<ProviderView>> {
    return this.command({
      actor,
      operation: 'provider.put',
      idempotency,
      statusCode: 200,
      run: async (tx, marketplaceActor) => {
        await tx`
          INSERT INTO provider_profiles (
            actor_id, display_name, summary, availability, capacity,
            geography, supported_protocols
          ) VALUES (
            ${marketplaceActor.id}, ${input.displayName}, ${input.summary},
            ${input.availability}, ${input.capacity}, ${tx.json(input.geography)},
            ${tx.array(input.supportedProtocols)}
          )
          ON CONFLICT (actor_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            summary = EXCLUDED.summary,
            availability = EXCLUDED.availability,
            capacity = EXCLUDED.capacity,
            geography = EXCLUDED.geography,
            supported_protocols = EXCLUDED.supported_protocols,
            profile_version = provider_profiles.profile_version + 1,
            updated_at = now()
        `
        return readProvider(tx, marketplaceActor.id)
      },
    })
  }

  async getProvider(id: string): Promise<ProviderView | null> {
    const rows = await this.sql<ProviderRow[]>`
      SELECT
        a.id, a.actor_type, a.chain_id, a.controller_address,
        p.display_name, p.summary, p.availability, p.capacity,
        p.supported_protocols, p.profile_version, p.created_at, p.updated_at
      FROM provider_profiles p
      JOIN actors a ON a.id = p.actor_id
      WHERE p.actor_id = ${id} AND a.status = 'ACTIVE'
    `
    return rows[0] ? providerView(rows[0]) : null
  }

  async listProviders(limit: number, cursor: PageCursor | null): Promise<Page<ProviderView>> {
    const rows = cursor
      ? await this.sql<ProviderRow[]>`
          SELECT
            a.id, a.actor_type, a.chain_id, a.controller_address,
            p.display_name, p.summary, p.availability, p.capacity,
            p.supported_protocols, p.profile_version, p.created_at, p.updated_at
          FROM provider_profiles p
          JOIN actors a ON a.id = p.actor_id
          WHERE a.status = 'ACTIVE'
            AND (p.created_at, p.actor_id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)
          ORDER BY p.created_at DESC, p.actor_id DESC
          LIMIT ${limit + 1}
        `
      : await this.sql<ProviderRow[]>`
          SELECT
            a.id, a.actor_type, a.chain_id, a.controller_address,
            p.display_name, p.summary, p.availability, p.capacity,
            p.supported_protocols, p.profile_version, p.created_at, p.updated_at
          FROM provider_profiles p
          JOIN actors a ON a.id = p.actor_id
          WHERE a.status = 'ACTIVE'
          ORDER BY p.created_at DESC, p.actor_id DESC
          LIMIT ${limit + 1}
        `
    const pageRows = rows.slice(0, limit)
    const last = pageRows.at(-1)
    return {
      items: pageRows.map(providerView),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: iso(last.created_at), id: last.id })
          : null,
    }
  }

  async createOffer(
    actor: ActorIdentity,
    input: CreateOffer,
    idempotency: Idempotency,
  ): Promise<CommandResult<OfferView>> {
    return this.command({
      actor,
      operation: 'offer.create',
      idempotency,
      statusCode: 201,
      run: async (tx, marketplaceActor) => {
        const profile = await tx<{ exists: boolean }[]>`
          SELECT EXISTS(
            SELECT 1 FROM provider_profiles WHERE actor_id = ${marketplaceActor.id}
          ) AS exists
        `
        if (!profile[0]?.exists)
          throw new MarketplaceError(
            'PROVIDER_PROFILE_REQUIRED',
            'Create your provider profile before publishing an offer.',
            { statusCode: 409 },
          )

        const offerId = randomUUID()
        const termsHash = hashCanonicalJson({
          providerId: marketplaceActor.id,
          version: 1,
          ...input,
        } as unknown as JsonValue)
        await tx`
          INSERT INTO offers (
            id, provider_actor_id, status, visibility, current_version
          ) VALUES (${offerId}, ${marketplaceActor.id}, 'DRAFT', 'PUBLIC', NULL)
        `
        await tx`
          INSERT INTO offer_versions (
            offer_id, version, title, summary, capability_tags,
            input_schema, output_schema, evidence_schema, pricing_model,
            settlement_chain_id, settlement_token, settlement_decimals, amount,
            platform_fee_bps, delivery_sla_seconds, review_sla_seconds,
            included_revisions, concurrent_capacity, dispatch_method,
            dispatch_endpoint, failover_safe, terms_hash
          ) VALUES (
            ${offerId}, 1, ${input.title}, ${input.summary}, ${tx.array(input.capabilityTags)},
            ${tx.json(input.inputSchema)}, ${tx.json(input.outputSchema)},
            ${tx.json(input.evidenceSchema)}, ${input.pricingModel},
            ${input.settlementChainId}, ${input.settlementToken},
            ${input.settlementDecimals}, ${input.amount}, ${input.platformFeeBps},
            ${input.deliverySlaSeconds}, ${input.reviewSlaSeconds},
            ${input.includedRevisions}, ${input.concurrentCapacity},
            ${input.dispatchMethod}, ${input.dispatchEndpoint}, ${input.failoverSafe},
            ${termsHash}
          )
        `
        await tx`
          UPDATE offers
          SET current_version = 1, status = 'ACTIVE', updated_at = now()
          WHERE id = ${offerId}
        `
        return readOffer(tx, offerId)
      },
    })
  }

  async pauseOffer(
    actor: ActorIdentity,
    offerId: string,
    idempotency: Idempotency,
  ): Promise<CommandResult<OfferView>> {
    return this.command({
      actor,
      operation: 'offer.pause',
      idempotency,
      statusCode: 200,
      run: async (tx, marketplaceActor) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE offers
          SET status = 'PAUSED', updated_at = now()
          WHERE id = ${offerId}
            AND provider_actor_id = ${marketplaceActor.id}
            AND status IN ('ACTIVE', 'PAUSED')
          RETURNING id
        `
        if (!updated.length)
          throw new MarketplaceError('OFFER_NOT_FOUND', 'No such offer.', { statusCode: 404 })
        return readOffer(tx, offerId)
      },
    })
  }

  async getOffer(id: string): Promise<OfferView | null> {
    const rows = await this.offerRows(false, id, 1, null)
    return rows[0] ? offerView(rows[0]) : null
  }

  async listOffers(limit: number, cursor: PageCursor | null): Promise<Page<OfferView>> {
    const rows = await this.offerRows(true, null, limit + 1, cursor)
    const pageRows = rows.slice(0, limit)
    const last = pageRows.at(-1)
    return {
      items: pageRows.map(offerView),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: iso(last.created_at), id: last.id })
          : null,
    }
  }

  private async offerRows(
    list: boolean,
    id: string | null,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<OfferRow[]> {
    if (list && cursor)
      return this.sql<OfferRow[]>`
        SELECT
          o.id, o.provider_actor_id, p.display_name AS provider_name,
          o.status, o.visibility, v.version, v.title, v.summary,
          v.capability_tags, v.input_schema, v.output_schema, v.evidence_schema,
          v.pricing_model, v.settlement_chain_id, v.settlement_token,
          v.settlement_decimals, v.amount, v.platform_fee_bps,
          v.delivery_sla_seconds, v.review_sla_seconds, v.included_revisions,
          v.concurrent_capacity, v.dispatch_method, v.dispatch_endpoint,
          v.failover_safe, v.terms_hash, o.created_at, o.updated_at
        FROM offers o
        JOIN offer_versions v ON v.offer_id = o.id AND v.version = o.current_version
        JOIN provider_profiles p ON p.actor_id = o.provider_actor_id
        JOIN actors a ON a.id = o.provider_actor_id
        WHERE o.status = 'ACTIVE' AND o.visibility = 'PUBLIC' AND a.status = 'ACTIVE'
          AND (o.created_at, o.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${limit}
      `

    return this.sql<OfferRow[]>`
      SELECT
        o.id, o.provider_actor_id, p.display_name AS provider_name,
        o.status, o.visibility, v.version, v.title, v.summary,
        v.capability_tags, v.input_schema, v.output_schema, v.evidence_schema,
        v.pricing_model, v.settlement_chain_id, v.settlement_token,
        v.settlement_decimals, v.amount, v.platform_fee_bps,
        v.delivery_sla_seconds, v.review_sla_seconds, v.included_revisions,
        v.concurrent_capacity, v.dispatch_method, v.dispatch_endpoint,
        v.failover_safe, v.terms_hash, o.created_at, o.updated_at
      FROM offers o
      JOIN offer_versions v ON v.offer_id = o.id AND v.version = o.current_version
      JOIN provider_profiles p ON p.actor_id = o.provider_actor_id
      JOIN actors a ON a.id = o.provider_actor_id
      WHERE o.status = 'ACTIVE' AND o.visibility = 'PUBLIC' AND a.status = 'ACTIVE'
        AND (${list} OR o.id = ${id}::uuid)
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${limit}
    `
  }
}
