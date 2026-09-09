# UX test plan

AiKi is a marketplace for humans and AI agents to get work done together. [PRODUCT.md](PRODUCT.md) defines the product, participants and priorities. Test the complete work flow, not only discovery and endpoint checks.

The current checklist comes first. The original August prototype checklist is retained below as a dated reference. Its fixed fixture scores, old routes, automatic job animation and simulated wallet setup are not current production acceptance criteria.

## Current release setup

Run `pnpm --filter @aiki/web dev` and use the port it reports. Confirm the API deployment, account, network and payment rail before testing mutations. Use dedicated test accounts and approved balances. Never paste keys, session tokens or wallet secrets into a report.

Record the app revision, environment, browser, viewport and test time. A checkbox is an instruction to verify, not a claim that it passed. Keep fixture-only results separate from live API and chain tests. The development MOCK panel is not proof that a task was delivered or a payment settled.

## A. Entry and mode switching

- [ ] `/` explains the marketplace and its entry action opens the app.
- [ ] Fast at `/app` and Manual at `/market` are two ways into the same marketplace.
- [ ] Switching Fast to Manual immediately changes the active view; no extra Home click is needed. Switching back works too.
- [ ] The account and existing work remain the same after either switch or reload.
- [ ] A first-time user can tell how to describe work, browse providers, open Work and find People.
- [ ] Connecting or signing in explains what it authorizes. It does not silently buy a task or grant fund access.
- [ ] History contains only this wallet's saved conversations. Reload and a second signed-in device can resume the same real messages without submitting another turn.
- [ ] Interrupt a Fast reply, reload, and use Check reply. It retains the exact request key and does not create another charge or task. Disconnecting or switching wallets clears the private view.

## B. Find and choose

- [ ] Fast understands a supported request, shows the relevant provider and keeps the conversation context.
- [ ] An unsupported request or unavailable provider is explained without inventing a result, price or completed action.
- [ ] Manual cards lead to the correct profile. Registry IDs use `/registry/[id]`; reference-agent keys use `/agent/[key]`.
- [ ] A profile makes the offer, scope, price and next step understandable before asking the user to inspect technical detail.
- [ ] The compact identity card and supporting details remain readable without a forced full-height empty container.
- [ ] Endpoint checks, thin evidence and stale observations support the choice. A probe response is not presented as delivered work or a guarantee.
- [ ] Live categories and supported sources are discoverable without implying that a featured or indexed subset is the whole marketplace.

## C. Commission, deliver and review in Work

- [ ] Before commissioning, the buyer can identify the provider or open-task audience, brief, expected delivery, price, fee and deadline.
- [ ] The confirmed request reaches the correct task API and appears in `/work` under the same task ID.
- [ ] An AiKi points task is labeled in points, with the current withdrawal limitation visible. Do not describe its Paid state as an on-chain token transfer.
- [ ] A named-agent task records the dispatch attempt and its result. An unavailable endpoint does not produce a fabricated delivery or success message.
- [ ] The provider can submit only work assigned to or claimed by its authenticated account. A second claimant cannot take the same active task.
- [ ] The buyer can read the full submission before accepting or declining it.
- [ ] Acceptance updates the task and points balance once. Repeating the request or refreshing the page does not pay twice.
- [ ] The brief, submitted work and final review remain visible after reload.
- [ ] Missing balance, dispatch failure, delivery expiry, review expiry, dispute and cancellation paths have accurate states and recovery actions.
- [ ] Open work cannot be cancelled to reclaim held points after a valid claim, except through the implemented expiry or resolution rules.
- [ ] Expanding a delivery preserves its code, URLs and original text. A background status refresh does not collapse the reading area. An expired assigned task offers its poster the supported cancel-and-refund action.

## D. People and participant directions

- [ ] People shows real listings from `/v1/sellers`, including availability, skills and asking price.
- [ ] A signed-in person can publish or update a listing; saving a profile is not shown as a completed hire.
- [ ] No delivery history is presented as a new provider, not as proof of poor work.
- [ ] A direct hire of a person uses `hirePerson`; a direct agent hire uses `assignAgentId`. The request cannot select both.
- [ ] The hired person sees the assigned work in their own task list and can submit it for the buyer's review.
- [ ] The listing form opens only when requested. Pausing availability saves `false`, removes the listing from available results and preserves the existing work record.
- [ ] Request work shows the actual offer, server fee, points hold and withdrawal limitation before confirmation. An interrupted request retains its original body and payment key.

Verify these directions with supported clients and dedicated test participants. The task API and assistant tool support described here is not a claim of feature parity in every UI or deployment.

| Direction | Flow to exercise | Boundary to verify |
|---|---|---|
| Human to agent | A person commissions a named agent, receives a delivery and reviews it | A listing or permission preview alone is not a completed hire |
| Agent to agent | An assistant uses the named-agent task tool under its authenticated account | Required confirmation, account permissions and supplied mandate limits still apply |
| Agent to human | An assistant posts open work or hires a named person | Do not infer unlimited labour spending from permission to act elsewhere |
| Human to human | One test account hires or posts work for another, which submits it for review | Claim, submission and review ownership must be enforced |

Record a direction as unavailable when the relevant client, provider or deployment support is missing. Do not substitute a screenshot of a form for a passed delivery test.

## E. Permission and settlement boundaries

- [ ] A one-off paid task and permission to act on funds are presented as separate decisions.
- [ ] Each permission control identifies the action, amount, period or expiry and who enforces it.
- [ ] A monthly check held by AiKi is not labeled as a chain-enforced monthly limit when the module only holds a lifetime cap.
- [ ] The selected network, token, decimals and unaudited/testnet warnings match the actual deployment.
- [ ] Cancelling a connection or signature leaves the preview unsubmitted and does not create a successful job state.
- [ ] Pause and revoke are reachable on mobile. Disconnecting a wallet is not described as revoking an existing authorization.
- [ ] `/v1/tasks` points state, `/v1/jobs` execution state and `/v2/jobs` settlement state are checked independently. A submitted transaction is not final settlement.

## F. Shared UX and copy

- [ ] Check 390, 768, 1180 and 1440 pixel widths. No page-level horizontal overflow; wide tables scroll in their own container.
- [ ] Dialogs, menus, task review and permission actions fit the phone viewport.
- [ ] Icon-only controls have accessible names and hover/focus labels. Fullscreen and exit hints do not occupy permanent extra space.
- [ ] Keyboard focus is visible, order follows reading order, and Escape closes the appropriate surface.
- [ ] A closed mobile sidebar cannot receive keyboard focus. An open sidebar contains focus, closes on Escape, and returns focus to its trigger.
- [ ] Reduced motion preserves access to every action and all content.
- [ ] Loading, unavailable and genuinely empty states are distinct. Failed requests never appear as successful work.
- [ ] Copy describes a marketplace and the work a person can do next. It does not make probing the product or describe humans only as a substitute when agents fail.
- [ ] Prices, counts and network claims match their source. Do not promise safety, delivery or a payout that the implementation cannot establish.

## Current implementation references

`apps/web/src/components/work/WorkBoard.tsx`, `components/people/People.tsx`, `components/shell/prefs.ts`, `lib/routes.ts`, `apps/api/src/tasks/routes.ts`, `tasks/store.ts`, `assistant/tools.ts` and `marketplace/routes.ts` are the relevant starting points. Preserve the API ownership and idempotency tests alongside this UX walkthrough.

---

## Archived August 2026 prototype checklist

The remainder records fixture-era checks. It is useful for regression ideas, but route names, copy, scores, simulation timings and the final gap list describe that prototype only. `/welcome` and `/how-we-test` in this archive are old route references; they are not in the current app route tree. The current landing is `/`, Fast is `/app`, and mode-specific onboarding lives in the app.

**Setup.** `pnpm --filter @aiki/web dev` → `localhost:3000`. The **MOCK** tab on the
right edge (or `⌘⇧M`) opens the local controls: seed demo, seed fresh, wipe, step
a job by hand, and a JSON box you can paste any state into.

Three states worth testing from:

- **Wipe**: no wallet. What a stranger sees.
- **Fresh**: connected, nothing hired. What a real new user sees.
- **Demo**: two working, one paused, a week of history, one approval waiting.

---

## 0 · First contact

- [ ] `/` loads with no wallet: greeting reads **Welcome to AiKi**, no name
- [ ] Status pill says **No agents yet**, dot is grey and not breathing
- [ ] Top-right avatar is a `+` and goes to `/welcome`
- [ ] Under the field: **New here? Take the walkthrough**
- [ ] Shard cards drift, and each one lands on that agent's passport
- [ ] Hint text rotates every ~4s; `Tab` on an empty field accepts it
- [ ] `⌘/` opens the ask history; `Esc` closes it
- [ ] Bottom-left **Your asks** pill and bottom-right view switch never overlap
- [ ] "how we test" goes to `/how-we-test`

## 1 · Onboarding: `/welcome`

- [ ] Four steps; the progress rail fills as you go
- [ ] **Skip for now** exits to the home you have selected
- [ ] Step 1 explains what connecting does *and does not* grant
- [ ] Pressing **Connect wallet** actually connects (check the MOCK panel)
- [ ] Step 2 **Continue** is disabled until a kind of work is picked
- [ ] Step 3 names the work you picked and the agent with the most evidence
- [ ] Step 3 cap chips change selection
- [ ] Step 4 writes the home-layout preference: verify it in the sidebar after
- [ ] **Back** works from every step and keeps your choices
- [ ] Final button says **Open AiKi** or **Open the market** depending on step 4
- [ ] Landing after finish matches the layout you chose

## 2 · Ask → results

- [ ] Type "protect me from liquidation" → panel shows matching kinds of work
- [ ] Type "mint an nft" → panel says AiKi claims four kinds of work today
- [ ] `Enter` goes to `/explore?q=…`
- [ ] Results header reads the query back and names how it was understood
- [ ] Coverage block shows **shown of matched**, and *why* the rest were excluded
- [ ] A query we do not understand reports **nothing matched**: not a fake count
- [ ] The no-match state offers the four kinds of work, and each is clickable
- [ ] Ask history: a row refills the field / reopens the result

## 3 · Explore: `/explore`

- [ ] Tabs actually filter: **Suggested** (5) · **All** (6) · **Tested most** (6)
- [ ] Tab hint text changes per tab
- [ ] **Tested most** is ordered by check count, descending
- [ ] Evidence bars: Guardian 5 filled, Sentinel 1, and empty bars read as
      missing evidence rather than as a bad score
- [ ] **Save** toggles to **Saved**, and the agent appears in `/saved`
- [ ] Save survives a reload
- [ ] **View** opens the passport
- [ ] **Compare** opens `/compare`
- [ ] **How we test** under the table opens `/how-we-test`

## 4 · Passport: `/agent/[key]`

Walk **guardian** (thick evidence), **sentinel** (thin), **harbor** (degraded + a
vendor-held cap).

- [ ] Header: mark, name, liveness in plain language, price, **Compare**, **Hire**
- [ ] Harbor shows the **slow** banner; Guardian does not
- [ ] **Evidence** tab
  - [ ] Guardian scores **95**, band 95-99 on 174 checks
  - [ ] Sentinel scores **≈50**, band 49-97 on 7 checks: the rounding is the point
  - [ ] Sentinel's unobserved components read **never observed**, not `0`
  - [ ] Component bands are each drawn separately
- [ ] **What it can do** tab: capabilities, permissions, and where each limit is
      held: T0 quiet, anything weaker loud
- [ ] Harbor's vendor-held cap shows the "we have not read the enforcing code"
      callout
- [ ] **Identity** tab: unproven wallet and no reciprocal proof both read as
      caveats, not as failures
- [ ] **Risks** tab: worst first
- [ ] Tabs do not wrap on a phone; the row scrolls

## 5 · Compare: `/compare`

- [ ] Guardian vs Sentinel → **We cannot tell these apart yet**
- [ ] The reason names both scores and both ranges
- [ ] **What would settle it** gives a check count *and* a duration
- [ ] Guardian vs LPilot → separated verdict, no projection block
- [ ] Swapping the second agent from the chips reruns the verdict
- [ ] Cells with no evidence say **never observed**
- [ ] The table scrolls sideways rather than squashing on a phone

## 6 · Hiring: `/agent/[key]/hire`

The screen worth the most attention.

- [ ] Every control carries its own enforcement badge
- [ ] **Guardian**: all four limits read **On-chain**
- [ ] **YieldMax** + "a month" → badge flips to **AiKi only**, headline goes amber,
      and the caveat explains the session module holds lifetime caps only
- [ ] Switching that back to **in total, ever** returns it to On-chain
- [ ] **Sentinel** shows "It cannot spend" instead of the money controls
- [ ] Summary lists exactly what you granted, in your words
- [ ] Headline is the **weakest link**, never an average
- [ ] Expiry chips update the "Stops on …" date
- [ ] Approval mode selection changes the summary line
- [ ] **Sign and hire** creates the agent and lands on its live job

## 7 · Mission control: `/jobs/[id]`

- [ ] The job advances on its own roughly every 1.4s
- [ ] The refusal happens **at the per-action cap you chose**: hire at $40 and
      it refuses $45.60; hire at $150 and it refuses $171
- [ ] The refusal is the loudest row; routine checks are nearly silent
- [ ] Transaction hashes are stable across reloads
- [ ] The approval blocks the top of the page, shows the amount and a deadline,
      and says "if you do nothing, it does nothing"
- [ ] The job stops dead while waiting: leave it a minute and nothing advances
- [ ] **Go ahead** resumes; **No** ends the job and logs a refusal you can see
- [ ] **Pause** stops it; **Resume** restarts under the same limits
- [ ] **Revoke** asks first, and offers pause as the alternative
- [ ] Revoking removes the agent and returns you to `/agents`
- [ ] Spend meter climbs as the job spends
- [ ] The receipt placeholder becomes a real button when the job finishes
- [ ] Reload mid-job: nothing is lost
- [ ] Open a job id that does not exist → honest "not running any more" state

## 8 · Receipt: `/receipts/[id]`

- [ ] Lists **every** action including the one that was refused
- [ ] The refused row has no transaction and says "never signed, never broadcast"
- [ ] Costs split three ways, and the total adds up
- [ ] Mandate hash present, and changes if you hire with different limits
- [ ] Verify URL points at `useaiki.xyz`, not at an internal route
- [ ] A receipt id that does not exist → honest empty state

## 9 · My agents: `/agents`

- [ ] Tabs filter: Working / Paused / All
- [ ] **Paused** with nothing paused says so, rather than showing an empty table
- [ ] Status pill matches reality: Working, Waiting on you, Paused by you
- [ ] Spend meter turns orange past a quarter of the cap
- [ ] **Pause** flips the row and the tab it belongs to, immediately
- [ ] **Open** goes to that agent's live job
- [ ] Banner appears only once something has actually been blocked
- [ ] Empty (fresh) and no-wallet (wipe) states both read correctly

## 10 · Activity: `/activity`

- [ ] Everything / Money moved / Blocked each show a different set
- [ ] With nothing blocked: **Nothing was blocked**: framed as a good week
- [ ] Banner totals match what the agents actually spent
- [ ] **Export** downloads a CSV; open it and check the refused row is in there
- [ ] Quotes inside a description do not break the CSV row
- [ ] Newest first

## 11 · Limits: `/limits`

- [ ] Headline is the weakest link across everything authorised
- [ ] Each agent shows **the caps you chose**, marked *Yours*, separately from the
      passport's own enforcement claims
- [ ] **Pause everything** pauses every agent and the rows say so
- [ ] Revoke asks first and offers pause
- [ ] Banner counts the limits not held by the chain
- [ ] Empty and no-wallet states

## 12 · Saved: `/saved`

- [ ] Saving from Explore and from a market card both land here
- [ ] Empty state explains that saving grants nothing
- [ ] Unsaving removes it

## 13 · How we test: `/how-we-test`

- [ ] Sweep bars are proportional and the percentages add to 100
- [ ] The "not one agent was fully live" callout is present
- [ ] Rules D0-D10 read as plain language, not as jargon
- [ ] The naive-percentage comparison shows 100% → 51 and 98% → 95
- [ ] The limits-of-the-method section is present and honest

## 14 · Settings: `/settings`

- [ ] Sidebar Wallet / Notifications / Evidence API each deep-link to a section
- [ ] **Connect** / **Disconnect** actually change state, and the shell follows
- [ ] Disconnect copy is explicit that it is *not* revoking
- [ ] Home layout toggle here matches the sidebar control
- [ ] **Clear** wipes browser storage and the app returns to defaults

## 15 · Shell

- [ ] `⌘K` opens the palette from anywhere
- [ ] Typing "liquid" matches two kinds of work
- [ ] Typing nonsense still offers **Ask AiKi for "…"**
- [ ] Arrow keys move, `Enter` runs, `Esc` closes, backdrop click closes
- [ ] Sidebar collapse persists across reloads
- [ ] Collapsed: badge counts become dots, layout card becomes one toggle,
      the AiKi mark stays visible
- [ ] Notifications: ordered by what it costs to miss, **Mark all read** works,
      each row lands on the right page
- [ ] Account menu: copy address works, and fails honestly if the browser refuses
- [ ] Status panel: pause works from inside it

## 16 · States

- [ ] First paint shows a skeleton, never a flash of the wrong answer
- [ ] Throttle the network and confirm the skeleton is shaped like the content
- [ ] Force an error (edit the JSON in the MOCK panel to something invalid) →
      the error boundary leads with "nothing was changed and nothing was spent"
- [ ] `/agent/does-not-exist` → not-found explains transferred identities
- [ ] Freshness pill disappears when no wallet is connected

## 17 · Responsive

Check at **390** (phone), **768** (tablet), **1180**, **1440**.

- [ ] No horizontal scroll on any route at any width
- [ ] ≤767: sidebar is a drawer, hamburger appears, drawer closes on navigate
- [ ] ≤767: ask page drops shards, nav links, and the TAB affordance
- [ ] Detail headers stack rather than squeezing the title to one word per line
- [ ] Tables scroll inside their own container, not the page
- [ ] Pause / Revoke / approval buttons go full width on a phone
- [ ] Dialogs and dropdowns fit the screen

## 18 · Keyboard and reduced motion

- [ ] `Tab` from the top reaches **Skip to content** first
- [ ] Every interactive element shows an orange focus ring
- [ ] Focus order matches reading order
- [ ] Nothing is reachable only by hover
- [ ] With `prefers-reduced-motion: reduce`, drift and breathing stop and
      everything still reads correctly

## 19 · Copy pass

Read every screen and flag anything that:

- [ ] Names a number without saying what it is measured from
- [ ] Uses an enum or an internal term (`T0`, `IMPOSTOR_STATIC`, `NO_DATA`)
- [ ] Says "no data" where it means "we have not measured this yet"
- [ ] Promises something the mandate cannot actually enforce
- [ ] Describes an action as safe without saying who holds the limit
- [ ] Reads as marketing rather than as a statement of fact

---

## Gaps recorded for the August prototype only

These were fixture-stage limitations. They are not current product status; verify the live services and flows using the current checklist above.

- Wallet connection is simulated. No signature is requested and no chain is read.
- Search matches four kinds of work by keyword. It is not semantic.
- Filter chips in the top bar (date range, protocol) are decorative.
- The Evidence API is described but not served.
- Freshness always reports LIVE: nothing can go stale until there is a source.
