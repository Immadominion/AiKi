# Ownership & Workflow

**Team:** 2 engineers
**Deadline:** 12:00 UTC, 9 September 2026 (midday, not midnight)
**Today:** 19 August 2026 — **21 days**

---

## 1. The one rule that makes two people work

> **Neither person may block the other.**

Everything below exists to serve that. The mechanism is a **frozen contract at the seam**: [`01-api-contract.md`](01-api-contract.md) defines every endpoint, every type, and ships with fixtures. The frontend builds against fixtures from hour one. The backend implements to the same shapes. They meet at the end and it works.

**If you need something from the other person to keep moving, that is a bug in the contract, not a scheduling problem.** Fix the contract.

---

## 2. Who owns what

| | **Joel** (`@ImmaDotDev`) | **Protocol engineer** |
|---|---|---|
| **Owns** | Everything the user sees | Everything that produces truth |
| **Directories** | `apps/web/`, `packages/contracts/` (types), design | `apps/api/`, `onchain/`, `packages/sdk/` |
| **Scope** | Intent → Discover → Passport → Compare → Mandate Builder → Mission Control → Receipt. Design system, states, motion, responsiveness. | Ingestion, prober, evidence store, Proof Score, policy compiler, session keys, ERC-8183 adapter, `$U` settlement, Arena harness, reference agents. |
| **Does NOT touch** | `apps/api/`, `onchain/` | `apps/web/` styling or components |
| **Deploys** | Vercel (web) | Railway / Fly (api), BSC (contracts) |

**Shared, changed only by agreement:** `packages/contracts/` (the types), `docs/01-api-contract.md`, ADRs.

### Why this split

Joel's strengths are product judgment, dense UI and design taste — which map directly onto **Functionality**, one of the three judged criteria, and onto the "Mad UI" opportunity in the product spec. The protocol engineer takes indexing, chain integration and Solidity, which is the heavy unglamorous half and needs uninterrupted focus.

**Neither role is "the hard part."** The rubric scores the journey and the data equally.

---

## 3. Git workflow

### Before you write a single line, every session

```bash
git pull --rebase origin main
```

Then read what changed:

```bash
git log --oneline -15
git diff HEAD~5 --stat
```

**This is the discipline Joel asked for and it is not optional.** With two people in one repo, working from a stale tree is how you spend an afternoon rebuilding something that already exists.

### Branches

```
main                    always deployable, never broken
feat/<area>-<thing>     feat/api-ingestion, feat/web-passport
fix/<thing>
chore/<thing>
```

Branch off `main`. Rebase onto `main` before opening a PR. Never merge `main` into your branch.

### Commits

Conventional commits, present tense, explain **why** when it isn't obvious:

```
feat(api): index Registered events instead of scanning token IDs

totalSupply() reverts on the canonical registry — it is not
ERC721Enumerable, so a 1..totalSupply scan is impossible.
See research/02-ecosystem/03-bnb-agent-studio.md
```

**No AI attribution in commit messages** — this is a competition submission.

### Pull requests

Small and frequent beats large and correct-in-one-go. Two people means review is cheap; use it.

PR description answers three questions:
1. What does this change?
2. What did you verify, and how?
3. Does it change the API contract? *(If yes — say so in the title. Contract changes need the other person's sign-off.)*

**Merge your own PRs when the other person is asleep.** We are in different timezones half the time and blocking on review defeats the point. Review after the fact if needed — `main` history is the record.

### The contract is special

Changing `packages/contracts/` or `docs/01-api-contract.md`:
1. Open a PR that **only** touches the contract
2. Title it `contract: <what changed>`
3. Get an explicit 👍 in Telegram before merging
4. Both sides update in the same day

A contract change silently merged is the one thing that can genuinely break parallel work.

---

## 4. Communication

| Channel | Use |
|---|---|
| **Telegram** | Anything blocking. Response expected within a few hours. |
| **GitHub issues** | Anything not blocking. Bugs, ideas, questions with a shelf life. |
| **PR comments** | Code-specific. |
| **`docs/`** | Decisions. If it changes what someone builds, it goes in a doc, not a chat message. |

**Daily, async, in Telegram — three lines each:**
```
Yesterday: <what landed>
Today:     <what I'm on>
Blocked:   <what I need, or "nothing">
```

Costs 30 seconds. It is the entire project-management overhead.

---

## 5. Definition of done

A task is done when:

- [ ] It works against **real data**, not a fixture
- [ ] The failure path is handled — timeout, empty, malformed, rate-limited
- [ ] It matches the contract exactly (or the contract changed by agreement)
- [ ] `main` is green
- [ ] If it produces a user-visible number: **provenance and confidence are attached**

That last one is the product. A number without provenance is exactly what AiKi exists to replace — see [the charter](../research/00-method/00-research-charter.md).

---

## 6. Non-negotiables

Verified by research; violating any of these ships something false.

| Rule | Why |
|---|---|
| **Never call `totalSupply()`** on the identity registry | It reverts. Not ERC721Enumerable. Index `Registered` events. |
| **Never assume 6 decimals** | USDT-BSC is **18**. A 6-decimal assumption is wrong by 10¹². Decimals come from config, per token. |
| **Never hardcode a contract address** as a chain-agnostic constant | Addresses differ per chain and a global constant corrupts silently. Config keyed by chain ID, asserted at startup. |
| **Never render HTTP 200 as "live"** | 141 of 147 "live" BSC endpoints were static shells. Capability probe or nothing. |
| **Never show a score without confidence** | Sparse evidence must not read as certainty. |
| **Never claim "per month" on a spend cap** | The shipping policy module is a **lifetime** cap. Claiming otherwise is a false security promise. |
| **Never rank trading agents by PnL or Sharpe** | ~63 years of data to separate 0.5 Sharpe. Paired replay only. |
| **Build ERC-8183 from the deployed ABI**, not the EIP text | `fund` and `setProvider` diverge from spec. |
| **Secrets never enter the repo** | `.env` is gitignored at the workspace root. |

---

## 7. Timeline

```
Aug 19 ─────────────── Aug 26 ─────────────── Sep 2 ─────────── Sep 9
  │                       │                      │                │
  │  PROTOCOL ENG         │                      │                │
  ├─ unblock O-3          ├─ prober + score      ├─ commerce      ├─ FREEZE
  ├─ ingestion            ├─ policy compiler     ├─ Arena         │  Sep 7
  │                       ├─ reference agents    │                │
  │                                                               │
  │  JOEL                                                         │
  ├─ design system        ├─ Passport, Compare   ├─ Mission Ctrl  │
  ├─ against fixtures     ├─ Mandate Builder     ├─ Receipt       │
  │                                                               │
  └── Aug 25: Pasteur hardfork (mandatory, pin client v1.7.7)
```

**Freeze `main` on 7 September.** The last two days are deployment, the demo, and the submission form — not features. A working deployment is an eligibility condition during judging.

---

## 8. What we are NOT building

Scope discipline, from the research. Every one of these was considered and rejected with a reason.

| Not building | Because |
|---|---|
| A custom blockchain protocol | Existing standards cover the seams |
| A better scoring API as the flagship | trust8004 and 8004scan ship this free today |
| A trading leaderboard | Statistically void |
| Broad shallow coverage of all four categories | Supply is 132/40/10/**4** — coverage isn't obtainable by indexing |
| Rolling-window spend caps | Needs custom audited fund-holding code. Not under a deadline. |
| Enterprise, Workflow Studio, multi-chain | Real product scope, post-competition |

**This is sequencing, not scope reduction.** The complete product suite in the MPSS remains the product.
