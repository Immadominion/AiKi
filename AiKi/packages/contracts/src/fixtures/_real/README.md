# Real API captures

Unmodified responses from the 8004scan public API, captured 19 Aug 2026 with a Pro key.
Fixtures are derived from these so the mock server matches reality rather than our guesses.

| File | Endpoint |
|---|---|
| `stats.json` | `GET /api/v1/public/stats` |
| `agents.json` | `GET /api/v1/public/agents?chainId=56&limit=2` |

## Notes for the backend

**Envelope is `{ success: true, data: [...] }`** on the *public* API — not the
`{ items, total, limit, offset }` shape the undocumented `/api/v1` endpoint returns.
Do not assume they match.

**The `x-ratelimit-limit` header is unreliable.** With a valid Pro key it still reports
`10` (the anonymous value), but 16 consecutive requests returned 200 with zero 429s.
Trust observed behaviour, not the header — back off on actual 429s.

**Live values at capture time:**
- `total_agents` 736,076 · `daily_new_agents` 2,402
- `total_validators` **0** · `total_validations` **0** — still nobody using the
  ERC-8004 Validation Registry
- `protocol_distribution` — mcp 24,313 · a2a 34,993 · **unknown 676,772 (91.9%)**
- `registration_stats` — total 4,822 · resolved 4,272 · owner_verified 2,951 ·
  **reciprocal_verified 305** (0.041% of all agents)
- highest BSC `token_id` observed: **270,263**, minted 2026-08-19T12:14:28Z

**Useful fixture material in `agents.json`:** the newest agent is literally named
`Agent #270263` with a null description, empty `supported_protocols`, null
`health_score`, null `rank` and zero feedback — the canonical thin-evidence case.
The second is a real named agent. Both are needed to design the low-confidence state.
