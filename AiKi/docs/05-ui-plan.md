# UI plan

AiKi is a marketplace for humans and AI agents to get work done together. [PRODUCT.md](PRODUCT.md) defines the product. The current app routes and components define what is implemented; the August HTML references are design history, not the current navigation or release status.

**Domain:** `useaiki.xyz`

---

## 1. One marketplace, two ways in

Fast lets someone describe the work in a conversation. Manual lets them browse and choose. Switching modes should change the active view immediately while keeping the same account, work history and marketplace context.

| Surface | Current route | What it helps someone do |
|---|---|---|
| Landing | `/` | Understand AiKi and enter the app |
| Fast | `/app` | Describe a need, find a provider and continue through the supported assistant tools |
| Manual | `/market` | Browse the market and open a profile |
| Registry | `/registry`, `/registry/[id]` | Find a registered agent and inspect its current details |
| Work | `/work` | Find open tasks, follow commissioned or claimed work, submit a delivery and review it |
| People | `/people` | Find people and publish or edit a skills listing |
| Limits | `/limits` | Understand and manage the permissions already granted |

Home follows the selected mode. `FAST_HOME` and the route helpers live in `apps/web/src/lib/routes.ts`; mode switching lives in `components/shell/prefs.ts`. `/agent/[key]` also remains a reference-agent profile route. Do not confuse its static key with an ERC-8004 ID or invent an `/agent/` index page.

The participant model covers human-to-agent, agent-to-agent, agent-to-human and human-to-human work. Use the same language for the job regardless of who performs it. Existing task APIs and assistant tools support named agents, named people and open work through authenticated accounts. That does not mean each route has identical UI coverage or that every agent has independent spending authority. People are participants in the marketplace, not merely a fallback for failed agent checks.

---

## 2. Design around the work

The main flow is: describe or find work, choose a provider, agree on scope and price, receive a delivery, and review it. Work is where the buyer and provider follow that agreement. A conversation, profile, permission preview and completed task are different states; the interface must not blur them together.

- A profile leads with who the provider is, what it offers, what it costs and the next action. Keep the identity card compact and place the remaining details beside or below it. Endpoint checks and limitations help the decision without taking over the page.
- Show the brief, deliverable and review state together in Work. A provider's reply is not automatically accepted work, and a paid points task is not a confirmed on-chain transfer.
- People listings explain skills, availability and asking price. A new provider can have no delivery history without being presented as suspicious.
- Request permission only when the work needs it. Show each limit and who enforces it. Buying a task does not silently authorize movement of funds.
- Preserve conversation context and make its resulting work easy to reopen. `/activity` is the activity route; `/market/activity` belonged to an older plan.
- Keep hover labels, keyboard focus, loading, empty states and mobile actions clear. A compact card should not stretch to fill unused screen height.

Discovery quality matters, but the interface must also make commissioning, delivery and review usable. A probe count is supporting information, not the outcome someone came to AiKi for.

## Historical design record

The sections below preserve the August 2026 reference-file study and implementation notes. Their missing-screen lists, phase labels, route plans and test counts describe that prototype stage, not today's backlog or production readiness. Use the current code and [UX test plan](06-ux-test-plan.md) to check a release.

The source files for that study were `assets/AiKi Clean UI Design Reference/AiKi Home v3.dc.html` and `AiKi App.dc.html`. The older `Home.dc.html`, `Home v2.dc.html` and `uploads/` were not used as its canonical references.

## 3. Design tokens, reconciled

These tokens were extracted from the August reference files. They are retained to explain that design pass; use the current styles and brand assets for implementation.

```
canvas      #FAFAF8        ink        #141414   secondary #1A1A19
grey        #6B6B66  #767676  #8A8A8A  #57574F
orange      #FF4D00 → #FF5A00 → #FF7A2E → #FF8A3D → #FFB300  (gradients)
yellow      #FFD400        on #FFF8E0
teal        #00A092  #00786E        blue #3B82F6
purple      #7C5CFF  #C05CFF        (agent avatars ONLY)
font        Plus Jakarta Sans 400/500/600/700/800
grid        72px            radii  12 / 16 / 20 / 22 / 26 / 999px
```

**Conflict 1: orange.** The logo is `#FD4A01`; the design uses `#FF4D00`. They are 2/255
apart and indistinguishable side by side. **Adopt `#FF4D00` as the UI token** and keep the
logo file untouched: the mark is a fixed asset, the interface is a system, and matching
the system to a PNG's exact sample is not worth a visible-nowhere difference.

**Conflict 2: purple.** The design brief flagged indigo→purple gradients as the loudest
AI-slop tell of 2026. The design uses `#7C5CFF → #C05CFF`, but **only as agent avatar
fills**: never as UI chrome, never a background, never a CTA. That is a categorically
different use and it stays. **No purple enters buttons, panels, or backgrounds.**

**Carried forward from the design brief:** one colour, one meaning. Orange marks authority
and action. Yellow marks uncertainty and blocked things. Teal/plum carry direction, not
green/red. Stroke weight carries enforcement tier.

**Animations** (already named in the design, keep the names): `aikiDrift` floating shards ·
`aikiHint` rotating placeholder · `aikiRise` panel entry · `aikiBreathe` pulsing status dot.

---

## 4. What the design does not cover

These were gaps in the original HTML references, not a current list of missing app features.

### 4.1 Three screens to design, and they are the back half of the product

The original references covered discovery, but not the full path from choosing a provider to receiving and reviewing its work. The following screens were proposed for jobs that also need execution permissions. They are one part of the marketplace, not a replacement for ordinary task commissioning and delivery.

| Missing | Why it matters |
|---|---|
| **Mandate Builder** | A user grants execution authority here. It needs clear enforcement information per constraint, separately from the price of the work. It was not in either reference file. |
| **Mission Control** | Live execution. The SSE stream is already mocked, including the policy DENY and the approval request. No screen consumes it. |
| **Receipt** | A record of the actions, costs and authority used for an execution job. |

Also absent: a dedicated **Agent Passport**. The App has table rows with an *"Evidence AiKi
collected"* column, but not the full hiring-decision surface.

### 4.2 The design depicts an ecosystem that does not exist

The original illustrations showed healthy working agents. The 400-agent research sample at that time instead recorded:

```
LIVE                0     0.0%
IMPOSTOR_STATIC   133    33.3%
DECLARED_ONLY     243    60.8%
PLACEHOLDER_URL    22     5.5%
```

That sample had no agent classified LIVE by the test method. It justified states for unavailable services, thin evidence and stale data. It does not describe today's entire market or establish the availability of a provider now. The proposed yellow `#FFD400` / `#FFF8E0` treatment carried uncertainty in that reference system.

### 4.3 Desktop only

Both files are `min-width:880px`. But a user needs to **pause an agent from a phone at
3am**. Approvals, pause and revoke must work on mobile even if discovery does not.

### 4.4 Everything else absent

Onboarding (referenced as *"chosen during onboarding"*, never drawn) · wallet connect ·
loading and skeleton states · error and degraded states · stale-data treatment · the
`$U` settlement asset explanation · sponsored/curation labelling.

---

## 5. Recorded prototype build order

This records how the prototype was assembled: tokens, shells, then additional screens. A phase marked done below means it was recorded as implemented in that prototype, often against fixtures. It is not an end-to-end production test result.

### Phase 0: foundations · **done**

Tokens as CSS variables read out of the reference files rather than approximated. Plus
Jakarta Sans via `next/font`. The four animations under their original names. `AskStage`
(fullscreen, grid, glows, twin vignettes) and `AppShell` (sidebar + top bar + card) as
independent layouts. Layout preference persisted per browser, read defensively.

### Phase 1: the two reference screens · **done**

`AiKi Home v3.dc.html` → `/`. The shard field with its trapezoid warp, drift, mask and
smear; the 72px pill with rotating TAB-accept hint; fuzzy matching over the four
categories; the honest no-match panel; the status cluster with the policy-denial callout.

`AiKi App.dc.html` → `/explore`, `/agents`, `/activity`, `/market`. Sidebar with three nav
groups, top bar, page card with tabs and gradient banner, the data table, market cards.

Primitives were extracted from these screens rather than invented ahead of them: `Avatar`,
`StatusPill`, `LivenessBadge` (all seven states in plain language), `EvidenceBars`,
`SpendMeter`, `Toast`.

### Phase 2: the ask history panel · **done**

A collapsible rail on the left edge of Ask mode. Every ask, grouped Today / Yesterday /
Earlier, each row carrying its outcome and each one resumable. Opens on the rail or `⌘/`.
Unmet asks are kept deliberately: they are the record of what to build next.

### Phase 3: the decision surfaces · **done**

**Agent Passport** at `/agent/[key]`, with four panels: evidence, capabilities and where
each limit is held, identity, risks. Every score is computed from the counts behind it at
render time, so nothing on screen can drift from its evidence.

Still open here: **Compare**, including the statistically-indistinguishable state.

### Phase 4: the loop closes · **done**

**Mandate Builder** at `/agent/[key]/hire`. Reads what the agent can actually enforce off
its passport, so choosing a period the agent's session module cannot hold visibly
downgrades that limit and says why. The headline is the weakest link.

**Mission Control** at `/jobs/[id]`. Replays the event stream in SSE's own shape. A policy
denial is the loudest thing on the page; an allow is nearly silent.

**Receipt** at `/receipts/[id]`. Every action including the refused one, costs split by who
took what, the mandate hash binding the work to its authority, and a signature verifiable
without going through AiKi.

### Phase 5: the rest of the frontend · **done**

**Search results.** Explore reads the query the ask page sends it, and every
results page carries what was left out and why, using our own sweep proportions.
A query we did not understand reports nothing matched rather than inventing a
count.

**Compare** at `/compare`. Two agents are indistinguishable when their intervals
overlap; when they do the page says so and computes what would settle it.

**How we test** at `/how-we-test`: the sweep, the detection rules in plain
language, why a score is never a raw percentage, and what the method cannot do.

**Limits** at `/limits`, leading with the weakest link across everything
authorised. **Saved** at `/saved`, kept in the browser. **Settings** at
`/settings`. **Onboarding** at `/welcome`, which is where the layout preference
is actually chosen.

**The shell**: ⌘K palette, a sidebar that collapses and remembers it, a real
notifications panel, an account menu.

**Mobile**, verified over CDP with real device metrics: sidebar becomes a
drawer, detail headers stack, tabs scroll, and pause, revoke and approvals go
full width. Twenty routes, two widths, no horizontal overflow.

**The four data states**: skeletons shaped like what is coming, a freshness
indicator with NO DATA separate from STALE, an error boundary that leads with
what did *not* happen, and a not-found that explains transferred identities.

### Phase 5b: nothing to show · **done**

The app assumed a wallet everywhere. Connecting is now real state, written by
onboarding and cleared from Settings or the account menu, and every surface
reads it: My agents, Activity and Limits each have an empty state that says what
the emptiness means and what would fill it, the status pill reads "No agents
yet", badges disappear, freshness disappears because nothing is being read, and
the ask page derives first-run from it rather than from a demo switch.

Storage is only readable on the client, so each of those surfaces shows a
skeleton until it knows, rather than flashing the wrong answer and correcting
it.

### Phase 6: API integration, recorded as next in the original plan

The original plan was to wire fixture-backed screens to `apps/api` through the contract. That assumption is historical: current task, provider, assistant and settlement services must be checked against their actual clients. Do not present the old sample's 0% LIVE result as current marketplace availability.

### Deferred in the original plan

Onboarding, Arena, Workspaces and a provider console appeared here as later work. This list is not a current roadmap or a statement that these surfaces remain unimplemented.

---

## 6. Decisions recorded for the August reference pass

The current Fast/Manual labels and routes in section 1 take precedence over the older Ask terminology below.

1. Ask is a mode, not a nav item. It does not appear in the sidebar.
2. The label appears once, in Settings. Nowhere else.
3. Ask mode keeps a collapsible history rail: a real chat panel of past asks and their
   outcomes, resumable. The tabular record stays in Activity.
4. UI orange is `#FF4D00`. The logo file is left alone.
5. Purple stays, confined to agent avatars.
6. Shells are independent of screens, so onboarding and flow changes are additive.
7. Primitives are extracted from the screens that need them, not built speculatively
   ahead of them. A gallery of components nobody has placed is not progress.
8. Measured values are stored as the counts behind them and computed at render time. A
   score in a fixture file would be a number nobody could trace back to evidence.
9. Dynamic hrefs are cast in `lib/routes.ts` and nowhere else, so `typedRoutes` stays
   useful instead of being worked around in every component.
