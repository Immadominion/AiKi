# Design research

Primary research behind `docs/design-system-brief.md`. Five parallel passes on the
visual problems specific to AiKi, since none of them have off-the-shelf solutions.

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
because opacity is taken by disabled/loading and colour is taken by P&L — and because
the sticker logo already makes outline native to the brand.
