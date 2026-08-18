# Raw research output

Structured JSON returned by the research agents, preserved verbatim so every claim
in the write-ups can be traced back to its source.

Each `<topic>.json` follows one schema:

| Field | Meaning |
|---|---|
| `topic` | what was researched |
| `verdict` | SOLID / PARTIAL / THIN / CONTRADICTED / NOT_FOUND — how well primary sources supported it |
| `executive_summary` | engineer-to-engineer summary |
| `findings[]` | `claim`, `detail`, `confidence` (high/medium/low), `sources[]` (exact URLs fetched), `source_date` |
| `interfaces[]` | verbatim code / schemas / ABIs actually seen in a source |
| `gaps[]` | what could NOT be verified, and why |
| `aiki_implications[]` | consequences for the build |

`verdicts-round1.json` and `verdicts-round3.json` hold the adversarial verification
passes — independent agents instructed to *refute* the load-bearing claims, returning
`CONFIRMED` / `PARTIALLY_TRUE` / `REFUTED` / `UNVERIFIABLE` with corrections and the
engineering impact of building on a false version.

Method and epistemic standard: [`../00-method/00-research-charter.md`](../00-method/00-research-charter.md)
