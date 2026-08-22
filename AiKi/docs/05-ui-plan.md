# UI Plan

**Source of truth:** `assets/AiKi Clean UI Design Reference/` — `AiKi Home v3.dc.html` and
`AiKi App.dc.html` only. The older `Home.dc.html` / `Home v2.dc.html` and `uploads/` are
not canonical.

**Domain:** `useaiki.xyz`

---

## 1. The shape, resolved

The design ships two layouts. The important correction: **they are not two destinations,
they are two homes.**

| | **Ask** | **Market** |
|---|---|---|
| What it is | Fullscreen, focused. Everything unnecessary is dimmed away. | Conventional marketplace with sidebar, tables, tabs. |
| Route | `/` | `/market` |
| Chrome | None. Logo, top-right status, nothing else. | Sidebar, top bar, tabs. |
| Reached by | Default for users who chose it at onboarding | `/market`, or the "Market view" link in the status panel |

**"Ask" is a mode, never a sidebar item.** Its entire value is that it removes chrome —
listing it *inside* the chrome it removes is self-defeating. The design's
`nav('One ask', …)` entry does not survive into the build.

**The label mostly disappears.** It appears in exactly one place: the layout preference in
Settings. Nowhere else. No banner announcing which layout you're in, no repeated "One ask"
chips. The user notices the mode by *being in it*.

**Everything is reachable from the field.** Typing in Ask mode searches agents, past asks,
and destinations. `⌘K` opens the same field from anywhere in Market mode. One input, one
mental model.

---

## 2. Ask-mode history — a chat panel

A slide-out panel on the left edge of Ask mode holding the full history of what you have
asked and what the agents did about it. Collapsed to a thin rail by default so it does not
compete with the field; opens on click or `⌘/`.

Each entry is an **ask and its outcome**, not a bare message — the ask text, which agent
took it, what it cost, and where it ended. Clicking one resumes that thread: the field
refills, the result panel reopens, and if a job is still running it goes straight to
Mission Control.

Threads are grouped Today / Yesterday / Earlier, searchable from the same field, and
persist across sessions. The full tabular record still lives at `/market/activity` for when
you want columns and filters rather than a conversation.

The rail is the one piece of chrome Ask mode keeps, because it is *your* history rather
than product furniture — and it stays collapsed until you reach for it.

## 3. Design tokens, reconciled

Extracted from the files rather than invented. Two conflicts to settle.

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

**Conflict 1 — orange.** The logo is `#FD4A01`; the design uses `#FF4D00`. They are 2/255
apart and indistinguishable side by side. **Adopt `#FF4D00` as the UI token** and keep the
logo file untouched — the mark is a fixed asset, the interface is a system, and matching
the system to a PNG's exact sample is not worth a visible-nowhere difference.

**Conflict 2 — purple.** The design brief flagged indigo→purple gradients as the loudest
AI-slop tell of 2026. The design uses `#7C5CFF → #C05CFF`, but **only as agent avatar
fills** — never as UI chrome, never a background, never a CTA. That is a categorically
different use and it stays. **No purple enters buttons, panels, or backgrounds.**

**Carried forward from the design brief:** one colour, one meaning. Orange marks authority
and action. Yellow marks uncertainty and blocked things. Teal/plum carry direction, not
green/red. Stroke weight carries enforcement tier.

**Animations** (already named in the design, keep the names): `aikiDrift` floating shards ·
`aikiHint` rotating placeholder · `aikiRise` panel entry · `aikiBreathe` pulsing status dot.

---

## 4. What the design does not cover

This is the honest gap list. Some of it you flagged; most of it neither file contains.

### 4.1 Three screens to design, and they are the back half of the product

The loop is **intent → evidence → mandate → execution → proof.** Both files cover the first
two. The last three get designed here, from the established system — the reference screens
already show how this product handles panels, tables, status, callouts and money, so these
extend that language rather than needing a new one.

| Missing | Why it matters |
|---|---|
| **Mandate Builder** | The design brief calls it *"the most important screen in the product."* It is where a user grants an agent authority over real money, and where enforcement tier must be rendered per constraint. Not in either file. |
| **Mission Control** | Live execution. The SSE stream is already mocked, including the policy DENY and the approval request. No screen consumes it. |
| **Receipt** | The payoff. The thing that proves what happened. |

Also absent: a dedicated **Agent Passport**. The App has table rows with an *"Evidence AiKi
collected"* column, but not the full hiring-decision surface.

### 4.2 The design depicts an ecosystem that does not exist

Every agent drawn is healthy, named, and working. Our own 400-agent sweep found:

```
LIVE                0     0.0%
IMPOSTOR_STATIC   133    33.3%
DECLARED_ONLY     243    60.8%
PLACEHOLDER_URL    22     5.5%
```

**Zero live.** So the market page, rendered against real data today, is either empty or
full of things that do not work — and none of the seven liveness states, the thin-evidence
case, "too close to call", or stale data appear anywhere in the design.

This is the single biggest piece of design work still outstanding, and the piece nobody
else can copy. It also extends cleanly from what exists: the yellow `#FFD400` / `#FFF8E0`
callout already carries "blocked", and the same treatment carries "unverified".

### 4.3 Desktop only

Both files are `min-width:880px`. But a user needs to **pause an agent from a phone at
3am**. Approvals, pause and revoke must work on mobile even if discovery does not.

### 4.4 Everything else absent

Onboarding (referenced as *"chosen during onboarding"*, never drawn) · wallet connect ·
loading and skeleton states · error and degraded states · stale-data treatment · the
`$U` settlement asset explanation · sponsored/curation labelling.

---

## 5. Build order

Progressive by construction: tokens first, then the two shells ported faithfully from the
reference, then the screens the reference does not cover — each drawn from the same system
rather than invented. Onboarding and flow changes slot in later without rework because the
shells are independent of what fills them.

### Phase 0 — foundations · **done**
Tokens as CSS variables read out of the reference files rather than approximated. Plus
Jakarta Sans via `next/font`. The four animations under their original names. `AskStage`
(fullscreen, grid, glows, twin vignettes) and `AppShell` (sidebar + top bar + card) as
independent layouts. Layout preference persisted per browser, read defensively.

### Phase 1 — the two reference screens · **done**
`AiKi Home v3.dc.html` → `/`. The shard field with its trapezoid warp, drift, mask and
smear; the 72px pill with rotating TAB-accept hint; fuzzy matching over the four
categories; the honest no-match panel; the status cluster with the policy-denial callout.

`AiKi App.dc.html` → `/explore`, `/agents`, `/activity`, `/market`. Sidebar with three nav
groups, top bar, page card with tabs and gradient banner, the data table, market cards.

Primitives were extracted from these screens rather than invented ahead of them: `Avatar`,
`StatusPill`, `LivenessBadge` (all seven states in plain language), `EvidenceBars`,
`SpendMeter`, `Toast`.

### Phase 2 — the ask history panel · **done**
A collapsible rail on the left edge of Ask mode. Every ask, grouped Today / Yesterday /
Earlier, each row carrying its outcome and each one resumable. Opens on the rail or `⌘/`.
Unmet asks are kept deliberately — they are the record of what to build next.

### Phase 3 — the decision surfaces · **done**
**Agent Passport** at `/agent/[key]`, with four panels: evidence, capabilities and where
each limit is held, identity, risks. Every score is computed from the counts behind it at
render time, so nothing on screen can drift from its evidence.

Still open here: **Compare**, including the statistically-indistinguishable state.

### Phase 4 — the loop closes · **done**
**Mandate Builder** at `/agent/[key]/hire`. Reads what the agent can actually enforce off
its passport, so choosing a period the agent's session module cannot hold visibly
downgrades that limit and says why. The headline is the weakest link.

**Mission Control** at `/jobs/[id]`. Replays the event stream in SSE's own shape. A policy
denial is the loudest thing on the page; an allow is nearly silent.

**Receipt** at `/receipts/[id]`. Every action including the refused one, costs split by who
took what, the mandate hash binding the work to its authority, and a signature verifiable
without going through AiKi.

### Phase 5 — the rest of the frontend · **done**

**Search results.** Explore reads the query the ask page sends it, and every
results page carries what was left out and why, using our own sweep proportions.
A query we did not understand reports nothing matched rather than inventing a
count.

**Compare** at `/compare`. Two agents are indistinguishable when their intervals
overlap; when they do the page says so and computes what would settle it.

**How we test** at `/how-we-test` — the sweep, the detection rules in plain
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

### Phase 5b — nothing to show · **done**
The app assumed a wallet everywhere. Connecting is now real state, written by
onboarding and cleared from Settings or the account menu, and every surface
reads it: My agents, Activity and Limits each have an empty state that says what
the emptiness means and what would fill it, the status pill reads "No agents
yet", badges disappear, freshness disappears because nothing is being read, and
the ask page derives first-run from it rather than from a demo switch.

Storage is only readable on the client, so each of those surfaces shows a
skeleton until it knows, rather than flashing the wrong answer and correcting
it.

### Phase 6 — the seam · **next, and not ours**
Wiring these screens to `apps/api` through the contract. The frontend builds
against fixtures shaped exactly like the contract, so this is a change of import
per screen rather than a rewrite. Once real data lands: the market as it
actually looks, where LIVE is 0% and a third of the registry is
IMPOSTOR_STATIC.

### Later, unblocked by the above
Onboarding (which sets the layout preference) · Arena · Workspaces · Provider console.

---

## 6. Decisions taken here

1. Ask is a mode, not a nav item. It does not appear in the sidebar.
2. The label appears once, in Settings. Nowhere else.
3. Ask mode keeps a collapsible history rail — a real chat panel of past asks and their
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
