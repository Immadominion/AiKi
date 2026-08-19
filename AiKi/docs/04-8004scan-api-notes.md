# 8004scan API — measured behaviour

**Measured 19 August 2026.** Their OpenAPI spec is incomplete and in two places
actively misleading. Everything here was verified against live responses.

Base: `https://8004scan.io/api/v1/public` · OpenAPI: `/docs/openapi.json`

---

## ⚠️ Three traps, each of which produces a plausible-looking wrong answer

### 1. `offset` is silently ignored — pagination is `page`

```
?limit=2&offset=0        → token_ids 270404, 270403
?limit=2&offset=100000   → token_ids 270404, 270403   ← identical
?limit=2&page=2          → token_ids 270402, 270395   ← works
```

`meta.pagination` returns `{ page, limit, total, hasMore }`. There is no offset field.

**Why this matters more than a normal bug:** passing `offset` returns page 1 every
time, so a "spread sample across the registry" is silently a sample of the *newest*
agents only. Those were minted minutes ago and declare nothing, so the sweep reports
**"0% declare a service"** — which reads as a devastating finding and is entirely an
artifact. Prior research measured ~40% declaring a service.

A sampling bug that produces a *publishable statistic* is the most dangerous kind of
bug this project can have. It is exactly what AiKi exists to catch in other people's
data, so we cannot ship it in our own.

### 2. Services are FLATTENED, not an array

There is no `services` array on the detail record. Service entries are flattened into
named columns:

```
mcp_server, mcp_version, a2a_endpoint, a2a_version, agent_url
```

The verbatim ERC-8004 registration file is under `raw_metadata.offchain`, and **that
is the one to prefer** — it preserves `transport`, which D3 needs to distinguish a
`stdio` MCP entry (declared but not network-callable) from a real remote endpoint.

Use `--inspect <tokenId>` to dump a real record rather than guessing field names.

### 3. `x-ratelimit-limit` is not trustworthy

Reports `10` on every key tested — including a Pro-upgraded one, and including while
the same key serves a 14-request burst without a single 429.

| Signal | Trust |
|---|---|
| `x-ratelimit-limit` | ❌ appears hard-coded to 10 |
| `x-ratelimit-remaining` | ⚠️ decrements to 0, but requests keep succeeding — soft backpressure |
| HTTP 429 + `error.details.resetAt` | ✅ precise and worth obeying exactly |

**Do not hard-code a rate.** The client eases off when `remaining` hits 0, sleeps
until `resetAt` on a real 429, and discovers the true ceiling at runtime.

---

## Auth

Two header names are in circulation and it is undocumented which gates the Pro tier:

| Header | Where it appears |
|---|---|
| `X-API-Key` | their OpenAPI `securitySchemes` |
| `X-Access-Token` | their MCP server config |

We send **both** on every request.

There is also an **MCP endpoint** at `https://8004scan.io/api/v1/mcp` (SSE transport,
`X-Access-Token`). `POST` returns 405 — it is the older HTTP+SSE transport, so the
stream opens with `GET`. Configured in `~/.claude/settings.json`.

---

## Envelope

The **public** API wraps everything:

```jsonc
{ "success": true,
  "data": [ /* … */ ],
  "meta": { "version", "timestamp", "requestId",
            "pagination": { "page", "limit", "total", "hasMore" } } }
```

The **undocumented** `/api/v1` endpoint uses `{ items, total, limit, offset }` instead.
**They are not interchangeable** — a parser written against one silently returns
nothing against the other.

Errors:

```jsonc
{ "success": false,
  "error": { "code": "RATE_LIMIT_EXCEEDED", "message": "…",
             "details": { "limit": 10, "remaining": 0, "resetAt": "…Z" } },
  "meta": { … } }
```

---

## Endpoints in use

| Endpoint | Notes |
|---|---|
| `GET /agents?chainId=56&limit=&page=` | **`page`, not `offset`** |
| `GET /agents/{chainId}/{tokenId}` | flattened services; registration file in `raw_metadata.offchain` |
| `GET /stats` | `total_validators` and `total_validations` are still **0** network-wide |
| `GET /feedbacks?chainId=` | reputation records |
| `GET /chains` | 60 chains |
| `GET /agents/search` | ⚠️ returned **502** under test — never put on a critical path |

Live at time of writing: **258,335** BSC agents; highest token_id observed **270,404**.

---

## Standing posture

8004scan is a **seed source behind a circuit breaker**, never a runtime dependency.
It is undocumented, unversioned, has no SLA, and one endpoint 502s under load. AiKi
indexes the registry contracts directly and reconciles against it.
