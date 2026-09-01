import { randomUUID } from 'node:crypto'
import type { SignedDelegation } from '@aiki/contracts'
import { DELEGATION_TYPES, delegationDomain, ROOT_AUTHORITY } from '@aiki/contracts'
import Fastify from 'fastify'
import type { AccountDeployer } from '../accounts/deploy.js'
import type { AccountStore } from '../accounts/store.js'
import { type AssistantConfig, registerAssistantRoutes } from '../assistant/routes.js'
import { requireOwner, requireSession } from '../auth/guard.js'
import { requireIngestToken } from '../auth/ingest.js'
import type { AuthConfig } from '../auth/routes.js'
import { registerAuthRoutes } from '../auth/routes.js'
import { readCookie, SESSION_COOKIE } from '../auth/session.js'
import { acceptDelegation } from '../authority/accept-delegation.js'
import { compileCaveats, describeEnforcement, withDerivedTiers } from '../authority/caveats.js'
import type { ChainReader } from '../authority/chain-reader.js'
import type { Constraint } from '../authority/policy.js'
import { type BenchmarkRun, BenchmarkService, benchmarkEvidence } from '../benchmarks/service.js'
import type { EnforcerDeployment } from '../config/enforcers.js'
import { pointsForSettlement } from '../credits/pricing.js'
import { DuplicateCharge } from '../credits/store.js'
import type { NewObservation, Observation } from '../evidence/types.js'
import { parseIntent } from '../intent/parser.js'
import { act, parseAction } from '../jobs/act.js'
import { JobService } from '../jobs/service.js'
import { comparePassports, projectPassport } from '../projections/passport.js'
import { assembleStats, projectStats, type StatsAggregate } from '../projections/stats.js'
import { ReceiptService } from '../receipts/service.js'
import { registerWatchRoutes } from '../runner/routes.js'
import type { WatchStore } from '../runner/store.js'
import { buildSearchQuery } from '../search/query.js'
import { fundJob, InsufficientPoints, settleJob } from '../settlement/ledger.js'
import { buildQuote, priceJob, SETTLEMENT } from '../settlement/pricing.js'
import { priceForQuote, publishedAsset } from '../settlement/published-price.js'
import { asClientError, asProtocolError, asSchemaError, ClientError } from './errors.js'

/**
 * The most constraints one mandate may carry. The policy compiler already
 * refuses duplicate kinds and there are seven kinds, so anything near this is
 * already malformed; the cap exists because the preview route is unauthenticated.
 */
const MANDATE_MAX_CONSTRAINTS = 32

/** The most agents one comparison may name. See the check in /v1/compare. */
const COMPARE_MAX = 10

/** One page size rule for both search paths: 1 to 100, defaulting to 20. */
const clampLimit = (raw: number | undefined): number =>
  typeof raw === 'number' && Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 100) : 20

export function createApiServer(input: {
  observations: () => Observation[] | Promise<Observation[]>
  /**
   * Lowest block the indexer has ever scanned from. Omitted by deployments with no
   * indexer, where coverage is genuinely unknown rather than zero.
   */
  coverageStart?: () => number | null | Promise<number | null>
  /**
   * Counted over every row. Deployments that can do this MUST, because folding
   * the dashboard out of `observations()` reads a capped page and the totals
   * then shrink as the store grows.
   */
  statsAggregate?: () => StatsAggregate | Promise<StatsAggregate>
  /**
   * Every observation for the agents whose latest verdict is one of `states`,
   * selected in SQL. Deployments that can do this MUST, for the same reason
   * `statsAggregate` exists: projecting a search over the capped `observations()`
   * page silently drops agents as the store grows, and the ones it drops are the
   * ones probed longest ago.
   */
  observationsForLiveness?: (states: string[]) => Observation[] | Promise<Observation[]>
  /**
   * Every observation for named agents, unwindowed. A per-agent claim must not
   * depend on how recently that agent happened to be written.
   */
  observationsForAgents?: (agentIds: string[]) => Observation[] | Promise<Observation[]>
  /**
   * Rank agents by their own registration text, in SQL. Deployments that can do
   * this MUST, for the third time and the same reason: a text search projected
   * over the capped page cannot see the agents whose rows have aged out, and
   * those are exactly the agents that have been busy.
   */
  searchAgents?: (input: {
    tsquery: string | null
    states: string[] | null
    limit: number
  }) => Promise<{
    matches: { chainId: number; registry: string; agentId: string; state: string }[]
    total: number
    byState: Record<string, number>
    truncated: boolean
  }>
  /**
   * AiKi's own deployed mandate suite, when there is one. Its absence is not an
   * error: a deployment with no enforcers counts every limit itself and says so.
   */
  enforcers?: EnforcerDeployment
  /**
   * Reads the chain the enforcers are on. Needed only to accept a signed
   * delegation: without it a mandate can still be built and its limits are
   * counted by AiKi, which is what a deployment with no chain access should do.
   */
  chain?: ChainReader
  /**
   * The agent's session key, which is the only address allowed to redeem a
   * delegation. It pays its own gas and holds no authority of its own: whatever
   * it can do, it can do only inside a delegation somebody signed.
   */
  agentSessionKey?: `0x${string}`
  /**
   * The agent's private key, which signs redemptions and pays their gas. Its
   * address must be `agentSessionKey`, since the manager accepts a redemption
   * only from the delegate a mandate names. Absent means actions are decided
   * off chain and nothing is submitted anywhere.
   */
  agentKey?: `0x${string}`
  enforcerRpcUrl?: string
  /** Mandate accounts: where a person's value lives. Absent means none can be made. */
  accounts?: { store: AccountStore; deployer: AccountDeployer }
  jobs?: JobService
  /**
   * Standing instructions to watch a position. Absent means this deployment can
   * run agents on demand but nothing on a timer.
   */
  watches?: WatchStore
  /**
   * Fast mode and the points that pay for it. Absent means the deployment
   * serves Manual mode only, and says so rather than failing oddly.
   */
  assistant?: AssistantConfig
  /**
   * Record a fact. Present only where the deployment has a writable store.
   *
   * Needed so an agent's OWNER can list it. Until they could, an agent was
   * quotable only if its registration file carried a price, which meant editing
   * a JSON document at a URL you control, and four agents on the whole chain
   * had done it. A marketplace nobody can join from the supply side grows only
   * as fast as we index.
   */
  appendObservation?: (observation: NewObservation) => Promise<unknown>
  /**
   * Where AiKi's own fee lands. Absent means this deployment quotes a fee it has
   * nowhere to put, so it refuses to settle rather than keeping the money in a
   * place nobody named.
   */
  settlementTreasury?: string
  receipts?: ReceiptService
  benchmarks?: BenchmarkService
  /** Omitted only in tests of the public surface; every mandate route needs it. */
  auth?: AuthConfig
}) {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' })
  /*
   * An empty body is not a malformed one.
   *
   * Several routes here take no body at all: revoking a mandate names it in the
   * path, and issuing a receipt names the job. Fastify's default JSON parser
   * refuses an empty body outright when the content type says JSON, and almost
   * every HTTP client sets that header on every request whether or not it is
   * sending anything. Our own web client does, on every call it makes, which
   * meant POST /v1/authorizations/:id/revoke answered 500 from the browser and
   * 200 from curl. Revoke is the control a user reaches for when something is
   * wrong, so it is the worst possible route to have working only by accident.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (body === '') return done(null, undefined)
    try {
      done(null, JSON.parse(body as string))
    } catch {
      // A deliberate sentence rather than the raw SyntaxError, which names a
      // character offset in bytes the caller cannot see, and which reaches them
      // as a 500 inviting a retry that no amount of retrying will fix.
      done(new ClientError('Request body is not valid JSON.', { code: 'INVALID_JSON' }))
    }
  })
  const jobs = input.jobs ?? new JobService()
  const receipts = input.receipts ?? new ReceiptService(process.env.RECEIPT_SIGNING_KEY)
  const benchmarks = input.benchmarks ?? new BenchmarkService()
  app.addHook('onRequest', async (request, reply) => {
    const id = request.headers['x-request-id']?.toString() ?? randomUUID()
    request.headers['x-request-id'] = id
    reply.header('x-request-id', id)
    if (input.auth)
      request.session =
        input.auth.signer.verify(readCookie(request.headers.cookie, SESSION_COOKIE)) ?? undefined
  })
  if (input.auth) registerAuthRoutes(app, input.auth)
  if (input.watches) registerWatchRoutes(app, { jobs, watches: input.watches })
  if (input.assistant) registerAssistantRoutes(app, input.assistant)
  /**
   * Only messages written for a caller reach a caller.
   *
   * Fastify's own schema errors are safe and useful, and anything raised as a
   * ClientError was phrased deliberately. Everything else is ours: it gets a 500,
   * a generic sentence and the request id, and the real text goes to the log.
   */
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.headers['x-request-id']
    const client = asClientError(error)
    if (client)
      return reply.code(client.statusCode).send({
        error: { code: client.code, message: client.message, retryable: false, requestId },
      })
    const schema = asSchemaError(error)
    if (schema)
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: schema, retryable: false, requestId },
      })
    const protocol = asProtocolError(error)
    if (protocol)
      return reply.code(protocol.statusCode).send({
        error: {
          code: protocol.code,
          message: protocol.message,
          retryable: false,
          requestId,
        },
      })
    request.log.error({ err: error, requestId }, 'unhandled request failure')
    return reply.code(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Something failed on our side. Quote the request id if you report it.',
        retryable: true,
        requestId,
      },
    })
  })

  /**
   * A job belongs to whoever owns its authorization. Deriving it rather than
   * copying it onto the job means the two can never disagree.
   */
  /*
   * Observations for specific agents, falling back to the windowed page only
   * where a deployment has not wired the scoped reader (the in-memory store in
   * tests). The fallback is the old behaviour, so nothing gets worse; the
   * production path stops depending on the window.
   */
  async function agentObservations(agentIds: string[]) {
    if (input.observationsForAgents) return input.observationsForAgents(agentIds)
    return input.observations()
  }

  async function ownedJob(
    request: Parameters<typeof requireSession>[0],
    reply: Parameters<typeof requireSession>[1],
    address: string,
    jobId: string,
  ) {
    const job = await jobs.getJob(jobId)
    const authorization = await jobs.getAuthorization(job.authorizationId)
    if (authorization.owner?.toLowerCase() !== address.toLowerCase()) {
      reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'No such job.',
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
      return null
    }
    return job
  }
  /**
   * Liveness and readiness in one answer.
   *
   * Readiness means the evidence store actually responds, not that the process
   * is up: an API that returns 200 while its database is unreachable will be
   * kept in a load balancer's rotation while serving nothing.
   */
  app.get('/healthz', async (request, reply) => {
    try {
      await input.observations()
      return { status: 'ok' }
    } catch (error) {
      // A health endpoint is unauthenticated by design, so it says that it is
      // unhealthy and not why. The reason belongs in the log.
      request.log.error({ err: error }, 'healthcheck: evidence store unreachable')
      return reply.code(503).send({ status: 'degraded', detail: 'Evidence store unreachable.' })
    }
  })
  app.get('/v1/stats', async () => {
    const coverageStart = input.coverageStart ? await input.coverageStart() : null
    const opts = typeof coverageStart === 'number' ? { coverageStart } : {}
    return input.statsAggregate
      ? assembleStats(await input.statsAggregate(), opts)
      : projectStats(await input.observations(), opts)
  })
  app.get<{ Params: { agentId: string } }>('/v1/agents/:agentId/passport', async (request) =>
    projectPassport(request.params.agentId, await agentObservations([request.params.agentId])),
  )
  app.post<{ Body: { agentIds: string[] } }>('/v1/compare', async (request, reply) => {
    if (!Array.isArray(request.body.agentIds) || request.body.agentIds.length < 2)
      return reply.code(400).send({
        error: {
          code: 'INVALID_COMPARE',
          message: 'At least two agentIds are required.',
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
    /*
     * Bounded, because each id projects a passport over the whole observation
     * set and this route is unauthenticated. Measured at roughly 5ms per id, and
     * Fastify's default 1MB body holds about 116,000 of them, which is on the
     * order of ten minutes of blocked event loop from a single POST. Comparison
     * is pairwise and nobody reads a hundred agents side by side anyway.
     */
    if (request.body.agentIds.length > COMPARE_MAX)
      return reply.code(400).send({
        error: {
          code: 'TOO_MANY_AGENTS',
          message: `Compare takes at most ${COMPARE_MAX} agents at a time.`,
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
    const observations = await agentObservations(request.body.agentIds)
    const passports = request.body.agentIds.map((id) => projectPassport(id, observations))
    return { agents: passports, ...comparePassports(passports) }
  })
  app.post<{ Body: { text: string } }>('/v1/intent', async (request) =>
    parseIntent(request.body.text),
  )
  app.post<{
    Body: { query?: string; filters?: { category?: string; liveness?: string[] }; limit?: number }
  }>(
    '/v1/search',
    {
      /*
       * The only unauthenticated route that takes a free-text body, so the
       * shape is checked before any of it is used. Measured on production
       * before this existed: `{"query":123}` and `{"filters":{"liveness":"LIVE"}}`
       * both answered 500, because a number has no `toLowerCase` and a string
       * has the wrong `includes`. A judge poking at the API got a server error
       * from a request that was merely wrong.
       *
       * The length cap is a real limit and not a formality: the term budget
       * bounds ranking work, and this bounds the term budget.
       */
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', maxLength: 200 },
            /*
             * Validated as a number and no further. `clampLimit` documents 1 to
             * 100 and CLAMPS, which existing callers rely on: a schema maximum
             * here turned a request for 250 into a 400 where it used to return
             * a page of 100. Rejecting a caller outright is a breaking change,
             * and this route's job today is to stop being findable-only-in-theory,
             * not to tighten a contract nobody complained about.
             */
            limit: { type: 'integer', minimum: 1 },
            filters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                category: { type: 'string', maxLength: 64 },
                liveness: {
                  type: 'array',
                  maxItems: 8,
                  items: {
                    type: 'string',
                    enum: [
                      'LIVE',
                      'DEGRADED',
                      'DECLARED_ONLY',
                      'PLACEHOLDER_URL',
                      'IMPOSTOR_STATIC',
                      'UNREACHABLE',
                      'UNPROBED',
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const query = request.body.query?.toLowerCase()
      const limit = clampLimit(request.body.limit)

      /*
       * The catalogue is the registry, not the part of it we approve of.
       *
       * This defaulted to LIVE and DEGRADED and dropped everything else, so the
       * marketplace listed 243 agents of more than sixteen thousand indexed. No
       * marketplace personally uses every item it lists, and gating the listing
       * on our own probe made the catalogue one tenth of one percent of the
       * chain and made the product unfinishable: it was only ever complete once
       * we had probed everything.
       *
       * So evidence ranks now, and does not exclude. An agent we have watched
       * answer is first, one nobody has probed is next, one we have caught
       * serving the same bytes to every input is last, and every row says which
       * it is. A filter is still available to a caller who asks for one.
       *
       * Hiring stays gated on evidence. You can read the page of a suspended
       * seller; you cannot buy from them.
       */
      const states = request.body.filters?.liveness ?? null

      if (input.searchAgents) {
        const built = query ? buildSearchQuery(query) : null
        // A query that survives to nothing is not a request to list everything.
        if (built && !built.tsquery)
          return {
            results: [],
            total: 0,
            coverage: {
              indexedAgents: input.statsAggregate
                ? ((await input.statsAggregate()).indexed?.totalAgents ?? 0)
                : 0,
              matchedBeforeFilters: 0,
              excludedUnverified: 0,
              exclusionReasons: {},
            },
            query: { terms: built.terms, expandedWith: built.expandedWith },
          }

        const [found, agg] = await Promise.all([
          input.searchAgents({ tsquery: built?.tsquery ?? null, states, limit }),
          input.statsAggregate ? input.statsAggregate() : Promise.resolve(null),
        ])

        // Only the page is projected. Projecting the whole match set would
        // re-scan its observations once per agent, which for a common word is
        // seconds of blocked event loop on a route needing no credentials.
        const observations = await agentObservations(found.matches.map((m) => m.agentId))
        const results = found.matches.map((m) => projectPassport(m.agentId, observations))

        /*
         * Not "excluded" any more, because nothing is. This says what the listed
         * set is MADE of, so a reader can see at a glance how much of it AiKi has
         * actually watched.
         */
        const unverified = Object.entries(found.byState).reduce(
          (n, [state, count]) => (state === 'LIVE' || state === 'DEGRADED' ? n : n + count),
          0,
        )

        return {
          results,
          total: found.total,
          coverage: {
            indexedAgents: agg?.indexed?.totalAgents ?? 0,
            matchedBeforeFilters: found.total,
            excludedUnverified: states ? unverified : 0,
            exclusionReasons: found.byState,
            ...(found.truncated ? { truncated: true } : {}),
          },
          ...(built ? { query: { terms: built.terms, expandedWith: built.expandedWith } } : {}),
        }
      }

      /*
       * No SQL search on this deployment. Read the widest correct source we
       * have: `observationsForLiveness` selects AGENTS in SQL and is unwindowed,
       * so a filtered read still cannot lose an agent to the newest-page cap.
       * Only a deployment with neither falls back to the capped page.
       */
      const observations =
        states && input.observationsForLiveness
          ? await input.observationsForLiveness(states)
          : await input.observations()
      const ids = [...new Set(observations.map((o) => o.subject.agentId))]
      const terms = query ? query.split(/\s+/).filter(Boolean) : []
      const matched = ids
        .map((id) => projectPassport(id, observations))
        .filter(
          (passport) =>
            terms.length === 0 ||
            terms.some(
              (term) =>
                passport.agentId.toLowerCase().includes(term) ||
                (passport.name?.toLowerCase().includes(term) ?? false) ||
                passport.liveness.toLowerCase().includes(term),
            ),
        )
      const kept = states ? matched.filter((p) => states.includes(p.liveness)) : matched

      /*
       * Counted over every row where the deployment can do that, so the block
       * agrees with /v1/stats rather than with one page of it.
       */
      const agg = input.statsAggregate ? await input.statsAggregate() : null
      const byState: Partial<Record<string, number>> = {}
      let excludedUnverified = 0
      if (states && agg) {
        const total = agg.indexed?.totalAgents ?? 0
        const unprobed = Math.max(0, total - agg.probed.agentsProbed)
        const note = (state: string, count: number) => {
          if (count <= 0 || states.includes(state)) return
          byState[state] = (byState[state] ?? 0) + count
          if (state !== 'LIVE' && state !== 'DEGRADED') excludedUnverified += count
        }
        for (const [state, count] of Object.entries(agg.probed.byRawState)) note(state, count)
        note('UNPROBED', unprobed)
      } else {
        for (const passport of matched) {
          if (states?.includes(passport.liveness) === false) {
            byState[passport.liveness] = (byState[passport.liveness] ?? 0) + 1
            if (passport.liveness !== 'LIVE' && passport.liveness !== 'DEGRADED')
              excludedUnverified += 1
          }
        }
      }

      return {
        results: kept.slice(0, limit),
        total: kept.length,
        coverage: {
          indexedAgents: agg?.indexed?.totalAgents ?? ids.length,
          matchedBeforeFilters: agg && states ? (agg.indexed?.totalAgents ?? 0) : matched.length,
          excludedUnverified,
          exclusionReasons: byState,
        },
      }
    },
  )
  app.post<{ Body: { agentId: string } }>('/v1/quotes', async (request, reply) => {
    /*
     * Read by agent, never off the windowed page.
     *
     * A quote is a claim about ONE agent, so it has the same requirement the
     * passport does. Reading it off `observations()` made hiring depend on how
     * recently the agent happened to be written, and the agents most worth
     * hiring are the ones writing the most: measured on production, all four
     * reference agents were LIVE on their passports and every one of them was
     * refused here with AGENT_NOT_QUOTABLE, because an agent's own working
     * output pushes its registration and verdict rows out of the page. The
     * marketplace could show you an agent and then decline to sell it to you.
     */
    const observations = await agentObservations([request.body.agentId])
    const passport = projectPassport(request.body.agentId, observations)
    const fail = (code: string, message: string) =>
      reply.code(422).send({
        error: { code, message, retryable: false, requestId: request.headers['x-request-id'] },
      })

    if (passport.liveness !== 'LIVE')
      return fail('AGENT_NOT_QUOTABLE', 'Only LIVE agents may issue a marketplace quote.')

    /*
     * A price is a number AND the thing it is counted in, and this route settles
     * every quote in `SETTLEMENT` regardless of what the agent published. An
     * agent asking for 100000 of a six-decimal token, quoted as 100000 of an
     * eighteen-decimal one, has been repriced by a factor of a trillion without
     * anybody being told. So the currency has to agree before the number is used.
     */
    const declaredAsset = publishedAsset(request.body.agentId, observations)
    if (declaredAsset !== null && declaredAsset !== SETTLEMENT.symbol)
      return fail(
        'AGENT_PRICES_IN_ANOTHER_ASSET',
        `This agent publishes its price in ${declaredAsset}, and AiKi settles in ${SETTLEMENT.symbol}. Quoting it would restate the price in a currency the agent never named.`,
      )

    const quoted = priceForQuote(request.body.agentId, observations)
    const price = quoted?.amount ?? null
    // A price we do not have is not a price of zero. Quoting free work that is
    // not free is the same class of mistake as reporting an unmeasured field as
    // a measurement, and this endpoint used to do exactly that.
    if (price === null)
      return fail(
        'AGENT_HAS_NO_PUBLISHED_PRICE',
        'This agent publishes no price in its registration, so there is nothing to quote.',
      )

    return {
      ...buildQuote({ quoteId: randomUUID(), agentId: request.body.agentId, price }),
      /*
       * Where the number came from. A price in the registration file is public:
       * everybody reading the agent sees it. A price the owner listed with AiKi
       * is something they told us. Both are the owner's own declaration and
       * they are not the same claim, so a buyer is told which one they are
       * being quoted rather than left to assume.
       */
      priceSource: quoted?.source ?? 'registration',
    }
  })
  /*
   * What a mandate would be worth, without creating one.
   *
   * The builder has to show which limits the chain will hold WHILE the limits
   * are being chosen, since that is what the choice is between. It creates
   * nothing, touches no user data, and reads only the deployed enforcer set,
   * which is public, so it needs no session: a person can see what AiKi can and
   * cannot enforce before deciding whether to connect a wallet at all. Being
   * asked to sign in before you may learn what the product does is the wrong
   * way round.
   */
  app.post<{ Body: { constraints: Constraint[] } }>(
    '/v1/mandates/preview',
    async (request, reply) => {
      const constraints = request.body?.constraints
      if (!Array.isArray(constraints) || constraints.length === 0)
        return reply.code(400).send({
          error: {
            code: 'NO_CONSTRAINTS',
            message: 'At least one constraint is required.',
            retryable: false,
            requestId: request.headers['x-request-id'],
          },
        })
      if (constraints.length > MANDATE_MAX_CONSTRAINTS)
        return reply.code(400).send({
          error: {
            code: 'TOO_MANY_CONSTRAINTS',
            message: `A mandate carries at most ${MANDATE_MAX_CONSTRAINTS} constraints.`,
            retryable: false,
            requestId: request.headers['x-request-id'],
          },
        })
      const enforcement = describeEnforcement(constraints, input.enforcers)
      return {
        tier: enforcement.tier,
        network: enforcement.network,
        audited: enforcement.audited,
        limits: enforcement.outcomes.map((o) => ({
          kind: o.constraint.kind,
          label: o.constraint.label,
          tier: o.tier,
          enforcedBy: o.enforcer,
          why: o.why,
        })),
      }
    },
  )
  app.post<{ Body: { constraints: Constraint[] } }>(
    '/v1/authorizations',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      /*
       * The tier is decided here, not accepted. It arrives on each constraint
       * from whoever posted the mandate, and `weakestTier` was reduced straight
       * out of those claims, so a caller could assert T0 on every line and be
       * served it back having had nothing checked. What a limit is worth is a
       * fact about the deployed enforcers, so it is derived by trying to compile
       * against them and the claim is overwritten.
       */
      const enforcement = describeEnforcement(request.body.constraints, input.enforcers)
      const authorization = await jobs.authorize(
        withDerivedTiers(enforcement.outcomes),
        session.address,
      )
      return {
        ...authorization,
        spent: authorization.spent.toString(),
        enforcement: {
          tier: enforcement.tier,
          network: enforcement.network,
          audited: enforcement.audited,
          limits: enforcement.outcomes.map((o) => ({
            kind: o.constraint.kind,
            label: o.constraint.label,
            tier: o.tier,
            enforcedBy: o.enforcer,
            why: o.why,
          })),
        },
      }
    },
  )
  /*
   * The account a person's mandates spend from.
   *
   * Nobody can use this product without one, and asking somebody to deploy a
   * contract before they may try anything is not an onboarding step, it is a
   * wall. So AiKi pays the gas. That is not custody: the constructor names the
   * caller as owner and the manager as the account's only executor, so it
   * belongs to them from the first block and the key that deployed it holds
   * nothing.
   */
  app.get('/v1/account', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    if (!input.accounts || !input.enforcers)
      return reply.code(503).send({
        error: {
          code: 'ACCOUNTS_UNAVAILABLE',
          message: 'This deployment does not provide mandate accounts.',
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
    const account = await input.accounts.store.find(session.address, input.enforcers.chainId)
    return {
      address: account?.address ?? null,
      chainId: input.enforcers.chainId,
      network: input.enforcers.network,
      ...(account ? { deployedTx: account.deployedTx, createdAt: account.createdAt } : {}),
    }
  })
  app.post('/v1/account', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    if (!input.accounts || !input.enforcers)
      return reply.code(503).send({
        error: {
          code: 'ACCOUNTS_UNAVAILABLE',
          message: 'This deployment does not provide mandate accounts.',
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
    // Deploying twice for one person would split their mandates across two
    // accounts, and half their limits would sit against the wrong one. Checked
    // before spending gas, and the primary key decides a race afterwards.
    const held = await input.accounts.store.find(session.address, input.enforcers.chainId)
    if (held) return { address: held.address, chainId: held.chainId, created: false }
    const deployed = await input.accounts.deployer.deploy(session.address as `0x${string}`)
    const stored = await input.accounts.store.claim({
      owner: session.address,
      chainId: input.enforcers.chainId,
      address: deployed.address,
      deployedTx: deployed.transactionHash,
      createdAt: new Date().toISOString(),
    })
    return {
      address: stored.address,
      chainId: stored.chainId,
      // False when a concurrent request won the race, so a caller is never told
      // it created something it did not.
      created: stored.address === deployed.address,
      deployedTx: stored.deployedTx,
    }
  })
  /*
   * Exactly what to sign, computed by the side that will check it.
   *
   * A wallet cannot build this itself without the compiled caveats, and having
   * the client compile them would put a second copy of the compiler in the
   * browser, free to drift from the one the API verifies against. Then a person
   * would sign what their browser believed and the API would reject it, or
   * worse, accept something they were never shown. So the server hands over the
   * bytes and the same server checks them back in.
   *
   * `delegator` is the caller's own account and is a query parameter rather than
   * something we look up, because a person may hold more than one and only they
   * know which is being used. Ownership of it is checked when the signature
   * comes back, which is the moment it matters.
   */
  app.get<{ Params: { id: string }; Querystring: { delegator?: string } }>(
    '/v1/authorizations/:id/delegation',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      if (!input.enforcers || !input.agentSessionKey)
        return reply.code(503).send({
          error: {
            code: 'DELEGATION_UNAVAILABLE',
            message: 'This deployment cannot hold mandates on a chain.',
            retryable: false,
            requestId: request.headers['x-request-id'],
          },
        })
      const delegator = request.query.delegator
      if (!delegator || !/^0x[0-9a-fA-F]{40}$/.test(delegator))
        return reply.code(400).send({
          error: {
            code: 'DELEGATOR_REQUIRED',
            message: 'Name the account this mandate spends from.',
            retryable: false,
            requestId: request.headers['x-request-id'],
          },
        })
      const authorization = await jobs.getAuthorization(request.params.id)
      if (!requireOwner(request, reply, session, authorization.owner, 'authorization')) return reply
      const { caveats, outcomes } = compileCaveats(
        authorization.policy.constraints,
        input.enforcers,
      )
      return {
        domain: delegationDomain(input.enforcers.chainId, input.enforcers.manager as `0x${string}`),
        types: DELEGATION_TYPES,
        primaryType: 'Delegation',
        // What the wallet signs. `args` are absent because they are not part of
        // the signed type at all.
        message: {
          delegate: input.agentSessionKey,
          delegator,
          authority: ROOT_AUTHORITY,
          caveats: caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
          salt: '1',
          epoch: '0',
        },
        // What to post back, once signed. Carries args, which the manager needs
        // and the signature deliberately does not cover.
        unsigned: {
          delegate: input.agentSessionKey,
          delegator,
          authority: ROOT_AUTHORITY,
          caveats,
          salt: '1',
          epoch: '0',
        },
        limits: outcomes.map((o) => ({
          kind: o.constraint.kind,
          label: o.constraint.label,
          tier: o.tier,
          enforcedBy: o.enforcer,
        })),
      }
    },
  )
  /**
   * Turn a mandate into authority a chain will hold.
   *
   * The limits are chosen and stored first, and only then is a wallet asked to
   * sign them, so this attaches a signature to something that already exists
   * rather than creating anything. Every refusal lives in `acceptDelegation`,
   * and the constraints it checks against are read from the store rather than
   * taken from this request: a caller who supplies both sides of a comparison is
   * not being checked by it.
   */
  app.post<{ Params: { id: string }; Body: { delegation: SignedDelegation } }>(
    '/v1/authorizations/:id/delegation',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      if (!input.enforcers || !input.chain)
        return reply.code(503).send({
          error: {
            code: 'DELEGATION_UNAVAILABLE',
            message: 'This deployment cannot hold mandates on a chain.',
            retryable: false,
            requestId: request.headers['x-request-id'],
          },
        })
      const authorization = await jobs.getAuthorization(request.params.id)
      if (!requireOwner(request, reply, session, authorization.owner, 'authorization')) return reply
      // A revoked mandate must not become signable again. Revoke is the control
      // somebody reaches for when they want a thing to stop.
      if (authorization.status === 'revoked')
        return reply.code(409).send({
          error: {
            code: 'AUTHORIZATION_REVOKED',
            message: 'This mandate has been revoked.',
            retryable: false,
            requestId: request.headers['x-request-id'],
          },
        })
      const accepted = await acceptDelegation({
        delegation: request.body?.delegation,
        constraints: authorization.policy.constraints,
        owner: session.address,
        deployment: input.enforcers,
        chain: input.chain,
      })
      const updated = await jobs.attachDelegation(request.params.id, accepted)
      return {
        id: updated.id,
        status: updated.status,
        delegator: updated.delegator ?? null,
        delegationChainId: updated.delegationChainId ?? null,
        signedAt: updated.delegationSignedAt ?? null,
      }
    },
  )
  app.post<{ Params: { id: string } }>('/v1/authorizations/:id/revoke', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const existing = await jobs.getAuthorization(request.params.id)
    if (!requireOwner(request, reply, session, existing.owner, 'authorization')) return reply
    const authorization = await jobs.revoke(request.params.id)
    return { ...authorization, spent: authorization.spent.toString() }
  })
  app.post<{ Body: { authorizationId: string } }>('/v1/jobs', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const key = request.headers['idempotency-key']?.toString()
    if (!key)
      return reply.code(400).send({
        error: {
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key is required.',
          retryable: false,
          requestId: request.headers['x-request-id'],
        },
      })
    const authorization = await jobs.getAuthorization(request.body.authorizationId)
    if (!requireOwner(request, reply, session, authorization.owner, 'authorization')) return reply
    return jobs.createJob(request.body.authorizationId, key)
  })
  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    return ownedJob(request, reply, session.address, request.params.id)
  })
  app.get<{ Params: { id: string } }>('/v1/jobs/:id/events', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const job = await ownedJob(request, reply, session.address, request.params.id)
    if (!job) return reply
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    for (const event of job.events)
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    reply.raw.end()
    return reply
  })
  /**
   * The buyer pays, and the job becomes fundable work rather than a quote.
   *
   * Of the twelve job states the contract defines, FUNDED and SETTLED were
   * reached by no code path at all, and `settle()` was imported by no file. A
   * venue that shows a price and hands over the goods but cannot take payment
   * is a catalogue. These two routes are the difference.
   */
  app.post<{ Params: { id: string }; Body: { agentId?: string } }>(
    '/v1/jobs/:id/fund',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const job = await ownedJob(request, reply, session.address, request.params.id)
      if (!job) return reply
      if (!input.assistant?.credits)
        return reply.code(503).send({
          error: {
            code: 'SETTLEMENT_UNAVAILABLE',
            message: 'This deployment has no points ledger, so it cannot take payment.',
            retryable: false,
          },
        })

      const agentId = request.body?.agentId
      if (!agentId)
        return reply.code(400).send({
          error: {
            code: 'AGENT_REQUIRED',
            message: 'agentId is required to price the job.',
            retryable: false,
          },
        })

      // Priced from the agent's own published price, through the same reader
      // the quote uses, so funding and quoting cannot disagree.
      const observations = await agentObservations([agentId])
      const passport = projectPassport(agentId, observations)
      const fail = (code: string, message: string) =>
        reply.code(422).send({ error: { code, message, retryable: false } })
      if (passport.liveness !== 'LIVE')
        return fail('AGENT_NOT_QUOTABLE', 'Only LIVE agents may be hired.')
      const price = priceForQuote(agentId, observations)?.amount ?? null
      if (price === null)
        return fail(
          'AGENT_HAS_NO_PUBLISHED_PRICE',
          'This agent publishes no price and its owner has listed none.',
        )

      /*
       * Converted before it is charged. An agent publishes its price in base
       * units of the settlement asset; a balance is in points. Charging one as
       * the other asked a buyer for 102,500,000,000,000,000 points for a job
       * priced at ten cents.
       */
      const pricePoints = pointsForSettlement(price, SETTLEMENT.decimals)
      const total = Number(priceJob(BigInt(pricePoints)).total)
      try {
        const held = await fundJob({
          credits: input.assistant.credits,
          jobId: job.id,
          buyer: session.address,
          totalPoints: total,
        })
        await jobs.advance(job.id, 'FUNDED', `Buyer funded ${total} points.`)
        return { jobId: job.id, agentId, ...held, status: 'FUNDED' }
      } catch (error) {
        if (error instanceof InsufficientPoints)
          return reply.code(402).send({
            error: { code: 'INSUFFICIENT_POINTS', message: error.message, retryable: false },
          })
        throw error
      }
    },
  )

  /**
   * The work was accepted, so the money moves on: the agent's owner is paid and
   * AiKi keeps the fee it quoted. Both legs are keyed on the job, so a retry
   * settles nothing twice.
   */
  app.post<{ Params: { id: string }; Body: { agentId?: string } }>(
    '/v1/jobs/:id/settle',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const job = await ownedJob(request, reply, session.address, request.params.id)
      if (!job) return reply
      const credits = input.assistant?.credits
      const treasury = input.settlementTreasury
      if (!credits || !treasury)
        return reply.code(503).send({
          error: {
            code: 'SETTLEMENT_UNAVAILABLE',
            message: 'This deployment has no points ledger or no treasury, so it cannot settle.',
            retryable: false,
          },
        })
      if (job.status !== 'FUNDED' && job.status !== 'COMPLETED')
        return reply.code(409).send({
          error: {
            code: 'JOB_NOT_SETTLEABLE',
            message: `A job settles once it is funded and the work is in. This one is ${job.status}.`,
            retryable: false,
          },
        })

      const agentId = request.body?.agentId
      if (!agentId)
        return reply.code(400).send({
          error: {
            code: 'AGENT_REQUIRED',
            message: 'agentId is required to pay the agent.',
            retryable: false,
          },
        })
      const observations = await agentObservations([agentId])
      const passport = projectPassport(agentId, observations)
      const owner = passport.identity?.owner
      if (!owner)
        return reply.code(422).send({
          error: {
            code: 'AGENT_HAS_NO_OWNER',
            message: 'The registry records no owner for this agent, so there is nobody to pay.',
            retryable: false,
          },
        })
      const price = priceForQuote(agentId, observations)?.amount ?? null
      if (price === null)
        return reply.code(422).send({
          error: {
            code: 'AGENT_HAS_NO_PUBLISHED_PRICE',
            message: 'No price to settle.',
            retryable: false,
          },
        })

      const legs = await settleJob({
        credits,
        jobId: job.id,
        agentOwner: owner,
        treasury,
        pricePoints: pointsForSettlement(price, SETTLEMENT.decimals),
      })
      await jobs.advance(
        job.id,
        'SETTLED',
        `Paid ${legs.paidToAgent} points to ${owner}, kept ${legs.fee} as the quoted fee.`,
      )
      return { jobId: job.id, agentId, paidTo: owner, ...legs, status: 'SETTLED' }
    },
  )

  /**
   * The supply side: an owner puts their own agent up for hire.
   *
   * Everything else on this marketplace is something AiKi went and found. This
   * is the one route where the other party acts, and it is the difference
   * between a directory that grows when we index and a venue people join.
   *
   * The gate is ownership, checked against the address the registry recorded
   * when the token was minted. It is chain-derived and it is not live: a token
   * transferred since registration is not reflected until the indexer sees it,
   * so this says who the registry last told us owns the agent, which is stated
   * in the response rather than implied.
   */
  app.post<{ Params: { agentId: string }; Body: { priceAmount?: string } }>(
    '/v1/agents/:agentId/listing',
    async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      if (!input.appendObservation)
        return reply.code(503).send({
          error: {
            code: 'LISTING_UNAVAILABLE',
            message: 'This deployment cannot record listings.',
            retryable: false,
          },
        })

      const amount = request.body?.priceAmount
      if (typeof amount !== 'string' || !/^\d+$/.test(amount))
        return reply.code(400).send({
          error: {
            code: 'INVALID_PRICE',
            message: `priceAmount must be a whole number of base units of ${SETTLEMENT.symbol}, which has ${SETTLEMENT.decimals} decimals.`,
            retryable: false,
          },
        })

      const agentId = request.params.agentId
      const observations = await agentObservations([agentId])
      const passport = projectPassport(agentId, observations)
      const owner = passport.identity?.owner
      if (!owner)
        return reply.code(404).send({
          error: {
            code: 'AGENT_NOT_INDEXED',
            message: 'AiKi holds no registration for this agent, so it cannot tell who owns it.',
            retryable: false,
          },
        })
      if (owner.toLowerCase() !== session.address.toLowerCase())
        return reply.code(403).send({
          error: {
            code: 'NOT_THE_OWNER',
            message: `The registry records ${owner} as this agent's owner. Only that address can list it.`,
            retryable: false,
          },
        })

      const now = new Date().toISOString()
      await input.appendObservation({
        subject: {
          type: 'agent',
          chainId: passport.chainId ?? 56,
          registry: passport.registry ?? '',
          agentId,
        },
        predicate: 'marketplace.listing',
        /*
         * Class D: the owner said it. The OWNERSHIP is chain-derived and
         * checked, the price is a declaration, and calling a stated price a
         * measurement is the mistake this whole product is arranged against.
         */
        evidenceClass: 'D',
        value: { price: { amount, asset: SETTLEMENT.symbol, decimals: SETTLEMENT.decimals } },
        validAt: now,
        observedAt: now,
        source: `owner:${owner.toLowerCase()}`,
        method: 'marketplace-listing/v1',
        // One listing per owner per instant; relisting supersedes by being newer.
        dedupeKey: `listing:${agentId}:${now}`,
      })

      return {
        agentId,
        listedBy: owner,
        price: { amount, asset: SETTLEMENT.symbol, decimals: SETTLEMENT.decimals },
        note: "Recorded as the owner's stated price, not as something AiKi measured. A price published in the agent's own registration file takes precedence, because that one is public.",
      }
    },
  )

  app.post<{ Params: { id: string } }>('/v1/jobs/:id/receipt', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const job = await ownedJob(request, reply, session.address, request.params.id)
    if (!job) return reply
    const authorization = await jobs.getAuthorization(job.authorizationId)
    return receipts.create({
      jobId: job.id,
      mandateHash: authorization.policy.hash,
      actions: job.events,
      startedAt: job.createdAt,
      completedAt: new Date().toISOString(),
    })
  })
  /**
   * Do one thing, and report what each of the three said about it.
   *
   * The agent decides something should happen, the mandate decides whether it is
   * permitted, and the chain decides whether it lands. Every answer is recorded
   * against the job, refusals included, because a log of only what worked is a
   * brochure rather than evidence.
   */
  app.post<{
    Params: { id: string }
    Body: { target?: string; selector?: string; asset?: string; amount?: string; callData?: string }
  }>('/v1/jobs/:id/actions', async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const job = await ownedJob(request, reply, session.address, request.params.id)
    if (!job) return reply
    const authorization = await jobs.getAuthorization(job.authorizationId)
    const { action, callData } = parseAction(request.body ?? {})
    return act({
      jobs,
      jobId: job.id,
      action,
      callData,
      authorization,
      ...(input.enforcers && input.agentKey
        ? {
            config: {
              rpcUrl: input.enforcerRpcUrl ?? '',
              chainId: input.enforcers.chainId,
              manager: input.enforcers.manager as `0x${string}`,
              agentKey: input.agentKey,
            },
          }
        : {}),
    })
  })
  app.get<{ Params: { id: string } }>('/v1/receipts/:id', async (request) =>
    receipts.get(request.params.id),
  )
  // What a verifier pins: checking a receipt must not require trusting us.
  app.get('/v1/receipts/key', async () => ({
    alg: 'Ed25519',
    publicKey: receipts.publicKey(),
    profile: 'aiki-scitt-cose/v1',
  }))
  // A leaderboard anyone can write to is not a measurement, it is a guestbook.
  app.post<{ Body: Omit<BenchmarkRun, 'id' | 'completedAt' | 'methodology'> }>(
    '/v1/arena/runs',
    async (request, reply) => {
      if (!requireIngestToken(request, reply)) return reply
      return benchmarks.add(request.body)
    },
  )
  app.get<{ Params: { id: string } }>('/v1/arena/runs/:id', async (request) => {
    const run = benchmarks.get(request.params.id)
    return { ...run, evidence: benchmarkEvidence(run) }
  })
  app.get<{ Querystring: { agentId?: string } }>('/v1/arena/leaderboards', async (request) =>
    benchmarks
      .list()
      .filter((run) => !request.query.agentId || run.agentId === request.query.agentId)
      .map((run) => ({
        runId: run.id,
        agentId: run.agentId,
        scenarioId: run.scenarioId,
        ...benchmarkEvidence(run),
      })),
  )
  return app
}
