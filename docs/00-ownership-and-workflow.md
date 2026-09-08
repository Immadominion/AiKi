# Ownership and workflow

AiKi is a marketplace for humans and AI agents to get work done together. Read [PRODUCT.md](PRODUCT.md) for the current product definition, participants and priorities.

Fast and Manual are two routes into that marketplace. Work carries the brief, delivery and review. Profiles, endpoint checks and permission limits help people choose a provider and agree to the right scope.

The product direction includes work in all four relationships: human to agent, agent to agent, agent to human, and human to human. These are participants in the same marketplace, not four separate products. Implemented task tools operate through authenticated accounts and, when supplied, a spending mandate. Do not describe that as unrestricted agent autonomy or assume every direction has the same UI or deployment coverage.

This guide retains the original two-engineer ownership split. The August schedule and scope exclusions in sections 7 and 8 are dated planning records, not the current roadmap.

Original planning baseline: 19 August 2026. Submission deadline recorded then: 12:00 UTC, 9 September 2026 (midday, not midnight).

---

## 1. The one rule that makes two people work

> **Neither person may block the other.**

Agree on the shared API types and fixtures before building either side. Keep [`01-api-contract.md`](01-api-contract.md) and the implementation in sync, including newer task and marketplace endpoints. Fixtures let frontend and backend work in parallel; they do not replace integration tests.

**If you need something from the other person to keep moving, that is a bug in the contract, not a scheduling problem.** Fix the contract.

---

## 2. Who owns what

| | **Joel** (`@ImmaDotDev`) | **Protocol engineer** |
|---|---|---|
| **Owns** | Marketplace experience | Marketplace services and execution |
| **Directories** | `apps/web/`, `packages/contracts/` (types), design | `apps/api/`, `onchain/`, `packages/sdk/` |
| **Scope** | Fast and Manual entry, discovery, profiles, hiring, People, Work, delivery and review. Design system, states, motion, responsiveness and permission controls. | Provider and task APIs, dispatch, delivery, review, ledger and settlement, authorization, reference agents, ingestion and endpoint checks. |
| **Does NOT touch** | `apps/api/`, `onchain/` | `apps/web/` styling or components |
| **Deploys** | Vercel (web) | API deployment and BSC contracts; use the current deployment configuration rather than the original Railway / Fly proposal. |

**Shared, changed only by agreement:** `packages/contracts/` (the types), `docs/01-api-contract.md`, ADRs.

### Why this split

Joel owns how someone finds work, chooses a provider and follows a delivery. The protocol engineer owns the services that make those actions reliable. Both review the complete hiring flow, including its failure paths.

---

## 3. Git workflow

### Before you write a single line, every session

Check the working tree first and preserve existing work. Do not reset or discard changes to make a pull succeed. When the tree and branch are ready to update:

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

totalSupply() reverts on the canonical registry - it is not
ERC721Enumerable, so a 1..totalSupply scan is impossible.
See research/02-ecosystem/03-bnb-agent-studio.md
```

**No AI attribution in commit messages**, per the original submission convention.

### Pull requests

Small and frequent beats large and correct-in-one-go. Two people means review is cheap; use it.

PR description answers three questions:

1. What does this change?
2. What did you verify, and how?
3. Does it change the API contract? *(If yes, say so in the title. Contract changes need the other person's sign-off.)*

**Merge your own PRs when the other person is asleep**, within the team's agreed review policy. Review after the fact if needed; `main` history is the record. Contract changes still need the explicit sign-off below.

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

Daily, async, in Telegram:

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
- [ ] The failure path is handled: timeout, empty, malformed, rate-limited
- [ ] It matches the contract exactly (or the contract changed by agreement)
- [ ] `main` is green
- [ ] Measured or estimated claims have an appropriate source and uncertainty label
- [ ] If it changes a job, the brief, price, delivery, review and payment state agree across the API and UI
- [ ] Repeated requests cannot charge twice or create a second delivery or acceptance
- [ ] The interface names the payment asset and network accurately; AiKi points are not presented as withdrawable money

Endpoint checks and sourced numbers help buyers choose. They support the marketplace's main job: getting agreed work delivered and reviewed. The [research charter](../research/00-method/00-research-charter.md) describes how those supporting measurements were gathered.

---

## 6. Non-negotiables

These safeguards came from the protocol research. Counts and chain observations are dated findings, not live marketplace totals. Recheck provider support and contract deployments before using them operationally.

| Rule | Why |
|---|---|
| **Never call `totalSupply()`** on the identity registry | It reverts. Not ERC721Enumerable. Index `Registered` events. |
| **Never assume 6 decimals** | USDT-BSC is **18**. A 6-decimal assumption is wrong by 10¹². Decimals come from config, per token. |
| **Never hardcode a contract address** as a chain-agnostic constant | Addresses differ per chain and a global constant corrupts silently. Config keyed by chain ID, asserted at startup. |
| **Never render HTTP 200 as "live"** | In the recorded research sample, 141 of 147 apparently live BSC endpoints were static shells. Require a capability response before making a capability claim. |
| **Never show a score without confidence** | Sparse evidence must not read as certainty. |
| **Never claim a lifetime module enforces a monthly cap** | The researched policy module is a **lifetime** cap. Label a monthly check held by AiKi separately from chain enforcement. |
| **Never rank trading agents by PnL or Sharpe** | ~63 years of data to separate 0.5 Sharpe. Paired replay only. |
| **Build ERC-8183 from the deployed ABI**, not the EIP text | `fund` and `setProvider` diverge from spec. |
| **Secrets never enter the repo** | `.env` is gitignored at the workspace root. |

---

## 7. Original August timeline, historical reference

The dates and priorities below belong to the 19 August plan. They do not establish today's blockers, shipping status or feature order. Use current issues and [PRODUCT.md](PRODUCT.md) for that.

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

The original plan called for a 7 September freeze and reserved the final two days for deployment and submission. Keep the deployment available during judging; do not treat this old schedule as authority to ship or freeze unrelated work now.

---

## 8. Original scope exclusions, historical reference

These exclusions recorded the competition plan. In particular, the sampled category counts below are not current inventory. None of these exclusions removes human-to-human or agent-to-human work from AiKi's product direction.

| Not building | Because |
|---|---|
| A custom blockchain protocol | Existing standards cover the seams |
| A better scoring API as the flagship | trust8004 and 8004scan ship this free today |
| A trading leaderboard | Statistically void |
| Broad shallow coverage of all four categories | Supply is 132/40/10/**4**: coverage isn't obtainable by indexing |
| Rolling-window spend caps | Needs custom audited fund-holding code. Not under a deadline. |
| Enterprise, Workflow Studio, multi-chain | Real product scope, post-competition |

The old MPSS and this table are planning inputs. [PRODUCT.md](PRODUCT.md) is the current product reference; a feature in an earlier plan is not a shipping commitment.
