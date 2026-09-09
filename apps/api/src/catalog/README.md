# External BNB Chain catalog and read connector

AiKi can browse real ERC-8004 registrations independently of its own index and its paid task protocol. Registration, protocol discovery and completed work are different facts. This connector never creates a hire, delivery, receipt, rating or payment record.

## Integration

Register after the API's existing signed-session hook:

```ts
import { registerCatalogRoutes } from '../catalog/routes.js'
registerCatalogRoutes(app)
```

The browser uses `catalogApi` from `apps/web/src/lib/catalog-api.ts`. It delegates to the existing accepted-wallet `apiRequest` wrapper, including stale-session cancellation. `/explore` lists registrations and `/catalog/[id]` presents the available read action.

Fast uses the same HTTP routes through `catalog_agents`, `catalog_agent`, `catalog_capabilities` and `read_external_agent`. The last tool accepts only the two reviewed registration IDs and an optional Venus pool. It cannot supply an endpoint, method, tool name or wallet address. The route's accepted session address is forwarded in `x-aiki-wallet-address` and supplies the Venus read address. Provider authentication, payment and error states are refusals, not successful hires. The external connector costs zero AiKi points, while Fast model usage remains separately billed.

| Route | Input | Meaning |
| --- | --- | --- |
| `GET /v1/catalog/agents` | `query`, `protocol=MCP\|A2A`, `category`, `limit=1..40`, `cursor` | Real chain56 registrations, source identity/artwork, declared protocols and categories, opaque next cursor |
| `GET /v1/catalog/agents/:id` | Decimal uint256 token ID | One registration, fixed source attribution, safe registered endpoints |
| `GET /v1/catalog/agents/:id/capabilities` | Token ID only, never an endpoint URL | MCP initialize and tools/list, schemas, authentication/payment status, explicitly enabled `readTools` |
| `POST /v1/catalog/agents/:id/read` | `{tool, arguments}` | Signed-session read result; matching `x-aiki-wallet-address` is required |

Category IDs match the marketplace: `health_factor`, `rebalancing`, `grid_trading`, `yield_optimisation`, `other`. The first four search source text using `lending`, `rebalancing`, `grid`, `yield`. They are search aids, not independently verified performance classifications. `declaredCategories` contains only categories actually returned by the publisher source. The source list omits category metadata, so `other` filters the current page for descriptions/names outside those work keywords. Its source total is not an uncategorized total.

`totalRegistered` is the source's registration count, never a count of working agents. `taskAvailability` remains `not_verified`; MCP discovery alone does not establish compatibility with AiKi paid jobs. `capabilities.status=available` means MCP discovery answered, while `readTools` controls executable actions. No numeric source reputation/health scores are relabelled as AiKi ratings.

## Enabled actions

The exact registry, chain, registered owner, endpoint and tool must match `read-policy.ts`. Tool arguments pass both AiKi's fixed schema and the provider's current schema. Unknown validation keywords and unknown tools fail closed.

| Registration | Provider | Action | Scope |
| --- | --- | --- | --- |
| BSC43129 | Venus powered by HeyAnon | `getAccountLiquidity` | BNB Chain only, CORE/DEFI pool, signed-in wallet only |
| BSC45650 | V3 Pools powered by HeyAnon | `getDexInfo` | BNB Chain DEX information only |

No borrow, repay, supply, swap, fee collection, position creation or calldata-building tool is enabled. No arbitrary MCP passthrough exists. Upstream401/403 and402 stop at explicit provider-authentication/payment states; no wallet credential, session cookie, API key or payment header is forwarded. Provider session IDs stay inside the request and are not cached or returned. User inputs and provider results are not persisted.

These reads charge zero AiKi points. Provider pricing is not inferred from a successful handshake. Any future paid integration must preserve the provider's price and payment protocol, not create an invented100point hire.

## Network and abuse limits

- HTTPS443 only, no credentials, fragments or redirects. All DNS answers must be public; the checked IP is pinned into the actual TLS connection, with certificate verification against the original hostname. IPv6 private, reserved and transition forms are rejected.
- Source request deadline12s; complete MCP session deadline18s; source JSON maximum2MiB, each MCP response512KiB, each schema16KiB, at most100 discovered tools, request body4KiB. Server sampling/elicitation/roots requests are ignored, not executed.
- Source cache5minutes,256 entries and16MiB serialized-weight ceiling; capability cache2minutes,128 entries and8MiB ceiling. Each cache coalesces identical loads and bounds new concurrent loads to8.
- Anonymous source budget24requests/minute and900/day, below the documented30/minute and1000/day. Upstream429 pauses further source requests according to bounded Retry-After. No API key is required or exposed.
- Public catalog40requests/IP/minute; capability checks6/IP/minute; reads6/signed-wallet/minute, one concurrent read per wallet, maximum4reads total. Total fresh provider sessions30/minute. Active rate-limit identities are not evicted to reset their quota.
- Budgets/caches are process-local. Coordinate source quota and abuse limits across replicas before scaling to multiple API processes; do not assume this in-memory budget is distributed enforcement.

## Verified live smoke

On 2026-09-09 at 12:37:12 UTC, the production HeyAnon V3 Pools endpoint answered via this module's pinned transport: MCP 2025-06-18, 17 tools, HTTP 201 initialization/discovery. The actual `getDexInfo({"chainName":"bsc"})` call returned:

```json
{"project":"v3pools","operation":"getDexInfo","data":{"chain":"bsc","dex":"Pancake","feeTiers":["0.01%","0.05%","0.25%","1%"]}}
```

This call has no wallet-address argument and made no transaction or payment. It establishes one working external read integration at that time, not 100 working providers. The Venus handshake had been verified separately; its authenticated wallet-specific call still needs the native user-flow check.

## Sources

- [8004scan developer API and quota](https://8004scan.io/developers), [OpenAPI](https://api.8004scan.io/openapi.json)
- [Venus registration43129](https://api.8004scan.io/api/v1/agents/56/43129), [V3 Pools registration45650](https://api.8004scan.io/api/v1/agents/56/45650)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [ERC-8004 identity/services](https://eips.ethereum.org/EIPS/eip-8004)

Tests: `pnpm --filter @aiki/api exec vitest run src/catalog`; browser request/filter tests: `pnpm --filter @aiki/web exec tsx --tsconfig tsconfig.test.json --test src/components/catalog/*.test.ts`.
