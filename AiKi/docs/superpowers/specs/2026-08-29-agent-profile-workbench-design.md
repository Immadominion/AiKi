# Agent profile workbench design

## Outcome

Replace the current four-tab agent dossier with a compact, responsive agent profile that keeps the collectible passport visible while the user inspects authority, proof, and identity in place.

The desktop default must fit inside a 1440 by 900 viewport without page scrolling. When content or viewport height requires scrolling, the page must grow naturally. The passport container must remain content-height and must never stretch to match a taller details panel.

## Product model

The route is an agent profile. The crafted object inside it is the Agent Passport.

The profile answers four questions in order:

1. What is this agent for?
2. What will it do and what access does it need?
3. What limits contain it?
4. What evidence and identity support the decision?

No information from the current Evidence, What it can do, Identity, or Risks views is removed. Repeated facts are consolidated and supporting detail switches inside one stable workbench.

## Desktop composition

Use a specialized white profile surface inside the existing `AppShell`.

### Profile toolbar

The toolbar contains:

- Back to Explore
- Chain and agent number
- Save
- Compare
- Overflow actions

Every profile backed by the current fixtures carries a quiet `Demonstration data` label. The label is removed when API-backed data replaces the fixtures. It must not claim that the agent is unprobed or unregistered while the page displays probe and registry figures.

### Persistent passport column

The left column is approximately 280 to 310 pixels wide and uses `align-self: start` with automatic height.

It contains:

- A layered collectible passport with agent artwork
- Agent name and verified identity seal
- One-line job description
- Protocol and asset access
- Proof, observation count, and price
- A crafted trust-boundary cell
- Price and billing asset
- Hire with your limits
- Save and Compare
- Last checked date and ownership history

The background mat hugs this content with ordinary padding. It does not use `height: 100%`, `min-height: 100%`, grid stretching, or a spacer that pushes metadata to the bottom of the screen.

The trust-boundary cell uses this plain-language treatment:

> $250 monthly cap. AiKi checks this limit. The chain does not.

It is part of the credential's fact matrix. It is not an orange alert strip and does not use the phrase `Weakest rule`.

The passport contains no `Answering now` label. Evidence freshness is represented by the exact last-checked time. Operational states such as Monitoring belong on hired-agent screens.

### Decision surface

The right side contains three stable layers.

1. A short promise and explanation
2. A ruled metrics strip for proof, observations, reply time, and price
3. A compact operating sequence followed by the inspection workbench

The operating sequence is:

`Watch position` → `Test your floor` → `Repay debt`

Permissions are attached directly to the relevant step:

- `read_position`
- no spend while healthy
- `repay_debt`
- `spend_usdt`

This replaces the two oversized capability cards.

## Inspection workbench

Use three keyboard-accessible tabs. The passport and operating sequence remain unchanged while tabs switch.

### Mandate

Default view. It contains four compact rule rows:

- Venus Comptroller and vUSDT only, enforced on-chain
- No more than $80 per action, enforced by AiKi
- No more than $250 each month, enforced by AiKi
- Stops on 30 September 2026, enforced on-chain

Each row keeps the consequence or caveat beside the claim. A compact action-route diagram shows:

`Your smart account` → `AiKi mandate` → `Venus Comptroller` and `vUSDT`

The transferable-identity risk remains visible at the bottom of this view.

### Proof

This view contains:

- Overall proof score and uncertainty explanation
- Five component scores with their own sample counts
- Direct probes, finalized actions, and registry reports
- Last checked time, reply latency, and the one-location probe caveat

The score is not repeated as multiple decorative badges.

### Identity

Use a compact two-column fact grid for:

- Registry and token
- Owner and wallet proof
- Reciprocal domain proof
- Registration file
- Declared trust models
- Ownership history
- Registration date
- Transfer policy

The transfer policy explains that evidence confidence resets when ownership changes.

## Visual language

Retain the existing AiKi tray, grid, white page surface, dark ink, and orange accent.

Geometry has distinct jobs:

- Profile surface: 22 to 24 pixel radius
- Passport mat: one pronounced curved corner, 24 pixel secondary corners
- Passport object: layered 27 to 45 pixel corner treatment
- Workbench: 24 pixel main corners with one deeper lower corner
- Controls: 10 to 13 pixels
- Status only: full pill

Use single-stroke SVG icons. The passport illustration is a deliberate branded identity asset, not an emoji or a generic icon bubble. Avoid glassmorphism, gradient score rings, equal KPI cards, repeated shadows, and identical radii on every element.

## Responsive behavior

### Wide desktop, 1120 pixels and above

- Expanded or user-selected global sidebar
- Two-column profile layout
- Content-height passport mat
- Right workbench uses the remaining width
- Initial view fits at 1440 by 900 when browser zoom is 100 percent

### Compact desktop and tablet, 840 to 1119 pixels

- Existing global sidebar may collapse to its icon rail
- Passport column remains between 260 and 290 pixels
- Metrics and rule descriptions compress before core labels or enforcement sources disappear
- No horizontal page overflow

### Mobile, below 840 pixels

- Existing drawer navigation remains unchanged
- Passport comes first and stays content-height
- Decision surface stacks below it
- The page scrolls naturally
- Workbench tabs remain visible and may scroll horizontally if needed
- Capability sequence stacks vertically
- Rule descriptions may move beneath the rule title, but they remain available
- Identity facts become one column
- Buttons keep a minimum 44 pixel touch target where they are primary actions

There are no fixed viewport heights on the profile's internal content regions at mobile widths.

## Interaction and accessibility

- Tabs use `role="tablist"`, `role="tab"`, `role="tabpanel"`, `aria-selected`, and `aria-controls`.
- Left and right arrow keys move between tabs.
- Visible focus follows the existing global focus treatment.
- SVG artwork has an accessible name. Decorative SVGs are hidden from assistive technology.
- Text remains selectable and is not baked into raster artwork.
- Color is not the only indication of enforcement source, verification, or selection.
- Reduced-motion users receive no decorative transition.

## Code structure

Keep the route and data fixtures unchanged. Split the UI into focused components under `apps/web/src/components/agent/`:

- `AgentPassport.tsx`: data preparation, selected workbench tab, navigation actions
- `AgentProfileShell.tsx`: profile toolbar and responsive two-column composition
- `AgentCredentialCard.tsx`: passport object, commercial decision block, and content-height mat
- `AgentOperationFlow.tsx`: compact Watch, Test, Repay sequence
- `AgentInspectionWorkbench.tsx`: Mandate, Proof, and Identity tabs and panels

Reuse the existing measurement utilities and agent detail types. Do not duplicate score calculations or hard-code Guardian-only values into shared components.

The detail route receives its own profile surface instead of forcing this asymmetric layout through the generic `PageCard` tab structure. `AppShell`, global navigation, Fast and Manual mode behavior, and unrelated pages remain unchanged.

## Verification

Automated checks must cover:

- All three workbench tabs switch reactively
- Keyboard arrows move between tabs
- No `Answering now` text is rendered
- The monthly-cap trust boundary says who enforces it
- Every capability permission appears
- Every enforcement rule appears
- Proof component and evidence-source data remain present
- All identity facts and the transfer risk remain reachable
- Agent-specific data renders for every key in `DETAILS`

Visual checks must cover:

- 1440 by 900 desktop with expanded sidebar
- 1280 by 800 desktop with collapsed sidebar
- 1024 by 768 tablet
- 390 by 844 mobile
- Long names, longer capability copy, and more than one risk
- Passport mat remains content-height when the selected workbench panel is taller
- No horizontal overflow at any target viewport

Run the repository's existing lint, typecheck, and web tests after implementation.

## Acceptance criteria

- The approved one-screen composition is recognizable in production.
- The passport remains the visual protagonist without taking over the page.
- The left passport mat ends shortly after its final content row.
- The page introduces no empty full-height slab beside longer content.
- Desktop users can judge the default profile without scrolling at 1440 by 900.
- Mobile users can read and operate the full profile through natural vertical scrolling.
- No current agent-detail information is discarded.
- Risk and enforcement caveats remain attached to the claims they qualify.
