# Design research

Research behind the [archived design brief](../../../../docs/archive/2026-08-19-design-system-brief.md), originally `docs/design-system-brief.md`: five parallel studies
of uncertainty, permissions, dense data, brand and typography. These are inputs to
particular interface decisions, not a complete marketplace design brief. Current
product scope is defined in [PRODUCT.md](../../../docs/PRODUCT.md).

| File | Covers |
|---|---|
| `uncertainty-viz.json` | Communicating confidence to non-experts. Lower-bound ranking, countable evidence, refusal-to-compute, named tie states |
| `permission-ui.json` | Making scoped authority legible. Wallet previews, OAuth, spend-limit vocabulary, and why Chrome killed the padlock |
| `dense-data-ui.json` | Reference products for density. LMArena Rank-UB, Datadog No-Data, Chainlink heartbeat |
| `brand-tension.json` | Playful brand over serious instrument. Monzo/Ramp/Mercury token separation, 2026 AI-slop tells |
| `type-and-numbers.json` | Typefaces, measured contrast ratios, numeric precision as an uncertainty channel |

Each holds `patterns[]` (with `when_it_fails`), `references[]`, `recommendations[]`
and `anti_patterns[]`.

**The convergent finding:** four of five independently concluded that AiKi should use
**stroke/outline weight** as the semantic channel for confidence and enforcement,
because opacity is taken by disabled/loading and colour is taken by P&L - and because
the sticker logo already makes outline native to the brand.

That conclusion describes the research recommendation, not a requirement that
every component encode confidence or enforcement. Hiring, delivery, review,
payment and human-agent handoffs need clear interaction design in their own right.
